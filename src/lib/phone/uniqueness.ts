import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { customer, member, user } from "@/db/schema";
import { userPhoneConfirmedGlobally, userPhoneConfirmedIn } from "@/lib/phone/confirmed";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * Unicidade do telefone, por grupo (`docs/specs/pre-producao/spec.md`, bloco T):
 *
 * - **owners:** não se repete entre owners no SaaS inteiro;
 * - **equipe:** não se repete entre os membros de uma organização (owner incluído);
 * - **clientes:** não se repete entre os clientes de uma organização;
 * - **equipe da plataforma:** não se repete entre si.
 *
 * Cliente e equipe da mesma organização PODEM ter o mesmo número: a pessoa da equipe que
 * também é cliente tem dois cadastros (`src/lib/tenant/team-customer.ts`).
 *
 * Nas contas (`user`), só o telefone **confirmado** conta: um número apenas declarado não
 * reserva nada, senão qualquer um trancaria o número de outra pessoa cadastrando-se com ele. E
 * "confirmado" depende do grupo (`src/lib/phone/confirmed.ts`): nos grupos que atravessam
 * organizações (owners, equipe da plataforma) só vale o que vale no sistema inteiro; na equipe
 * de uma organização vale também o que o owner dela liberou.
 *
 * `user` é global e o papel fica em `member`, então não cabe índice único: quem confirma um
 * número chama estas funções na mesma transação, sob `lockPhoneKey`.
 */

/** O papel `owner` na coluna `member.role`, que guarda papéis separados por vírgula. */
const isOwner = sql`'owner' = any(string_to_array(${member.role}, ','))`;

/** Teto de detentores devolvidos: mais que isso é dado inconsistente, não um caso de uso. */
const MAX_HOLDERS = 50;

/** Resposta única para número de conta em uso: não diz de quem é. */
export const accountPhoneInUse = () =>
  new TenantRuleError(409, "PHONE_IN_USE", "Este telefone já está em uso.");

/**
 * Trava o número até o fim da transação. Duas confirmações do mesmo número, uma em cada
 * transação, leriam "livre" ao mesmo tempo; com a trava, a segunda espera e enxerga a primeira.
 */
export async function lockPhoneKey(tx: Tx, phoneKey: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`phone:${phoneKey}`}, 0))`,
  );
}

const ids = (rows: { id: string }[]) => [...new Set(rows.map(({ id }) => id))];

/**
 * Os outros owners, de qualquer organização, com este número confirmado para o sistema inteiro.
 * `member` e `user` não têm RLS: a consulta atravessa organizações de propósito e só devolve ids.
 */
export async function ownerPhoneHolders(tx: Tx, phoneKey: string, exceptUserId?: string) {
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(
      and(
        eq(user.phoneKey, phoneKey),
        userPhoneConfirmedGlobally,
        isOwner,
        exceptUserId ? ne(user.id, exceptUserId) : undefined,
      ),
    )
    .limit(MAX_HOLDERS);

  return ids(rows);
}

/** Os outros membros da organização (owner incluído) com este número confirmado para ela. */
export async function teamPhoneHolders(
  tx: Tx,
  tenantId: string,
  phoneKey: string,
  exceptUserId?: string,
) {
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, tenantId),
        eq(user.phoneKey, phoneKey),
        userPhoneConfirmedIn(tenantId),
        exceptUserId ? ne(user.id, exceptUserId) : undefined,
      ),
    )
    .limit(MAX_HOLDERS);

  return ids(rows);
}

/** As outras pessoas da equipe da plataforma (proprietário ou suporte) com este número. */
export async function platformStaffPhoneHolders(
  tx: Tx,
  phoneKey: string,
  exceptUserId?: string,
) {
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.phoneKey, phoneKey),
        userPhoneConfirmedGlobally,
        inArray(user.role, ["platform_owner", "platform_support"]),
        exceptUserId ? ne(user.id, exceptUserId) : undefined,
      ),
    )
    .limit(MAX_HOLDERS);

  return ids(rows);
}

/**
 * Outro cliente da organização com este número, confirmado ou não: aqui o índice único
 * (`customer_tenant_phone_key_idx`) já vale para todo número. Roda em `withTenant`.
 */
export async function customerPhoneHolder(
  tx: Tx,
  tenantId: string,
  phoneKey: string,
  exceptCustomerId?: string,
) {
  const [row] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(
      and(
        eq(customer.tenantId, tenantId),
        eq(customer.phoneKey, phoneKey),
        exceptCustomerId ? ne(customer.id, exceptCustomerId) : undefined,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

export type PhoneGroup = "team" | "customer";

/**
 * 409 `PHONE_IN_USE` se o número já é de outro cadastro do mesmo grupo na organização. `exceptId`
 * é o próprio cadastro (id do usuário em `team`, do cliente em `customer`). O outro grupo não é
 * consultado: cliente e equipe podem dividir o número.
 */
export async function assertPhoneFreeInTenant(
  tx: Tx,
  tenantId: string,
  group: PhoneGroup,
  phoneKey: string,
  exceptId?: string,
) {
  const taken =
    group === "team"
      ? (await teamPhoneHolders(tx, tenantId, phoneKey, exceptId)).length > 0
      : (await customerPhoneHolder(tx, tenantId, phoneKey, exceptId)) !== null;

  if (taken) throw accountPhoneInUse();
}

/** 409 `PHONE_IN_USE` se outro owner do SaaS tem o número confirmado. */
export async function assertOwnerPhoneFree(tx: Tx, phoneKey: string, exceptUserId?: string) {
  if ((await ownerPhoneHolders(tx, phoneKey, exceptUserId)).length > 0) {
    throw accountPhoneInUse();
  }
}

/**
 * As contas que hoje têm o número confirmado em algum grupo de que `userId` faz parte (vazio =
 * livre). Quem chama decide o que fazer com elas: recusar (liberação à mão) ou mandá-las de
 * volta a "telefone pendente" (quem provou a posse fica com o número).
 *
 * `onlyTenantId` limita a pergunta à equipe de UMA organização: é o que a liberação do owner
 * dela confere, porque essa liberação só vale ali dentro. Sem ele, a pergunta é a do sistema
 * inteiro: a equipe de cada organização da conta, o grupo dos owners se ela é owner de alguma, e
 * a equipe da plataforma se faz parte.
 */
export async function accountPhoneConflicts(
  tx: Tx,
  userId: string,
  phoneKey: string,
  { onlyTenantId }: { onlyTenantId?: string } = {},
) {
  if (onlyTenantId) return teamPhoneHolders(tx, onlyTenantId, phoneKey, userId);

  const [account] = await tx
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId));
  const memberships = await tx
    .select({ tenantId: member.organizationId, owner: sql<boolean>`${isOwner}` })
    .from(member)
    .where(eq(member.userId, userId));

  const holders = new Set<string>();

  for (const { tenantId } of memberships) {
    for (const id of await teamPhoneHolders(tx, tenantId, phoneKey, userId)) holders.add(id);
  }
  if (memberships.some(({ owner }) => owner)) {
    for (const id of await ownerPhoneHolders(tx, phoneKey, userId)) holders.add(id);
  }
  if (account?.role === "platform_owner" || account?.role === "platform_support") {
    for (const id of await platformStaffPhoneHolders(tx, phoneKey, userId)) holders.add(id);
  }

  return [...holders];
}

/** A conta responde a alguém além da própria organização: é owner de alguma, ou da plataforma. */
export async function isOwnerOrPlatformStaff(tx: Tx, userId: string) {
  const [account] = await tx.select({ role: user.role }).from(user).where(eq(user.id, userId));
  if (account?.role === "platform_owner" || account?.role === "platform_support") return true;

  const [owned] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), isOwner))
    .limit(1);

  return owned !== undefined;
}
