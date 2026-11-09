import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimit,
  MINUTE,
  sameOrigin,
  validationError,
  validId,
} from "@/api/guards";
import { blockMutationsWhileImpersonating } from "@/api/impersonation";
import { requirePermission, requireTenant, type TenantEnv } from "@/api/permissions";
import { clientKey, rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { isProviderEnabled } from "@/lib/channels/registry";
import {
  type ChannelActor,
  channelLimits,
  listChannels,
  removeChannel,
  renameChannel,
  setDefaultChannel,
} from "@/lib/channels/service";
import { channelTypes } from "@/lib/channels/types";
import { deleteChannelSchema, renameChannelSchema } from "@/lib/schemas/channels";
import type { Context } from "hono";

/**
 * `/api/channels/*`: números de WhatsApp do tenant (`docs/specs/whatsapp-canais/spec.md`).
 * Ler pede `channel:read`; mudar, `channel:manage`. O tenant vem sempre da sessão. A resposta
 * nunca traz coluna `_enc`: o serviço devolve `ChannelView`.
 */
export const channelRoutes = new Hono<TenantEnv>();

channelRoutes.onError(handleTenantError);
channelRoutes.use(
  "/api/channels/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
  blockMutationsWhileImpersonating,
);
const canRead = requirePermission("channel", "read");
const canManage = requirePermission("channel", "manage");

/** Demais ações: 30 por minuto, por usuário (criar instância e QR têm limites próprios). */
const writeLimit = rateLimit({ name: "channel-write", limit: 30, windowMs: MINUTE });

const scopeOf = (c: Context<TenantEnv>) => ({
  kind: "tenant" as const,
  tenantId: c.get("tenant").id,
});

const actorOf = (c: Context<TenantEnv>): ChannelActor => ({
  userId: c.get("user").id,
  ip: clientKey(c),
});

/** Quais módulos este servidor oferece; sem `EVOLUTION_API_URL`, o QR some da tela. */
export function providersState() {
  return Object.fromEntries(
    channelTypes.map((type) => [type, { enabled: isProviderEnabled(type) }]),
  );
}

channelRoutes.get("/api/channels", canRead, async (c) => {
  const scope = scopeOf(c);

  return c.json({
    channels: await listChannels(scope),
    providers: providersState(),
    limits: await channelLimits(scope),
  });
});

channelRoutes.patch(
  "/api/channels/:id",
  canManage,
  writeLimit,
  validId,
  zValidator("json", renameChannelSchema, validationError),
  async (c) => {
    await renameChannel(scopeOf(c), c.req.valid("param").id, c.req.valid("json").name, actorOf(c));

    return c.json({ ok: true });
  },
);

channelRoutes.post("/api/channels/:id/default", canManage, writeLimit, validId, async (c) => {
  await setDefaultChannel(scopeOf(c), c.req.valid("param").id, actorOf(c));

  return c.json({ ok: true });
});

channelRoutes.delete(
  "/api/channels/:id",
  canManage,
  writeLimit,
  validId,
  zValidator("json", deleteChannelSchema, validationError),
  async (c) => {
    const result = await removeChannel(
      scopeOf(c),
      c.req.valid("param").id,
      c.req.valid("json").confirm,
      actorOf(c),
    );

    return c.json(result);
  },
);
