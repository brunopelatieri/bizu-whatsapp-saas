import { and, eq } from "drizzle-orm";
import { logError } from "@/api/log";
import type { Tx } from "@/db/rls";
import { customer } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { purgeCustomerContacts, purgeTeamCustomerContacts } from "@/lib/inbox/privacy";
import { deleteVerificationsOf } from "@/lib/phone/verification-records";
import { dropOrphanPortalUser, leavePortalTenant } from "@/lib/portal/access";
import { getStorage } from "@/lib/storage";
import { CUSTOMER_NOT_FOUND } from "@/lib/tenant/customer-constants";
import { notFound } from "@/lib/tenant/errors";

/**
 * A exclusão de uma ficha de cliente, sem o resto das regras de `customers.ts`: a exclusão pela
 * equipe, a D-11 (`team-customer-removal.ts`) e o `claim` (`src/lib/phone/claim.ts`) passam por
 * aqui. Não importa `requests.ts`, de onde o `claim` a chama.
 */

const byId = (tenantId: string, customerId: string) =>
  and(eq(customer.id, customerId), eq(customer.tenantId, tenantId));

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
  if (!found) throw notFound(CUSTOMER_NOT_FOUND);

  const inbox =
    options.teamPhoneKey === undefined
      ? await purgeCustomerContacts(tx, [found.id])
      : await purgeTeamCustomerContacts(tx, found.id, options.teamPhoneKey);
  await deleteVerificationsOf(tx, "customer", [found.id]);
  const [removed] = await tx
    .delete(customer)
    .where(byId(tenantId, customerId))
    .returning({ portalUserId: customer.portalUserId });
  if (!removed) throw notFound(CUSTOMER_NOT_FOUND);

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
