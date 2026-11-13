import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { withPlatformScope } from "@/db/rls";
import { customer, member, organization, user } from "@/db/schema";
import {
  customerPhoneConfirmed,
  userPhoneConfirmedGlobally,
  userPhoneConfirmedIn,
} from "@/lib/phone/confirmed";
import { confirmableRecord } from "@/lib/phone/requests";
import { isOwnerOrPlatformStaff } from "@/lib/phone/uniqueness";

/**
 * O predicado do portão de telefone (SPEC `pre-producao`, T3 e D-2). Decide se a sessão usa o
 * sistema com o telefone que tem; quem aplica é `requireAuth` e `requirePortalAuth`, só com
 * `PHONE_VERIFICATION_REQUIRED=true`. É o mesmo alcance da T2a ("Alcance da confirmação"): nada
 * aqui vale mais do que o responsável que confirmou.
 *
 * - **Equipe:** passa com a conta confirmada no sistema inteiro. O membro comum também passa na
 *   **organização ativa da sessão** se ela o liberou (`userPhoneConfirmedIn`) e ele ainda é da
 *   equipe dela. Sem organização ativa, só a confirmação do sistema vale.
 * - **Owner (de qualquer organização) e equipe da plataforma:** só a confirmação do sistema. A
 *   liberação de uma organização não os alcança (eles respondem à plataforma, P16).
 */
export async function teamPhoneGatePasses(userId: string, activeTenantId: string | null) {
  // O caso comum (conta confirmada no sistema) é uma leitura de `user`, que não tem RLS: roda em
  // toda requisição autenticada, então fica fora de transação.
  const [account] = await getDb()
    .select({ global: sql<boolean>`coalesce(${userPhoneConfirmedGlobally}, false)` })
    .from(user)
    .where(eq(user.id, userId));

  if (!account) return false;
  if (account.global) return true;
  if (!activeTenantId) return false;

  // A liberação da organização (`phone_tenant_vouch`, RLS forçado) e o papel, só para quem precisa.
  return withPlatformScope("telefone: portão de acesso da equipe", async (tx) => {
    const [vouched] = await tx
      .select({ ok: sql<boolean>`coalesce(${userPhoneConfirmedIn(activeTenantId)}, false)` })
      .from(user)
      .where(eq(user.id, userId));

    if (!vouched?.ok) return false;
    if (await isOwnerOrPlatformStaff(tx, userId)) return false;

    // A liberação cai quando a pessoa sai da equipe; a conferência aqui não depende disso.
    const [membership] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, activeTenantId)))
      .limit(1);

    return membership !== undefined;
  });
}

/**
 * O portão do portal avalia a **ficha de cliente** da organização em uso, nunca a conta
 * (`portal_user`), que nenhuma organização confirma (T2a). Contam as fichas que podem confirmar o
 * número (`confirmableRecord`, as mesmas do link e do reenvio).
 *
 * - Com organização ativa e ficha nela: a ficha decide.
 * - Sem organização ativa (ou sem ficha nela): passa se alguma ficha da pessoa está confirmada. O
 *   lead do autocadastro confirma o número antes de virar cliente ativo, e não pode ficar trancado
 *   depois disso; os dados da organização continuam atrás de `requirePortalTenant`.
 * - Sem ficha nenhuma que possa confirmar: passa. Não há número a confirmar nem dado de organização
 *   a abrir (`requirePortalTenant` recusa), e a pessoa não teria como sair dali.
 */
export function portalPhoneGatePasses(portalUserId: string, activeTenantId: string | null) {
  return withPlatformScope("telefone: portão de acesso do portal", async (tx) => {
    const records = await tx
      .select({
        tenantId: customer.tenantId,
        confirmed: sql<boolean>`coalesce(${customerPhoneConfirmed}, false)`,
      })
      .from(customer)
      .innerJoin(organization, eq(organization.id, customer.tenantId))
      .where(and(eq(customer.portalUserId, portalUserId), confirmableRecord));

    if (records.length === 0) return true;

    const current = records.find(({ tenantId }) => tenantId === activeTenantId);
    if (current) return current.confirmed;

    return records.some(({ confirmed }) => confirmed);
  });
}
