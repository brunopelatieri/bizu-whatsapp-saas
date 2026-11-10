/**
 * Vocabulário da caixa de entrada (`docs/specs/caixa-de-entrada/spec.md`). Só dados: o schema
 * (`src/db/schema/inbox.ts`) importa daqui sem puxar código de servidor.
 */

/** Como o `chat_contact` nasceu: mensagem recebida, conversa iniciada pela equipe ou eco do aparelho. */
export const chatContactOrigins = ["inbound", "outbound", "device"] as const;
export type ChatContactOrigin = (typeof chatContactOrigins)[number];

/** Identificadores alternativos ao telefone. `lid`: o identificador oculto do WhatsApp (Evolution). */
export const chatIdentityKinds = ["lid"] as const;
export type ChatIdentityKind = (typeof chatIdentityKinds)[number];

export const conversationStatuses = ["open", "pending", "closed"] as const;
export type ConversationStatus = (typeof conversationStatuses)[number];

export const messageDirections = ["in", "out"] as const;
export type MessageDirection = (typeof messageDirections)[number];

export const messageSenderTypes = ["contact", "user", "device", "system"] as const;
export type MessageSenderType = (typeof messageSenderTypes)[number];

export const messageTypes = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contacts",
  "template",
  "interactive",
  "unsupported",
] as const;
export type MessageType = (typeof messageTypes)[number];

export const mediaStatuses = ["ready", "pending", "failed"] as const;
export type MediaStatus = (typeof mediaStatuses)[number];

/** Escada de entrega: `queued < sent < delivered < read`; `failed` só a partir de `queued` ou `sent`. */
export const messageStatuses = ["queued", "sent", "delivered", "read", "failed"] as const;
export type MessageStatus = (typeof messageStatuses)[number];

/** Tamanho máximo da prévia da última mensagem na lista de conversas. */
export const PREVIEW_MAX = 120;
