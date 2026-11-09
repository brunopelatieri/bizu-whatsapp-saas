import { and, asc, count, eq, inArray, isNull, isNotNull, type SQL, sql } from "drizzle-orm";
import { isUniqueViolation } from "@/db/errors";
import { type Scope, scopeTenantId, type Tx, withScope } from "@/db/rls";
import { customer, customField } from "@/db/schema";
import { type AuditAction, auditInTransaction } from "@/lib/audit";
import {
  CUSTOM_FIELD_LIMIT,
  type CustomFieldEntity,
  listFieldTypes,
} from "@/lib/crm/constants";
import {
  buildCustomFieldsSchema,
  type CustomFieldDef,
  type CustomFieldOption,
  type CustomFieldsPatch,
  type CustomFieldValue,
  type CustomFieldValues,
  displayCustomFieldValue,
  missingRequired,
  slugifyKey,
} from "@/lib/crm/values";
import type { CustomFieldInput, UpdateCustomFieldInput } from "@/lib/schemas/crm";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Campos adicionais (`docs/specs/crm-cadastro/spec.md`). Os valores ficam no jsonb
 * `customer.custom_fields`, chaveados pelo **id** do campo. O serviço recebe `Scope` (como
 * `tags.ts`): o tenant vem do escopo, nunca do corpo; o banco isola pelo `scopedPolicy()` e o
 * `where` daqui é a segunda camada. Valor de campo é dado pessoal em potencial: nunca vai para
 * log nem para `metadata` da auditoria (só ids e `key`).
 */

export type CustomFieldActor = { userId: string | null; ip?: string };

const NOT_FOUND = "Campo não encontrado.";

const KEY_TAKEN = new TenantRuleError(
  409,
  "FIELD_KEY_TAKEN",
  "Já existe um campo com esta chave.",
);

export type CustomFieldView = CustomFieldDef & {
  entity: CustomFieldEntity;
  position: number;
  archived: boolean;
  /** Quantos cadastros têm valor neste campo. */
  usage: number;
};

/** A entidade é decidida pelo escopo: tenant só tem `customer`, a plataforma só `organization`. */
function entityOf(scope: Scope): CustomFieldEntity {
  return scope.kind === "tenant" ? "customer" : "organization";
}

function assertEntity(scope: Scope, entity: CustomFieldEntity) {
  if (entity !== entityOf(scope)) {
    throw new TenantRuleError(400, "INVALID_ENTITY", "Entidade inválida.");
  }
}

const inScope = (scope: Scope) =>
  and(
    scope.kind === "tenant" ? eq(customField.tenantId, scope.tenantId) : isNull(customField.tenantId),
    eq(customField.entity, entityOf(scope)),
  );

const byId = (scope: Scope, id: string) => and(eq(customField.id, id), inScope(scope));

function auditOf(
  scope: Scope,
  action: AuditAction,
  field: { id: string; key: string },
  actor: CustomFieldActor,
  tx: Tx,
  extra: Record<string, string | number | boolean | null> = {},
) {
  return auditInTransaction(tx, action, {
    actor: scope.kind === "platform" ? { type: "platform", id: actor.userId } : { id: actor.userId },
    tenantId: scopeTenantId(scope),
    target: { type: "custom_field", id: field.id },
    metadata: { key: field.key, ...extra },
    ip: actor.ip,
  });
}

/** Um por escopo e entidade: serializa o teto, a posição e a chave. */
function lockScope(tx: Tx, scope: Scope) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`custom_field:${scopeTenantId(scope) ?? "platform"}:${entityOf(scope)}`}))`,
  );
}

type Row = typeof customField.$inferSelect;

const toDef = (row: Row): CustomFieldDef => ({
  id: row.id,
  key: row.key,
  label: row.label,
  type: row.type,
  options: row.options,
  required: row.required,
});

/** Quantos clientes têm valor no campo (só tenant; subconsulta correlacionada: colunas com o prefixo da tabela; a plataforma ganha o dela na fase A4). */
function usageSql(scope: Scope) {
  if (scope.kind !== "tenant") return sql<number>`0`;

  return sql<number>`(select count(*)::int from "customer" where "customer"."tenant_id" = ${scope.tenantId} and jsonb_exists("customer"."custom_fields", "custom_field"."id"::text))`;
}

export function listCustomFields(
  scope: Scope,
  {
    entity,
    archived,
    usage = false,
  }: { entity: CustomFieldEntity; archived: "true" | "false" | "all"; usage?: boolean },
): Promise<CustomFieldView[]> {
  assertEntity(scope, entity);

  return withScope(scope, async (tx) => {
    const rows = await tx
      // `usage` varre os clientes de cada campo: só o gestor pede.
      .select({ row: customField, usage: usage ? usageSql(scope) : sql<number>`0` })
      .from(customField)
      .where(
        and(
          inScope(scope),
          archived === "false" ? isNull(customField.archivedAt) : undefined,
          archived === "true" ? isNotNull(customField.archivedAt) : undefined,
        ),
      )
      .orderBy(asc(customField.position), asc(customField.createdAt));

    return rows.map(({ row, usage }) => ({
      ...toDef(row),
      entity: row.entity,
      position: row.position,
      archived: row.archivedAt !== null,
      usage,
    }));
  });
}

/**
 * Definições na ordem da tela. Sem `includeArchived`, só as ativas (o que valida e desenha o
 * formulário). Com `lock`, `FOR SHARE`: excluir o campo ou tirar opção (`FOR UPDATE`) espera quem
 * está gravando valor, e vice-versa.
 */
async function loadDefs(
  tx: Tx,
  scope: Scope,
  { includeArchived = false, lock = false } = {},
): Promise<CustomFieldDef[]> {
  const query = tx
    .select()
    .from(customField)
    .where(and(inScope(scope), includeArchived ? undefined : isNull(customField.archivedAt)))
    .orderBy(asc(customField.position), asc(customField.createdAt));

  return (lock ? await query.for("share") : await query).map(toDef);
}

/** Todas as definições (inclusive arquivadas): rótulo dos valores na exportação LGPD. */
export const allCustomFields = (tx: Tx, scope: Scope) =>
  loadDefs(tx, scope, { includeArchived: true });

async function assertActiveRoom(tx: Tx, scope: Scope, exceptId?: string) {
  const [{ total } = { total: 0 }] = await tx
    .select({ total: count() })
    .from(customField)
    .where(
      and(
        inScope(scope),
        isNull(customField.archivedAt),
        exceptId ? sql`${customField.id} <> ${exceptId}` : undefined,
      ),
    );

  if (total >= CUSTOM_FIELD_LIMIT) {
    throw new TenantRuleError(
      409,
      "FIELD_LIMIT",
      `O limite de ${CUSTOM_FIELD_LIMIT} campos ativos foi atingido. Arquive um campo para liberar vaga.`,
    );
  }
}

/**
 * Opções novas ganham `value` gerado do rótulo (único na lista); as existentes mantêm o
 * `value`, mesmo com o rótulo renomeado. Valor desconhecido (de opção que não existe) é 400.
 */
function normalizeOptions(
  existing: CustomFieldOption[],
  input: { value?: string; label: string }[],
): CustomFieldOption[] {
  const known = new Set(existing.map(({ value }) => value));
  const taken = new Set(input.flatMap(({ value }) => (value ? [value] : [])));
  const result: CustomFieldOption[] = [];

  for (const option of input) {
    if (option.value) {
      if (!known.has(option.value)) {
        throw new TenantRuleError(400, "UNKNOWN_OPTION", "Opção desconhecida.");
      }
      result.push({ value: option.value, label: option.label });
      continue;
    }

    const base = slugifyKey(option.label, 36) || "opcao";
    let value = base;
    for (let n = 2; taken.has(value); n += 1) value = `${base}_${n}`;
    taken.add(value);
    result.push({ value, label: option.label });
  }

  return result;
}

export function createCustomField(scope: Scope, input: CustomFieldInput, actor: CustomFieldActor) {
  assertEntity(scope, input.entity);

  const key = input.key ?? slugifyKey(input.label);
  if (!key) {
    throw new TenantRuleError(
      400,
      "INVALID_KEY",
      "Não foi possível gerar a chave: informe uma, com letras, números e _.",
    );
  }

  return withScope(scope, async (tx) => {
    await lockScope(tx, scope);
    await assertActiveRoom(tx, scope);

    const [last] = await tx
      .select({ max: sql<number>`coalesce(max(${customField.position}), 0)::int` })
      .from(customField)
      .where(inScope(scope));

    const options = normalizeOptions([], input.options ?? []);
    const [created] = await tx
      .insert(customField)
      .values({
        tenantId: scopeTenantId(scope),
        entity: input.entity,
        key,
        label: input.label,
        type: input.type,
        options,
        required: input.required ?? false,
        position: (last?.max ?? 0) + 1,
        createdBy: actor.userId,
      })
      .returning()
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw KEY_TAKEN;
        throw error;
      });
    if (!created) throw new Error("campo não criado");

    await auditOf(scope, "custom_field.created", created, actor, tx);

    return { ...toDef(created), entity: created.entity, position: created.position, archived: false, usage: 0 };
  });
}

/**
 * Quantos cadastros do escopo usam cada opção (lista de uma ou de várias), numa consulta só:
 * um `count(*) filter` por opção.
 */
async function optionsUsage(tx: Tx, scope: Scope, fieldId: string, values: string[]) {
  if (scope.kind !== "tenant" || values.length === 0) return values.map(() => 0);

  const columns = Object.fromEntries(
    values.map((value, n) => [
      `n${n}`,
      // Um escalar contém a si mesmo e um array contém o elemento: serve os dois tipos.
      sql<number>`(count(*) filter (where (${customer.customFields} -> ${fieldId}::text) @> to_jsonb(${value}::text)))::int`,
    ]),
  );

  const [row] = await tx.select(columns).from(customer).where(eq(customer.tenantId, scope.tenantId));

  return values.map((_, n) => row?.[`n${n}`] ?? 0);
}

export function updateCustomField(
  scope: Scope,
  id: string,
  patch: UpdateCustomFieldInput,
  actor: CustomFieldActor,
) {
  return withScope(scope, async (tx) => {
    await lockScope(tx, scope);

    const [current] = await tx.select().from(customField).where(byId(scope, id)).for("update");
    if (!current) throw notFound(NOT_FOUND);

    const set: Partial<typeof customField.$inferInsert> = {};

    if (patch.label !== undefined) set.label = patch.label;
    if (patch.required !== undefined) set.required = patch.required;

    if (patch.options !== undefined) {
      if (!listFieldTypes.includes(current.type)) {
        throw new TenantRuleError(400, "INVALID_OPTIONS", "Só campos de lista têm opções.");
      }
      if (patch.options.length === 0) {
        throw new TenantRuleError(400, "INVALID_OPTIONS", "Informe ao menos uma opção.");
      }

      const next = normalizeOptions(current.options, patch.options);
      const kept = new Set(next.map(({ value }) => value));
      const removed = current.options.filter(({ value }) => !kept.has(value));
      const inUse: { value: string; label: string; count: number }[] = [];

      const usage = await optionsUsage(tx, scope, id, removed.map(({ value }) => value));
      for (const [n, option] of removed.entries()) {
        const used = usage[n] ?? 0;
        if (used > 0) inUse.push({ ...option, count: used });
      }
      if (inUse.length > 0) {
        const names = inUse.map(({ label }) => label).join(", ");
        throw new TenantRuleError(
          409,
          "OPTION_IN_USE",
          `Há cadastros usando: ${names}. Renomeie a opção em vez de removê-la.`,
          { options: inUse },
        );
      }

      set.options = next;
    }

    let archiving = false;
    if (patch.archived !== undefined) {
      const isArchived = current.archivedAt !== null;
      if (patch.archived && !isArchived) {
        set.archivedAt = new Date();
        archiving = true;
      } else if (!patch.archived && isArchived) {
        await assertActiveRoom(tx, scope, id);
        set.archivedAt = null;
      }
    }

    const [updated] = await tx
      .update(customField)
      .set(set)
      .where(byId(scope, id))
      .returning();
    if (!updated) throw notFound(NOT_FOUND);

    await auditOf(scope, archiving ? "custom_field.archived" : "custom_field.updated", updated, actor, tx);

    return {
      ...toDef(updated),
      entity: updated.entity,
      position: updated.position,
      archived: updated.archivedAt !== null,
    };
  });
}

/** Grava a ordem dos campos pedidos (posição = índice). Campo de outro escopo é 404. */
export function reorderCustomFields(scope: Scope, entity: CustomFieldEntity, ids: string[]) {
  assertEntity(scope, entity);

  return withScope(scope, async (tx) => {
    await lockScope(tx, scope);

    if (ids.length > 0) {
      const found = await tx
        .select({ id: customField.id })
        .from(customField)
        .where(and(inScope(scope), inArray(customField.id, ids)));
      if (found.length !== ids.length) throw notFound(NOT_FOUND);
    }

    for (const [position, id] of ids.entries()) {
      await tx.update(customField).set({ position }).where(byId(scope, id));
    }
  });
}

/**
 * Apaga a definição e limpa o valor em todos os cadastros, na mesma transação. Pede a `key`
 * digitada (`CONFIRMATION_MISMATCH`): é ação destrutiva, ao contrário de arquivar.
 */
export function deleteCustomField(
  scope: Scope,
  id: string,
  confirm: string,
  actor: CustomFieldActor,
) {
  return withScope(scope, async (tx) => {
    await lockScope(tx, scope);

    const [current] = await tx.select().from(customField).where(byId(scope, id)).for("update");
    if (!current) throw notFound(NOT_FOUND);

    if (confirm.trim() !== current.key) {
      throw new TenantRuleError(
        400,
        "CONFIRMATION_MISMATCH",
        "Digite a chave do campo para confirmar a exclusão.",
      );
    }

    let clearedFrom = 0;
    if (scope.kind === "tenant") {
      const cleared = await tx
        .update(customer)
        .set({ customFields: sql`${customer.customFields} - ${current.id}::text` })
        .where(
          and(
            eq(customer.tenantId, scope.tenantId),
            sql`jsonb_exists(${customer.customFields}, ${current.id}::text)`,
          ),
        )
        .returning({ id: customer.id });
      clearedFrom = cleared.length;
    }

    await tx.delete(customField).where(byId(scope, id));
    await auditOf(scope, "custom_field.deleted", current, actor, tx, { clearedFrom });

    return { clearedFrom };
  });
}

/* ---------- Valores no cadastro (usado por `src/lib/tenant/customers.ts`) ---------- */

/** Valores do bloco `customFields` já validados contra as definições ativas. */
export type ResolvedCustomFields = {
  defs: CustomFieldDef[];
  patch: CustomFieldsPatch;
};

/**
 * Confere o bloco `customFields` do corpo contra as definições ativas do tenant, na transação
 * de quem grava o cliente (chame antes de travar a linha do cliente: a ordem dos locks evita
 * deadlock com a exclusão do campo). Id desconhecido ou arquivado é 400 `UNKNOWN_FIELD`; valor
 * inválido, 400 `INVALID_FIELD_VALUE`. `null` (ou vazio) vira "remova".
 */
export async function resolveCustomFields(
  tx: Tx,
  tenantId: string,
  raw: Record<string, unknown>,
): Promise<ResolvedCustomFields> {
  // `FOR SHARE`: o campo não é excluído nem perde opção enquanto este cadastro é gravado.
  const defs = await loadDefs(tx, { kind: "tenant", tenantId }, { lock: true });
  const known = new Set(defs.map(({ id }) => id));

  if (Object.keys(raw).some((id) => !known.has(id))) {
    throw new TenantRuleError(400, "UNKNOWN_FIELD", "Campo desconhecido ou arquivado.");
  }

  const parsed = buildCustomFieldsSchema(defs, { requireAll: false }).safeParse(raw);
  if (!parsed.success) {
    const labels = new Map(defs.map(({ id, label }) => [id, label]));
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const id = String(issue.path[0] ?? "");
      fields[id] ??= issue.message;
    }
    const [firstId = ""] = Object.keys(fields);

    throw new TenantRuleError(
      400,
      "INVALID_FIELD_VALUE",
      `${labels.get(firstId) ?? "Campo"}: ${fields[firstId] ?? "valor inválido."}`,
      { fields },
    );
  }

  const patch: CustomFieldsPatch = {};
  for (const [id, value] of Object.entries(parsed.data)) {
    if (value !== undefined) patch[id] = value as CustomFieldValue | null;
  }

  return { defs, patch };
}

/** `required` vale sobre o estado final do cadastro, só quando o corpo trouxe `customFields`. */
export function assertRequiredFilled(defs: CustomFieldDef[], finalValues: CustomFieldValues) {
  const missing = missingRequired(defs, finalValues);
  if (missing.length > 0) {
    throw new TenantRuleError(
      400,
      "FIELD_REQUIRED",
      `Preencha os campos obrigatórios: ${missing.join(", ")}.`,
      { missing },
    );
  }
}

/** Só os valores a gravar (sem os `null`). */
export function valuesOf(patch: CustomFieldsPatch): CustomFieldValues {
  const values: CustomFieldValues = {};
  for (const [id, value] of Object.entries(patch)) {
    if (value !== null) values[id] = value;
  }
  return values;
}

/** `custom_fields || $set - $removidas`, no mesmo `UPDATE`: o merge por chave é atômico. */
export function customFieldsMergeSql(patch: CustomFieldsPatch): SQL {
  const set = valuesOf(patch);
  const removed = Object.entries(patch)
    .filter(([, value]) => value === null)
    .map(([id]) => id);

  let expression = sql`${customer.customFields}`;
  if (Object.keys(set).length > 0) {
    // `::text::jsonb`: o driver não serializa o texto de novo como JSON.
    expression = sql`(${expression} || ${JSON.stringify(set)}::text::jsonb)`;
  }
  if (removed.length > 0) {
    expression = sql`(${expression} - array[${sql.join(
      removed.map((id) => sql`${id}`),
      sql`, `,
    )}]::text[])`;
  }

  return expression;
}

/** Rótulo e valor legíveis de cada campo preenchido (exportação LGPD). */
export function labelledCustomFields(defs: CustomFieldDef[], values: Record<string, unknown>) {
  return defs.flatMap((def) => {
    const valor = displayCustomFieldValue(def, values[def.id]);
    return valor === null ? [] : [{ rotulo: def.label, chave: def.key, valor }];
  });
}
