import { createHash, timingSafeEqual } from "node:crypto";
import { asRecord, pickArray, pickRecord, pickString } from "@/lib/channels/payload";
import { eventKindOf, normalizeEventName } from "@/lib/channels/providers/whatsapp_qr/normalize";
import type { VerifyResult, WebhookContext } from "@/lib/channels/types";

/**
 * Verificação em cadeia do webhook da Evolution (spec, "Webhooks"). Três fatores, todos
 * obrigatórios; qualquer falha é 401 sem detalhe:
 *
 * 1. `sha256(secret do caminho)` acha a instância (feito pela rota, em `webhook_secret_hash`);
 * 2. `instanceId` do corpo = `remote_instance_id` da instância achada;
 * 3. `instanceToken` do corpo = token decifrado da instância, em tempo constante.
 *
 * Diferente da Meta, a Evolution não assina o corpo: a prova é o token que ela devolve. Por
 * isso o corpo precisa ser lido como JSON aqui (limitado a 25 MB pela rota).
 */

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash do segredo do caminho, para achar a instância sem guardar o segredo em claro duas vezes. */
export function hashWebhookSecret(secret: string) {
  return sha256Hex(secret);
}

function parseBody(rawBody: string) {
  try {
    return asRecord(JSON.parse(rawBody));
  } catch {
    return null;
  }
}

/**
 * `dedupe_key`: tipo do evento + `Info.ID` (mensagem), ou + ids do recibo + estado, ou o
 * sha256 do corpo (conexão e demais). A Evolution reentrega 5 vezes a cada 30 s.
 */
export function evolutionDedupeKey(envelope: Record<string, unknown>, rawBody: string) {
  const event = normalizeEventName(pickString(envelope, "event") ?? "");
  const kind = eventKindOf(envelope);
  const data = pickRecord(envelope, "data");

  if (kind === "message" || kind === "send_message") {
    const id = pickString(pickRecord(data, "Info"), "ID");
    if (id) return `${event}:${id}`;
  }

  if (kind === "receipt") {
    const state = pickString(envelope, "state") ?? pickString(data, "state", "Type") ?? "";
    const list = pickArray(data, "MessageIDs", "messageIds", "ids");
    const ids = (list.length ? list : [pickString(data, "MessageID", "ID", "id")])
      .filter((value): value is string => typeof value === "string" && value !== "")
      .sort();

    if (ids.length) return `${event}:${state.toLowerCase()}:${ids.join(",")}`;
  }

  return `${event}:${sha256Hex(rawBody)}`;
}

/**
 * `ctx.config.remoteInstanceId` e `ctx.credentials.instanceToken` vêm da instância que o
 * `sha256` do segredo do caminho achou. Sem qualquer um dos três, falha.
 */
export async function verifyEvolutionWebhook(ctx: WebhookContext): Promise<VerifyResult> {
  const fail = { ok: false, reason: "unauthorized" } as const;
  const body = parseBody(ctx.rawBody);
  const instanceId = pickString(body, "instanceId");
  const instanceToken = pickString(body, "instanceToken");
  const expectedId = ctx.config.remoteInstanceId;
  const expectedToken = ctx.credentials.instanceToken;

  if (!body || !instanceId || !instanceToken || !expectedId || !expectedToken) return fail;
  if (!safeEqual(instanceId, expectedId) || !safeEqual(instanceToken, expectedToken)) return fail;

  return { ok: true, dedupeKey: evolutionDedupeKey(body, ctx.rawBody) };
}

// ---------------------------------------------------------------------------
// mediaUrl (S3 privado onde o servidor Evolution grava)
// ---------------------------------------------------------------------------

/**
 * A URL vem de um aviso e nunca é confiável (SSRF). Só é baixada se a **origem** dela
 * (esquema + host + porta, comparados exatos) estiver em `EVOLUTION_MEDIA_ORIGINS`. `http:`
 * só vale se a própria entrada da lista for `http:`. Sem credencial na URL. O download não
 * segue redirecionamento.
 */
export function isAllowedMediaUrl(value: string, allowedOrigins: readonly string[]) {
  if (!URL.canParse(value)) return false;

  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;

  return allowedOrigins.some((origin) => URL.canParse(origin) && new URL(origin).origin === url.origin);
}
