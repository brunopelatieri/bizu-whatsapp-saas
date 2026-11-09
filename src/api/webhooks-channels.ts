import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MINUTE } from "@/api/guards";
import { clientKey, failureLimit } from "@/api/rate-limit";
import {
  classifyEvents,
  enqueueChannelEvent,
  receiveChannelEvent,
  scopeOf,
} from "@/lib/channels/events";
import { logChannelError } from "@/lib/channels/log";
import {
  type ChannelModule,
  type ChannelWebhook,
  type ChannelWebhookTarget,
  findProvider,
  getModules,
} from "@/lib/channels/registry";
import type { ChannelEventKind, ChannelProvider } from "@/lib/channels/types";

/**
 * `/api/webhooks/whatsapp/<segmento>/:key`: a porta de entrada dos avisos de canal
 * (`docs/specs/whatsapp-canais/spec.md`, "Webhooks"). Fica fora de `sameOrigin` e do CSRF, como
 * `/api/webhooks/payments/*`, e se autentica pela verificação do próprio módulo.
 *
 * O fluxo é um só para todos os provedores; o módulo declara o que é dele em
 * `ChannelModule.webhook` (segmento do caminho, teto do corpo, como achar o canal pela chave
 * e, na Meta, o `GET` de verificação). Um provedor novo não muda este arquivo.
 *
 * 1. Acha o canal pela chave do caminho. Canal `disabled` responde 200 e descarta.
 * 2. `provider.verifyWebhook` sobre o corpo cru. Falha: 401, conta no limite por IP e para.
 *    Chave desconhecida recebe a mesma resposta de assinatura errada.
 * 3. `receiveChannelEvent` grava `pending`; repetido cai na única e não duplica.
 * 4. Enfileira `channel.inbound` e responde 200. Quem aplica é o job.
 */
export const channelWebhooks = new Hono();

/** Só conta quem erra: o provedor legítimo manda volume. Por IP, 20 por minuto. */
const rejectedLimit = failureLimit({ limit: 20, windowMs: MINUTE });

const UNAUTHORIZED = { error: "Não autorizado." } as const;

const headersOf = (raw: Headers): Record<string, string> =>
  Object.fromEntries([...raw.entries()].map(([name, value]) => [name.toLowerCase(), value]));

function tooManyFailures(c: Context) {
  return c.json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
}

async function findTarget(webhook: ChannelWebhook, key: string) {
  // Chave fora do formato de qualquer módulo nem vai ao banco.
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) return null;

  return webhook.findTarget(key);
}

/** Só informativo (a coluna `kind`); normalizar de verdade é do job. Nunca derruba o aviso. */
function kindOf(provider: ChannelProvider, raw: unknown): ChannelEventKind {
  try {
    return classifyEvents(provider.normalizeEvents(raw));
  } catch {
    return "other";
  }
}

async function receive(c: Context, module: ChannelModule, webhook: ChannelWebhook) {
  const ip = clientKey(c);
  if (rejectedLimit.blocked(ip)) return tooManyFailures(c);

  const key = c.req.param("key") ?? "";
  const rawBody = await c.req.text();
  const provider = findProvider(module.id);

  let target: ChannelWebhookTarget | null;
  try {
    target = await findTarget(webhook, key);
  } catch (error) {
    logChannelError("Falha ao localizar o canal do webhook", error);
    return c.json({ error: "Indisponível." }, 503);
  }

  // O número saiu de uso aqui, mas segue assinado no provedor: 200 evita o reenvio eterno.
  if (target?.channel.status === "disabled") return c.json({ received: true });

  // Módulo desligado neste servidor: o provedor reenvia, e o aviso entra quando ele voltar.
  if (!provider) return c.json({ error: "Indisponível." }, 503);

  let verification: Awaited<ReturnType<ChannelProvider["verifyWebhook"]>>;
  try {
    // Com chave desconhecida a verificação roda mesmo assim, sem segredo: recusa igual.
    verification = await provider.verifyWebhook({
      rawBody,
      headers: headersOf(c.req.raw.headers),
      credentials: target?.credentials ?? {},
      config: target?.config ?? {},
      pathSecret: key,
    });
  } catch (error) {
    logChannelError("Falha ao verificar webhook de canal", error);
    return c.json({ error: "Indisponível." }, 503);
  }

  if (!target || !verification.ok) {
    rejectedLimit.hit(ip);
    return c.json(UNAUTHORIZED, 401);
  }

  // Só depois da verificação o corpo é lido como JSON.
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Corpo inválido." }, 400);
  }

  try {
    const kind = kindOf(provider, raw);
    const stored = webhook.prepareRaw ? await webhook.prepareRaw(target, raw) : raw;
    const received = await receiveChannelEvent({
      scope: scopeOf(target.channel.tenantId),
      channelId: target.channel.id,
      provider: module.id,
      dedupeKey: verification.dedupeKey,
      kind,
      raw: stored,
    });

    // Repetido que já foi tratado não volta à fila; o que parou `pending`, volta.
    if (received.pending) await enqueueChannelEvent(received.id);

    return c.json({ received: true });
  } catch (error) {
    // 5xx faz o provedor reenviar; o reenvio cai na única e só reenfileira o que parou.
    logChannelError("Falha ao receber webhook de canal", error);
    return c.json({ error: "Não foi possível processar agora." }, 500);
  }
}

async function handshake(c: Context, webhook: ChannelWebhook) {
  const ip = clientKey(c);
  if (rejectedLimit.blocked(ip)) return tooManyFailures(c);

  let answer: string | null = null;
  try {
    const target = await findTarget(webhook, c.req.param("key") ?? "");
    answer = (await webhook.handshake?.(target, c.req.query())) ?? null;
  } catch (error) {
    logChannelError("Falha na verificação do endereço de webhook de canal", error);
    return c.json({ error: "Indisponível." }, 503);
  }

  if (answer === null) {
    rejectedLimit.hit(ip);
    return c.json({ error: "Não autorizado." }, 403);
  }

  return c.text(answer, 200, { "Cache-Control": "no-store" });
}

for (const module of getModules()) {
  const { webhook } = module;
  if (!webhook) continue;

  const path = `/api/webhooks/whatsapp/${webhook.segment}/:key`;

  channelWebhooks.post(
    path,
    bodyLimit({
      maxSize: webhook.maxBodyBytes,
      onError: (c) => c.json({ error: "Corpo muito grande." }, 413),
    }),
    (c) => receive(c, module, webhook),
  );

  if (webhook.handshake) channelWebhooks.get(path, (c) => handshake(c, webhook));
}
