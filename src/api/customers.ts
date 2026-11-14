import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import { blockWhileImpersonating } from "@/api/impersonation";
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
import { phoneChangeSchema } from "@/lib/schemas/phone";
import { unlinkTeamCustomer } from "@/lib/tenant/team-customer-removal";
import {
  cancelCustomerPhoneChangeByTeam,
  createCustomer,
  deleteCustomer,
  getCustomer,
  inviteCustomer,
  listCustomers,
  requestCustomerPhoneChange,
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

/** Pedidos de troca de número por hora, por ficha (o job também limita os links por ficha). */
const phoneChangeRateLimit = rateLimit({
  name: "customer-phone-change",
  limit: 5,
  windowMs: 60 * MINUTE,
  key: (c) => c.req.param("id") ?? "",
});

/**
 * Troca do número da ficha (bloco T, P1): a ficha mantém o número antigo até o link do número novo
 * ser confirmado na sessão do portal dela, ou o owner liberar. Número de outro cliente: 409, como no
 * cadastro. Pedir de novo o mesmo número reenvia o link.
 */
customerRoutes.post(
  "/api/customers/:id/phone-change",
  requirePermission("customer", "update"),
  validId,
  phoneChangeRateLimit,
  zValidator("json", phoneChangeSchema, validationError),
  async (c) => {
    await requestCustomerPhoneChange(
      c.get("tenant").id,
      c.req.valid("param").id,
      c.req.valid("json").phone,
      { ...teamActor(c), canRead: c.get("permissions").includes("customer:read") },
    );

    return c.json({ ok: true }, 202);
  },
);

/** Desiste da troca aberta. Sem troca aberta, também 204. */
customerRoutes.delete(
  "/api/customers/:id/phone-change",
  requirePermission("customer", "update"),
  validId,
  async (c) => {
    await cancelCustomerPhoneChangeByTeam(c.get("tenant").id, c.req.valid("param").id, teamActor(c));
    return c.body(null, 204);
  },
);

/**
 * Desfaz a ligação da ficha com a pessoa da equipe (D-9/D-11): a ficha e as conversas ficam, e deixam
 * de ser apagadas junto com a pessoa. É assim que a equipe mantém a ficha antes de remover alguém.
 * Sensível (muda o que uma remoção apaga), por isso fora da personificação. Criar a ligação à mão
 * não existe: ela nasce do telefone confirmado.
 */
customerRoutes.delete(
  "/api/customers/:id/team-link",
  requirePermission("customer", "update"),
  blockWhileImpersonating,
  validId,
  async (c) => {
    await unlinkTeamCustomer(c.get("tenant").id, c.req.valid("param").id, teamActor(c));
    return c.body(null, 204);
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
