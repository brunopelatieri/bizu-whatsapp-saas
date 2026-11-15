import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { rateLimit } from "@/api/rate-limit";
import { getEnv } from "@/lib/env";

export const MINUTE = 60 * 1000;

/** Vem antes de `requireAuth`: cada sessão validada consulta o banco. */
export const authRateLimit = rateLimit({ name: "auth", limit: 60, windowMs: MINUTE });

/**
 * Limite de corpo de uma rota JSON. Sem `Content-Length` nem `Transfer-Encoding`, a requisição
 * HTTP/1.1 não tem corpo e não há o que limitar. Pular aqui importa no `npm run dev`: lá o
 * `Request` vem de outra classe, e o `bodyLimit`, ao embrulhar um corpo vazio, quebrava todo
 * `DELETE` sem corpo com 500.
 */
export function jsonBodyLimitOf(maxSize: number, message = "Requisição muito grande.") {
  const limit = bodyLimit({ maxSize, onError: (c) => c.json({ error: message }, 413) });

  return createMiddleware(async (c, next) => {
    if (!c.req.header("content-length") && !c.req.header("transfer-encoding")) {
      return next();
    }

    return limit(c, next);
  });
}

/** O padrão das rotas JSON: 16 KB. A importação de clientes tem o próprio teto (`customer-import.ts`). */
export const jsonBodyLimit = jsonBodyLimitOf(16 * 1024);

/**
 * Recusa `Origin` de outro site. O Better Auth só faz isso quando a requisição traz
 * cookie: sem esta checagem, cadastro e login aceitariam envio de qualquer origem.
 */
export const sameOrigin = createMiddleware(async (c, next) => {
  const origin = c.req.header("Origin");

  if (origin && origin !== new URL(getEnv().APP_URL).origin) {
    return c.json({ error: "Origem não permitida." }, 403);
  }

  await next();
});

export const validationError = (
  result: { success: boolean; error?: { issues: { message: string }[] } },
  c: Context,
) => {
  if (!result.success) {
    return c.json(
      { error: result.error?.issues[0]?.message ?? "Dados inválidos." },
      400,
    );
  }
};

/** Id malformado não chega ao banco: para quem pergunta, é só algo que não existe. */
export const validId = zValidator(
  "param",
  z.object({ id: z.uuid() }),
  (result, c) => {
    if (!result.success) return c.json({ error: "Não encontrado." }, 404);
  },
);
