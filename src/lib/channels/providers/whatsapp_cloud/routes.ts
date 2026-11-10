import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { validationError } from "@/api/guards";
import { blockWhileImpersonating } from "@/api/impersonation";
import {
  createCloudChannel,
  diagnoseCloudChannel,
  rotateWebhook,
  webhookOf,
} from "@/lib/channels/providers/whatsapp_cloud/service";
import {
  listChannelTemplates,
  syncChannelTemplates,
} from "@/lib/channels/providers/whatsapp_cloud/templates";
import { type ChannelRouteKit, isProviderEnabled } from "@/lib/channels/registry";
import { createCloudChannelSchema, listTemplatesQuerySchema } from "@/lib/schemas/channels";

/**
 * Rotas do WhatsApp Cloud, montadas por `buildChannelRoutes` (`src/api/channels.ts`) para o
 * tenant e para a plataforma; quem monta já aplicou `sameOrigin`, a autenticação e
 * `blockMutationsWhileImpersonating`. O escopo vem do `kit`, nunca do corpo. Segredo só entra;
 * nenhuma resposta traz coluna `_enc`.
 */
export function cloudRoutes(kit: ChannelRouteKit) {
  const routes = new Hono();
  const { base, canRead, canManage, writeLimit, validId } = kit;

  /** Módulo fora de `CHANNEL_PROVIDERS`: as rotas dele não existem (depois da permissão). */
  const active = createMiddleware(async (c, next) => {
    if (!isProviderEnabled("whatsapp_cloud")) return c.json({ error: "Não encontrado." }, 404);

    await next();
  });
  // `validId` já recusou o que não é uuid.
  const id = (c: Context) => c.req.param("id") ?? "";
  // Respostas com o token de verificação não ficam em cache nenhum.
  const noStore = { "Cache-Control": "no-store" };

  routes.post(
    `${base}/whatsapp-cloud`,
    canManage,
    active,
    kit.limit("channel-cloud-create", 10),
    zValidator("json", createCloudChannelSchema, validationError),
    async (c) =>
      c.json(
        await createCloudChannel(kit.scopeOf(c), c.req.valid("json"), kit.actorOf(c)),
        201,
        noStore,
      ),
  );

  // Lê uma credencial (o token de verificação): o suporte personificando não a vê.
  routes.get(`${base}/:id/webhook`, canManage, blockWhileImpersonating, active, validId, async (c) =>
    c.json(await webhookOf(kit.scopeOf(c), id(c)), 200, noStore),
  );

  routes.post(`${base}/:id/webhook/rotate`, canManage, active, writeLimit, validId, async (c) =>
    c.json(await rotateWebhook(kit.scopeOf(c), id(c), kit.actorOf(c)), 200, noStore),
  );

  routes.post(`${base}/:id/test`, canManage, active, writeLimit, validId, async (c) =>
    c.json(await diagnoseCloudChannel(kit.scopeOf(c), id(c))),
  );

  routes.get(
    `${base}/:id/templates`,
    canRead,
    active,
    validId,
    zValidator("query", listTemplatesQuerySchema, validationError),
    async (c) =>
      c.json(await listChannelTemplates(kit.scopeOf(c), id(c), c.req.valid("query").status)),
  );

  routes.post(
    `${base}/:id/templates/sync`,
    canManage,
    active,
    kit.limit("channel-cloud-templates-sync", 5),
    validId,
    async (c) => c.json(await syncChannelTemplates(kit.scopeOf(c), id(c))),
  );

  return routes;
}
