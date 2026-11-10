import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Tx } from "@/db/rls";
import { channel, chatContact, conversation, customer, file, message, user } from "@/db/schema";
import type { ChannelType } from "@/lib/channels/types";
import type { CustomerTagView } from "@/lib/crm/tags";
import type {
  ConversationStatus,
  MediaStatus,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  MessageType,
} from "@/lib/inbox/constants";
import { cursorTime } from "@/lib/inbox/cursor";
import type { PendingMediaInfo } from "@/lib/inbox/media";
import { previewOf } from "@/lib/inbox/preview";
import { type InboxActor, readsCustomers } from "@/lib/inbox/visibility";

/**
 * O que a API devolve da caixa de entrada (SPEC, "Contratos"). Uma consulta por página: as
 * etiquetas vêm de `tagsOfCustomers` com os ids da página, nunca uma por linha. Nada de `payload`
 * bruto, `phone_key` nem coluna interna.
 */

/** Membro vinculado ao contato (a busca da lista também procura pelo nome dele). */
export const contactUser = alias(user, "contact_user");
const assignee = alias(user, "assignee");

/** Colunas de uma linha da lista de conversas. */
const itemFields = {
  id: conversation.id,
  status: conversation.status,
  channelId: channel.id,
  channelName: channel.name,
  channelType: channel.type,
  channelStatus: channel.status,
  contactId: chatContact.id,
  contactPhone: chatContact.phone,
  contactName: chatContact.name,
  waName: chatContact.waName,
  customerId: chatContact.customerId,
  customerName: customer.name,
  linkedUserId: chatContact.userId,
  linkedUserName: contactUser.name,
  assignedUserId: conversation.assignedUserId,
  assigneeName: assignee.name,
  lastMessageAt: conversation.lastMessageAt,
  lastMessagePreview: conversation.lastMessagePreview,
  lastMessageDirection: conversation.lastMessageDirection,
  lastInboundAt: conversation.lastInboundAt,
  unreadCount: conversation.unreadCount,
  closedAt: conversation.closedAt,
  createdAt: conversation.createdAt,
  cursorAt: cursorTime(conversation.lastMessageAt),
};

/** `SELECT` da linha de conversa com contato, número, cliente, membro vinculado e dono. */
export function selectConversationRows(tx: Tx) {
  return tx
    .select(itemFields)
    .from(conversation)
    .innerJoin(chatContact, eq(chatContact.id, conversation.contactId))
    .innerJoin(channel, eq(channel.id, conversation.channelId))
    .leftJoin(customer, eq(customer.id, chatContact.customerId))
    .leftJoin(contactUser, eq(contactUser.id, chatContact.userId))
    .leftJoin(assignee, eq(assignee.id, conversation.assignedUserId));
}

export type ConversationItem = {
  id: string;
  status: ConversationStatus;
  channel: { id: string; name: string; type: ChannelType };
  contact: { id: string; displayName: string | null; phone: string; identified: boolean };
  assignedTo: { id: string; name: string } | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageDirection: MessageDirection | null;
  unreadCount: number;
  tags: CustomerTagView[];
};

export type ItemRow = Awaited<ReturnType<ReturnType<typeof selectConversationRows>["execute"]>>[number];

/**
 * Nome a mostrar: o do cliente vinculado (só para quem lê clientes), o do membro, o dado pela
 * equipe e, por fim, o do perfil do WhatsApp. `null` = a tela mostra o telefone.
 */
export function displayNameOf(row: ItemRow, actor: InboxActor) {
  const customerName = readsCustomers(actor) ? row.customerName : null;
  return customerName ?? row.linkedUserName ?? row.contactName ?? row.waName ?? null;
}

export function toConversationItem(
  row: ItemRow,
  actor: InboxActor,
  tags: Map<string, CustomerTagView[]>,
): ConversationItem {
  return {
    id: row.id,
    status: row.status,
    channel: { id: row.channelId, name: row.channelName, type: row.channelType },
    contact: {
      id: row.contactId,
      displayName: displayNameOf(row, actor),
      phone: row.contactPhone,
      identified: Boolean(row.customerId || row.linkedUserId),
    },
    assignedTo: row.assignedUserId
      ? { id: row.assignedUserId, name: row.assigneeName ?? "" }
      : null,
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageDirection: row.lastMessageDirection,
    unreadCount: row.unreadCount,
    tags: (readsCustomers(actor) && row.customerId ? tags.get(row.customerId) : undefined) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

const sender = alias(user, "sender");
const quoted = alias(message, "quoted");

const messageFields = {
  id: message.id,
  conversationId: message.conversationId,
  direction: message.direction,
  senderType: message.senderType,
  senderUserId: message.senderUserId,
  senderName: sender.name,
  type: message.type,
  text: message.text,
  status: message.status,
  errorCode: message.errorCode,
  errorMessage: message.errorMessage,
  mediaStatus: message.mediaStatus,
  fileId: message.fileId,
  fileName: file.name,
  fileMime: file.mime,
  fileSize: file.size,
  // Só o pedaço `media` do `payload` (nome e tipo declarados); o resto não sai.
  pendingMedia: sql<PendingMediaInfo | null>`${message.payload}->'media'`,
  quotedId: quoted.id,
  quotedType: quoted.type,
  quotedText: quoted.text,
  quotedDirection: quoted.direction,
  createdAt: message.createdAt,
  cursorAt: cursorTime(message.createdAt),
};

/** `SELECT` de mensagens com arquivo, autor e a mensagem citada. */
export function selectMessageRows(tx: Tx) {
  return tx
    .select(messageFields)
    .from(message)
    .leftJoin(file, eq(file.id, message.fileId))
    .leftJoin(sender, eq(sender.id, message.senderUserId))
    .leftJoin(quoted, eq(quoted.id, message.replyToMessageId));
}

type MessageRowView = Awaited<ReturnType<ReturnType<typeof selectMessageRows>["execute"]>>[number];

export type MessageView = {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  sender: { id: string; name: string } | null;
  type: MessageType;
  text: string | null;
  /** Só nas enviadas. */
  status: MessageStatus | null;
  error: { code: string | null; message: string | null } | null;
  media: {
    url: string;
    mime: string | null;
    size: number | null;
    name: string | null;
    status: MediaStatus;
  } | null;
  replyTo: { id: string; type: MessageType; preview: string; direction: MessageDirection } | null;
  createdAt: Date;
};

/** `base` é a raiz da API do escopo (`/api/inbox`; a plataforma, na C6, `/api/admin/inbox`). */
export function toMessageView(row: MessageRowView, base = "/api/inbox"): MessageView {
  const hasMedia = row.fileId !== null || row.mediaStatus !== null;

  return {
    id: row.id,
    conversationId: row.conversationId,
    direction: row.direction,
    senderType: row.senderType,
    sender: row.senderUserId ? { id: row.senderUserId, name: row.senderName ?? "" } : null,
    type: row.type,
    text: row.text,
    status: row.status,
    error:
      row.status === "failed" ? { code: row.errorCode, message: row.errorMessage } : null,
    media: hasMedia
      ? {
          url: `${base}/messages/${row.id}/media`,
          mime: row.fileMime ?? row.pendingMedia?.mime ?? null,
          size: row.fileSize ?? null,
          name: row.fileName ?? row.pendingMedia?.filename ?? null,
          status: row.mediaStatus ?? "ready",
        }
      : null,
    replyTo:
      row.quotedId && row.quotedType && row.quotedDirection
        ? {
            id: row.quotedId,
            type: row.quotedType,
            preview: previewOf(row.quotedType, row.quotedText),
            direction: row.quotedDirection,
          }
        : null,
    createdAt: row.createdAt,
  };
}
