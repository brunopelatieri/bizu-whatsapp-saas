import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { VerifyResult, WebhookContext } from "@/lib/channels/types";

/**
 * Verificação do webhook da Meta. A rota acha o canal pela chave do caminho; aqui só se
 * confere quem mandou, sobre o corpo cru e com o segredo **daquele canal**.
 */

const SIGNATURE_PREFIX = "sha256=";

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 do corpo cru com o segredo do aplicativo.
 * Sem segredo ou sem cabeçalho, falha: nunca cai para "sem verificação".
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string | null | undefined,
) {
  if (!appSecret || !header?.startsWith(SIGNATURE_PREFIX)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return safeEqual(header.slice(SIGNATURE_PREFIX.length), expected);
}

/**
 * `GET` de verificação: `hub.mode = subscribe` e `hub.verify_token` igual ao do canal, em
 * tempo constante. Devolve o desafio ou `null`. Chave desconhecida e token errado caem no
 * mesmo `null`, então a resposta não diz qual dos dois falhou.
 */
export function verifyChallenge(
  query: { mode?: string | null; token?: string | null; challenge?: string | null },
  expectedToken: string | null | undefined,
) {
  if (query.mode !== "subscribe" || !query.challenge) return null;
  // Compara mesmo sem token esperado, para o tempo não revelar a diferença.
  const matches = safeEqual(query.token ?? "", expectedToken ?? "");

  return matches && expectedToken && query.token ? query.challenge : null;
}

/** `dedupe_key` do aviso da Meta: sha256 do corpo cru (a Meta reentrega o mesmo corpo). */
export function cloudDedupeKey(rawBody: string) {
  return createHash("sha256").update(rawBody).digest("hex");
}

export async function verifyCloudWebhook(ctx: WebhookContext): Promise<VerifyResult> {
  const valid = verifyMetaSignature(
    ctx.rawBody,
    ctx.headers["x-hub-signature-256"],
    ctx.credentials.appSecret,
  );

  return valid
    ? { ok: true, dedupeKey: cloudDedupeKey(ctx.rawBody) }
    : { ok: false, reason: "invalid_signature" };
}
