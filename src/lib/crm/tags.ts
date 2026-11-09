import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { isUniqueViolation } from "@/db/errors";
import { type Scope, scopeTenantId, type Tx, withScope } from "@/db/rls";
import { customer, customerTag, tag } from "@/db/schema";
import { type AuditAction, auditInTransaction } from "@/lib/audit";
import { CUSTOMER_TAG_LIMIT, DEFAULT_TAG_COLOR, TAG_LIMIT } from "@/lib/crm/constants";
import type { TagInput, UpdateTagInput } from "@/lib/schemas/crm";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Etiquetas dos dois escopos (`Scope`): as rotas de `/api/tags` e `/api/admin/crm/tags` só
 * montam o escopo e a autorização. O banco isola pelo `scopedPolicy()`; o `where` daqui é a
 * segunda camada. Nome e cor de etiqueta nunca vão para `metadata` da auditoria (só ids).
 */

export type TagActor = { userId: string | null; ip?: string };

const NOT_FOUND = "Etiqueta não encontrada.";

const NAME_TAKEN = new TenantRuleError(
  409,
  "TAG_NAME_TAKEN",
  "Já existe uma etiqueta com este nome.",
);

const inScope = (scope: Scope) =>
  scope.kind === "tenant" ? eq(tag.tenantId, scope.tenantId) : isNull(tag.tenantId);

const byId = (scope: Scope, id: string) => and(eq(tag.id, id), inScope(scope));

function auditOf(scope: Scope, action: AuditAction, tagId: string, actor: TagActor, tx: Tx) {
  return auditInTransaction(tx, action, {
    actor: scope.kind === "platform" ? { type: "platform", id: actor.userId } : { id: actor.userId },
    tenantId: scopeTenantId(scope),
    target: { type: "tag", id: tagId },
    ip: actor.ip,
  });
}

export type TagView = { id: string; name: string; color: string; usage: number };

/** Quantos clientes (ou organizações, na plataforma) usam a etiqueta. */
function usageOf(scope: Scope) {
  if (scope.kind === "tenant") {
    return sql<number>`(select count(*)::int from ${customerTag} where ${customerTag.tagId} = ${tag.id})`;
  }
  return sql<number>`0`;
}

export function listTags(scope: Scope): Promise<TagView[]> {
  return withScope(scope, (tx) =>
    tx
      .select({ id: tag.id, name: tag.name, color: tag.color, usage: usageOf(scope) })
      .from(tag)
      .where(inScope(scope))
      .orderBy(asc(sql`lower(${tag.name})`)),
  );
}

export function createTag(scope: Scope, input: TagInput, actor: TagActor) {
  return withScope(scope, async (tx) => {
    // Um por escopo: serializa a conferência do teto e a inserção.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`tag:${scopeTenantId(scope) ?? "platform"}`}))`,
    );

    const [{ total } = { total: 0 }] = await tx
      .select({ total: count() })
      .from(tag)
      .where(inScope(scope));
    if (total >= TAG_LIMIT) {
      throw new TenantRuleError(
        409,
        "TAG_LIMIT",
        `O limite de ${TAG_LIMIT} etiquetas foi atingido.`,
      );
    }

    const [created] = await tx
      .insert(tag)
      .values({
        tenantId: scopeTenantId(scope),
        name: input.name,
        color: input.color ?? DEFAULT_TAG_COLOR,
        createdBy: actor.userId,
      })
      .returning({ id: tag.id, name: tag.name, color: tag.color })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw NAME_TAKEN;
        throw error;
      });
    if (!created) throw new Error("etiqueta não criada");

    await auditOf(scope, "tag.created", created.id, actor, tx);

    return { ...created, usage: 0 };
  });
}

export function updateTag(scope: Scope, id: string, patch: UpdateTagInput, actor: TagActor) {
  return withScope(scope, async (tx) => {
    const [updated] = await tx
      .update(tag)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
      })
      .where(byId(scope, id))
      .returning({ id: tag.id, name: tag.name, color: tag.color })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw NAME_TAKEN;
        throw error;
      });
    if (!updated) throw notFound(NOT_FOUND);

    await auditOf(scope, "tag.updated", updated.id, actor, tx);

    return updated;
  });
}

/** Apaga a etiqueta e, por `cascade`, o vínculo com os clientes. Devolve em quantos estava. */
export function deleteTag(scope: Scope, id: string, actor: TagActor) {
  return withScope(scope, async (tx) => {
    const removedFrom =
      scope.kind === "tenant"
        ? ((
            await tx
              .select({ total: count() })
              .from(customerTag)
              .where(eq(customerTag.tagId, id))
          )[0]?.total ?? 0)
        : 0;

    const [removed] = await tx.delete(tag).where(byId(scope, id)).returning({ id: tag.id });
    if (!removed) throw notFound(NOT_FOUND);

    await auditOf(scope, "tag.deleted", removed.id, actor, tx);

    return { removedFrom };
  });
}

/* ---------- Etiquetas do cliente (só tenant) ---------- */

/** Todas as etiquetas pedidas existem no tenant; senão, 404 (sem dizer qual). */
async function assertTagsOfTenant(tx: Tx, tenantId: string, tagIds: string[]) {
  if (tagIds.length === 0) return;

  const found = await tx
    .select({ id: tag.id })
    .from(tag)
    .where(and(eq(tag.tenantId, tenantId), inArray(tag.id, tagIds)));

  if (found.length !== tagIds.length) throw notFound(NOT_FOUND);
}

/** Substitui o conjunto de etiquetas do cliente, na transação de quem grava o cliente. */
export async function replaceCustomerTags(
  tx: Tx,
  tenantId: string,
  customerId: string,
  tagIds: string[],
) {
  await assertTagsOfTenant(tx, tenantId, tagIds);

  await tx.delete(customerTag).where(eq(customerTag.customerId, customerId));
  if (tagIds.length > 0) {
    await tx
      .insert(customerTag)
      .values(tagIds.map((tagId) => ({ tenantId, customerId, tagId })));
  }
}

/** `PUT /api/customers/:id/tags/:tagId`: idempotente; passa do teto, 409. */
export function addCustomerTag(tenantId: string, customerId: string, tagId: string) {
  return withScope({ kind: "tenant", tenantId }, async (tx) => {
    const [owner] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.id, customerId), eq(customer.tenantId, tenantId)))
      .for("update");
    if (!owner) throw notFound("Cliente não encontrado.");

    await assertTagsOfTenant(tx, tenantId, [tagId]);

    const [{ total } = { total: 0 }] = await tx
      .select({ total: count() })
      .from(customerTag)
      .where(eq(customerTag.customerId, customerId));
    const [already] = await tx
      .select({ tagId: customerTag.tagId })
      .from(customerTag)
      .where(and(eq(customerTag.customerId, customerId), eq(customerTag.tagId, tagId)));

    if (!already && total >= CUSTOMER_TAG_LIMIT) {
      throw new TenantRuleError(
        409,
        "CUSTOMER_TAG_LIMIT",
        `Um cliente pode ter até ${CUSTOMER_TAG_LIMIT} etiquetas.`,
      );
    }

    await tx
      .insert(customerTag)
      .values({ tenantId, customerId, tagId })
      .onConflictDoNothing();
  });
}

/** `DELETE /api/customers/:id/tags/:tagId`: idempotente. */
export function removeCustomerTag(tenantId: string, customerId: string, tagId: string) {
  return withScope({ kind: "tenant", tenantId }, async (tx) => {
    const [owner] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.id, customerId), eq(customer.tenantId, tenantId)));
    if (!owner) throw notFound("Cliente não encontrado.");

    await tx
      .delete(customerTag)
      .where(and(eq(customerTag.customerId, customerId), eq(customerTag.tagId, tagId)));
  });
}

export type CustomerTagView = { id: string; name: string; color: string };

/** As etiquetas de um conjunto de clientes, agrupadas por cliente (uma consulta). */
export async function tagsOfCustomers(tx: Tx, customerIds: string[]) {
  const result = new Map<string, CustomerTagView[]>();
  if (customerIds.length === 0) return result;

  const rows = await tx
    .select({ customerId: customerTag.customerId, id: tag.id, name: tag.name, color: tag.color })
    .from(customerTag)
    .innerJoin(tag, eq(customerTag.tagId, tag.id))
    .where(inArray(customerTag.customerId, customerIds))
    .orderBy(asc(sql`lower(${tag.name})`));

  for (const { customerId, ...view } of rows) {
    const list = result.get(customerId) ?? [];
    list.push(view);
    result.set(customerId, list);
  }

  return result;
}
