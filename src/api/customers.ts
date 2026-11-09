import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
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
import {
  requirePermission,
  requireTenant,
  type TenantEnv,
  teamActor,
} from "@/api/permissions";
import { rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { addCustomerTag, removeCustomerTag } from "@/lib/crm/tags";
import {
  customerSchema,
  customersQuerySchema,
  updateCustomerSchema,
} from "@/lib/schemas/customer";
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  inviteCustomer,
  listCustomers,
  updateCustomer,
} from "@/lib/tenant/customers";

export const customerRoutes = new Hono<TenantEnv>();

/** Id malformado é só algo que não existe (como `validId`). */
const validCustomerTag = zValidator(
  "param",
  z.object({ id: z.uuid(), tagId: z.uuid() }),
  (result, c) => {
    if (!result.success) return c.json({ error: "Não encontrado." }, 404);
  },
);

customerRoutes.onError(handleTenantError);
customerRoutes.use(
  "/api/customers/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
);

/** O convite dispara e-mail: o limite segura quem usaria o app para enviar spam. */
const inviteRateLimit = rateLimit({
  name: "customer-invite",
  limit: 20,
  windowMs: 10 * MINUTE,
});

customerRoutes.get(
  "/api/customers",
  requirePermission("customer", "read"),
  zValidator("query", customersQuerySchema, validationError),
  async (c) =>
    c.json(await listCustomers(c.get("tenant").id, c.req.valid("query"))),
);

customerRoutes.post(
  "/api/customers",
  requirePermission("customer", "create"),
  zValidator("json", customerSchema, validationError),
  async (c) => {
    const customer = await createCustomer(
      c.get("tenant").id,
      c.req.valid("json"),
      { ...teamActor(c), canRead: c.get("permissions").includes("customer:read") },
    );

    return c.json({ customer }, 201);
  },
);

customerRoutes.get(
  "/api/customers/:id",
  requirePermission("customer", "read"),
  validId,
  async (c) =>
    c.json({
      customer: await getCustomer(c.get("tenant").id, c.req.valid("param").id),
    }),
);

customerRoutes.patch(
  "/api/customers/:id",
  requirePermission("customer", "update"),
  validId,
  zValidator("json", updateCustomerSchema, validationError),
  async (c) => {
    const customer = await updateCustomer(
      c.get("tenant").id,
      c.req.valid("param").id,
      c.req.valid("json"),
      { ...teamActor(c), canRead: c.get("permissions").includes("customer:read") },
    );

    return c.json({ customer });
  },
);

/** Aplicar e tirar etiqueta é editar o cliente: `customer:update`. Idempotentes. */
customerRoutes.put(
  "/api/customers/:id/tags/:tagId",
  requirePermission("customer", "update"),
  validCustomerTag,
  async (c) => {
    const { id, tagId } = c.req.valid("param");
    await addCustomerTag(c.get("tenant").id, id, tagId);

    return c.json({ ok: true });
  },
);

customerRoutes.delete(
  "/api/customers/:id/tags/:tagId",
  requirePermission("customer", "update"),
  validCustomerTag,
  async (c) => {
    const { id, tagId } = c.req.valid("param");
    await removeCustomerTag(c.get("tenant").id, id, tagId);

    return c.json({ ok: true });
  },
);

customerRoutes.delete(
  "/api/customers/:id",
  requirePermission("customer", "delete"),
  validId,
  async (c) => {
    await deleteCustomer(
      c.get("tenant").id,
      c.req.valid("param").id,
      teamActor(c),
    );

    return c.json({ ok: true });
  },
);

customerRoutes.post(
  "/api/customers/:id/invite",
  requirePermission("customer", "invite"),
  inviteRateLimit,
  validId,
  async (c) => {
    await inviteCustomer(
      c.get("tenant"),
      c.req.valid("param").id,
      teamActor(c),
    );

    return c.json({ ok: true });
  },
);
