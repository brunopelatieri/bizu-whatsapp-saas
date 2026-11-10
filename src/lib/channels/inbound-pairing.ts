import { and, eq } from "drizzle-orm";
import { withPlatformScope, withScope } from "@/db/rls";
import { channel, channelEvent, channelEvolution } from "@/db/schema";
import {
  evolutionConfigOf,
  evolutionCredentials,
  hashWebhookSecret,
} from "@/lib/channels/credentials";
import {
  classifyEvents,
  enqueueChannelEvent,
  receiveChannelEvent,
  scopeOf,
} from "@/lib/channels/events";
import { logChannelError } from "@/lib/channels/log";
import { deleteInboundMedia, storeInboundMedia } from "@/lib/channels/media";
import { asRecord } from "@/lib/channels/payload";
import { findProvider } from "@/lib/channels/registry";

/**
 * Recebimento do aviso de canal com pareamento (`POST /api/webhooks/whatsapp/evolution/:secret`).
 * Só verifica, grava em `channel_event` e enfileira; quem aplica é o job `channel.inbound`.
 *
 * Cadeia de verificação (spec, "Webhooks"), toda obrigatória:
 * 1. sha256 do segredo do caminho acha a instância (aqui, sem varrer nem decifrar);
 * 2. `instanceId` do corpo = `remote_instance_id` da instância achada (módulo);
 * 3. `instanceToken` do corpo = token decifrado, em tempo constante (módulo).
 *
 * Quem chama responde 401 **sem detalhe** em qualquer `unauthorized`: segredo desconhecido,
 * instância errada e token errado são indistinguíveis para quem está de fora.
 */

export type InboundOutcome =
  /** Gravado e enfileirado. */
  | "received"
  /** Já estava na caixa (a Evolution reentrega). */
  | "duplicate"
  /** Canal desativado: 200 e nada é gravado. */
  | "discarded"
  | "unauthorized"
  /** Módulo desligado neste servidor: o provedor tenta de novo depois. */
  | "unavailable";

/** O segredo é `randomBytes(32)` em base64url: 43 caracteres. Qualquer outra forma nem é procurada. */
const PATH_SECRET = /^[A-Za-z0-9_-]{32,128}$/;

async function findByPathSecret(pathSecret: string) {
  if (!PATH_SECRET.test(pathSecret)) return null;

  const [row] = await withPlatformScope("webhook de canal", (tx) =>
    tx
      .select({ channel, evolution: channelEvolution })
      .from(channelEvolution)
      .innerJoin(channel, eq(channel.id, channelEvolution.channelId))
      .where(eq(channelEvolution.webhookSecretHash, hashWebhookSecret(pathSecret))),
  );

  return row ?? null;
}

/**
 * O token da instância vem em todo aviso (é a prova de origem). Depois de conferido, sai do
 * corpo: `channel_event.raw` não é lugar de segredo em claro.
 */
function stripCredentials(raw: unknown, depth = 0): unknown {
  const record = asRecord(raw);
  if (!record || depth > 6) return raw;

  for (const [key, value] of Object.entries(record)) {
    const name = key.toLowerCase();

    // `token` só no envelope: mais fundo, é campo de mensagem (ex.: resposta de botão).
    if (name === "instancetoken" || name === "apikey" || (depth === 0 && name === "token")) {
      delete record[key];
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      stripCredentials(value, depth + 1);
    }
  }
  return record;
}

export async function receivePairingWebhook(input: {
  pathSecret: string;
  /** Só é lido depois de a instância ser achada: quem não sabe o segredo não faz o corpo ser lido. */
  readBody: () => Promise<string>;
  headers: Record<string, string | undefined>;
}): Promise<InboundOutcome> {
  const found = await findByPathSecret(input.pathSecret);
  if (!found) return "unauthorized";

  if (found.channel.status === "disabled") return "discarded";

  const provider = findProvider(found.channel.type);
  if (!provider) return "unavailable";

  let credentials: Record<string, string>;
  try {
    credentials = evolutionCredentials(found.evolution);
  } catch (error) {
    // Segredo que não decifra (chave trocada): sem token esperado não há como conferir.
    logChannelError("Segredo de canal ilegível no webhook", error);
    return "unauthorized";
  }

  const rawBody = await input.readBody();
  const verification = await provider.verifyWebhook({
    rawBody,
    headers: input.headers,
    credentials,
    config: evolutionConfigOf(found.evolution),
    pathSecret: input.pathSecret,
  });
  if (!verification.ok) return "unauthorized";

  const scope = scopeOf(found.channel.tenantId);
  const channelId = found.channel.id;

  // Reentrega: sem isto, cada uma das 5 tentativas da Evolution subiria a mídia de novo.
  const [known] = await withScope(scope, (tx) =>
    tx
      .select({ id: channelEvent.id, status: channelEvent.status })
      .from(channelEvent)
      .where(
        and(eq(channelEvent.channelId, channelId), eq(channelEvent.dedupeKey, verification.dedupeKey)),
      ),
  );
  if (known) {
    if (known.status === "pending") await enqueueChannelEvent(known.id);
    return "duplicate";
  }

  // Verificado: agora sim o corpo vira JSON. Mídia sai para o armazenamento antes de gravar.
  let raw = stripCredentials(JSON.parse(rawBody));
  if (provider.externalizeInboundMedia) {
    raw = await provider.externalizeInboundMedia(raw, storeInboundMedia);
  }

  try {
    const received = await receiveChannelEvent({
      scope,
      channelId,
      provider: found.channel.type,
      dedupeKey: verification.dedupeKey,
      kind: classifyEvents(provider.normalizeEvents(raw)),
      raw,
    });

    // Corrida entre duas entregas do mesmo aviso: a linha que ficou é a da outra.
    if (received.duplicate) await deleteInboundMedia(raw);
    if (received.pending) await enqueueChannelEvent(received.id);

    return received.duplicate ? "duplicate" : "received";
  } catch (error) {
    await deleteInboundMedia(raw);
    throw error;
  }
}
