import { formatMetaError } from "@/lib/channels/providers/whatsapp_cloud/graph";
import {
  asRecord,
  type JsonRecord,
  parseTimestamp,
  pickArray,
  pickRecord,
  pickString,
} from "@/lib/channels/payload";
import type {
  MessageKind,
  NormalizedEvent,
  NormalizedMedia,
  NormalizedMessage,
  NormalizedStatus,
  NormalizedTemplate,
  TemplateEventKind,
} from "@/lib/channels/types";

/**
 * Aviso da Meta (`{ object, entry: [{ id, changes: [{ field, value }] }] }`) → eventos comuns.
 * Função pura: não baixa mídia (o job usa `providerMediaId`) e não consulta banco. O que não
 * é lido (reação, apagar, tipo novo) some sem erro: um tipo novo da Meta não pode derrubar o
 * aviso inteiro nem lotar a fila morta.
 */

const MEDIA_KINDS = ["image", "video", "audio", "document", "sticker"] as const;

const TEMPLATE_FIELDS: Record<string, TemplateEventKind> = {
  message_template_status_update: "status",
  message_template_quality_update: "quality",
  template_category_update: "status",
  message_template_components_update: "components",
};

const STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function mediaOf(message: JsonRecord): NormalizedMedia | null {
  for (const kind of MEDIA_KINDS) {
    const media = pickRecord(message, kind);
    const providerMediaId = pickString(media, "id");

    if (media && providerMediaId) {
      return {
        kind,
        mime: pickString(media, "mime_type"),
        filename: pickString(media, "filename"),
        providerMediaId,
      };
    }
  }
  return null;
}

function textOf(message: JsonRecord, type: string, media: NormalizedMedia | null): string | null {
  switch (type) {
    case "text":
      return pickString(pickRecord(message, "text"), "body");
    case "image":
    case "video":
    case "document":
      return pickString(pickRecord(message, type), "caption") ?? media?.filename ?? null;
    case "location": {
      const location = pickRecord(message, "location");
      const coords =
        location && "latitude" in location && "longitude" in location
          ? `${location.latitude},${location.longitude}`
          : null;

      return (
        [pickString(location, "name"), pickString(location, "address"), coords]
          .filter(Boolean)
          .join(" - ") || null
      );
    }
    case "interactive": {
      const interactive = pickRecord(message, "interactive");
      const reply = pickRecord(interactive, "button_reply") ?? pickRecord(interactive, "list_reply");

      return pickString(reply, "title") ?? pickString(reply, "id");
    }
    case "button": {
      const button = pickRecord(message, "button");
      return pickString(button, "text") ?? pickString(button, "payload");
    }
    case "contacts": {
      const names = pickArray(message, "contacts")
        .map((contact) => pickString(pickRecord(asRecord(contact), "name"), "formatted_name"))
        .filter(Boolean);

      return names.length ? names.join(", ") : null;
    }
    default:
      return null;
  }
}

function messageType(type: string, media: NormalizedMedia | null): MessageKind {
  if (media) return media.kind;

  switch (type) {
    case "text":
    case "location":
    case "contacts":
      return type;
    case "interactive":
    case "button":
      return "interactive";
    default:
      return "unsupported";
  }
}

function normalizeMessage(
  message: JsonRecord,
  contacts: JsonRecord[],
  phoneNumberId: string | undefined,
): NormalizedMessage | null {
  const providerMessageId = pickString(message, "id");
  const occurredAt = parseTimestamp(pickString(message, "timestamp"));
  const type = pickString(message, "type") ?? "unsupported";

  // Reação não é mensagem; sem id ou sem hora não há como deduplicar nem ordenar.
  if (!providerMessageId || !occurredAt || type === "reaction") return null;

  const from = pickString(message, "from");
  const contact = contacts.find((item) => pickString(item, "wa_id") === from) ?? contacts[0];
  const media = mediaOf(message);

  return {
    type: "message",
    fromPhone: from,
    // Na Cloud API o identificador é o próprio telefone; o LID só existe na Evolution.
    fromExternalId: pickString(contact, "user_id"),
    pushName: pickString(pickRecord(contact, "profile"), "name"),
    providerMessageId,
    fromMe: false,
    messageType: messageType(type, media),
    text: textOf(message, type, media),
    media,
    replyToProviderMessageId: pickString(pickRecord(message, "context"), "id"),
    occurredAt,
    channelPhoneNumberId: phoneNumberId,
  };
}

function normalizeStatus(
  status: JsonRecord,
  phoneNumberId: string | undefined,
): NormalizedStatus | null {
  const providerMessageId = pickString(status, "id");
  const value = pickString(status, "status");
  const occurredAt = parseTimestamp(pickString(status, "timestamp"));

  if (!providerMessageId || !value || !STATUSES.has(value) || !occurredAt) return null;

  const first = asRecord(pickArray(status, "errors")[0]);
  const error =
    value === "failed" && first
      ? formatMetaError(
          {
            code: typeof first.code === "number" ? first.code : undefined,
            message: pickString(first, "message") ?? undefined,
            title: pickString(first, "title") ?? undefined,
          },
          "Mensagem não entregue",
        )
      : null;

  return {
    type: "status",
    providerMessageId,
    status: value as NormalizedStatus["status"],
    occurredAt,
    error,
    recipientPhone: pickString(status, "recipient_id"),
    channelPhoneNumberId: phoneNumberId,
  };
}

function normalizeTemplate(
  event: TemplateEventKind,
  value: JsonRecord,
  wabaId: string | undefined,
): NormalizedTemplate {
  const id = value.message_template_id;

  return {
    type: "template",
    event,
    providerTemplateId: id === undefined || id === null ? null : String(id),
    name: pickString(value, "message_template_name"),
    language: pickString(value, "message_template_language"),
    templateStatus: pickString(value, "event")?.toUpperCase() ?? null,
    reason: pickString(value, "reason"),
    wabaId,
  };
}

export function normalizeCloudEvents(raw: unknown): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  for (const entryValue of pickArray(asRecord(raw), "entry")) {
    const entry = asRecord(entryValue);
    const wabaId = pickString(entry, "id") ?? undefined;

    for (const changeValue of pickArray(entry, "changes")) {
      const change = asRecord(changeValue);
      const field = pickString(change, "field");
      const value = pickRecord(change, "value");
      if (!field || !value) continue;

      const templateEvent = TEMPLATE_FIELDS[field];
      if (templateEvent) {
        events.push(normalizeTemplate(templateEvent, value, wabaId));
        continue;
      }
      if (field !== "messages") continue;

      const phoneNumberId = pickString(pickRecord(value, "metadata"), "phone_number_id") ?? undefined;
      const contacts = pickArray(value, "contacts")
        .map(asRecord)
        .filter((item): item is JsonRecord => item !== null);

      for (const item of pickArray(value, "messages")) {
        const message = asRecord(item);
        const normalized = message && normalizeMessage(message, contacts, phoneNumberId);
        if (normalized) events.push(normalized);
      }
      for (const item of pickArray(value, "statuses")) {
        const status = asRecord(item);
        const normalized = status && normalizeStatus(status, phoneNumberId);
        if (normalized) events.push(normalized);
      }
    }
  }

  return events;
}
