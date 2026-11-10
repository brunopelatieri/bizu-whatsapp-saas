import { createHmac, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { withPlatformScope } from "@/db/rls";
import { file, message } from "@/db/schema";
import { logChannelError } from "@/lib/channels/log";
import { getEnv } from "@/lib/env";
import { OUTBOUND_MIME } from "@/lib/inbox/media";
import { INLINE_SAFE_MIME } from "@/lib/inbox/media-access";
import { getStorage } from "@/lib/storage";

/**
 * Endereço de curta duração do anexo de saída, para a **Evolution** (`POST /send/media` só aceita
 * `url`; a B0 não mediu base64, então a rota existe). O servidor Evolution não tem sessão: o que
 * autoriza é o token.
 *
 * - **Um arquivo:** o token assina o id do `file`; trocar o id invalida a assinatura.
 * - **5 minutos:** o prazo vai assinado junto; vencido ou adiado à mão, não vale.
 * - **Não lista nada:** só se chega ao arquivo conhecendo um token válido. Token inválido, vencido ou de
 *   arquivo que não é anexo de saída da equipe responde igual a "não existe" (404).
 * - O HMAC usa `BETTER_AUTH_SECRET` com um rótulo de domínio próprio (o segredo da sessão nunca assina
 *   outra coisa com a mesma entrada). Comparação em tempo constante.
 */

export const MEDIA_OUT_TTL_SECONDS = 5 * 60;
const LABEL = "bizu:inbox-media-out:v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const signature = (fileId: string, expires: number) =>
  createHmac("sha256", getEnv().BETTER_AUTH_SECRET)
    .update(`${LABEL}:${fileId}:${expires}`)
    .digest("base64url");

/** `<id do arquivo>.<expira em segundos>.<assinatura>`: só caracteres seguros em caminho de URL. */
export function signMediaOutToken(fileId: string, now = Date.now()) {
  const expires = Math.floor(now / 1000) + MEDIA_OUT_TTL_SECONDS;
  return `${fileId}.${expires}.${signature(fileId, expires)}`;
}

/** O id do arquivo se o token é autêntico e está no prazo; `null` em qualquer outro caso. */
export function verifyMediaOutToken(token: string, now = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [fileId, expiresText, given] = parts as [string, string, string];
  if (!UUID.test(fileId) || !/^\d{1,12}$/.test(expiresText)) return null;

  const expires = Number(expiresText);
  const nowSeconds = Math.floor(now / 1000);
  // Vencido, ou prazo maior que o que emitimos (token adulterado e, por acaso, assinado, não existe).
  if (expires <= nowSeconds || expires > nowSeconds + MEDIA_OUT_TTL_SECONDS) return null;

  const expected = Buffer.from(signature(fileId, expires));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  return fileId;
}

/** A URL que o servidor Evolution alcança (`EVOLUTION_WEBHOOK_PUBLIC_URL`, senão `APP_URL`). */
export function mediaOutUrl(fileId: string) {
  const env = getEnv();
  const base = (env.EVOLUTION_WEBHOOK_PUBLIC_URL ?? env.APP_URL).replace(/\/+$/, "");
  return `${base}/api/inbox/media-out/${signMediaOutToken(fileId)}`;
}

export type OutboundMedia = {
  name: string;
  size: number;
  mime: string;
  inline: boolean;
  body: Readable;
};

/**
 * Abre o anexo de saída do token. Só serve `file` que seja a mídia de uma mensagem **enviada pela
 * equipe** (`direction = out`, `sender_type = user`): um token jamais abre mídia recebida nem arquivo de
 * outro módulo, mesmo com assinatura válida. A leitura atravessa o RLS (não há sessão), por isso só aqui.
 */
export async function openOutboundMedia(token: string): Promise<OutboundMedia | null> {
  const fileId = verifyMediaOutToken(token);
  if (!fileId) return null;

  const [found] = await withPlatformScope("inbox.media-out", (tx) =>
    tx
      .select({ key: file.key, name: file.name, mime: file.mime, size: file.size })
      .from(file)
      .innerJoin(message, and(eq(message.fileId, file.id), eq(file.ownerId, message.id)))
      .where(
        and(
          eq(file.id, fileId),
          eq(file.ownerType, "message"),
          eq(message.direction, "out"),
          eq(message.senderType, "user"),
        ),
      ),
  );
  if (!found) return null;

  const body = await getStorage().get(found.key);
  if (!body) {
    logChannelError("Anexo de saída ausente no armazenamento", new Error("objeto não encontrado"));
    return null;
  }

  // O tipo foi conferido pelo conteúdo ao gravar; fora da lista de envio, vira binário genérico.
  const mime = found.mime in OUTBOUND_MIME ? found.mime : "application/octet-stream";
  return { name: found.name, size: found.size, mime, inline: INLINE_SAFE_MIME.has(mime), body };
}
