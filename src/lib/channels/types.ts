/**
 * Vocabulário dos canais de mensagem (`docs/specs/whatsapp-canais/spec.md`).
 *
 * O núcleo (serviço, jobs, rotas, caixa de entrada) só conhece este arquivo e o registro.
 * Nada aqui cita `phone_number_id` nem `instanceToken`: se citar, a abstração vazou.
 */

export const channelTypes = ["whatsapp_cloud", "whatsapp_qr"] as const;
export type ChannelType = (typeof channelTypes)[number];

/** Métrica de `plan.limits` de cada tipo de canal (`src/lib/billing/constants.ts`). */
export const CHANNEL_LIMIT_METRICS = {
  whatsapp_cloud: "channels_whatsapp_cloud",
  whatsapp_qr: "channels_whatsapp_qr",
} as const satisfies Record<ChannelType, string>;

export const channelStatuses = [
  "disconnected",
  "connecting",
  "connected",
  "error",
  "disabled",
] as const;
export type ChannelStatus = (typeof channelStatuses)[number];

export const channelEventKinds = ["message", "status", "connection", "template", "other"] as const;
export type ChannelEventKind = (typeof channelEventKinds)[number];

export const channelEventStatuses = ["pending", "processed", "ignored", "failed"] as const;
export type ChannelEventStatus = (typeof channelEventStatuses)[number];

/** O que o canal sabe fazer. O código pergunta à capacidade, nunca ao tipo. */
export type ChannelCapabilities = {
  /** Modelos de mensagem aprovados (só a Cloud API). */
  templates: boolean;
  /** Só responde de graça dentro de 24 h da última mensagem do contato. */
  sessionWindow24h: boolean;
  /** Aviso `failed` por mensagem não entregue. */
  deliveryFailure: boolean;
  /** Mensagem enviada pelo celular chega como aviso (`SendMessage`). */
  deviceEcho: boolean;
  /** QR Code e código de pareamento. */
  pairing: boolean;
};

export type ChannelCapability = keyof ChannelCapabilities;

// ---------------------------------------------------------------------------
// Eventos normalizados (formato do provedor → formato comum)
// ---------------------------------------------------------------------------

export type MessageKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "interactive"
  | "contacts"
  | "unsupported";

export type NormalizedMedia = {
  kind: "image" | "video" | "audio" | "document" | "sticker";
  mime: string | null;
  filename: string | null;
  /** Cloud API: id da mídia, baixado com `getMediaUrl` + `downloadMedia`. */
  providerMediaId?: string;
  /** Evolution: base64 já decifrado pelo servidor (sai do `raw` antes de gravar). */
  base64?: string;
  /** Evolution com S3: endereço do objeto, nunca confiável sem checar a origem. */
  mediaUrl?: string;
  /** Depois de gravado no `StorageProvider`. */
  storage?: { storageKey: string; mime: string | null; size: number };
};

export type NormalizedMessage = {
  type: "message";
  /** Telefone de quem conversa: só dígitos, com DDI, sem `+` e sem sufixo de dispositivo. */
  fromPhone: string | null;
  /** Identificador alternativo do provedor (LID da Evolution). */
  fromExternalId: string | null;
  pushName: string | null;
  providerMessageId: string;
  /** `true` quando a mensagem saiu do celular do dono do número (eco). */
  fromMe: boolean;
  messageType: MessageKind;
  text: string | null;
  media: NormalizedMedia | null;
  replyToProviderMessageId: string | null;
  /** Hora do provedor, nunca a do nosso servidor. */
  occurredAt: Date;
  /** Número do canal que recebeu, quando o aviso o traz (Cloud: `phone_number_id`). */
  channelPhoneNumberId?: string;
};

export type NormalizedStatus = {
  type: "status";
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurredAt: Date;
  /** `(#código) título: mensagem`, só em `failed`. */
  error: string | null;
  recipientPhone: string | null;
  channelPhoneNumberId?: string;
};

export type NormalizedConnection = {
  type: "connection";
  status: Extract<ChannelStatus, "connected" | "connecting" | "disconnected">;
  detail: string | null;
  /** Telefone conectado, quando o evento o informa. */
  phone: string | null;
  jid: string | null;
};

export type TemplateEventKind = "status" | "quality" | "components";

export type NormalizedTemplate = {
  type: "template";
  event: TemplateEventKind;
  providerTemplateId: string | null;
  name: string | null;
  language: string | null;
  /** Já no vocabulário da Meta (`APPROVED`, `REJECTED`...). */
  templateStatus: string | null;
  reason: string | null;
  channelPhoneNumberId?: string;
  wabaId?: string;
};

export type NormalizedEvent =
  | NormalizedMessage
  | NormalizedStatus
  | NormalizedConnection
  | NormalizedTemplate;

// ---------------------------------------------------------------------------
// Contrato do módulo
// ---------------------------------------------------------------------------

/** Segredos já decifrados, só em memória do servidor e só para chamar o provedor. */
export type ChannelContext = {
  channelId: string;
  type: ChannelType;
  credentials: Record<string, string>;
};

export type SendText = { to: string; text: string; quotedProviderMessageId?: string };

export type SendMedia = {
  to: string;
  kind: "image" | "video" | "audio" | "document";
  /** Endereço pré-assinado de curta duração, ou `providerMediaId` já enviado à Meta. */
  url?: string;
  providerMediaId?: string;
  caption?: string;
  filename?: string;
  quotedProviderMessageId?: string;
};

export type SendTemplate = {
  to: string;
  name: string;
  language: string;
  components?: unknown[];
};

export type SendResult = { providerMessageId: string };

export type ProbeResult = {
  status: Extract<ChannelStatus, "connected" | "connecting" | "disconnected" | "error">;
  detail: string | null;
  /** Telefone exibido, quando o provedor devolve. */
  identifier?: string | null;
};

/** Cabeçalhos em minúsculas e corpo cru: a assinatura vale sobre os bytes recebidos. */
export type WebhookContext = {
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** Segredos decifrados do canal achado pela chave do caminho. */
  credentials: Record<string, string>;
  /** Dados não secretos do canal (ex.: `remoteInstanceId`). */
  config: Record<string, string>;
  /** Cada módulo decide o que vem do caminho (`secret` na Evolution). */
  pathSecret?: string;
};

export type VerifyResult = { ok: true; dedupeKey: string } | { ok: false; reason: string };

export interface ChannelProvider {
  type: ChannelType;
  capabilities: ChannelCapabilities;
  /** Confere quem mandou, sobre o corpo cru. Nunca lança por assinatura errada. */
  verifyWebhook(ctx: WebhookContext): Promise<VerifyResult>;
  /** Formato do provedor → eventos comuns. Função pura, testada com fixtures. */
  normalizeEvents(raw: unknown): NormalizedEvent[];
  sendText(ctx: ChannelContext, input: SendText): Promise<SendResult>;
  sendMedia(ctx: ChannelContext, input: SendMedia): Promise<SendResult>;
  sendTemplate?(ctx: ChannelContext, input: SendTemplate): Promise<SendResult>;
  fetchMedia?(
    ctx: ChannelContext,
    providerMediaId: string,
  ): Promise<{ body: Buffer; mime: string }>;
  /** Estado real no provedor; a camada comum grava em `channel.status`. */
  probe(ctx: ChannelContext): Promise<ProbeResult>;
}
