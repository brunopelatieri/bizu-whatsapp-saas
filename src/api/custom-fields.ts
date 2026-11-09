import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
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
import {
  createCustomField,
  deleteCustomField,
  listCustomFields,
  reorderCustomFields,
  updateCustomField,
} from "@/lib/crm/custom-fields";
import {
  customFieldOrderSchema,
  customFieldSchema,
  customFieldsQuerySchema,
  deleteCustomFieldSchema,
  updateCustomFieldSchema,
} from "@/lib/schemas/crm";

/**
 * `/api/custom-fields`: campos adicionais do cliente (`docs/specs/crm-cadastro/spec.md`). Ler
 * pede `customer:read` (o formulário precisa das definições); criar, editar, ordenar,
 * arquivar e excluir, `custom_field:manage`. O tenant vem sempre da sessão. Preencher o valor
 * é `customer:update`, em `/api/customers`.
 */
export const customFieldRoutes = new Hono<TenantEnv>();

customFieldRoutes.onError(handleTenantError);
customFieldRoutes.use(
  "/api/custom-fields/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
  blockMutationsWhileImpersonating,
);

const canRead = requirePermission("customer", "read");
const canManage = requirePermission("custom_field", "manage");

const scopeOf = (c: Context<TenantEnv>) => ({
  kind: "tenant" as const,
  tenantId: c.get("tenant").id,
});

const actorOf = (c: Context<TenantEnv>) => ({ userId: c.get("user").id, ip: clientKey(c) });

customFieldRoutes.get(
  "/api/custom-fields",
  canRead,
  zValidator("query", customFieldsQuerySchema, validationError),
  async (c) => {
    const { entity, archived, usage } = c.req.valid("query");

    return c.json({
      fields: await listCustomFields(scopeOf(c), { entity, archived, usage: usage === "true" }),
    });
  },
);

customFieldRoutes.post(
  "/api/custom-fields",
  canManage,
  zValidator("json", customFieldSchema, validationError),
  async (c) => {
    const field = await createCustomField(scopeOf(c), c.req.valid("json"), actorOf(c));
    return c.json({ field }, 201);
  },
);

// Antes de `/:id`, para `order` nunca ser lido como id.
customFieldRoutes.put(
  "/api/custom-fields/order",
  canManage,
  zValidator("json", customFieldOrderSchema, validationError),
  async (c) => {
    const { entity, ids } = c.req.valid("json");

    await reorderCustomFields(scopeOf(c), entity, ids);
    return c.json({ ok: true });
  },
);

customFieldRoutes.patch(
  "/api/custom-fields/:id",
  canManage,
  validId,
  zValidator("json", updateCustomFieldSchema, validationError),
  async (c) => {
    const field = await updateCustomField(
      scopeOf(c),
      c.req.valid("param").id,
      c.req.valid("json"),
      actorOf(c),
    );
    return c.json({ field });
  },
);

customFieldRoutes.delete(
  "/api/custom-fields/:id",
  canManage,
  validId,
  zValidator("json", deleteCustomFieldSchema, validationError),
  async (c) => {
    const { clearedFrom } = await deleteCustomField(
      scopeOf(c),
      c.req.valid("param").id,
      c.req.valid("json").confirm,
      actorOf(c),
    );
    return c.json({ ok: true, clearedFrom });
  },
);
