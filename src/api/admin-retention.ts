import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthEnv, requireAuth, requirePlatform } from "@/api/auth";
import { authRateLimit, jsonBodyLimit, sameOrigin, validationError } from "@/api/guards";
import { blockWhileImpersonating } from "@/api/impersonation";
import { clientKey } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { channelTypes } from "@/lib/channels/types";
import {
  getRetentionView,
  retentionTenantExists,
  runRetention,
  saveRetentionPolicy,
} from "@/lib/inbox/retention";
import { retentionChannelTypeSchema, retentionPolicySchema } from "@/lib/schemas/retention";
import { notFound } from "@/lib/tenant/errors";

/**
 * `/api/admin/retention/*`: retenção de mensagens por organização e tipo de canal (bloco R, R2).
 * A tela do `/admin` (R3b) consome estas rotas.
 *
 * - leitura (política efetiva, `sources`, última execução, prévia): toda a equipe da plataforma;
 * - escrita (a linha de `retention_policy`): só `platform_owner`, bloqueada na personificação,
 *   auditada sem `tenant_id` e só com números;
 * - a prévia **não apaga nem grava** nada (`dryRun`) e funciona com a retenção desligada; quem apaga
 *   é só o job `inbox.retention`.
 *
 * Traz a própria cadeia de guardas e é montado **antes** de `adminRoutes` em `app.ts`, como
 * `admin-channel-events.ts`: a cadeia de `/api/admin/*` não roda duas vezes.
 */
export const adminRetentionRoutes = new Hono<AuthEnv>();

adminRetentionRoutes.onError(handleTenantError);
adminRetentionRoutes.use(
  "/api/admin/retention/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requirePlatform(),
);

const notFoundHook = (result: { success: boolean }, c: Parameters<typeof validationError>[1]) => {
  if (!result.success) return c.json({ error: "Não encontrado." }, 404);
};

const tenantParams = zValidator("param", z.object({ id: z.uuid() }), notFoundHook);
const tenantTypeParams = zValidator(
  "param",
  z.object({ id: z.uuid(), channelType: retentionChannelTypeSchema }),
  notFoundHook,
);
const platformTypeParams = zValidator(
  "param",
  z.object({ channelType: retentionChannelTypeSchema }),
  notFoundHook,
);

async function assertTenant(id: string) {
  if (!(await retentionTenantExists(id))) throw notFound("Organização não encontrada.");
}

/** As duas visões (uma por tipo de canal) de um escopo. */
const viewsOf = (tenantId: string | null) =>
  Promise.all(channelTypes.map((channelType) => getRetentionView({ tenantId, channelType })));

adminRetentionRoutes.get("/api/admin/retention/platform", async (c) =>
  c.json({ scopes: await viewsOf(null) }),
);

adminRetentionRoutes.get(
  "/api/admin/retention/platform/:channelType/preview",
  platformTypeParams,
  async (c) => {
    const { channelType } = c.req.valid("param");
    const { result } = await runRetention({ tenantId: null, channelType }, { dryRun: true });
    return c.json({ preview: result });
  },
);

adminRetentionRoutes.get("/api/admin/retention/tenants/:id", tenantParams, async (c) => {
  const { id } = c.req.valid("param");
  await assertTenant(id);
  return c.json({ scopes: await viewsOf(id) });
});

adminRetentionRoutes.get(
  "/api/admin/retention/tenants/:id/:channelType/preview",
  tenantTypeParams,
  async (c) => {
    const { id, channelType } = c.req.valid("param");
    await assertTenant(id);
    const { result } = await runRetention({ tenantId: id, channelType }, { dryRun: true });
    return c.json({ preview: result });
  },
);

adminRetentionRoutes.put(
  "/api/admin/retention/tenants/:id/:channelType",
  requirePlatform(["platform_owner"]),
  blockWhileImpersonating,
  tenantTypeParams,
  zValidator("json", retentionPolicySchema, validationError),
  async (c) => {
    const { id, channelType } = c.req.valid("param");
    await assertTenant(id);

    await saveRetentionPolicy(id, channelType, c.req.valid("json"), {
      userId: c.get("user").id,
      ip: clientKey(c),
    });

    return c.json({ scope: await getRetentionView({ tenantId: id, channelType }) });
  },
);
