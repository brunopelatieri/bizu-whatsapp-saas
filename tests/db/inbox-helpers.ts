import { randomInt } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { type Scope, scopeTenantId, withPlatformScope, withScope } from "@/db/rls";
import { chatContact, conversation, file, message } from "@/db/schema";
import type { ConversationStatus, MessageStatus } from "@/lib/inbox/constants";
import { providerPhone } from "@/lib/inbox/contacts";
import type { StorageProvider } from "@/lib/storage/types";

/** Apoio dos testes da API do atendimento: conversas e mensagens prontas, armazenamento em memória. */

/** Celular do Brasil como o provedor entrega (só dígitos, com DDI), sorteado. */
export function randomMobile() {
  return `55119${String(randomInt(10_000_000, 99_999_999))}`;
}

type ConversationSeed = {
  status?: ConversationStatus;
  assignedUserId?: string | null;
  unreadCount?: number;
  lastMessageAt?: Date;
  lastInboundAt?: Date | null;
  phone?: string;
  waName?: string | null;
  name?: string | null;
  customerId?: string | null;
  userId?: string | null;
};

export async function seedConversation(scope: Scope, channelId: string, seed: ConversationSeed = {}) {
  const phone = seed.phone ?? randomMobile();
  const key = providerPhone(phone);
  if (!key) throw new Error("telefone inválido no teste");

  return withScope(scope, async (tx) => {
    const tenantId = scopeTenantId(scope);
    const [contact] = await tx
      .insert(chatContact)
      .values({
        tenantId,
        phone: key.phone,
        phoneKey: key.phoneKey,
        waName: seed.waName === undefined ? "Contato WhatsApp" : seed.waName,
        name: seed.name ?? null,
        customerId: seed.customerId ?? null,
        userId: seed.userId ?? null,
        createdVia: "inbound",
      })
      .returning();
    if (!contact) throw new Error("contato não criado");

    const at = seed.lastMessageAt ?? new Date();
    const [row] = await tx
      .insert(conversation)
      .values({
        tenantId,
        channelId,
        contactId: contact.id,
        status: seed.status ?? "open",
        assignedUserId: seed.assignedUserId ?? null,
        assignedAt: seed.assignedUserId ? new Date() : null,
        lastMessageAt: at,
        lastMessagePreview: "oi",
        lastMessageDirection: "in",
        lastInboundAt: seed.lastInboundAt === undefined ? at : seed.lastInboundAt,
        unreadCount: seed.unreadCount ?? 0,
      })
      .returning();
    if (!row) throw new Error("conversa não criada");

    return { id: row.id, contactId: contact.id, phone: key.phone, phoneKey: key.phoneKey };
  });
}

type MessageSeed = {
  direction?: "in" | "out";
  text?: string | null;
  type?: "text" | "image" | "document";
  status?: MessageStatus | null;
  createdAt?: Date;
  mediaStatus?: "ready" | "pending" | "failed" | null;
  providerMediaId?: string | null;
  senderUserId?: string | null;
  errorCode?: string | null;
};

export async function seedMessage(
  scope: Scope,
  target: { conversationId: string; channelId: string },
  seed: MessageSeed = {},
) {
  const direction = seed.direction ?? "in";

  return withScope(scope, async (tx) => {
    const [row] = await tx
      .insert(message)
      .values({
        tenantId: scopeTenantId(scope),
        conversationId: target.conversationId,
        channelId: target.channelId,
        direction,
        senderType: direction === "in" ? "contact" : "user",
        senderUserId: seed.senderUserId ?? null,
        type: seed.type ?? "text",
        text: seed.text === undefined ? "olá" : seed.text,
        status: seed.status === undefined ? (direction === "out" ? "sent" : null) : seed.status,
        mediaStatus: seed.mediaStatus ?? null,
        providerMediaId: seed.providerMediaId ?? null,
        errorCode: seed.errorCode ?? null,
        createdAt: seed.createdAt,
      })
      .returning();
    if (!row) throw new Error("mensagem não criada");
    return row;
  });
}

/** Grava o objeto e o `file` da mensagem, como a ingestão faz. */
export async function attachMedia(
  scope: Scope,
  storage: MemoryStorage,
  messageId: string,
  content: Buffer,
  declaredMime: string,
  name = "arquivo",
) {
  const key = `inbox/test/${messageId}`;
  await storage.storage.put(key, content, { contentType: declaredMime });

  return withScope(scope, async (tx) => {
    const [created] = await tx
      .insert(file)
      .values({
        tenantId: scopeTenantId(scope),
        ownerType: "message",
        ownerId: messageId,
        key,
        name,
        size: content.byteLength,
        mime: declaredMime,
        provider: "local",
      })
      .returning({ id: file.id });
    if (!created) throw new Error("arquivo não criado");
    await tx.update(message).set({ fileId: created.id, mediaStatus: "ready" }).where(eq(message.id, messageId));
    return created.id;
  });
}

export type MemoryStorage = ReturnType<typeof memoryStorage>;

export function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage: StorageProvider = {
    id: "local",
    async put(key, body) {
      objects.set(key, body);
    },
    async get(key) {
      const body = objects.get(key);
      return body ? Readable.from([body]) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { objects, storage };
}

/**
 * Outra conversa do **mesmo contato**, em outro número (há uma por contato e número): a "Também
 * neste contato" da X1 parte dela.
 */
export async function seedConversationOnContact(
  scope: Scope,
  channelId: string,
  contactId: string,
  seed: Pick<ConversationSeed, "status" | "assignedUserId" | "lastMessageAt" | "unreadCount"> = {},
) {
  return withScope(scope, async (tx) => {
    const at = seed.lastMessageAt ?? new Date();
    const [row] = await tx
      .insert(conversation)
      .values({
        tenantId: scopeTenantId(scope),
        channelId,
        contactId,
        status: seed.status ?? "open",
        assignedUserId: seed.assignedUserId ?? null,
        assignedAt: seed.assignedUserId ? new Date() : null,
        lastMessageAt: at,
        lastMessagePreview: "segredo da outra conversa",
        lastMessageDirection: "in",
        lastInboundAt: at,
        unreadCount: seed.unreadCount ?? 0,
      })
      .returning();
    if (!row) throw new Error("conversa não criada");
    return { id: row.id, contactId };
  });
}

/** Leitura direta, atravessando o RLS, para conferir o banco depois da chamada à API. */
export const readAll = <T>(fn: Parameters<typeof withPlatformScope<T>>[1]) =>
  withPlatformScope("teste", fn);
