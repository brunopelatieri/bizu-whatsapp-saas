import { and, count, desc, eq, ilike, ne, or, type SQL, sql } from "drizzle-orm";
import { logError } from "@/api/log";
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
import {
  countCustomerConversations,
  purgeCustomerContacts,
  purgeTeamCustomerContacts,
} from "@/lib/inbox/privacy";
import { phoneErrorMessage } from "@/lib/phone/br";
import { getStorage } from "@/lib/storage";
import { InvalidPhoneError, phoneValues } from "@/lib/phone/columns";
import { requestPhoneVerificationSend } from "@/lib/phone/dispatch";
import {
  cancelCustomerPhoneChange,
  customerPhoneChange,
  deleteVerificationsOf,
  type NewPhone,
  openCustomerPhoneChange,
  type PhoneChangeOpened,
} from "@/lib/phone/requests";
import { type PhoneVerifiedVia, verifiedPhone } from "@/lib/phone/verification";
import { CUSTOMER_NOT_FOUND } from "@/lib/tenant/customer-constants";
import { notFound, phoneInUse, TenantRuleError } from "@/lib/tenant/errors";
import {
  isTeamCustomer,
  matchingTeamMember,
  type TeamLink,
  teamRolesOf,
} from "@/lib/tenant/team-customer";

/** Quem age e de onde, para a auditoria. */
export type CustomerActor = {
  userId: string;
  ip?: string;
  /** Só quem lê clientes vê o nome do dono do telefone repetido (`PHONE_IN_USE`). */
  canRead?: boolean;
};

type CustomerRow = typeof customer.$inferSelect;

export { CUSTOMER_NOT_FOUND };
const NOT_FOUND = CUSTOMER_NOT_FOUND;
const EMAIL_TAKEN = new TenantRuleError(
  409,
  "CUSTOMER_EMAIL_TAKEN",
  "Já existe um cliente com este e-mail.",
);

const PHONE_INDEX = "customer_tenant_phone_key_idx";
const TEAM_INDEX = "customer_tenant_user_idx";

/** Duas fichas nascendo ao mesmo tempo para a mesma pessoa da equipe: a segunda tenta de novo. */
const TEAM_LINK_RACE = new TenantRuleError(
  409,
  "CUSTOMER_CONFLICT",
  "Outro cadastro foi criado ao mesmo tempo. Tente de novo.",
);

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
    const constraint = violatedConstraint(error);
    if (constraint === TEAM_INDEX) throw TEAM_LINK_RACE;
    throw constraint === PHONE_INDEX ? phoneInUse() : EMAIL_TAKEN;
  }
  throw error;
}

/**
 * `emailVerified` e os demais dados de `portal_user` são globais e não saem daqui. `team` é a
 * pessoa da equipe que também é este cliente, com o papel atual dela (`null` se não é, ou se
 * já saiu da equipe).
 */
function toCustomer(
  { portalUserId, tenantId: _tenantId, phoneKey: _phoneKey, userId, ...row }: CustomerRow,
  tags: CustomerTagView[] = [],
  roles: Map<string, string> = new Map(),
) {
  const role = userId ? roles.get(userId) : undefined;
  const team: TeamLink | null = userId && role ? { userId, role } : null;

  return {
    ...row,
    tags,
    team,
    phoneVerified: row.phoneVerifiedAt !== null,
    hasPortalAccess: portalUserId !== null,
  };
}

function byId(tenantId: string, customerId: string) {
  return and(eq(customer.id, customerId), eq(customer.tenantId, tenantId));
}

export { byId as byCustomerId };

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

  if (query.team) filters.push(isTeamCustomer);

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
    const roles = await teamRolesOf(tx, tenantId, rows.map(({ userId }) => userId));

    return {
      items: rows.map((row) => toCustomer(row, tags.get(row.id), roles)),
      total: total?.total ?? 0,
      pageSize: CUSTOMER_PAGE_SIZE,
    };
  });
}

export async function getCustomer(tenantId: string, customerId: string) {
  const found = await withTenant(tenantId, async (tx) => {
    const [row] = await tx.select().from(customer).where(byId(tenantId, customerId));
    if (!row) return null;

    return {
      row,
      tags: await tagsOfCustomers(tx, [row.id]),
      roles: await teamRolesOf(tx, tenantId, [row.userId]),
      phoneChange: await customerPhoneChange(tx, row.id),
      conversationCount: await countCustomerConversations(tx, row.id),
    };
  });

  if (!found) throw notFound(NOT_FOUND);

  // A troca de número em andamento: a ficha (e `phone`) segue com o número antigo até ela fechar.
  return {
    ...toCustomer(found.row, found.tags.get(found.row.id), found.roles),
    phoneChange: found.phoneChange,
    // As conversas que a exclusão da ficha apaga (o diálogo da tela avisa com este número).
    conversationCount: found.conversationCount,
  };
}

/**
 * `afterCreate` roda na mesma transação, depois de gravar: se lançar, o cliente não é criado
 * (a caixa de entrada vincula o contato ao "salvar como cliente").
 */
export async function createCustomer(
  tenantId: string,
  input: CustomerInput,
  actor: CustomerActor,
  options: {
    afterCreate?: (tx: Tx, customerId: string) => Promise<void>;
    /**
     * Como o telefone foi confirmado. Padrão `team`: quem cadastra é a equipe, e o número que
     * ela informa vale. `inbound`: o cliente nasceu de um contato que escreveu por esse número.
     */
    phoneVerifiedVia?: Extract<PhoneVerifiedVia, "team" | "inbound">;
  } = {},
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

      // Quem é da equipe também pode ser cliente da organização: a ficha nasce ligada à conta
      // dele quando o número é o telefone confirmado do membro (`team-customer.ts`). O e-mail
      // da ficha é texto de quem cadastra e nunca liga sozinho.
      const userId = await matchingTeamMember(tx, tenantId, phone.phoneKey);

      const [created] = await tx
        .insert(customer)
        .values({
          ...fields,
          ...phone,
          ...verifiedPhone(options.phoneVerifiedVia ?? "team"),
          userId,
          tenantId,
          customFields: values,
        })
        .returning();
      if (!created) throw new Error("cliente não criado");

      if (tagIds) await replaceCustomerTags(tx, tenantId, created.id, tagIds);
      if (options.afterCreate) await options.afterCreate(tx, created.id);

      await auditInTransaction(tx, "customer.created", {
        actor: { id: actor.userId },
        tenantId,
        target: { type: "customer", id: created.id },
        metadata: { status: created.status },
        ip: actor.ip,
      });
      if (userId) {
        await auditInTransaction(tx, "customer.team_linked", {
          actor: { id: actor.userId },
          tenantId,
          target: { type: "customer", id: created.id },
          metadata: { userId, via: "created" },
          ip: actor.ip,
        });
      }

      return toCustomer(
        created,
        (await tagsOfCustomers(tx, [created.id])).get(created.id),
        await teamRolesOf(tx, tenantId, [created.userId]),
      );
    });
  } catch (error) {
    return translateUnique(error);
  }
}

/**
 * Trocar o e-mail desfaz o vínculo com o portal: o endereço antigo perde o acesso, e o novo
 * só entra depois de um convite. Sair de `active` corta o acesso na hora.
 *
 * **Outro telefone não é gravado aqui:** abre a troca pelo pedido (P1), e a ficha segue com o número
 * antigo até o link do número novo ser confirmado na sessão do portal da ficha ou o owner liberar.
 * O mesmo número escrito de outro jeito (mesma `phone_key`) é gravado direto.
 */
export async function updateCustomer(
  tenantId: string,
  customerId: string,
  patch: UpdateCustomerInput,
  actor: CustomerActor,
) {
  let unlinkedUserId: string | null = null;
  let opened: PhoneChangeOpened | null = null;
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
      const phoneChanged = phone !== null && phone.phoneKey !== current.phoneKey;
      if (phone && phoneChanged) {
        // A equipe pode saber que o número é de outro cliente (vê a lista): 409 já no pedido.
        await assertPhoneFree(tx, tenantId, phone.phoneKey, actor, customerId);
      }

      const emailChanged =
        patch.email !== undefined && patch.email !== current.email;
      const fallbackStatus =
        current.status === "blocked" ? ("blocked" as const) : ("lead" as const);
      const status =
        patch.status ?? (emailChanged ? fallbackStatus : current.status);

      // O telefone sai do `...fields`: ele só muda pelo pedido de troca (ou na mesma `phone_key`, abaixo).
      const { tagIds, customFields: _customFields, phone: _phone, ...fields } = patch;
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
          ...(phone && !phoneChanged ? phone : {}),
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
      if (phone && phoneChanged) {
        opened = await openCustomerPhoneChange(tx, tenantId, customerId, phone, {
          type: "user",
          id: actor.userId,
        });
      }

      if (current.portalUserId && (emailChanged || status !== "active")) {
        await leavePortalTenant(tx, current.portalUserId, tenantId);
      }
      if (emailChanged) unlinkedUserId = current.portalUserId;

      await auditInTransaction(tx, "customer.updated", {
        actor: { id: actor.userId },
        tenantId,
        target: { type: "customer", id: customerId },
        metadata: { status, emailChanged, phoneChange: phoneChanged },
        ip: actor.ip,
      });

      return {
        ...toCustomer(
          row,
          (await tagsOfCustomers(tx, [row.id])).get(row.id),
          await teamRolesOf(tx, tenantId, [row.userId]),
        ),
        phoneChange: await customerPhoneChange(tx, row.id),
      };
    });

    if (unlinkedUserId) await dropOrphanPortalUser(unlinkedUserId);
    await sendChangeLink(customerId, opened);

    return updated;
  } catch (error) {
    return translateUnique(error);
  }
}

/** Depois do commit: o link da troca de número da ficha (o job decide se ela tem como confirmar). */
async function sendChangeLink(customerId: string, opened: PhoneChangeOpened | null) {
  if (!opened) return;
  await requestPhoneVerificationSend(
    opened.requestId,
    { type: "customer", id: customerId },
    opened.reason,
  );
}

/**
 * `POST /api/customers/:id/phone-change`: a equipe pede a troca do número da ficha. O número novo
 * já de outro cliente é 409 aqui (a equipe pode saber, como no cadastro). A ficha não muda: o link
 * vai ao número novo e só confirma na sessão do portal da própria ficha; ficha sem conta no portal
 * vai para a liberação do owner (`phone:confirm`), que vale como `manual` (não atrai conversas nem
 * liga a ficha à pessoa da equipe com o número). Assim um colaborador não passa a ficha de um
 * cliente para um número dele. Pedir de novo o mesmo número reenvia o link.
 */
export async function requestCustomerPhoneChange(
  tenantId: string,
  customerId: string,
  raw: string,
  actor: CustomerActor,
) {
  const phone: NewPhone = phoneOf(raw);

  const opened = await withTenant(tenantId, async (tx) => {
    const [current] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(byId(tenantId, customerId))
      .for("update");
    if (!current) throw notFound(NOT_FOUND);

    await assertPhoneFree(tx, tenantId, phone.phoneKey, actor, customerId);
    return openCustomerPhoneChange(tx, tenantId, customerId, phone, {
      type: "user",
      id: actor.userId,
    });
  });

  await sendChangeLink(customerId, opened);
  return opened;
}

/** `DELETE /api/customers/:id/phone-change`: desiste da troca aberta (a ficha não tinha mudado). */
export async function cancelCustomerPhoneChangeByTeam(
  tenantId: string,
  customerId: string,
  actor: CustomerActor,
) {
  await withTenant(tenantId, async (tx) => {
    const [current] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(byId(tenantId, customerId))
      .for("update");
    if (!current) throw notFound(NOT_FOUND);

    await cancelCustomerPhoneChange(tx, tenantId, customerId, { type: "user", id: actor.userId });
  });
}

/**
 * Apaga a ficha e o que está ligado a ela: os contatos vinculados saem com conversas, mensagens e
 * mídia (SPEC da caixa de entrada, LGPD), os pedidos de verificação de telefone e o vínculo do
 * portal. Roda na transação de quem chama, com o RLS limitando tudo ao tenant (ou na de plataforma,
 * na anonimização da conta). Devolve o que sobra para **depois do commit**: as chaves dos objetos
 * do armazenamento e a identidade do portal que ficou sem ficha.
 *
 * `teamPhoneKey` (D-11, ficha de quem é da equipe): só os contatos desse número saem; os demais só
 * perdem o vínculo. `undefined` é a exclusão comum (todos os contatos da ficha).
 */
export async function deleteCustomerIn(
  tx: Tx,
  tenantId: string,
  customerId: string,
  audit: {
    actor: { type?: "user" | "system"; id: string | null };
    ip?: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
  options: { teamPhoneKey?: string | null } = {},
) {
  const [found] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(byId(tenantId, customerId))
    .for("update");
  if (!found) throw notFound(NOT_FOUND);

  const inbox =
    options.teamPhoneKey === undefined
      ? await purgeCustomerContacts(tx, [found.id])
      : await purgeTeamCustomerContacts(tx, found.id, options.teamPhoneKey);
  await deleteVerificationsOf(tx, "customer", [found.id]);
  const [removed] = await tx
    .delete(customer)
    .where(byId(tenantId, customerId))
    .returning({ portalUserId: customer.portalUserId });
  if (!removed) throw notFound(NOT_FOUND);

  if (removed.portalUserId) {
    await leavePortalTenant(tx, removed.portalUserId, tenantId);
  }

  await auditInTransaction(tx, "customer.deleted", {
    actor: audit.actor,
    tenantId,
    target: { type: "customer", id: customerId },
    ip: audit.ip,
    metadata: audit.metadata,
  });

  return { portalUserId: removed.portalUserId, storageKeys: inbox.storageKeys };
}

/** Depois do commit: os objetos saem do armazenamento (falha vira log) e a identidade órfã do portal cai. */
export async function afterCustomerDeleted(deleted: {
  portalUserId: string | null;
  storageKeys: string[];
}) {
  for (const key of deleted.storageKeys) {
    await getStorage()
      .delete(key)
      .catch((error) => logError("Falha ao apagar a mídia do cliente excluído", error));
  }

  if (deleted.portalUserId) await dropOrphanPortalUser(deleted.portalUserId);
}

/**
 * Apaga o cliente. As conversas de WhatsApp com ele saem junto (contatos vinculados, mensagens e
 * mídia; SPEC da caixa de entrada, LGPD): o RLS do tenant limita tudo a este tenant, e os objetos
 * do armazenamento saem depois do commit.
 */
export async function deleteCustomer(
  tenantId: string,
  customerId: string,
  actor: CustomerActor,
) {
  const deleted = await withTenant(tenantId, (tx) =>
    deleteCustomerIn(tx, tenantId, customerId, { actor: { id: actor.userId }, ip: actor.ip }),
  );

  await afterCustomerDeleted(deleted);
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
