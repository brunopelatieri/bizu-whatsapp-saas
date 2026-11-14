import { and, eq, inArray } from "drizzle-orm";
import { type Tx, withPlatformScope, withTenant } from "@/db/rls";
import { customer, user } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { countConversationsByContactPhone } from "@/lib/inbox/privacy";
import { userPhoneConfirmedGlobally } from "@/lib/phone/confirmed";
import { byCustomerId, CUSTOMER_NOT_FOUND, deleteCustomerIn } from "@/lib/tenant/customers";
import { notFound } from "@/lib/tenant/errors";

/**
 * A ficha de cliente de quem é da equipe sai junto com a pessoa (D-11 de
 * `docs/specs/pre-producao/spec.md`, "Equipe que também é cliente"). É a **única** situação em que
 * apagar alguém da equipe apaga cliente, e vale só para a ficha **ligada à própria pessoa**
 * (`customer.user_id`, criada por `team-customer.ts`): outras fichas nunca são tocadas (P7).
 *
 * Três regras limitam o estrago:
 *
 * 1. **A ligação decide, e a equipe a desfaz antes.** A rota `DELETE /api/customers/:id/team-link`
 *    (`unlinkTeamCustomer`) tira a pessoa da ficha, e a ficha deixa de ser apagada com ela.
 * 2. **Só os contatos do telefone confirmado da pessoa são apagados** (`purgeTeamCustomerContacts`).
 *    Quem tem `customer:update` liga à mão o contato de qualquer número à ficha; os demais contatos só
 *    perdem o vínculo, e a conversa deles fica com a organização. "Confirmado" é o do sistema inteiro
 *    (`userPhoneConfirmedGlobally`), o mesmo que liga a ficha sozinha: a liberação de uma
 *    organização não prova posse do número.
 * 3. **O que se apaga é o que está ligado à ficha**, nunca o `chat_contact.user_id`: esse vínculo
 *    vem de telefone declarado e nunca decide exportação nem exclusão (`.claude/rules/inbox.md`).
 *
 * Trocar o papel da pessoa não passa por aqui.
 */

/** O telefone confirmado (no sistema inteiro) da conta, ou `null`. Ler **antes** de anonimizar a conta. */
async function confirmedPhoneKeyOf(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ phoneKey: user.phoneKey })
    .from(user)
    .where(and(eq(user.id, userId), userPhoneConfirmedGlobally));

  return row?.phoneKey ?? null;
}

/** O telefone confirmado de cada conta (só as que têm), numa consulta. */
async function confirmedPhoneKeys(tx: Tx, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string>();

  const rows = await tx
    .select({ id: user.id, phoneKey: user.phoneKey })
    .from(user)
    .where(and(inArray(user.id, userIds), userPhoneConfirmedGlobally));

  return new Map(rows.flatMap(({ id, phoneKey }) => (phoneKey ? [[id, phoneKey] as const] : [])));
}

/**
 * As conversas que a D-11 apagaria de cada ficha ligada: só as dos contatos do telefone confirmado da
 * pessoa. Três consultas para todas as fichas, qualquer que seja o número de pessoas.
 */
async function conversationsToDelete(
  tx: Tx,
  linked: { id: string; userId: string | null }[],
): Promise<Map<string, number>> {
  const phones = await confirmedPhoneKeys(
    tx,
    linked.flatMap(({ userId }) => (userId ? [userId] : [])),
  );
  const rows = await countConversationsByContactPhone(
    tx,
    linked.map(({ id }) => id),
  );

  const total = new Map<string, number>();
  for (const { id, userId } of linked) {
    const phoneKey = userId ? phones.get(userId) : undefined;
    total.set(
      id,
      phoneKey
        ? rows
            .filter((row) => row.customerId === id && row.phoneKey === phoneKey)
            .reduce((sum, row) => sum + row.total, 0)
        : 0,
    );
  }

  return total;
}

/** O que o aviso do diálogo mostra: existe ficha ligada e quantas conversas a remoção apagaria. */
export type TeamCustomerWarning = { conversationCount: number };

/**
 * Para cada pessoa da lista, a ficha ligada a ela **nesta organização** com as conversas que a remoção
 * dela apagaria (`null` sem ficha ligada). Roda em `withTenant`; o tamanho da equipe não muda o número
 * de consultas.
 */
export async function teamCustomerWarnings(
  tx: Tx,
  tenantId: string,
  userIds: string[],
): Promise<Map<string, TeamCustomerWarning | null>> {
  const result = new Map<string, TeamCustomerWarning | null>(userIds.map((id) => [id, null]));
  if (userIds.length === 0) return result;

  const linked = await tx
    .select({ id: customer.id, userId: customer.userId })
    .from(customer)
    .where(and(eq(customer.tenantId, tenantId), inArray(customer.userId, userIds)));
  const counts = await conversationsToDelete(tx, linked);

  for (const { id, userId } of linked) {
    if (userId) result.set(userId, { conversationCount: counts.get(id) ?? 0 });
  }

  return result;
}

type Removal = { portalUserId: string | null; storageKeys: string[] };

/**
 * `removeMember`: apaga a ficha ligada à pessoa **nesta organização**, na transação da remoção.
 * Devolve o que sobra para depois do commit (`afterCustomerDeleted`), ou `null` sem ficha ligada.
 */
export async function deleteMemberCustomer(
  tx: Tx,
  tenantId: string,
  userId: string,
  actor: { id: string; ip?: string },
): Promise<Removal | null> {
  // Trava a ficha relendo a ligação: quem desfez a ligação um instante antes (`unlinkTeamCustomer`)
  // não aparece mais aqui, e a ficha que ele quis manter não é apagada.
  const [linked] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.tenantId, tenantId), eq(customer.userId, userId)))
    .for("update");
  if (!linked) return null;

  return deleteCustomerIn(
    tx,
    tenantId,
    linked.id,
    { actor: { id: actor.id }, ip: actor.ip, metadata: { userId, via: "member_removed" } },
    { teamPhoneKey: await confirmedPhoneKeyOf(tx, userId) },
  );
}

/**
 * `anonymizeUser`: apaga as fichas ligadas à conta em **todas** as organizações, na transação da
 * exclusão (escopo de plataforma). Chamar antes de zerar o telefone da conta.
 */
export async function deleteAccountCustomers(tx: Tx, userId: string) {
  // Travadas, relendo a ligação (ver `deleteMemberCustomer`): ficha desligada ou apagada no meio não entra.
  const linked = await tx
    .select({ id: customer.id, tenantId: customer.tenantId })
    .from(customer)
    .where(eq(customer.userId, userId))
    .for("update");
  if (linked.length === 0) return { portalUserIds: [] as string[], storageKeys: [] as string[] };

  const teamPhoneKey = await confirmedPhoneKeyOf(tx, userId);
  const portalUserIds = new Set<string>();
  const storageKeys = new Set<string>();

  for (const { id, tenantId } of linked) {
    const removed = await deleteCustomerIn(
      tx,
      tenantId,
      id,
      { actor: { type: "system", id: null }, metadata: { userId, via: "account_deleted" } },
      { teamPhoneKey },
    );
    if (removed.portalUserId) portalUserIds.add(removed.portalUserId);
    for (const key of removed.storageKeys) storageKeys.add(key);
  }

  return { portalUserIds: [...portalUserIds], storageKeys: [...storageKeys] };
}

/** A pessoa da equipe e o número de fichas ligadas a ela em todas as organizações, para o aviso da exclusão da conta. */
export async function accountCustomerWarning(
  tx: Tx,
  userId: string,
): Promise<{ customers: number; conversationCount: number }> {
  const linked = await tx
    .select({ id: customer.id, userId: customer.userId })
    .from(customer)
    .where(eq(customer.userId, userId));
  if (linked.length === 0) return { customers: 0, conversationCount: 0 };

  const counts = await conversationsToDelete(tx, linked);

  return {
    customers: linked.length,
    conversationCount: [...counts.values()].reduce((sum, total) => sum + total, 0),
  };
}

/** `GET /api/me/deletion`: o aviso da exclusão da conta, lido da sessão da própria pessoa. */
export function accountCustomerRecords(userId: string) {
  return withPlatformScope("lgpd: aviso das fichas ligadas à conta", (tx) =>
    accountCustomerWarning(tx, userId),
  );
}

/**
 * `DELETE /api/customers/:id/team-link`: a equipe desfaz a ligação da ficha com a pessoa. A ficha
 * continua (com as conversas) e deixa de ser apagada junto com ela. Idempotente: ficha sem ligação
 * responde como a que foi desligada; ficha de outra organização é 404.
 */
export async function unlinkTeamCustomer(
  tenantId: string,
  customerId: string,
  actor: { userId: string; ip?: string },
) {
  await withTenant(tenantId, async (tx) => {
    const [current] = await tx
      .select({ id: customer.id, userId: customer.userId })
      .from(customer)
      .where(byCustomerId(tenantId, customerId))
      .for("update");
    if (!current) throw notFound(CUSTOMER_NOT_FOUND);
    if (!current.userId) return;

    await tx.update(customer).set({ userId: null }).where(eq(customer.id, customerId));
    await auditInTransaction(tx, "customer.team_unlinked", {
      actor: { id: actor.userId },
      tenantId,
      target: { type: "customer", id: customerId },
      metadata: { userId: current.userId },
      ip: actor.ip,
    });
  });
}
