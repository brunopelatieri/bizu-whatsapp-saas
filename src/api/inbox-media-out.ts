import { Readable } from "node:stream";
import { Hono } from "hono";
import { MINUTE } from "@/api/guards";
import { clientKey, failureLimit } from "@/api/rate-limit";
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

/**
 * Conta só as **recusas** por IP, como os webhooks: o servidor Evolution é um só (um IP) e baixa um arquivo por
 * envio de todos os tenants, então um teto sobre o volume legítimo o bloquearia. Quem adivinha tokens esbarra aqui.
 */
const rejectedLimit = failureLimit({ limit: 30, windowMs: MINUTE });

inboxMediaOutRoutes.get("/api/inbox/media-out/:token", async (c) => {
  const ip = clientKey(c);
  if (rejectedLimit.blocked(ip)) return c.json({ error: "Muitas tentativas. Tente mais tarde." }, 429);

  const media = await openOutboundMedia(c.req.param("token"));
  if (!media) {
    rejectedLimit.hit(ip);
    return c.json({ error: "Não encontrado." }, 404);
  }

  return new Response(Readable.toWeb(media.body) as ReadableStream, {
    headers: {
      "Content-Type": media.mime,
      "Content-Length": String(media.size),
      "Content-Disposition": dispositionHeader(media.name, media.inline ? "inline" : "attachment"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});
