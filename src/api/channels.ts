import { zValidator } from "@hono/zod-validator";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type AuthEnv, requireAuth } from "@/api/auth";
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
import type { Scope } from "@/db/rls";
import {
  type ChannelRouteKit,
  getModules,
  isProviderEnabled,
  missingProviderEnv,
} from "@/lib/channels/registry";
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

/**
 * Rotas de canal (`docs/specs/whatsapp-canais/spec.md`), escritas **uma vez** e montadas para os
 * dois escopos: `/api/channels` (tenant, abaixo) e `/api/admin/channels` (plataforma,
 * `src/api/admin-channels.ts`). Quem monta entrega a cadeia de guardas, a autorização, o escopo e
 * o ator; nada aqui lê o escopo da requisição. A resposta nunca traz coluna `_enc`: o serviço
 * devolve `ChannelView`.
 */
export type ChannelRoutesOptions = {
  /** `/api/channels` ou `/api/admin/channels`. */
  base: string;
  /** Guardas de todo o grupo, na ordem (`sameOrigin` … autenticação … personificação). */
  guards: [MiddlewareHandler, ...MiddlewareHandler[]];
  canRead: MiddlewareHandler;
  canManage: MiddlewareHandler;
  /** Separa os contadores de rate limit de cada base (`name` é único no store compartilhado). */
  limitPrefix: string;
  scopeOf(c: Context): Scope;
  actorOf(c: Context): ChannelActor;
  /** Só a plataforma: `providers` diz também quais variáveis faltam (nomes, nunca valores). */
  describeSetup?: boolean;
};

const userKey = (c: Context) => (c as Context<AuthEnv>).get("user").id;

/** Quais módulos este servidor oferece; fora de `CHANNEL_PROVIDERS`, o tipo some da tela. */
export function providersState(describeSetup = false) {
  return Object.fromEntries(
    channelTypes.map((type) => [
      type,
      {
        enabled: isProviderEnabled(type),
        ...(describeSetup ? { missing: missingProviderEnv(type) } : {}),
      },
    ]),
  );
}

export function buildChannelRoutes(options: ChannelRoutesOptions) {
  const { base, canRead, canManage, scopeOf, actorOf } = options;
  const routes = new Hono<AuthEnv>();
  const limit = (name: string, perMinute: number) =>
    rateLimit({
      name: `${options.limitPrefix}${name}`,
      limit: perMinute,
      windowMs: MINUTE,
      key: userKey,
    });
  /** Demais ações: 30 por minuto, por usuário (criar instância e QR têm limites próprios). */
  const writeLimit = limit("channel-write", 30);

  routes.onError(handleTenantError);
  routes.use(`${base}/*`, ...options.guards);

  routes.get(base, canRead, async (c) => {
    const scope = scopeOf(c);

    return c.json({
      channels: await listChannels(scope),
      providers: providersState(options.describeSetup),
      limits: await channelLimits(scope),
    });
  });

  routes.patch(
    `${base}/:id`,
    canManage,
    writeLimit,
    validId,
    zValidator("json", updateChannelSchema, validationError),
    async (c) => {
      await updateChannel(scopeOf(c), c.req.valid("param").id, c.req.valid("json"), actorOf(c));

      return c.json({ ok: true });
    },
  );

  routes.post(`${base}/:id/default`, canManage, writeLimit, validId, async (c) => {
    await setDefaultChannel(scopeOf(c), c.req.valid("param").id, actorOf(c));

    return c.json({ ok: true });
  });

  routes.delete(
    `${base}/:id`,
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
   * `ChannelModule.routes` e recebe daqui o escopo e a autorização. As pastas são montadas
   * todas; cada rota confere se o módulo está ativo (`CHANNEL_PROVIDERS`).
   */
  const kit: ChannelRouteKit = { base, canRead, canManage, writeLimit, limit, validId, scopeOf, actorOf };

  for (const module of getModules()) {
    if (module.routes) routes.route("/", module.routes(kit));
  }

  return routes;
}

/**
 * `/api/channels/*`: números de WhatsApp do tenant. Ler pede `channel:read`; mudar,
 * `channel:manage`. O tenant vem sempre da sessão.
 */
export const channelRoutes = buildChannelRoutes({
  base: "/api/channels",
  guards: [
    sameOrigin,
    jsonBodyLimit,
    authRateLimit,
    requireAuth,
    requireTenant,
    blockMutationsWhileImpersonating,
  ],
  canRead: requirePermission("channel", "read"),
  canManage: requirePermission("channel", "manage"),
  limitPrefix: "",
  scopeOf: (c) => ({ kind: "tenant", tenantId: (c as Context<TenantEnv>).get("tenant").id }),
  actorOf: (c) => ({ userId: userKey(c), ip: clientKey(c) }),
});
