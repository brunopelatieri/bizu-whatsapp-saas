import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { AUTO_LINK_CUSTOMER_VIAS } from "@/lib/phone/verification";
import { userPhoneConfirmed } from "@/lib/phone/confirmed";
import { type Scope, scopeTenantId, type Tx } from "@/db/rls";
import { chatContact, chatContactIdentity, customer, member, user } from "@/db/schema";
import { conversation } from "@/db/schema";
import { notifyInbox } from "@/lib/inbox/notify";
import type { ChatContactOrigin } from "@/lib/inbox/constants";
import { normalizePhone } from "@/lib/phone/br";

/**
 * Quem escreve no WhatsApp (`chat_contact`, plano T4). O contato é achado pela `phone_key` (o
 * celular sem o 9º dígito), então o número com e sem o 9 é um contato só. O vínculo automático
 * com `user` ou `customer` só acontece com correspondência **única**; o resto é manual (C2).
 */

/** O suficiente para tratar um telefone de provedor; nunca vira resposta de API. */
export type ProviderPhone = { phone: string; phoneKey: string };

/**
 * Telefone como o provedor entregou (só dígitos, com DDI, sem `+`). O `+` é acrescentado para a
 * regra do Brasil só valer com DDI `55`: sem ele, um número estrangeiro de 10 ou 11 dígitos seria
 * lido como DDD + número. Número que o normalizador recusa ainda é um contato (o provedor o
 * entregou): fica com os próprios dígitos como chave.
 */
export function providerPhone(raw: string | null | undefined): ProviderPhone | null {
  const digits = raw?.replace(/\D/g, "") ?? "";
  if (digits.length < 6 || digits.length > 20) return null;

  const result = normalizePhone(`+${digits}`);
  return result.ok ? { phone: result.phone, phoneKey: result.key } : { phone: digits, phoneKey: digits };
}

const scopeFilter = (scope: Scope) =>
  scope.kind === "tenant"
    ? eq(chatContact.tenantId, scope.tenantId)
    : isNull(chatContact.tenantId);

export type ContactRow = typeof chatContact.$inferSelect;

/** Contato do escopo com a mesma `phone_key` (o número com ou sem o 9º dígito). */
export async function findContactByPhoneKey(tx: Tx, scope: Scope, phoneKey: string) {
  const [row] = await tx
    .select()
    .from(chatContact)
    .where(and(scopeFilter(scope), eq(chatContact.phoneKey, phoneKey)));
  return row ?? null;
}

/** Contato que já mostrou este LID junto com o telefone. Sem ele, a mensagem é descartada. */
export async function findContactByLid(tx: Tx, scope: Scope, lid: string) {
  const [row] = await tx
    .select({ contact: chatContact })
    .from(chatContactIdentity)
    .innerJoin(chatContact, eq(chatContact.id, chatContactIdentity.contactId))
    .where(
      and(
        scope.kind === "tenant"
          ? eq(chatContactIdentity.tenantId, scope.tenantId)
          : isNull(chatContactIdentity.tenantId),
        eq(chatContactIdentity.kind, "lid"),
        eq(chatContactIdentity.value, lid),
      ),
    );
  return row?.contact ?? null;
}

/** Grava o LID do contato. O mesmo LID já ligado a outro contato fica como estava. */
export async function rememberLid(tx: Tx, scope: Scope, contactId: string, lid: string) {
  const values = { tenantId: scopeTenantId(scope), contactId, kind: "lid" as const, value: lid };

  await (scope.kind === "tenant"
    ? tx
        .insert(chatContactIdentity)
        .values(values)
        .onConflictDoNothing({
          target: [chatContactIdentity.tenantId, chatContactIdentity.kind, chatContactIdentity.value],
        })
    : tx
        .insert(chatContactIdentity)
        .values(values)
        .onConflictDoNothing({
          target: [chatContactIdentity.kind, chatContactIdentity.value],
          where: sql`tenant_id is null`,
        }));
}

/**
 * Acha ou cria o contato pela `phone_key`, em um comando (duas mensagens simultâneas do mesmo
 * número não criam dois). `waName` atualiza o nome do perfil quando vem; `inserted` diz se nasceu
 * agora (só então há vínculo automático).
 */
export async function upsertContact(
  tx: Tx,
  scope: Scope,
  input: ProviderPhone & { waName: string | null; createdVia: ChatContactOrigin },
) {
  const values = {
    tenantId: scopeTenantId(scope),
    phone: input.phone,
    phoneKey: input.phoneKey,
    waName: input.waName,
    createdVia: input.createdVia,
  };
  const set = {
    waName: sql`coalesce(excluded.wa_name, ${chatContact.waName})`,
    updatedAt: sql`now()`,
  };
  // `xmax = 0` só na linha recém-inserida: no `DO UPDATE` ela carrega a transação que atualizou.
  const returning = { id: chatContact.id, inserted: sql<boolean>`(xmax = 0)` };

  const [row] = await (scope.kind === "tenant"
    ? tx
        .insert(chatContact)
        .values(values)
        .onConflictDoUpdate({ target: [chatContact.tenantId, chatContact.phoneKey], set })
        .returning(returning)
    : tx
        .insert(chatContact)
        .values(values)
        .onConflictDoUpdate({
          target: chatContact.phoneKey,
          targetWhere: sql`tenant_id is null`,
          set,
        })
        .returning(returning));
  if (!row) throw new Error("Contato não gravado.");

  return row;
}

/**
 * Quem tem a mesma `phone_key` no escopo: membros ativos do tenant (ou usuários, na plataforma) e
 * clientes do tenant. Base do vínculo automático e da lista de candidatos do painel (C2). A
 * plataforma nunca consulta `customer` de tenant (decisão do proprietário).
 *
 * `verifiedOnly` deixa só quem tem o telefone **confirmado** (`phone_verified_at`): é o filtro do
 * vínculo automático. O painel mostra todos, porque ali quem decide é a equipe.
 */
export async function linkCandidates(
  tx: Tx,
  scope: Scope,
  phoneKey: string,
  limit = 20,
  { verifiedOnly = false }: { verifiedOnly?: boolean } = {},
) {
  // Confirmado PARA ESTE ESCOPO: a liberação do owner de outra organização não vale aqui
  // (`src/lib/phone/confirmed.ts`). No painel, a equipe vê quem tem o número só declarado e
  // decide sabendo disso.
  const confirmed = userPhoneConfirmed(scope);
  const userIsVerified = sql<boolean>`coalesce(${confirmed}, false)`;
  const userVerified = verifiedOnly ? confirmed : undefined;
  // Na ficha, `manual` é o número que o próprio cliente declarou e o owner liberou sem prova:
  // serve para a organização tratar a ficha como confirmada, mas não para entregar a ela,
  // sozinha, a conversa de quem tiver esse número. O que a equipe informou (`team`), o contato
  // que escreveu (`inbound`) e a prova de posse (`whatsapp`) atraem.
  const customerVerified = verifiedOnly
    ? and(
        isNotNull(customer.phoneVerifiedAt),
        inArray(customer.phoneVerifiedVia, [...AUTO_LINK_CUSTOMER_VIAS]),
      )
    : undefined;

  const users =
    scope.kind === "tenant"
      ? await tx
          .select({ id: user.id, name: user.name, phoneVerified: userIsVerified })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(
            and(
              eq(member.organizationId, scope.tenantId),
              eq(user.phoneKey, phoneKey),
              eq(user.banned, false),
              userVerified,
            ),
          )
          .orderBy(user.name)
          .limit(limit)
      : await tx
          .select({ id: user.id, name: user.name, phoneVerified: userIsVerified })
          .from(user)
          .where(and(eq(user.phoneKey, phoneKey), eq(user.banned, false), userVerified))
          .orderBy(user.name)
          .limit(limit);

  const customers =
    scope.kind === "tenant"
      ? await tx
          .select({
            id: customer.id,
            name: customer.name,
            phone: customer.phoneNormalized,
            phoneVerified: sql<boolean>`${customer.phoneVerifiedAt} is not null`,
          })
          .from(customer)
          .where(
            and(
              eq(customer.tenantId, scope.tenantId),
              eq(customer.phoneKey, phoneKey),
              customerVerified,
            ),
          )
          .limit(limit)
      : [];

  return { users, customers };
}

/**
 * Vínculo automático do contato recém-criado, só com correspondência única e só com telefone
 * **confirmado** (um número apenas declarado não pode atrair a conversa do verdadeiro dono dele).
 *
 * No tenant, o cliente vem antes do membro: quem é da equipe e também é cliente da organização
 * tem os dois cadastros com o mesmo número, e a conversa fica na ficha de cliente (o painel
 * mostra o selo da equipe). Sem cliente, vale o membro. Na plataforma, só o usuário.
 */
export async function autoLinkContact(tx: Tx, scope: Scope, contactId: string, phoneKey: string) {
  const { users, customers } = await linkCandidates(tx, scope, phoneKey, 2, {
    verifiedOnly: true,
  });

  const link =
    customers.length === 1 && customers[0]
      ? { customerId: customers[0].id }
      : users.length === 1 && users[0]
        ? { userId: users[0].id }
        : null;
  if (!link) return null;

  await tx.update(chatContact).set(link).where(eq(chatContact.id, contactId));
  return link;
}

/**
 * O cliente provou a posse do número (link de verificação): o contato do tenant que já escreveu
 * por ele, ainda sem cadastro, passa a ser deste cliente. Só contato sem vínculo: o que a equipe
 * ligou à mão não é desfeito. Avisa as conversas do contato, para o painel reler o vínculo.
 */
export async function linkUnlinkedContactToCustomer(
  tx: Tx,
  tenantId: string,
  phoneKey: string,
  customerId: string,
) {
  const linked = await tx
    .update(chatContact)
    .set({ customerId })
    .where(
      and(
        eq(chatContact.tenantId, tenantId),
        eq(chatContact.phoneKey, phoneKey),
        isNull(chatContact.customerId),
        isNull(chatContact.userId),
      ),
    )
    .returning({ id: chatContact.id });

  for (const contact of linked) {
    const conversations = await tx
      .select({ id: conversation.id, assignedUserId: conversation.assignedUserId })
      .from(conversation)
      .where(eq(conversation.contactId, contact.id));

    for (const row of conversations) {
      await notifyInbox(tx, {
        s: tenantId,
        c: row.id,
        k: "conversation",
        a: row.assignedUserId,
        p: row.assignedUserId,
      });
    }
  }

  return linked.length;
}
