import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { type AuthEnv, requireAuth, requirePlatform } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimit,
  sameOrigin,
  validationError,
  validId,
} from "@/api/guards";
import { blockWhileImpersonating } from "@/api/impersonation";
import { clientKey } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { audit } from "@/lib/audit";
import { listChannelEvents, reprocessChannelEvent } from "@/lib/channels/events";
import { listChannelEventsQuerySchema } from "@/lib/schemas/channels";

/**
 * Caixa de avisos dos canais (`channel_event`) vista pela plataforma, de todos os escopos.
 * Leitura é de `platform_owner` e `platform_support`; reprocessar é só de `platform_owner`.
 *
 * Traz a própria cadeia de guardas e é montado **antes** de `adminRoutes` em `app.ts`: assim não
 * depende da ordem de montagem para estar protegido, e a cadeia de `/api/admin/*` não roda duas vezes.
 */
export const adminChannelEventRoutes = new Hono<AuthEnv>();

adminChannelEventRoutes.onError(handleTenantError);
adminChannelEventRoutes.use(
  "/api/admin/channel-events/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requirePlatform(),
);

/** `raw` tem dado pessoal (telefone, corpo da mensagem) e nunca sai daqui. */
adminChannelEventRoutes.get(
  "/api/admin/channel-events",
  zValidator("query", listChannelEventsQuerySchema, validationError),
  async (c) => c.json(await listChannelEvents(c.req.valid("query"))),
);

adminChannelEventRoutes.post(
  "/api/admin/channel-events/:id/reprocess",
  requirePlatform(["platform_owner"]),
  blockWhileImpersonating,
  validId,
  async (c) => {
    const { id } = c.req.valid("param");

    await reprocessChannelEvent(id);
    await audit("admin.channel_event_reprocessed", {
      actor: { type: "platform", id: c.get("user").id },
      ip: clientKey(c),
      target: { type: "channel_event", id },
    });

    return c.json({ ok: true });
  },
);
