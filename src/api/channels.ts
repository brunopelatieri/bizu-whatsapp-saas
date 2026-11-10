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
import { type ChannelRouteKit, getModules, isProviderEnabled } from "@/lib/channels/registry";
import {
  type ChannelActor,
  channelLimits,
  listChannels,
  removeChannel,
  setDefaultChannel,
  updateChannel,
} from "@/lib/channels/service";
import { channelTypes } from "@/lib/channels/types";
import { deleteChannelSchema, updateChannelSchema } from "@/lib/schemas/channels";
import {
  createPairingChannel,
  getPairingStatus,
  requestPairingCode,
  requestPairingQr,
  runPairingAction,
  updatePairingSettings,
} from "@/lib/channels/pairing";
import {
  createQrChannelSchema,
  pairChannelSchema,
  updateQrSettingsSchema,
} from "@/lib/schemas/channels";
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

const userKey = (c: Context) => (c as Context<TenantEnv>).get("user").id;

/** Demais ações: 30 por minuto, por usuário (criar instância e QR têm limites próprios). */
const writeLimit = rateLimit({
  name: "channel-write",
  limit: 30,
  windowMs: MINUTE,
  key: userKey,
});

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
  zValidator("json", updateChannelSchema, validationError),
  async (c) => {
    await updateChannel(scopeOf(c), c.req.valid("param").id, c.req.valid("json"), actorOf(c));

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

/**
 * Rotas de cada tipo (criar, diagnosticar, modelos, QR...): o módulo as declara em
 * `ChannelModule.routes` e este arquivo só entrega o escopo e a autorização. As pastas são
 * montadas todas; cada rota confere se o módulo está ativo (`CHANNEL_PROVIDERS`).
 */
const kit: ChannelRouteKit = {
  base: "/api/channels",
  canRead,
  canManage,
  writeLimit,
  limit: (name, perMinute) =>
    rateLimit({ name, limit: perMinute, windowMs: MINUTE, key: userKey }),
  validId,
  scopeOf: (c) => scopeOf(c as Context<TenantEnv>),
  actorOf: (c) => actorOf(c as Context<TenantEnv>),
};

for (const module of getModules()) {
  if (module.routes) channelRoutes.route("/", module.routes(kit));
}
// ---------------------------------------------------------------------------
// Canal por QR Code (B3): criação, pareamento e ciclo de vida. O módulo é resolvido pela
// capacidade `pairing`; sem ele em `CHANNEL_PROVIDERS`, tudo aqui responde 503.
// ---------------------------------------------------------------------------

const byUser = (c: Context) => (c as Context<TenantEnv>).get("user").id;

/** Limites da SPEC, por usuário: criar instância 10 por minuto, QR 15, consulta de estado 30. */
const createQrLimit = rateLimit({ name: "channel-qr-create", limit: 10, windowMs: MINUTE, key: byUser });
const qrLimit = rateLimit({ name: "channel-qr", limit: 15, windowMs: MINUTE, key: byUser });
const statusLimit = rateLimit({ name: "channel-status", limit: 30, windowMs: MINUTE, key: byUser });
const pairingWriteLimit = rateLimit({
  name: "channel-pairing-write",
  limit: 30,
  windowMs: MINUTE,
  key: byUser,
});

/** QR e código de pareamento dão acesso ao número: nunca em cache de navegador ou proxy. */
const noStore = (c: Context) => c.header("Cache-Control", "no-store");

channelRoutes.post(
  "/api/channels/whatsapp-qr",
  canManage,
  createQrLimit,
  zValidator("json", createQrChannelSchema, validationError),
  async (c) => {
    const created = await createPairingChannel(
      scopeOf(c),
      "whatsapp_qr",
      c.req.valid("json").name,
      actorOf(c),
    );

    return c.json({ channel: created }, 201);
  },
);

channelRoutes.post("/api/channels/:id/qr", canManage, qrLimit, validId, async (c) => {
  const qr = await requestPairingQr(scopeOf(c), c.req.valid("param").id);

  noStore(c);
  return c.json(
    qr.alreadyConnected
      ? { alreadyConnected: true }
      : { qrcode: qr.qrcode, code: qr.code, expiresInSeconds: qr.expiresInSeconds },
  );
});

channelRoutes.post(
  "/api/channels/:id/pair",
  canManage,
  qrLimit,
  validId,
  zValidator("json", pairChannelSchema, validationError),
  async (c) => {
    const result = await requestPairingCode(
      scopeOf(c),
      c.req.valid("param").id,
      c.req.valid("json").phone,
    );

    noStore(c);
    return c.json({ pairingCode: result.pairingCode });
  },
);

channelRoutes.get("/api/channels/:id/status", canRead, statusLimit, validId, async (c) => {
  noStore(c);
  return c.json(await getPairingStatus(scopeOf(c), c.req.valid("param").id));
});

for (const action of ["disconnect", "logout", "reconnect"] as const) {
  channelRoutes.post(
    `/api/channels/:id/${action}`,
    canManage,
    pairingWriteLimit,
    validId,
    async (c) =>
      c.json({
        channel: await runPairingAction(scopeOf(c), c.req.valid("param").id, action, actorOf(c)),
      }),
  );
}

/**
 * Ajustes avançados da instância. Rota própria (e não o `PATCH /api/channels/:id` da SPEC) para
 * não disputar o handler de renomear com os campos da Cloud API; o contrato do corpo é o mesmo.
 */
channelRoutes.patch(
  "/api/channels/:id/advanced-settings",
  canManage,
  pairingWriteLimit,
  validId,
  zValidator("json", updateQrSettingsSchema, validationError),
  async (c) =>
    c.json({
      channel: await updatePairingSettings(
        scopeOf(c),
        c.req.valid("param").id,
        c.req.valid("json").advancedSettings,
        actorOf(c),
      ),
    }),
);
