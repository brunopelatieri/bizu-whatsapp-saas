import { and, desc, eq, gt, ilike, isNull, like, ne, or, type SQL, sql } from "drizzle-orm";
import { type Tx, withScope } from "@/db/rls";
import { chatContact, conversation, customer, message, user } from "@/db/schema";
import { escapeLike } from "@/lib/admin/tenants";
import { type CustomerTagView, tagsOfCustomers } from "@/lib/crm/tags";
import { linkCandidates, providerPhone } from "@/lib/inbox/contacts";
import { afterCursor, decodeCursor, encodeCursor } from "@/lib/inbox/cursor";
import {
  contactUser,
  type ConversationItem,
  displayNameOf,
  type ItemRow,
  selectConversationRows,
  selectMessageRows,
  toConversationItem,
  toMessageView,
} from "@/lib/inbox/views";
import { type InboxActor, readsCustomers, visibleConversation } from "@/lib/inbox/visibility";
import { sessionWindow } from "@/lib/inbox/window";
import { normalizePhone } from "@/lib/phone/br";
import type { ConversationsQuery, MessagesQuery } from "@/lib/schemas/inbox";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Leitura da caixa de entrada (SPEC, passo 3). Toda consulta de conversa passa por
 * `visibleConversation`: fora dele, 404 igual a id inexistente.
 */

export const CONVERSATION_NOT_FOUND = "Conversa não encontrada.";

export const permissionDenied = () =>
  new TenantRuleError(403, "PERMISSION_DENIED", "Você não tem permissão para esta ação.");

/** Conversa visível pelo ator, travada se pedido. `null` fora do predicado. */
export async function findVisibleConversation(
  tx: Tx,
  actor: InboxActor,
  conversationId: string,
  lock = false,
) {
  const query = tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), visibleConversation(actor)));
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

export async function requireVisibleConversation(
  tx: Tx,
  actor: InboxActor,
  conversationId: string,
  lock = false,
) {
  const row = await findVisibleConversation(tx, actor, conversationId, lock);
  if (!row) throw notFound(CONVERSATION_NOT_FOUND);
  return row;
}

/** Etiquetas dos clientes vinculados de uma página: uma consulta só. */
async function pageTags(tx: Tx, actor: InboxActor, rows: ItemRow[]) {
  if (!readsCustomers(actor)) return new Map<string, CustomerTagView[]>();
  const ids = [...new Set(rows.flatMap((row) => (row.customerId ? [row.customerId] : [])))];
  return tagsOfCustomers(tx, ids);
}

/** Uma linha da lista, já com as etiquetas, para quem acabou de mudar a conversa. */
export async function conversationItem(tx: Tx, actor: InboxActor, conversationId: string) {
  const [row] = await selectConversationRows(tx).where(eq(conversation.id, conversationId));
  if (!row) throw notFound(CONVERSATION_NOT_FOUND);
  return toConversationItem(row, actor, await pageTags(tx, actor, [row]));
}

/**
 * Busca por nome do contato, do membro vinculado, do cliente vinculado (só para quem lê
 * clientes) e por telefone, pelos dígitos e pela `phone_key` (o número com e sem o 9º dígito).
 * Conteúdo de mensagem não entra (SPEC, "Decisões").
 */
function searchFilter(q: string, actor: InboxActor): SQL {
  const term = `%${escapeLike(q)}%`;
  const parts: SQL[] = [
    ilike(chatContact.name, term),
    ilike(chatContact.waName, term),
    ilike(contactUser.name, term),
  ];
  if (readsCustomers(actor)) parts.push(ilike(customer.name, term));

  const digits = q.replace(/\D/g, "");
  if (digits.length >= 4) {
    parts.push(like(chatContact.phone, `%${digits}%`));
    // Como a pessoa digitou (regra do Brasil sem DDI) e como o provedor entrega (com DDI).
    const local = normalizePhone(digits);
    const keys = new Set([local.ok ? local.key : null, providerPhone(digits)?.phoneKey ?? null]);
    for (const key of keys) if (key) parts.push(eq(chatContact.phoneKey, key));
  }

  return or(...parts) as SQL;
}

export async function listConversations(actor: InboxActor, query: ConversationsQuery) {
  if ((query.tab === "all" || query.assignedTo) && !actor.can.supervise) throw permissionDenied();
  if (query.tagIds?.length && !readsCustomers(actor)) throw permissionDenied();

  const filters: (SQL | undefined)[] = [visibleConversation(actor)];

  if (query.tab === "queue") {
    filters.push(isNull(conversation.assignedUserId), ne(conversation.status, "closed"));
  }
  if (query.tab === "mine") filters.push(eq(conversation.assignedUserId, actor.userId));
  if (query.assignedTo) filters.push(eq(conversation.assignedUserId, query.assignedTo));
  if (query.status) filters.push(eq(conversation.status, query.status));
  if (query.unread !== undefined) {
    filters.push(query.unread ? gt(conversation.unreadCount, 0) : eq(conversation.unreadCount, 0));
  }
  if (query.channelId) filters.push(eq(conversation.channelId, query.channelId));
  if (query.tagIds?.length) {
    const ids = sql.join(query.tagIds.map((id) => sql`${id}`), sql`, `);
    filters.push(
      sql`exists (select 1 from customer_tag where customer_tag.customer_id = "chat_contact"."customer_id" and customer_tag.tag_id in (${ids}))`,
    );
  }
  if (query.q) filters.push(searchFilter(query.q, actor));
  if (query.cursor) {
    filters.push(afterCursor(decodeCursor(query.cursor), conversation.lastMessageAt, conversation.id));
  }

  return withScope(actor.scope, async (tx) => {
    const rows = await selectConversationRows(tx)
      .where(and(...filters))
      .orderBy(sql`${conversation.lastMessageAt} desc nulls last`, desc(conversation.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const tags = await pageTags(tx, actor, page);
    const last = page.at(-1);

    return {
      items: page.map((row): ConversationItem => toConversationItem(row, actor, tags)),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Detalhe e vínculo do contato
// ---------------------------------------------------------------------------

type ContactRow = typeof chatContact.$inferSelect;

export type ContactLink =
  | {
      kind: "customer";
      customer: {
        id: string;
        name: string | null;
        email?: string | null;
        phone?: string | null;
        status?: string;
      };
      tags: CustomerTagView[];
      customFields: Record<string, unknown>;
    }
  | { kind: "member"; user: { id: string; name: string } }
  | {
      kind: "none";
      candidates: { customers: { id: string; name: string; phone: string | null }[]; users: { id: string; name: string }[] };
    };

/**
 * O cadastro ao lado do chat. Os dados do cliente só para quem lê clientes (`customer:read`);
 * os candidatos (mesma `phone_key`) só para quem responde, e os clientes entre eles também só
 * para quem lê clientes.
 */
export async function linkOf(tx: Tx, actor: InboxActor, contact: ContactRow): Promise<ContactLink> {
  if (contact.customerId) {
    if (!readsCustomers(actor)) {
      return { kind: "customer", customer: { id: contact.customerId, name: null }, tags: [], customFields: {} };
    }

    const [row] = await tx
      .select({
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phoneNormalized,
        status: customer.status,
        customFields: customer.customFields,
      })
      .from(customer)
      .where(eq(customer.id, contact.customerId));
    if (row) {
      const { customFields, ...view } = row;
      return {
        kind: "customer",
        customer: view,
        tags: (await tagsOfCustomers(tx, [row.id])).get(row.id) ?? [],
        customFields: (customFields ?? {}) as Record<string, unknown>,
      };
    }
  }

  if (contact.userId) {
    const [row] = await tx
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(eq(user.id, contact.userId));
    if (row) return { kind: "member", user: row };
  }

  if (!actor.can.reply) return { kind: "none", candidates: { customers: [], users: [] } };

  const candidates = await linkCandidates(tx, actor.scope, contact.phoneKey);
  return {
    kind: "none",
    candidates: {
      users: candidates.users,
      customers: readsCustomers(actor) ? candidates.customers : [],
    },
  };
}

/** O contato como a tela o vê: sem `phone_key` nem `tenant_id`. */
export function contactView(contact: ContactRow, displayName: string | null) {
  return {
    id: contact.id,
    phone: contact.phone,
    name: contact.name,
    waName: contact.waName,
    displayName,
    createdVia: contact.createdVia,
    identified: Boolean(contact.customerId || contact.userId),
  };
}

export async function getConversation(actor: InboxActor, conversationId: string) {
  return withScope(actor.scope, async (tx) => {
    const [row] = await selectConversationRows(tx).where(
      and(eq(conversation.id, conversationId), visibleConversation(actor)),
    );
    if (!row) throw notFound(CONVERSATION_NOT_FOUND);

    const [contact] = await tx.select().from(chatContact).where(eq(chatContact.id, row.contactId));
    if (!contact) throw notFound(CONVERSATION_NOT_FOUND);

    const item = toConversationItem(row, actor, await pageTags(tx, actor, [row]));

    return {
      conversation: {
        ...item,
        channel: { ...item.channel, status: row.channelStatus },
        closedAt: row.closedAt,
        createdAt: row.createdAt,
      },
      contact: contactView(contact, displayNameOf(row, actor)),
      link: await linkOf(tx, actor, contact),
      window: sessionWindow(row.channelType, row.lastInboundAt),
    };
  });
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

/** Da mais nova para a mais antiga; `nextCursor` traz a página anterior. */
export async function listMessages(actor: InboxActor, conversationId: string, query: MessagesQuery) {
  const cursor = query.before ? decodeCursor(query.before) : null;

  return withScope(actor.scope, async (tx) => {
    await requireVisibleConversation(tx, actor, conversationId);

    const rows = await selectMessageRows(tx)
      .where(
        and(
          eq(message.conversationId, conversationId),
          cursor ? afterCursor(cursor, message.createdAt, message.id) : undefined,
        ),
      )
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map((row) => toMessageView(row)),
      nextCursor:
        rows.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    };
  });
}

/** Uma mensagem já gravada, na forma da API. */
export async function messageView(tx: Tx, messageId: string) {
  const [row] = await selectMessageRows(tx).where(eq(message.id, messageId));
  if (!row) throw notFound("Mensagem não encontrada.");
  return toMessageView(row);
}

/** Mensagem cuja conversa o ator vê. `null` fora do predicado. */
export async function findVisibleMessage(tx: Tx, actor: InboxActor, messageId: string) {
  const [row] = await tx
    .select({ message })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(and(eq(message.id, messageId), visibleConversation(actor)));
  return row?.message ?? null;
}

// ---------------------------------------------------------------------------
// Não lidas
// ---------------------------------------------------------------------------

/** Conversas com não lidas na fila e nas minhas (o ponto no menu). */
export async function unreadCounts(actor: InboxActor) {
  return withScope(actor.scope, async (tx) => {
    const [row] = await tx
      .select({
        queue: sql<number>`count(*) filter (where ${conversation.assignedUserId} is null and ${conversation.status} <> 'closed')::int`,
        mine: sql<number>`count(*) filter (where ${conversation.assignedUserId} = ${actor.userId})::int`,
      })
      .from(conversation)
      .where(and(visibleConversation(actor), gt(conversation.unreadCount, 0)));

    return { queue: row?.queue ?? 0, mine: row?.mine ?? 0 };
  });
}
