import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimit,
  sameOrigin,
  validationError,
  validId,
} from "@/api/guards";
import { blockMutationsWhileImpersonating } from "@/api/impersonation";
import { requirePermission, requireTenant, type TenantEnv } from "@/api/permissions";
import { clientKey } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { createTag, deleteTag, listTags, updateTag } from "@/lib/crm/tags";
import { tagSchema, updateTagSchema } from "@/lib/schemas/crm";
import type { Context } from "hono";

/**
 * `/api/tags`: etiquetas do tenant (`docs/specs/crm-cadastro/spec.md`). Ler pede
 * `customer:read` (quem filtra e aplica etiqueta precisa vê-las); criar, renomear e apagar,
 * `tag:manage`. O tenant vem sempre da sessão.
 */
export const tagRoutes = new Hono<TenantEnv>();

tagRoutes.onError(handleTenantError);
tagRoutes.use(
  "/api/tags/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
  blockMutationsWhileImpersonating,
);

const canRead = requirePermission("customer", "read");
const canManage = requirePermission("tag", "manage");

const scopeOf = (c: Context<TenantEnv>) => ({
  kind: "tenant" as const,
  tenantId: c.get("tenant").id,
});

const actorOf = (c: Context<TenantEnv>) => ({ userId: c.get("user").id, ip: clientKey(c) });

tagRoutes.get("/api/tags", canRead, async (c) =>
  c.json({ tags: await listTags(scopeOf(c)) }),
);

tagRoutes.post(
  "/api/tags",
  canManage,
  zValidator("json", tagSchema, validationError),
  async (c) => {
    const tag = await createTag(scopeOf(c), c.req.valid("json"), actorOf(c));
    return c.json({ tag }, 201);
  },
);

tagRoutes.patch(
  "/api/tags/:id",
  canManage,
  validId,
  zValidator("json", updateTagSchema, validationError),
  async (c) => {
    const tag = await updateTag(
      scopeOf(c),
      c.req.valid("param").id,
      c.req.valid("json"),
      actorOf(c),
    );
    return c.json({ tag });
  },
);

tagRoutes.delete("/api/tags/:id", canManage, validId, async (c) => {
  const { removedFrom } = await deleteTag(scopeOf(c), c.req.valid("param").id, actorOf(c));
  return c.json({ ok: true, removedFrom });
});
