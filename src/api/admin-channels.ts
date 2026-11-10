import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { type AuthEnv, requireAuth, requirePlatform } from "@/api/auth";
import { buildChannelRoutes } from "@/api/channels";
import { authRateLimit, jsonBodyLimit, sameOrigin } from "@/api/guards";
import { blockMutationsWhileImpersonating } from "@/api/impersonation";
import { clientKey } from "@/api/rate-limit";

/**
 * `/api/admin/channels/*`: números de WhatsApp **da plataforma** (`tenant_id` nulo). São as
 * mesmas rotas de `/api/channels` (`buildChannelRoutes`), com `Scope = platform`:
 *
 * - leitura para `platform_owner` e `platform_support`; escrita só para `platform_owner`;
 * - nenhuma escrita durante a personificação;
 * - sem limite de plano (o teto do servidor Evolution continua valendo);
 * - auditoria com `actor_type = platform` e sem `tenant_id`: só a plataforma a lê.
 *
 * Traz a própria cadeia de guardas e é montado **antes** de `adminRoutes` em `app.ts`, como
 * `admin-channel-events.ts`: a cadeia de `/api/admin/*` não roda duas vezes.
 */
export const adminChannelRoutes = buildChannelRoutes({
  base: "/api/admin/channels",
  guards: [
    sameOrigin,
    jsonBodyLimit,
    authRateLimit,
    requireAuth,
    requirePlatform(),
    blockMutationsWhileImpersonating,
  ],
  // `requirePlatform()` da cadeia já deixou passar só quem é da plataforma.
  canRead: createMiddleware((_c, next) => next()),
  canManage: requirePlatform(["platform_owner"]),
  limitPrefix: "admin-",
  // O escopo é fixo: nada da requisição escolhe o tenant.
  scopeOf: () => ({ kind: "platform" }),
  actorOf: (c) => ({
    type: "platform",
    userId: (c as Context<AuthEnv>).get("user").id,
    ip: clientKey(c),
  }),
});
