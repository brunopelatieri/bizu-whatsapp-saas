import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { customer, member, user } from "@/db/schema";
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
 * reserva nada, senão qualquer um trancaria o número de outra pessoa cadastrando-se com ele.
 * `user` é global e o papel fica em `member`, então não cabe índice único: quem confirma um
 * número chama estas funções na mesma transação, sob `lockPhoneKey`.
 */

/** O papel `owner` na coluna `member.role`, que guarda papéis separados por vírgula. */
const isOwner = sql`'owner' = any(string_to_array(${member.role}, ','))`;

const confirmed = isNotNull(user.phoneVerifiedAt);

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

/**
 * Outro owner, de qualquer organização, com este número confirmado. `member` e `user` não têm
 * RLS: a consulta atravessa organizações de propósito e só devolve o id.
 */
export async function ownerPhoneHolder(tx: Tx, phoneKey: string, exceptUserId?: string) {
  const [row] = await tx
    .select({ id: user.id })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(
      and(
        eq(user.phoneKey, phoneKey),
        confirmed,
        isOwner,
        exceptUserId ? ne(user.id, exceptUserId) : undefined,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

/** Outro membro da organização (owner incluído) com este número confirmado. */
export async function teamPhoneHolder(
  tx: Tx,
  tenantId: string,
  phoneKey: string,
  exceptUserId?: string,
) {
  const [row] = await tx
    .select({ id: user.id })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .where(
      and(
        eq(member.organizationId, tenantId),
        eq(user.phoneKey, phoneKey),
        confirmed,
        exceptUserId ? ne(user.id, exceptUserId) : undefined,
      ),
    )
    .limit(1);

  return row?.id ?? null;
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

/** Outra pessoa da equipe da plataforma (proprietário ou suporte) com este número confirmado. */
export async function platformStaffPhoneHolder(
  tx: Tx,
  phoneKey: string,
  exceptUserId?: string,
) {
  const [row] = await tx
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.phoneKey, phoneKey),
        confirmed,
        inArray(user.role, ["platform_owner", "platform_support"]),
        exceptUserId ? ne(user.id, exceptUserId) : undefined,
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
  const holder =
    group === "team"
      ? await teamPhoneHolder(tx, tenantId, phoneKey, exceptId)
      : await customerPhoneHolder(tx, tenantId, phoneKey, exceptId);

  if (holder) throw accountPhoneInUse();
}

/** 409 `PHONE_IN_USE` se outro owner do SaaS tem o número confirmado. */
export async function assertOwnerPhoneFree(tx: Tx, phoneKey: string, exceptUserId?: string) {
  if (await ownerPhoneHolder(tx, phoneKey, exceptUserId)) throw accountPhoneInUse();
}

/**
 * Tudo o que a conta `userId` precisa ter livre para ficar com o número confirmado: o grupo de
 * cada organização de que ela é membro, o dos owners se ela é owner de alguma, e o da equipe
 * da plataforma se ela faz parte. Devolve os ids das contas que hoje têm o número em algum
 * desses grupos (vazio = livre). Quem chama decide o que fazer com elas: recusar (liberação
 * manual) ou mandá-las de volta a "telefone pendente" (quem provou a posse fica com o número).
 */
export async function accountPhoneConflicts(tx: Tx, userId: string, phoneKey: string) {
  const [account] = await tx
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId));
  const memberships = await tx
    .select({ tenantId: member.organizationId, owner: sql<boolean>`${isOwner}` })
    .from(member)
    .where(eq(member.userId, userId));

  const holders = new Set<string>();
  const add = (id: string | null) => {
    if (id) holders.add(id);
  };

  for (const { tenantId } of memberships) {
    add(await teamPhoneHolder(tx, tenantId, phoneKey, userId));
  }
  if (memberships.some(({ owner }) => owner)) {
    add(await ownerPhoneHolder(tx, phoneKey, userId));
  }
  if (account?.role === "platform_owner" || account?.role === "platform_support") {
    add(await platformStaffPhoneHolder(tx, phoneKey, userId));
  }

  return [...holders];
}
