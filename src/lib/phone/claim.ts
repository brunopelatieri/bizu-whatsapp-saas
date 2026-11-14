import { and, eq, or } from "drizzle-orm";
import { logError } from "@/api/log";
import type { Tx } from "@/db/rls";
import { customer, type phoneVerification, portalUser } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { linkUnlinkedContactToCustomer } from "@/lib/inbox/contacts";
import { notifyCustomerClaimed } from "@/lib/phone/notify";
import { type PhoneClaimPayload, verifiedPhone } from "@/lib/phone/verification";
import { TenantRuleError } from "@/lib/tenant/errors";
import { linkVerifiedTeamMember } from "@/lib/tenant/team-customer";

/**
 * O telefone que já existe (P3, D-1, `purpose = claim`; SPEC `pre-producao`, "Telefone que já
 * existe"). **Quem verifica fica com o número.**
 *
 * Só nasce no autocadastro do portal (decisão do proprietário de 2026-11-14: a equipe não pede
 * `claim`, recebe 409 `PHONE_IN_USE` como sempre). A pessoa do portal se cadastrou com o número de
 * uma ficha que já existe; a ficha nova ainda não existe (`subject_id` é o id que ela vai ganhar) e
 * os dados dela ficam no `payload` do pedido. O link vai ao número e **só confirma na sessão do
 * portal de quem se cadastrou** (`requested_by_id`): quem tem o número mas não a sessão, ou a sessão
 * mas não o número, não fecha nada. Sem rota pública.
 *
 * Confirmado, na mesma transação, com a ficha que tinha o número travada (`lockForConfirmation`):
 * a ficha antiga sai por `deleteCustomerIn` (contatos, conversas, mensagens, arquivos, pedidos e o
 * vínculo do portal; os objetos depois do commit) e a nova nasce com o número confirmado
 * (`whatsapp`). A liberação à mão nunca fecha um `claim`: sem prova de posse, não se apaga a ficha
 * de ninguém (409 `CLAIM_LINK_ONLY`).
 *
 * Só `src/lib/phone/requests.ts` chama este módulo: abrir, confirmar e fechar pedido é de lá.
 */

type Request = typeof phoneVerification.$inferSelect;

/**
 * `customers.ts` importa `requests.ts`, que importa este módulo: carregar a exclusão de cliente só na
 * hora evita o ciclo na inicialização dos módulos.
 */
const customersModule = () => import("@/lib/tenant/customers");

export const CLAIM_LINK_ONLY = () =>
  new TenantRuleError(
    409,
    "CLAIM_LINK_ONLY",
    "Este número já é de outra ficha: só o link enviado ao número confirma. A liberação à mão não apaga a ficha de ninguém.",
  );

/** O que fica para depois do commit: os objetos e as contas órfãs das fichas apagadas, e o aviso ao owner. */
export type ClaimEffects = {
  tenantId: string;
  newCustomerId: string;
  phoneHint: string;
  deleted: { portalUserId: string | null; storageKeys: string[] }[];
};

function payloadOf(request: Request): PhoneClaimPayload | null {
  const value = request.payload as Partial<PhoneClaimPayload> | null;
  if (!value || typeof value.name !== "string" || typeof value.email !== "string") return null;
  return { name: value.name, email: value.email };
}

/**
 * O efeito do `claim` confirmado pelo link. Roda na transação da confirmação (escopo de plataforma),
 * com a ficha que tem o número e o pedido já travados. `invalid` é o 400 de sempre: o pedido não
 * serve mais (a pessoa sumiu ou trocou de e-mail, ou já tem ficha nesta organização).
 */
export async function applyCustomerClaim(
  tx: Tx,
  request: Request,
  proven: boolean,
  invalid: () => Error,
): Promise<ClaimEffects> {
  if (!proven) throw CLAIM_LINK_ONLY();

  const payload = payloadOf(request);
  const tenantId = request.tenantId;
  if (
    !payload ||
    !tenantId ||
    !request.phone ||
    request.requestedByType !== "portal_user" ||
    !request.requestedById
  ) {
    throw invalid();
  }

  const [person] = await tx
    .select({ id: portalUser.id, email: portalUser.email, emailVerified: portalUser.emailVerified })
    .from(portalUser)
    .where(eq(portalUser.id, request.requestedById));
  if (!person?.emailVerified || person.email !== payload.email) throw invalid();

  // A pessoa já tem ficha nesta organização (pela conta ou pelo e-mail): o `claim` não serve mais, e
  // nunca apaga a ficha dela mesma.
  const [own] = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(
      and(
        eq(customer.tenantId, tenantId),
        or(eq(customer.portalUserId, person.id), eq(customer.email, payload.email)),
      ),
    )
    .limit(1);
  if (own) throw invalid();

  // A ficha que tem o número agora (no máximo uma: índice único por organização). Pode ter sido
  // apagada ou trocado de número enquanto o link estava a caminho: aí nada é apagado.
  const holders = await tx
    .select({ id: customer.id })
    .from(customer)
    .where(and(eq(customer.tenantId, tenantId), eq(customer.phoneKey, request.phoneKey)))
    .for("update");

  const { deleteCustomerIn } = await customersModule();
  const deleted: ClaimEffects["deleted"] = [];
  for (const holder of holders) {
    deleted.push(
      await deleteCustomerIn(tx, tenantId, holder.id, {
        actor: { type: "system", id: null },
        metadata: { via: "phone_claim", newCustomerId: request.subjectId },
      }),
    );
  }

  const [created] = await tx
    .insert(customer)
    .values({
      id: request.subjectId,
      tenantId,
      portalUserId: person.id,
      name: payload.name,
      email: payload.email,
      phone: request.phone,
      phoneNormalized: request.phoneNormalized,
      phoneKey: request.phoneKey,
      ...verifiedPhone("whatsapp"),
    })
    .returning({ id: customer.id });
  if (!created) throw new Error("ficha do claim não criada");

  const phoneHint = request.phoneNormalized.slice(-4);
  await auditInTransaction(tx, "portal.signed_up", {
    actor: { type: "portal_user", id: person.id },
    tenantId,
    target: { type: "customer", id: created.id },
    metadata: { via: "phone_claim" },
  });
  for (const holder of holders) {
    // Ids e os 4 últimos dígitos (a SPEC pede o final do número aqui); nunca o número inteiro.
    await auditInTransaction(tx, "customer.deleted_by_phone_claim", {
      actor: { type: "portal_user", id: person.id },
      tenantId,
      target: { type: "customer", id: holder.id },
      metadata: { newCustomerId: created.id, phoneHint },
    });
  }

  // Como na confirmação do cadastro pelo link: a prova de posse liga a pessoa da equipe com o número
  // e o contato sem vínculo que já escreveu dele (os contatos da ficha antiga saíram com ela).
  await linkVerifiedTeamMember(tx, tenantId, created.id, request.phoneKey);
  await linkUnlinkedContactToCustomer(tx, tenantId, request.phoneKey, created.id);

  return { tenantId, newCustomerId: created.id, phoneHint, deleted };
}

/** Depois do commit: objetos e contas órfãs das fichas apagadas, e o e-mail aos owners. Falha vira log. */
export async function afterCustomerClaim(effects: ClaimEffects) {
  const { afterCustomerDeleted } = await customersModule();
  for (const removed of effects.deleted) {
    await afterCustomerDeleted(removed).catch((error: unknown) =>
      logError("Falha ao concluir a exclusão da ficha substituída pelo claim", error),
    );
  }
  if (effects.deleted.length === 0) return;

  await notifyCustomerClaimed(effects).catch((error: unknown) =>
    logError("Falha ao avisar a organização sobre a ficha substituída", error),
  );
}
