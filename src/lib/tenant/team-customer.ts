import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { isUniqueViolation, violatedConstraint } from "@/db/errors";
import { type Tx, withTenant } from "@/db/rls";
import { customer, member, user } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { userPhoneConfirmedGlobally } from "@/lib/phone/confirmed";
import { AUTO_LINK_CUSTOMER_VIAS } from "@/lib/phone/verification";
import { CUSTOMER_NOT_FOUND } from "@/lib/tenant/customer-constants";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * A pessoa da equipe que também é cliente da própria organização
 * (`docs/specs/pre-producao/spec.md`, "Equipe que também é cliente").
 *
 * São dois cadastros separados, `user` e `customer`, que podem ter o mesmo telefone e o mesmo
 * e-mail. `customer.user_id` os liga por id; o papel mostrado na ficha é lido de `member` na
 * hora, não gravado.
 *
 * **A ligação automática é só pelo telefone, e só com o telefone da conta confirmado para o
 * sistema inteiro** (`userPhoneConfirmedGlobally`: prova de posse, ou liberação do proprietário
 * da plataforma). A liberação do owner de uma organização, mesmo desta, não basta: ela não prova
 * que o número é da pessoa, e o que está em jogo é a ficha (e as conversas) de um cliente. A ficha
 * ligada será apagada, com as conversas dela, quando a pessoa sair da equipe (D-11). O e-mail da
 * ficha é texto livre de quem cadastra: se bastasse ele, um colaborador salvaria o contato de um
 * cliente com o próprio e-mail e passaria a ser "dono" da ficha e das conversas de outra pessoa.
 * Com o telefone, a ficha ligada é sempre a do número que a própria pessoa provou ser dela. Ligar
 * por e-mail, ou qualquer outro caso, é ação explícita da equipe (`linkTeamCustomer`, no fim do
 * arquivo).
 */

export type TeamLink = { userId: string; role: string };

/** Só os membros que estão nesta organização: `member` e `user` não têm RLS. */
const inTenant = (tenantId: string) => eq(member.organizationId, tenantId);

/**
 * O membro da organização cujo telefone **confirmado** é o desta ficha. `null` quando não há,
 * quando há mais de um com o número, ou quando ele já tem ficha de cliente na organização.
 */
export async function matchingTeamMember(tx: Tx, tenantId: string, phoneKey: string | null) {
  if (!phoneKey) return null;

  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(and(inTenant(tenantId), eq(user.phoneKey, phoneKey), userPhoneConfirmedGlobally))
    .limit(2);

  const [only] = rows;
  if (rows.length !== 1 || !only) return null;

  const [taken] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.tenantId, tenantId), eq(customer.userId, only.id)))
    .limit(1);

  return taken ? null : only.id;
}

/**
 * A ficha que acabou de provar o número pelo link (confirmação do cadastro, da troca ou do `claim`):
 * liga a pessoa da equipe cujo telefone confirmado é esse, se a ficha ainda não tem ligação e a pessoa
 * ainda não tem ficha (`matchingTeamMember`). Audita `customer.team_linked` com `via: verified`.
 */
export async function linkVerifiedTeamMember(
  tx: Tx,
  tenantId: string,
  customerId: string,
  phoneKey: string,
) {
  const teamUserId = await matchingTeamMember(tx, tenantId, phoneKey);
  if (!teamUserId) return null;

  const [linked] = await tx
    .update(customer)
    .set({ userId: teamUserId })
    .where(and(eq(customer.id, customerId), isNull(customer.userId)))
    .returning({ id: customer.id });
  if (!linked) return null;

  await auditInTransaction(tx, "customer.team_linked", {
    actor: { id: null, type: "system" },
    tenantId,
    target: { type: "customer", id: customerId },
    metadata: { userId: teamUserId, via: "verified" },
  });
  return teamUserId;
}

/**
 * Quem acabou de entrar na equipe e já era cliente da organização: liga a ficha que tem o mesmo
 * telefone, confirmado dos dois lados (na ficha, por uma forma de `AUTO_LINK_CUSTOMER_VIAS`). Roda em `withTenant`. Devolve o id da ficha ligada (a
 * que já estava ligada, se havia), ou `null`.
 */
export async function linkExistingCustomer(tx: Tx, tenantId: string, userId: string) {
  const [person] = await tx
    .select({ phoneKey: user.phoneKey })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(and(inTenant(tenantId), eq(user.id, userId), userPhoneConfirmedGlobally));
  if (!person?.phoneKey) return null;

  const [already] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.tenantId, tenantId), eq(customer.userId, userId)))
    .limit(1);
  if (already) return already.id;

  // O índice único do tenant garante no máximo uma ficha com o número.
  const [linked] = await tx
    .update(customer)
    .set({ userId })
    .where(
      and(
        eq(customer.tenantId, tenantId),
        eq(customer.phoneKey, person.phoneKey),
        // Não a ficha liberada à mão: lá o número é o que o próprio cliente declarou, e a ficha
        // ligada é apagada quando a pessoa sai da equipe (D-11).
        inArray(customer.phoneVerifiedVia, [...AUTO_LINK_CUSTOMER_VIAS]),
        isNull(customer.userId),
      ),
    )
    .returning({ id: customer.id });
  if (!linked) return null;

  await auditInTransaction(tx, "customer.team_linked", {
    actor: { id: userId },
    tenantId,
    target: { type: "customer", id: linked.id },
    metadata: { userId, via: "joined" },
  });

  return linked.id;
}

/** `linkExistingCustomer` na transação própria, para a rota de aceite do convite. */
export function linkMemberCustomer(tenantId: string, userId: string) {
  return withTenant(tenantId, (tx) => linkExistingCustomer(tx, tenantId, userId));
}

/**
 * O papel atual de cada pessoa na organização, para o selo da ficha. Quem saiu da equipe não
 * aparece: a ligação pode até existir, mas o selo é do membro.
 */
export async function teamRolesOf(tx: Tx, tenantId: string, userIds: (string | null)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map<string, string>();

  const rows = await tx
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(and(inTenant(tenantId), inArray(member.userId, ids)));

  return new Map(rows.map(({ userId, role }) => [userId, role]));
}

/** Filtro da lista: só as fichas de quem é da equipe hoje. */
export const isTeamCustomer = sql`exists (select 1 from member where member.user_id = "customer"."user_id" and member.organization_id = "customer"."tenant_id")`;

// ---------------------------------------------------------------------------------------------
// Ligação feita à mão pela equipe (D-9, `customer:update`)
// ---------------------------------------------------------------------------------------------

const PERSON_NOT_FOUND = "Pessoa da equipe não encontrada.";

/** Quem liga não liga a si mesmo: excluir a própria conta apagaria a ficha de outra pessoa (D-11). */
const SELF_LINK = () =>
  new TenantRuleError(
    403,
    "SELF_LINK",
    "Você não pode ligar uma ficha de cliente à sua própria conta. Peça a outra pessoa da equipe.",
  );

const ALREADY_LINKED = () =>
  new TenantRuleError(
    409,
    "CUSTOMER_ALREADY_LINKED",
    "Esta ficha já está ligada a outra pessoa da equipe. Desfaça a ligação antes.",
  );

const MEMBER_HAS_CUSTOMER = () =>
  new TenantRuleError(
    409,
    "TEAM_MEMBER_HAS_CUSTOMER",
    "Esta pessoa já tem outra ficha de cliente nesta organização. Desfaça aquela ligação antes.",
  );

/** Uma pessoa por ficha e uma ficha por pessoa: a corrida bate no índice único. */
const TEAM_INDEX = "customer_tenant_user_idx";

/**
 * As pessoas da equipe que a tela oferece para ligar à ficha: só id, nome, papel e se já têm ficha
 * nesta organização. Sem e-mail, telefone nem estado do telefone: quem tem `customer:update` não
 * precisa deles para escolher, e a ficha a que alguém está ligado não sai daqui (só "já tem").
 */
export function teamLinkCandidates(tenantId: string, customerId: string) {
  return withTenant(tenantId, async (tx) => {
    const [record] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.id, customerId), eq(customer.tenantId, tenantId)));
    if (!record) throw notFound(CUSTOMER_NOT_FOUND);

    const rows = await tx
      .select({ userId: user.id, name: user.name, role: member.role })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(inTenant(tenantId))
      .orderBy(asc(user.name));

    const linked = await tx
      .select({ userId: customer.userId })
      .from(customer)
      .where(and(eq(customer.tenantId, tenantId), isNotNull(customer.userId)));
    const taken = new Set(linked.map(({ userId }) => userId));

    return rows.map((row) => ({ ...row, hasCustomer: taken.has(row.userId) }));
  });
}

/**
 * `PUT /api/customers/:id/team-link`: a equipe liga a ficha à pessoa da equipe **desta
 * organização**, à mão (por e-mail ou em qualquer outro caso que o telefone confirmado não
 * cobre, SPEC "Equipe que também é cliente"). A ligação decide o que uma remoção futura apaga
 * (D-11): removida a pessoa da equipe, ou excluída a conta dela, a ficha sai, e com ela só os
 * contatos do telefone **confirmado** da pessoa (`purgeTeamCustomerContacts`), exatamente como na
 * ligação automática.
 *
 * - Pessoa que não é membro desta organização (ou de outra) e ficha de outra organização: 404.
 * - Quem liga não liga a si mesmo (403 `SELF_LINK`).
 * - Ficha ligada a outra pessoa, ou pessoa com outra ficha: 409. Desfazer é a rota `DELETE`.
 * - A mesma ligação de novo: nada muda, sem auditoria (idempotente).
 *
 * Travas na ordem de `removeMember` (o membro, depois a ficha): a remoção que corre junto ou vê a
 * ligação e apaga a ficha, ou acontece antes e a ligação responde 404.
 */
export async function linkTeamCustomer(
  tenantId: string,
  customerId: string,
  userId: string,
  actor: { userId: string; ip?: string },
): Promise<TeamLink> {
  if (userId === actor.userId) throw SELF_LINK();

  try {
    return await withTenant(tenantId, async (tx) => {
      const [person] = await tx
        .select({ role: member.role })
        .from(member)
        .where(and(inTenant(tenantId), eq(member.userId, userId)))
        .for("share");
      if (!person) throw notFound(PERSON_NOT_FOUND);

      const [current] = await tx
        .select({ id: customer.id, userId: customer.userId })
        .from(customer)
        .where(and(eq(customer.id, customerId), eq(customer.tenantId, tenantId)))
        .for("update");
      if (!current) throw notFound(CUSTOMER_NOT_FOUND);

      if (current.userId === userId) return { userId, role: person.role };
      if (current.userId) throw ALREADY_LINKED();

      const [other] = await tx
        .select({ id: customer.id })
        .from(customer)
        .where(and(eq(customer.tenantId, tenantId), eq(customer.userId, userId)))
        .limit(1);
      if (other) throw MEMBER_HAS_CUSTOMER();

      await tx.update(customer).set({ userId }).where(eq(customer.id, customerId));
      await auditInTransaction(tx, "customer.team_linked", {
        actor: { id: actor.userId },
        tenantId,
        target: { type: "customer", id: customerId },
        metadata: { userId, via: "manual" },
        ip: actor.ip,
      });

      return { userId, role: person.role };
    });
  } catch (error) {
    if (isUniqueViolation(error) && violatedConstraint(error) === TEAM_INDEX) {
      throw MEMBER_HAS_CUSTOMER();
    }
    throw error;
  }
}
