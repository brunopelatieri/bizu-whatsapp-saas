import { isNotNull, or, type SQL, sql } from "drizzle-orm";
import type { Scope } from "@/db/rls";
import { customer, user } from "@/db/schema";

/**
 * "O telefone desta conta está confirmado?" depende de quem pergunta.
 *
 * A conta (`user`) é global, e qualquer pessoa cria uma organização. Se a liberação à mão do
 * owner de uma organização valesse em todo lugar, bastaria uma organização de fachada para
 * "confirmar" o número de outra pessoa numa conta e usá-lo nas demais. Por isso há dois níveis:
 *
 * - **no sistema inteiro** (plataforma, grupo dos owners, outras organizações): as colunas
 *   `phone_verified_*` da conta, que só guardam a prova de posse (`whatsapp`) e a liberação do
 *   proprietário da plataforma (`manual`);
 * - **numa organização:** isso, ou a liberação do owner DELA, que é uma linha em
 *   `phone_tenant_vouch` para o par (conta, organização) e para o número atual da conta.
 *
 * Toda consulta que decide algo pelo telefone da conta usa um destes predicados. O que entrega a
 * alguém uma coisa de quem tem o número (a ficha de cliente, a conversa na plataforma) usa o
 * nível do sistema inteiro: a liberação de uma organização não prova posse.
 */

/** Confirmado para o sistema inteiro. */
export const userPhoneConfirmedGlobally: SQL = isNotNull(user.phoneVerifiedAt);

/**
 * O owner desta organização liberou o número que a conta tem agora. Subconsulta correlacionada
 * com `"user"`: a consulta de fora precisa ter a tabela `user`. Sob o RLS de outro tenant a
 * linha não aparece, e a resposta é "não".
 */
export const userPhoneVouchedBy = (tenantId: string): SQL =>
  sql`exists (select 1 from phone_tenant_vouch where phone_tenant_vouch.user_id = "user"."id" and phone_tenant_vouch.tenant_id = ${tenantId} and phone_tenant_vouch.phone_key = "user"."phone_key")`;

/** Confirmado para esta organização: no sistema inteiro, ou liberado pelo owner dela. */
export const userPhoneConfirmedIn = (tenantId: string): SQL =>
  or(userPhoneConfirmedGlobally, userPhoneVouchedBy(tenantId)) as SQL;

/**
 * A ficha de cliente está confirmada, de qualquer forma (`whatsapp`, `manual`, `team`, `inbound`).
 * É a pergunta do portão do portal (T3): a ficha já é da organização, e o que ela aceitou vale
 * para ela. Quem atrai conversa é outra pergunta (`AUTO_LINK_CUSTOMER_VIAS`, sem `manual`).
 */
export const customerPhoneConfirmed: SQL = isNotNull(customer.phoneVerifiedAt);

/** O predicado do escopo: a organização, ou a plataforma (só o que vale no sistema inteiro). */
export const userPhoneConfirmed = (scope: Scope): SQL =>
  scope.kind === "tenant" ? userPhoneConfirmedIn(scope.tenantId) : userPhoneConfirmedGlobally;
