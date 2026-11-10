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

// ---------------------------------------------------------------------------
// Anexo de saída (C5)
// ---------------------------------------------------------------------------

export type OutboundKind = "image" | "video" | "audio" | "document";

/** Teto de um anexo de saída (SPEC, "Envio"): 16 MB, conferido antes de gravar. */
export const MAX_OUTBOUND_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Tipos que o atendimento envia, com o tipo de mensagem de cada um. Lista própria (não é a de
 * `ALLOWED_UPLOAD_MIME`): é o que a Meta aceita em imagem, vídeo, áudio e documento. SVG, HTML,
 * GIF, WebM, CSV e executável nunca entram.
 */
export const OUTBOUND_MIME: Readonly<Record<string, OutboundKind>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/3gpp": "video",
  "audio/ogg": "audio",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/aac": "audio",
  "audio/amr": "audio",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "text/plain": "document",
};
