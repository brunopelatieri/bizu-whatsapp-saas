import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Tx, withTenant } from "@/db/rls";
import { customer, member, user } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { userPhoneConfirmedGlobally } from "@/lib/phone/confirmed";
import { AUTO_LINK_CUSTOMER_VIAS } from "@/lib/phone/verification";

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
 * por e-mail, ou qualquer outro caso, é ação explícita da equipe (T4).
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
