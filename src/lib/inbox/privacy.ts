import { and, asc, desc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { chatContact, conversation, file, message, organization } from "@/db/schema";
import { notifyInbox } from "@/lib/inbox/notify";

/**
 * LGPD da caixa de entrada (SPEC, "Segurança", item LGPD; C7). Só este módulo apaga e exporta
 * conversas (T13): os ganchos de `src/lib/lgpd/` e de `src/lib/tenant/customers.ts` chamam aqui,
 * dentro da transação deles, e apagam os objetos do armazenamento **depois do commit** com as
 * chaves devolvidas (falha ao apagar deixa um objeto órfão no log, nunca uma pessoa nos dados).
 *
 * Apagar o `chat_contact` leva por cascata a identidade (LID), as conversas e as mensagens. A
 * linha de `file` da mídia não cai em cascata (a mensagem só aponta para ela, `set null`): sai
 * aqui, com a chave do objeto.
 */

export type InboxPurge = { contacts: number; storageKeys: string[] };

const NONE: InboxPurge = { contacts: 0, storageKeys: [] };

/** Teto de mensagens no arquivo da exportação (as mais recentes); o zip é montado em memória. */
export const EXPORT_MESSAGE_LIMIT = 20_000;

/**
 * Apaga os contatos que casam com `where`, com conversas, mensagens e a mídia delas. `notify`
 * avisa as telas abertas (a conversa some na releitura); na exclusão da organização não há quem
 * avisar.
 */
async function purgeContacts(
  tx: Tx,
  where: SQL,
  options: { notify: boolean },
): Promise<InboxPurge> {
  const contactIds = tx.select({ id: chatContact.id }).from(chatContact).where(where);
  const conversationIds = tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(inArray(conversation.contactId, contactIds));
  const messageIds = tx
    .select({ id: message.id })
    .from(message)
    .where(inArray(message.conversationId, conversationIds));
  const messageFiles = tx
    .select({ id: message.fileId })
    .from(message)
    .where(and(inArray(message.conversationId, conversationIds), isNotNull(message.fileId)));

  const files = await tx
    .delete(file)
    .where(
      or(
        and(eq(file.ownerType, "message"), inArray(file.ownerId, messageIds)),
        inArray(file.id, messageFiles),
      ),
    )
    .returning({ key: file.key });

  const conversations = options.notify
    ? await tx
        .select({
          id: conversation.id,
          tenantId: conversation.tenantId,
          assignedUserId: conversation.assignedUserId,
        })
        .from(conversation)
        .where(inArray(conversation.contactId, contactIds))
    : [];

  const removed = await tx.delete(chatContact).where(where).returning({ id: chatContact.id });
  if (removed.length === 0 && files.length === 0) return NONE;

  for (const row of conversations) {
    // Com `a`, o aviso não relê a conversa (que já não existe).
    await notifyInbox(tx, { s: row.tenantId, c: row.id, k: "conversation", a: row.assignedUserId });
  }

  return { contacts: removed.length, storageKeys: [...new Set(files.map(({ key }) => key))] };
}

/**
 * Exclusão ou anonimização de `customer` (SPEC): os contatos vinculados a ele somem com as
 * conversas, as mensagens e a mídia. Roda no escopo de quem chama (o RLS do tenant, em
 * `deleteCustomer`; o de plataforma, na anonimização LGPD).
 */
export function purgeCustomerContacts(tx: Tx, customerIds: string[]): Promise<InboxPurge> {
  if (customerIds.length === 0) return Promise.resolve(NONE);
  return purgeContacts(tx, inArray(chatContact.customerId, customerIds), { notify: true });
}

/**
 * Exclusão da organização: a linha de `organization` é anonimizada, não apagada, então o
 * `cascade` não roda. Todos os contatos do tenant saem, com conversas e mensagens. A mídia
 * (`file` com o `tenant_id`) já sai inteira em `anonymizeTenant`; as chaves daqui só somam.
 */
export function purgeTenantInbox(tx: Tx, tenantId: string): Promise<InboxPurge> {
  return purgeContacts(tx, eq(chatContact.tenantId, tenantId), { notify: false });
}

/**
 * Anonimização de `user`. Como atendente: as mensagens que enviou ficam sem autor e as conversas
 * que encerrou, sem `closed_by` (as que atendia já voltaram à fila por `releaseAssignments`).
 * Como contato: no tenant, o contato perde o vínculo (a conversa é do owner, controlador); na
 * plataforma, que é a controladora da conversa com o próprio usuário, o contato vinculado a ele
 * sai com as conversas e a mídia, como o do cliente no tenant.
 */
export async function detachUserFromInbox(tx: Tx, userId: string): Promise<InboxPurge> {
  const platform = await purgeContacts(
    tx,
    and(isNull(chatContact.tenantId), eq(chatContact.userId, userId)) as SQL,
    { notify: true },
  );

  await tx
    .update(chatContact)
    .set({ userId: null, updatedAt: sql`now()` })
    .where(eq(chatContact.userId, userId));
  await tx.update(message).set({ senderUserId: null }).where(eq(message.senderUserId, userId));
  await tx.update(conversation).set({ closedBy: null }).where(eq(conversation.closedBy, userId));

  return platform;
}

export type ExportedMessage = {
  em: string;
  direcao: "recebida" | "enviada";
  tipo: string;
  texto: string | null;
  modelo: string | null;
  situacao: string | null;
  /** Mídia por referência: nome, tipo e tamanho, nunca o conteúdo. */
  anexo: { nome: string; tipo: string; tamanho: number } | null;
};

export type ExportedConversation = {
  /** Organização com quem a conversa aconteceu; `null` é a plataforma. */
  organizacao: string | null;
  telefone: string;
  nomeNoWhatsapp: string | null;
  situacao: string;
  iniciadaEm: string;
  mensagens: ExportedMessage[];
};

/**
 * As conversas em que o titular é o contato: pelos cadastros de cliente (exportação do portal) ou
 * pelo vínculo com o usuário (exportação da equipe, em qualquer escopo). Sem dado de terceiros:
 * nem quem atendeu, nem o nome dado pela equipe, nem a carga do provedor ou o erro dele. Roda em
 * `withPlatformScope` (a exportação atravessa tenants, como `cadastros-nas-organizacoes.json`).
 */
export async function conversationsForExport(
  tx: Tx,
  subject: { customerIds: string[] } | { userId: string },
  limit = EXPORT_MESSAGE_LIMIT,
): Promise<{ conversations: ExportedConversation[]; truncated: boolean }> {
  const contactWhere =
    "userId" in subject
      ? eq(chatContact.userId, subject.userId)
      : subject.customerIds.length > 0
        ? inArray(chatContact.customerId, subject.customerIds)
        : undefined;
  if (!contactWhere) return { conversations: [], truncated: false };

  const heads = await tx
    .select({
      id: conversation.id,
      tenantId: conversation.tenantId,
      tenantName: organization.name,
      phone: chatContact.phone,
      waName: chatContact.waName,
      status: conversation.status,
      createdAt: conversation.createdAt,
    })
    .from(conversation)
    .innerJoin(chatContact, eq(conversation.contactId, chatContact.id))
    .leftJoin(organization, eq(conversation.tenantId, organization.id))
    .where(contactWhere)
    .orderBy(asc(conversation.createdAt), asc(conversation.id));
  if (heads.length === 0) return { conversations: [], truncated: false };

  const rows = await tx
    .select({
      conversationId: message.conversationId,
      createdAt: message.createdAt,
      direction: message.direction,
      type: message.type,
      text: message.text,
      templateName: message.templateName,
      status: message.status,
      fileName: file.name,
      fileMime: file.mime,
      fileSize: file.size,
    })
    .from(message)
    .leftJoin(file, eq(message.fileId, file.id))
    .where(
      inArray(
        message.conversationId,
        heads.map(({ id }) => id),
      ),
    )
    // As mais recentes primeiro, para o teto cortar as antigas; a lista volta à ordem no fim.
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const byConversation = new Map<string, ExportedMessage[]>();

  for (const row of rows.slice(0, limit).reverse()) {
    const list = byConversation.get(row.conversationId) ?? [];
    list.push({
      em: row.createdAt.toISOString(),
      direcao: row.direction === "in" ? "recebida" : "enviada",
      tipo: row.type,
      texto: row.text,
      modelo: row.templateName,
      situacao: row.status,
      anexo:
        row.fileName !== null && row.fileMime !== null && row.fileSize !== null
          ? { nome: row.fileName, tipo: row.fileMime, tamanho: row.fileSize }
          : null,
    });
    byConversation.set(row.conversationId, list);
  }

  return {
    conversations: heads.map((head) => ({
      organizacao: head.tenantId === null ? null : head.tenantName,
      telefone: head.phone,
      nomeNoWhatsapp: head.waName,
      situacao: head.status,
      iniciadaEm: head.createdAt.toISOString(),
      mensagens: byConversation.get(head.id) ?? [],
    })),
    truncated,
  };
}
