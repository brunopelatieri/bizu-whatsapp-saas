import { and, count, desc, eq, ilike, ne, or, type SQL, sql } from "drizzle-orm";
import { type Tx, withTenant } from "@/db/rls";
import { customer } from "@/db/schema";
import { isUniqueViolation, violatedConstraint } from "@/db/errors";
import { escapeLike } from "@/lib/admin/tenants";
import { auditInTransaction } from "@/lib/audit";
import { getPortalAuth } from "@/lib/auth/portal";
import type { PortalLinkContext } from "@/lib/auth/portal-emails";
import { assertWithinLimit } from "@/lib/billing/limits";
import {
  dropOrphanPortalUser,
  ensurePortalUser,
  leavePortalTenant,
} from "@/lib/portal/access";
import {
  CUSTOMER_PAGE_SIZE,
  type CustomerInput,
  type CustomersQuery,
  type UpdateCustomerInput,
} from "@/lib/schemas/customer";
import {
  assertRequiredFilled,
  customFieldsMergeSql,
  resolveCustomFields,
  valuesOf,
} from "@/lib/crm/custom-fields";
import { replaceCustomerTags, tagsOfCustomers, type CustomerTagView } from "@/lib/crm/tags";
import { type CustomFieldValues, mergeCustomFields } from "@/lib/crm/values";
import { phoneErrorMessage } from "@/lib/phone/br";
import { InvalidPhoneError, phoneValues } from "@/lib/phone/columns";
import { notFound, phoneInUse, TenantRuleError } from "@/lib/tenant/errors";

/** Quem age e de onde, para a auditoria. */
export type CustomerActor = {
  userId: string;
  ip?: string;
  /** Só quem lê clientes vê o nome do dono do telefone repetido (`PHONE_IN_USE`). */
  canRead?: boolean;
};

type CustomerRow = typeof customer.$inferSelect;

const NOT_FOUND = "Cliente não encontrado.";
const EMAIL_TAKEN = new TenantRuleError(
  409,
  "CUSTOMER_EMAIL_TAKEN",
  "Já existe um cliente com este e-mail.",
);

const PHONE_INDEX = "customer_tenant_phone_key_idx";

/** Colunas de telefone calculadas no servidor; número recusado vira 400 `INVALID_PHONE`. */
function phoneOf(raw: string) {
  try {
    return phoneValues(raw);
  } catch (error) {
    if (error instanceof InvalidPhoneError) {
      throw new TenantRuleError(400, "INVALID_PHONE", phoneErrorMessage(error.reason), {
        reason: error.reason,
      });
    }
    throw error;
  }
}

/** O mesmo número (ou a variante sem o 9º dígito) em outro cliente do tenant: 409. */
async function assertPhoneFree(
  tx: Tx,
  tenantId: string,
  phoneKey: string,
  actor: CustomerActor,
  exceptId?: string,
) {
  const [other] = await tx
    .select({ id: customer.id, name: customer.name })
    .from(customer)
    .where(
      and(
        eq(customer.tenantId, tenantId),
        eq(customer.phoneKey, phoneKey),
        exceptId ? ne(customer.id, exceptId) : undefined,
      ),
    );

  if (other) {
    throw phoneInUse({
      customerId: other.id,
      ...(actor.canRead ? { name: other.name } : {}),
    });
  }
}

/** O índice único é a rede de segurança da corrida: o 23505 vira o mesmo 409, sem detalhes. */
function translateUnique(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw violatedConstraint(error) === PHONE_INDEX ? phoneInUse() : EMAIL_TAKEN;
  }
  throw error;
}

/** `emailVerified` e os demais dados de `portal_user` são globais e não saem daqui. */
function toCustomer({
  portalUserId,
  tenantId: _tenantId,
  phoneKey: _phoneKey,
  ...row
}: CustomerRow, tags: CustomerTagView[] = []) {
  return { ...row, tags, hasPortalAccess: portalUserId !== null };
}

function byId(tenantId: string, customerId: string) {
  return and(eq(customer.id, customerId), eq(customer.tenantId, tenantId));
}

export function listCustomers(tenantId: string, query: CustomersQuery) {
  const term = query.q ? `%${escapeLike(query.q)}%` : null;
  const filters: (SQL | undefined)[] = [eq(customer.tenantId, tenantId)];

  if (query.status) filters.push(eq(customer.status, query.status));
  if (term) {
    filters.push(
      or(
        ilike(customer.name, term),
        ilike(customer.email, term),
        ilike(customer.phone, term),
        ilike(customer.document, term),
      ),
    );
  }

  // Qualquer uma das etiquetas pedidas (as do filtro são do tenant por causa do RLS).
  if (query.tags && query.tags.length > 0) {
    const ids = sql.join(query.tags.map((id) => sql`${id}`), sql`, `);
    filters.push(
      sql`exists (select 1 from customer_tag where customer_tag.customer_id = "customer"."id" and customer_tag.tag_id in (${ids}))`,
    );
  }

  const where = and(...filters);

  return withTenant(tenantId, async (tx) => {
    const [total] = await tx.select({ total: count() }).from(customer).where(where);
    const rows = await tx
      .select()
      .from(customer)
      .where(where)
      .orderBy(desc(customer.createdAt), desc(customer.id))
      .limit(CUSTOMER_PAGE_SIZE)
      .offset((query.page - 1) * CUSTOMER_PAGE_SIZE);

    const tags = await tagsOfCustomers(tx, rows.map(({ id }) => id));

    return {
      items: rows.map((row) => toCustomer(row, tags.get(row.id))),
      total: total?.total ?? 0,
      pageSize: CUSTOMER_PAGE_SIZE,
    };
  });
}

export async function getCustomer(tenantId: string, customerId: string) {
  const found = await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(customer).where(byId(tenantId, customerId));
    if (!row) return null;

    return { row, tags: await tagsOfCustomers(tx, [row.id]) };
  });

  if (!found) throw notFound(NOT_FOUND);

  return toCustomer(found.row, found.tags.get(found.row.id));
}

export async function createCustomer(
  tenantId: string,
  input: CustomerInput,
  actor: CustomerActor,
) {
  await assertWithinLimit(tenantId, "customers");
  const phone = phoneOf(input.phone);

  try {
    return await withTenant(tenantId, async (tx) => {
      await assertPhoneFree(tx, tenantId, phone.phoneKey, actor);

      const { tagIds, customFields, ...fields } = input;
      // `required` só vale quando o corpo traz `customFields`.
      let values: CustomFieldValues = {};
      if (customFields) {
        const resolved = await resolveCustomFields(tx, tenantId, customFields);
        values = valuesOf(resolved.patch);
        assertRequiredFilled(resolved.defs, values);
      }

      const [created] = await tx
        .insert(customer)
        .values({ ...fields, ...phone, tenantId, customFields: values })
        .returning();
      if (!created) throw new Error("cliente não criado");

      if (tagIds) await replaceCustomerTags(tx, tenantId, created.id, tagIds);

      await auditInTransaction(tx, "customer.created", {
        actor: { id: actor.userId },
        tenantId,
        target: { type: "customer", id: created.id },
        metadata: { status: created.status },
        ip: actor.ip,
      });

      return toCustomer(
        created,
        (await tagsOfCustomers(tx, [created.id])).get(created.id),
      );
    });
  } catch (error) {
    return translateUnique(error);
  }
}

/**
 * Trocar o e-mail desfaz o vínculo com o portal: o endereço antigo perde o acesso, e o novo
 * só entra depois de um convite. Sair de `active` corta o acesso na hora.
 */
export async function updateCustomer(
  tenantId: string,
  customerId: string,
  patch: UpdateCustomerInput,
  actor: CustomerActor,
) {
  let unlinkedUserId: string | null = null;
  const phone = patch.phone === undefined ? null : phoneOf(patch.phone);

  try {
    const updated = await withTenant(tenantId, async (tx) => {
      // Antes de travar a linha do cliente: a exclusão do campo trava o campo e depois os clientes.
      const resolved = patch.customFields
        ? await resolveCustomFields(tx, tenantId, patch.customFields)
        : null;

      const [current] = await tx
        .select()
        .from(customer)
        .where(byId(tenantId, customerId))
        .for("update");
      if (!current) throw notFound(NOT_FOUND);

      // O `PATCH` pode omitir o telefone, mas o estado final não pode ficar sem ele.
      if (!phone && !current.phoneKey) {
        throw new TenantRuleError(400, "PHONE_REQUIRED", "Informe o telefone do cliente.");
      }
      if (phone && phone.phoneKey !== current.phoneKey) {
        await assertPhoneFree(tx, tenantId, phone.phoneKey, actor, customerId);
      }

      const emailChanged =
        patch.email !== undefined && patch.email !== current.email;
      const fallbackStatus =
        current.status === "blocked" ? ("blocked" as const) : ("lead" as const);
      const status =
        patch.status ?? (emailChanged ? fallbackStatus : current.status);

      const { tagIds, customFields: _customFields, ...fields } = patch;
      // Merge por chave no mesmo `UPDATE`: `null` remove, ausente não muda. `required` vale
      // sobre o estado final, e só quando o corpo trouxe `customFields`.
      let customFieldsSet = {};
      if (resolved) {
        const merged = mergeCustomFields(
          current.customFields as CustomFieldValues,
          resolved.patch,
        );
        assertRequiredFilled(resolved.defs, merged);
        customFieldsSet = { customFields: customFieldsMergeSql(resolved.patch) };
      }

      const [row] = await tx
        .update(customer)
        .set({
          ...fields,
          ...(phone ?? {}),
          ...customFieldsSet,
          status,
          ...(emailChanged
            ? { portalUserId: null, invitedAt: null, lastLoginAt: null }
            : {}),
        })
        .where(byId(tenantId, customerId))
        .returning();
      if (!row) throw notFound(NOT_FOUND);

      if (tagIds) await replaceCustomerTags(tx, tenantId, customerId, tagIds);

      if (current.portalUserId && (emailChanged || status !== "active")) {
        await leavePortalTenant(tx, current.portalUserId, tenantId);
      }
      if (emailChanged) unlinkedUserId = current.portalUserId;

      await auditInTransaction(tx, "customer.updated", {
        actor: { id: actor.userId },
        tenantId,
        target: { type: "customer", id: customerId },
        metadata: { status, emailChanged },
        ip: actor.ip,
      });

      return toCustomer(row, (await tagsOfCustomers(tx, [row.id])).get(row.id));
    });

    if (unlinkedUserId) await dropOrphanPortalUser(unlinkedUserId);

    return updated;
  } catch (error) {
    return translateUnique(error);
  }
}

export async function deleteCustomer(
  tenantId: string,
  customerId: string,
  actor: CustomerActor,
) {
  const portalUserId = await withTenant(tenantId, async (tx) => {
    const [removed] = await tx
      .delete(customer)
      .where(byId(tenantId, customerId))
      .returning({ portalUserId: customer.portalUserId });
    if (!removed) throw notFound(NOT_FOUND);

    if (removed.portalUserId) {
      await leavePortalTenant(tx, removed.portalUserId, tenantId);
    }

    await auditInTransaction(tx, "customer.deleted", {
      actor: { id: actor.userId },
      tenantId,
      target: { type: "customer", id: customerId },
      ip: actor.ip,
    });

    return removed.portalUserId;
  });

  if (portalUserId) await dropOrphanPortalUser(portalUserId);
}

/**
 * "Enviar acesso": decisão do owner, e por isso `lead` passa a `active`. A posse do e-mail
 * só é provada no clique: até lá, `portal_user` fica sem senha e sem verificação. Quem já
 * tem conta em outro tenant recebe o mesmo convite, e a resposta não muda: este tenant não
 * fica sabendo. Cliente bloqueado é desbloqueado de propósito, por `status`.
 */
export async function inviteCustomer(
  tenant: { id: string; slug: string; name: string },
  customerId: string,
  actor: CustomerActor,
) {
  const [current] = await withTenant(tenant.id, (tx) =>
    tx.select().from(customer).where(byId(tenant.id, customerId)),
  );

  if (!current) throw notFound(NOT_FOUND);

  // Só tem conta acessível quem tem e-mail: sem ele não há convite, magic link nem login.
  if (!current.email) {
    throw new TenantRuleError(
      409,
      "EMAIL_REQUIRED",
      "Cadastre um e-mail para liberar o acesso do cliente.",
    );
  }
  if (!current.phone) {
    throw new TenantRuleError(409, "PHONE_REQUIRED", "Informe o telefone do cliente.");
  }
  if (current.status === "blocked") {
    throw new TenantRuleError(
      409,
      "CUSTOMER_BLOCKED",
      "Desbloqueie o cliente antes de enviar o acesso.",
    );
  }

  const portalUserId =
    current.portalUserId ??
    (await ensurePortalUser(current.email, current.name, current.phone));

  await withTenant(tenant.id, async (tx) => {
    await tx
      .update(customer)
      .set({ portalUserId, status: "active", invitedAt: new Date() })
      .where(byId(tenant.id, customerId));
    await auditInTransaction(tx, "customer.invited", {
      actor: { id: actor.userId },
      tenantId: tenant.id,
      target: { type: "customer", id: customerId },
      ip: actor.ip,
    });
  });

  await getPortalAuth().api.signInMagicLink({
    headers: new Headers(),
    body: {
      email: current.email,
      metadata: {
        kind: "invite",
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        customerName: current.name,
      } satisfies PortalLinkContext,
    },
  });
}
