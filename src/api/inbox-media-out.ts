import { Readable } from "node:stream";
import { Hono } from "hono";
import { MINUTE } from "@/api/guards";
import { rateLimit } from "@/api/rate-limit";
import { dispositionHeader } from "@/lib/files/types";
import { openOutboundMedia } from "@/lib/inbox/media-out";

/**
 * `GET /api/inbox/media-out/:token`: o anexo de saída para o servidor Evolution baixar (C5). Sem sessão e
 * sem CSRF, como um webhook: quem autoriza é o token assinado (um arquivo, 5 minutos; ver
 * `src/lib/inbox/media-out.ts`). Fica **antes** do `csrfGuard` em `app.ts` e fora da cadeia de
 * `/api/inbox/*`, que exige sessão. Token inválido, vencido ou de arquivo que não é anexo da equipe: 404
 * igual, sem dizer qual.
 */
export const inboxMediaOutRoutes = new Hono();

inboxMediaOutRoutes.get(
  "/api/inbox/media-out/:token",
  // Por IP: quem adivinha tokens esbarra aqui; o servidor Evolution faz uma chamada por envio.
  rateLimit({ name: "inbox-media-out", limit: 120, windowMs: MINUTE }),
  async (c) => {
    const media = await openOutboundMedia(c.req.param("token"));
    if (!media) return c.json({ error: "Não encontrado." }, 404);

    return new Response(Readable.toWeb(media.body) as ReadableStream, {
      headers: {
        "Content-Type": media.mime,
        "Content-Length": String(media.size),
        "Content-Disposition": dispositionHeader(media.name, media.inline ? "inline" : "attachment"),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  },
);
