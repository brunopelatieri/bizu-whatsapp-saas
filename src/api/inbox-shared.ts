import { Readable } from "node:stream";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { jsonBodyLimit } from "@/api/guards";
import { dispositionHeader } from "@/lib/files/types";
import { MAX_OUTBOUND_MEDIA_BYTES } from "@/lib/inbox/media";
import type { openMessageMedia } from "@/lib/inbox/media-access";
import { sendText } from "@/lib/inbox/send";
import { sendMedia } from "@/lib/inbox/send-media";
import { sendTemplate } from "@/lib/inbox/send-template";
import type { InboxActor } from "@/lib/inbox/visibility";
import { sendMediaFormSchema, sendMessageSchema } from "@/lib/schemas/inbox";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * O que `/api/inbox/*` (tenant, `src/api/inbox.ts`) e `/api/admin/inbox/*` (plataforma,
 * `src/api/admin-inbox.ts`) têm em comum: o limite de corpo, a leitura do envio (JSON ou anexo) e a
 * resposta da mídia. Quem decide permissão e visibilidade continua sendo o serviço, com o `InboxActor`
 * que a rota monta; nada aqui conhece tenant ou plataforma.
 */

/** Envio de anexo: `POST .../conversations/:id/messages` com `multipart/form-data`. */
export const isMediaUpload = (c: Context) =>
  c.req.method === "POST" &&
  /^\/api\/(?:admin\/)?inbox\/conversations\/[^/]+\/messages$/.test(c.req.path) &&
  (c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");

const limitUpload = bodyLimit({
  // O arquivo (16 MB) mais os campos de texto e as fronteiras do multipart.
  maxSize: MAX_OUTBOUND_MEDIA_BYTES + 64 * 1024,
  onError: (c) =>
    c.json({ error: "Arquivo grande demais. O máximo é 16 MB.", code: "FILE_TOO_LARGE" }, 413),
});

/** 16 KB para JSON; no envio de anexo, o limite do arquivo. Sem corpo declarado, não há o que limitar. */
export const inboxBodyLimit = createMiddleware(async (c, next) => {
  if (!isMediaUpload(c)) return jsonBodyLimit(c, next);
  if (!c.req.header("content-length") && !c.req.header("transfer-encoding")) return next();
  return limitUpload(c, next);
});

export async function sendJsonFrom(c: Context, actor: InboxActor, conversationId: string) {
  const parsed = sendMessageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new TenantRuleError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Dados inválidos.");
  }

  return parsed.data.type === "template"
    ? sendTemplate(actor, conversationId, parsed.data)
    : sendText(actor, conversationId, parsed.data);
}

export async function sendMediaFrom(c: Context, actor: InboxActor, conversationId: string) {
  const form = await c.req.parseBody().catch(() => null);
  const upload = form?.file;
  if (!(upload instanceof File)) {
    throw new TenantRuleError(400, "FILE_REQUIRED", "Envie o arquivo no campo file.");
  }
  // Antes de ler o arquivo para a memória.
  if (upload.size > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new TenantRuleError(413, "FILE_TOO_LARGE", "Arquivo grande demais. O máximo é 16 MB.");
  }

  const fields = sendMediaFormSchema.safeParse({
    caption: form?.caption,
    replyTo: form?.replyTo,
    clientId: form?.clientId,
  });
  if (!fields.success) {
    throw new TenantRuleError(400, "VALIDATION_ERROR", fields.error.issues[0]?.message ?? "Dados inválidos.");
  }

  return sendMedia(
    actor,
    conversationId,
    {
      name: upload.name,
      declaredMime: upload.type || null,
      body: Buffer.from(await upload.arrayBuffer()),
    },
    fields.data,
  );
}

/** A mídia de uma mensagem como resposta HTTP: tipo decidido pelo conteúdo, `nosniff`, sem URL pública. */
export function mediaResponse(media: Awaited<ReturnType<typeof openMessageMedia>>) {
  return new Response(Readable.toWeb(media.body) as ReadableStream, {
    headers: {
      "Content-Type": media.mime,
      "Content-Length": String(media.size),
      "Content-Disposition": dispositionHeader(media.name, media.inline ? "inline" : "attachment"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    },
  });
}
