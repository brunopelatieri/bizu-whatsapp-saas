import {
  asRecord,
  type JsonRecord,
  parseTimestamp,
  pickArray,
  pickBoolean,
  pickKey,
  pickRecord,
  pickString,
} from "@/lib/channels/payload";
import type {
  MessageKind,
  NormalizedConnection,
  NormalizedEvent,
  NormalizedMedia,
  NormalizedMessage,
  NormalizedStatus,
} from "@/lib/channels/types";

/**
 * Aviso da Evolution Go → eventos comuns. O servidor é Go sobre whatsmeow e serializa três
 * convenções de nome no mesmo aviso (struct Go: `Info`, `Chat`; protojson: `audioMessage`;
 * envelope: `event`, `state`), então toda leitura ignora a caixa (`payload.ts`).
 *
 * Duas lições caras da origem estão aqui:
 * 1. `event` **não** carrega o nome da família assinada: `SEND_MESSAGE` chega como
 *    `SendMessage`, `READ_RECEIPT` como `Receipt`, `CONNECTION` como `Connected`/`LoggedOut`.
 * 2. O `URL` de um proto de mídia aponta para o CDN do WhatsApp e o conteúdo é **cifrado**.
 *    Só servem o `base64` (decifrado pelo servidor) ou um `mediaUrl` de S3 já em claro.
 *
 * Função pura. Proto que não sabemos ler é descartado (melhor que bolha em branco).
 */

type EventKind = "message" | "send_message" | "receipt" | "connection" | "qrcode";

const EVENT_KINDS: Record<string, EventKind> = {
  MESSAGE: "message",
  SENDMESSAGE: "send_message",
  RECEIPT: "receipt",
  READRECEIPT: "receipt",
  CONNECTION: "connection",
  CONNECTED: "connection",
  DISCONNECTED: "connection",
  LOGGEDOUT: "connection",
  PAIRSUCCESS: "connection",
  OFFLINESYNCCOMPLETED: "connection",
  QRCODE: "qrcode",
  QRTIMEOUT: "qrcode",
  QRSUCCESS: "qrcode",
};

/** Sem `_`, espaço nem hífen, em maiúsculas: `SEND_MESSAGE` e `SendMessage` viram um só. */
export function normalizeEventName(raw: string) {
  return raw.replace(/[_\s-]/g, "").toUpperCase();
}

export function eventKindOf(raw: unknown): EventKind | null {
  const event = pickString(asRecord(raw), "event");

  return (event && EVENT_KINDS[normalizeEventName(event)]) || null;
}

export type ParsedJid = { phone: string | null; lid: string | null };

/**
 * Tira o sufixo `:NN` de dispositivo antes do `@`, nas duas formas. Grupo, broadcast e
 * qualquer outro formato não são adivinhados: voltam vazios.
 */
export function parseJid(raw: string | null | undefined): ParsedJid {
  if (!raw) return { phone: null, lid: null };

  const lid = raw.match(/^(\d+)(?::\d+)?@lid$/);
  if (lid) return { phone: null, lid: `${lid[1]}@lid` };

  const phone = raw.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  return { phone: phone ? (phone[1] ?? null) : null, lid: null };
}

/** URL do CDN do WhatsApp (`*.whatsapp.net`, `.enc`): o conteúdo é cifrado e não serve. */
export function isEncryptedWhatsappUrl(url: string) {
  if (/\.enc(\?|#|$)/i.test(url)) return true;
  try {
    return /(^|\.)whatsapp\.net$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export const MEDIA_KEYS: Array<[string, NormalizedMedia["kind"]]> = [
  ["imageMessage", "image"],
  ["videoMessage", "video"],
  ["audioMessage", "audio"],
  ["documentMessage", "document"],
  ["stickerMessage", "sticker"],
];

type Content = {
  messageType: MessageKind;
  text: string | null;
  media: NormalizedMedia | null;
};

/** Referência gravada pelo webhook no lugar do base64: `{ storageKey, mime, size }`. */
export function isStoredRef(value: unknown): value is NonNullable<NormalizedMedia["storage"]> {
  const record = asRecord(value);

  return typeof record?.storageKey === "string" && typeof record.size === "number";
}

/**
 * O conteúdo decifrado é **irmão** do proto dentro de `Message`; `data.base64` é alternativa.
 * Depois do webhook, o que está ali é a referência ao `StorageProvider` (o base64 nunca vai ao
 * `raw`); o texto base64 só aparece aqui em aviso que não passou pelo webhook (testes, fixtures).
 */
function mediaSource(
  proto: JsonRecord,
  fallback: unknown,
): Pick<NormalizedMedia, "base64" | "mediaUrl" | "storage"> {
  const embedded = pickKey(proto, "base64") ?? fallback;

  if (isStoredRef(embedded)) {
    return {
      storage: {
        storageKey: embedded.storageKey,
        mime: typeof embedded.mime === "string" ? embedded.mime : null,
        size: embedded.size,
      },
    };
  }

  const base64 =
    pickString(proto, "base64", "data") ?? (typeof fallback === "string" && fallback ? fallback : null);
  if (base64) return { base64 };

  // `mediaUrl` é o objeto em claro do S3; `directPath` é relativo ao CDN e continua cifrado.
  const plain = pickString(proto, "mediaUrl", "fileUrl");
  if (plain && !isEncryptedWhatsappUrl(plain)) return { mediaUrl: plain };

  const cdn = pickString(proto, "URL", "url");
  if (cdn && !isEncryptedWhatsappUrl(cdn)) return { mediaUrl: cdn };

  return {};
}

function contentOf(message: JsonRecord, fallback: unknown): Content | null {
  const conversation = pickString(message, "conversation");
  if (conversation) return { messageType: "text", text: conversation, media: null };

  const extended = pickString(pickRecord(message, "extendedTextMessage"), "text");
  if (extended) return { messageType: "text", text: extended, media: null };

  for (const [key, kind] of MEDIA_KEYS) {
    const proto = pickRecord(message, key);
    if (!proto) continue;

    return {
      messageType: kind,
      text: pickString(proto, "caption"),
      media: {
        kind,
        mime: pickString(proto, "mimetype", "mimeType"),
        filename: pickString(proto, "fileName", "filename", "title"),
        ...mediaSource(proto, fallback),
      },
    };
  }

  const location = pickRecord(message, "locationMessage");
  if (location) {
    const lat = typeof location.degreesLatitude === "number" ? location.degreesLatitude : null;
    const lng = typeof location.degreesLongitude === "number" ? location.degreesLongitude : null;
    const text = [pickString(location, "name"), lat != null && lng != null ? `${lat},${lng}` : null]
      .filter(Boolean)
      .join(" - ");

    return { messageType: "location", text: text || null, media: null };
  }

  return null;
}

function normalizeMessage(
  data: JsonRecord,
  isEcho: boolean,
  now: Date,
): NormalizedMessage | null {
  const info = pickRecord(data, "Info");
  if (!info) return null;

  const fromMe = isEcho || pickBoolean(info, "IsFromMe") === true;

  // `Chat` é o destino da conversa (o contato) nos dois sentidos. `Sender` só serve de
  // reserva no recebimento: no eco ele é o NOSSO número, e cair nele criaria uma conversa
  // do dono do número consigo mesmo.
  const chat = pickString(info, "Chat");
  const sender = fromMe ? null : pickString(info, "Sender");
  const jid = parseJid(chat ?? sender);
  const providerMessageId = pickString(info, "ID");

  if (!providerMessageId || (!jid.phone && !jid.lid)) return null;

  const message = pickRecord(data, "Message") ?? {};

  // Revogação, reação e demais protos que não são conteúdo: o recibo de que existem fica
  // fora do escopo desta entrega e não pode virar bolha vazia.
  if (pickRecord(message, "protocolMessage") || pickRecord(message, "reactionMessage")) {
    return null;
  }

  const content = contentOf(message, pickKey(message, "base64") ?? pickKey(data, "base64"));
  if (!content) return null;

  const quoted = pickString(
    pickRecord(pickRecord(message, "extendedTextMessage"), "contextInfo"),
    "stanzaID",
    "stanzaId",
  );

  return {
    type: "message",
    fromPhone: jid.phone,
    fromExternalId: jid.lid,
    pushName: pickString(info, "PushName"),
    providerMessageId,
    fromMe,
    messageType: content.messageType,
    text: content.text,
    media: content.media,
    replyToProviderMessageId: quoted,
    occurredAt: parseTimestamp(pickKey(info, "Timestamp")) ?? now,
  };
}

/** Chaveado em minúsculas: `Read`, `ReadSelf` e `Delivered` convivem com variantes. */
const RECEIPT_STATUS: Record<string, "delivered" | "read"> = {
  delivered: "delivered",
  read: "read",
  readself: "read",
};

function normalizeReceipts(envelope: JsonRecord, data: JsonRecord, now: Date): NormalizedStatus[] {
  // O tipo do recibo chega em `state` no ENVELOPE, irmão de `event`, não dentro de `data`.
  const raw = pickString(envelope, "state") ?? pickString(data, "state", "Type");
  const status = raw ? RECEIPT_STATUS[raw.toLowerCase()] : undefined;
  if (!status) return [];

  const list = pickArray(data, "MessageIDs", "messageIds", "ids");
  const ids = (
    list.length ? list : [pickString(data, "MessageID", "ID", "id")]
  ).filter((id): id is string => typeof id === "string" && id !== "");

  const occurredAt = parseTimestamp(pickKey(data, "Timestamp")) ?? now;
  const recipient = parseJid(pickString(data, "Chat", "Sender")).phone;

  return ids.map((providerMessageId) => ({
    type: "status",
    providerMessageId,
    status,
    occurredAt,
    error: null,
    recipientPhone: recipient,
  }));
}

/**
 * O **nome** do evento carrega o estado (`Connected`, `PairSuccess`, `LoggedOut`): o corpo do
 * `Connected` é `{status: "open", jid, pushName}`, sem booleano. Ler booleanos que nunca vêm
 * marcava o canal como desconectado logo ao conectar. Os booleanos ficam só como reforço.
 */
function normalizeConnection(eventName: string, data: JsonRecord): NormalizedConnection {
  let status: NormalizedConnection["status"];
  let detail: string | null = null;

  if (eventName === "LOGGEDOUT" || eventName === "DISCONNECTED") {
    status = "disconnected";
    detail = eventName === "LOGGEDOUT" ? "Desconectado no celular." : "Conexão encerrada.";
  } else if (["CONNECTED", "PAIRSUCCESS", "OFFLINESYNCCOMPLETED"].includes(eventName)) {
    status = "connected";
  } else {
    const text = pickString(data, "status")?.toLowerCase();
    const connected = pickBoolean(data, "Connected") === true;
    const loggedIn = pickBoolean(data, "LoggedIn") === true;

    if (text === "open" || text === "connected" || (connected && loggedIn)) status = "connected";
    else if (text === "close" || text === "closed") status = "disconnected";
    else status = connected ? "connecting" : "disconnected";
  }

  const jid = pickString(data, "JID", "ID");
  return { type: "connection", status, detail, jid, phone: parseJid(jid).phone };
}

export function normalizeEvolutionEvents(raw: unknown, now: Date = new Date()): NormalizedEvent[] {
  const envelope = asRecord(raw);
  const event = pickString(envelope, "event");
  const kind = eventKindOf(raw);
  if (!envelope || !event || !kind) return [];

  const data = pickRecord(envelope, "data") ?? {};

  switch (kind) {
    case "message":
    case "send_message": {
      const message = normalizeMessage(data, kind === "send_message", now);
      return message ? [message] : [];
    }
    case "receipt":
      return normalizeReceipts(envelope, data, now);
    case "connection":
      return [normalizeConnection(normalizeEventName(event), data)];
    default:
      // O QR em si nunca é gravado; mudar de tela é problema da tela (consulta o estado).
      return [];
  }
}
