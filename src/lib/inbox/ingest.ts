import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type Scope, scopeTenantId, type Tx } from "@/db/rls";
import { type channel, chatContact, conversation, file, message } from "@/db/schema";
import { can } from "@/lib/channels/capabilities";
import type { AfterCommit } from "@/lib/channels/connection";
import type { InboxHandlers } from "@/lib/channels/events";
import { isStoredMedia } from "@/lib/channels/media";
import type { NormalizedMessage, NormalizedStatus } from "@/lib/channels/types";
import { type MessageType, PREVIEW_MAX } from "@/lib/inbox/constants";
import {
  autoLinkContact,
  findContactByLid,
  providerPhone,
  rememberLid,
  upsertContact,
} from "@/lib/inbox/contacts";
import { enqueueInboxMedia, type PendingMediaInfo, storedMediaFile } from "@/lib/inbox/media";
import { notifyInbox } from "@/lib/inbox/notify";
import { getStorage } from "@/lib/storage";

/**
 * Ingestão (SPEC da caixa de entrada, "Ingestão"). Chamada por `applyChannelEvent` dentro de
 * `withScope`, na transação do aviso. Idempotente: repetir o evento não muda nada. Conteúdo de
 * mensagem nunca vai a log, auditoria nem Sentry.
 */

type ChannelRow = typeof channel.$inferSelect;

/** Identificador oculto do WhatsApp, como a Evolution o entrega (`<dígitos>@lid`). */
const LID = /^\d+@lid$/;

const PREVIEW_LABELS: Record<MessageType, string> = {
  text: "Mensagem",
  image: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contacts: "Contato",
  template: "Modelo de mensagem",
  interactive: "Resposta",
  unsupported: "Mensagem não suportada",
};

/** Prévia da lista: o texto (ou legenda), senão o tipo; até 120 caracteres. */
export function previewOf(type: MessageType, text: string | null) {
  const body = text?.replace(/\s+/g, " ").trim() || PREVIEW_LABELS[type];
  const chars = Array.from(body);

  return chars.length > PREVIEW_MAX ? `${chars.slice(0, PREVIEW_MAX - 1).join("")}…` : body;
}

/** Hora do provedor, nunca no futuro: relógio de celular adiantado não fura a ordem da lista. */
function eventTime(occurredAt: Date, now = new Date()) {
  const time = occurredAt.getTime();
  return Number.isFinite(time) && time < now.getTime() ? occurredAt : now;
}

/** O id do provedor já está gravado (reentrega, ou eco de mensagem que o próprio sistema enviou). */
async function knownMessage(tx: Tx, channelId: string, providerMessageId: string) {
  const [row] = await tx
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.channelId, channelId), eq(message.providerMessageId, providerMessageId)))
    .limit(1);
  return Boolean(row);
}

/** O `INSERT ... DO NOTHING` da mensagem não inseriu: desfaz o savepoint da conversa. */
class DuplicateMessage extends Error {}

/** Depois do commit do aviso; sem a lista (chamada direta), na hora. */
async function defer(after: AfterCommit | undefined, effect: () => Promise<void>) {
  if (after) after.push(effect);
  else await effect();
}

/**
 * Item descartado (repetido, LID desconhecido, eco sem `deviceEcho`): a mídia que ele trouxe
 * (gravada pelo webhook sob uma chave nova) não é de ninguém e sai do armazenamento depois do
 * commit, mesmo que outro item do aviso seja aplicado. Só se nenhum `file` a cita.
 */
async function discardMedia(tx: Tx, event: NormalizedMessage, after?: AfterCommit) {
  const key = event.media?.storage?.storageKey;
  if (!key || !isStoredMedia(event.media?.storage)) return;

  const [used] = await tx.select({ id: file.id }).from(file).where(eq(file.key, key)).limit(1);
  if (!used) await defer(after, () => getStorage().delete(key));
}

/** A mesma conversa por contato e número; reaberta, volta à fila. Um comando só. */
async function upsertConversation(
  tx: Tx,
  scope: Scope,
  input: { channelId: string; contactId: string; at: Date; preview: string; echo: boolean },
) {
  const { echo, at } = input;
  const values = {
    tenantId: scopeTenantId(scope),
    channelId: input.channelId,
    contactId: input.contactId,
    status: "open" as const,
    lastMessageAt: at,
    lastMessagePreview: input.preview,
    lastMessageDirection: echo ? ("out" as const) : ("in" as const),
    lastInboundAt: echo ? null : at,
    unreadCount: echo ? 0 : 1,
  };

  // No `DO UPDATE`, as colunas da tabela são os valores **antes** da mudança.
  const newer = sql`excluded.last_message_at >= coalesce(${conversation.lastMessageAt}, '-infinity'::timestamptz)`;
  const closed = sql`${conversation.status} = 'closed'`;
  const latest = {
    lastMessageAt: sql`greatest(${conversation.lastMessageAt}, excluded.last_message_at)`,
    lastMessagePreview: sql`case when ${newer} then excluded.last_message_preview else ${conversation.lastMessagePreview} end`,
    lastMessageDirection: sql`case when ${newer} then excluded.last_message_direction else ${conversation.lastMessageDirection} end`,
    updatedAt: sql`now()`,
  };
  // Eco do aparelho: não soma não lidas, não mexe na situação, no dono nem na janela de 24 h.
  const set: Record<string, SQL | null> = echo
    ? latest
    : {
        ...latest,
        unreadCount: sql`${conversation.unreadCount} + 1`,
        lastInboundAt: sql`greatest(${conversation.lastInboundAt}, excluded.last_inbound_at)`,
        // Encerrada que recebe mensagem do contato volta aberta e **sem dono**, para a fila.
        status: sql`case when ${closed} then 'open' else ${conversation.status} end`,
        assignedUserId: sql`case when ${closed} then null else ${conversation.assignedUserId} end`,
        assignedAt: sql`case when ${closed} then null else ${conversation.assignedAt} end`,
        closedAt: null,
        closedBy: null,
      };

  const returning = { id: conversation.id, assignedUserId: conversation.assignedUserId };
  const [row] = await (scope.kind === "tenant"
    ? tx
        .insert(conversation)
        .values(values)
        .onConflictDoUpdate({
          target: [conversation.tenantId, conversation.contactId, conversation.channelId],
          set,
        })
        .returning(returning)
    : tx
        .insert(conversation)
        .values(values)
        .onConflictDoUpdate({
          target: [conversation.contactId, conversation.channelId],
          targetWhere: sql`tenant_id is null`,
          set,
        })
        .returning(returning));
  if (!row) throw new Error("Conversa não gravada.");

  return row;
}

/** Contato da mensagem: pelo telefone (cria se preciso) ou por um LID já conhecido. */
async function resolveContact(tx: Tx, scope: Scope, event: NormalizedMessage, lid: string | null) {
  const phone = providerPhone(event.fromPhone);
  const echo = event.fromMe;

  if (phone) {
    const contact = await upsertContact(tx, scope, {
      ...phone,
      // No eco, o nome do perfil é o do dono do número, não o do contato.
      waName: echo ? null : event.pushName,
      createdVia: echo ? "device" : "inbound",
    });
    if (contact.inserted) await autoLinkContact(tx, scope, contact.id, phone.phoneKey);
    if (lid) await rememberLid(tx, scope, contact.id, lid);
    return contact.id;
  }

  if (!lid) return null;
  const known = await findContactByLid(tx, scope, lid);
  if (!known) return null;

  if (!echo && event.pushName && event.pushName !== known.waName) {
    await tx.update(chatContact).set({ waName: event.pushName }).where(eq(chatContact.id, known.id));
  }
  return known.id;
}

/**
 * Evento `message`. `true` quando gravou a mensagem; `false` vira `ignored` no aviso (grupo,
 * status do WhatsApp, eco em canal sem `deviceEcho`, LID desconhecido, repetida).
 */
export async function ingestMessage(
  tx: Tx,
  scope: Scope,
  target: ChannelRow,
  event: NormalizedMessage,
  after?: AfterCommit,
): Promise<boolean> {
  const applied = await applyMessage(tx, scope, target, event, after);
  if (!applied) await discardMedia(tx, event, after);
  return applied;
}

async function applyMessage(
  tx: Tx,
  scope: Scope,
  target: ChannelRow,
  event: NormalizedMessage,
  after: AfterCommit | undefined,
): Promise<boolean> {
  const echo = event.fromMe;
  if (echo && !can(target.type, "deviceEcho")) return false;

  const lid = event.fromExternalId && LID.test(event.fromExternalId) ? event.fromExternalId : null;
  // Sem telefone nem LID: grupo, transmissão ou status. O normalizador já descarta; aqui é a trava.
  if (!event.fromPhone && !lid) return false;
  if (!event.providerMessageId) return false;

  if (await knownMessage(tx, target.id, event.providerMessageId)) return false;

  const contactId = await resolveContact(tx, scope, event, lid);
  if (!contactId) return false;

  const at = eventTime(event.occurredAt);
  const type: MessageType = event.messageType;

  try {
    // Savepoint: se a mensagem já existir (corrida com outro aviso), a conversa volta como estava.
    return await tx.transaction(async (sp) => {
      const thread = await upsertConversation(sp, scope, {
        channelId: target.id,
        contactId,
        at,
        preview: previewOf(type, event.text),
        echo,
      });

      const [quoted] = event.replyToProviderMessageId
        ? await sp
            .select({ id: message.id })
            .from(message)
            .where(
              and(
                eq(message.channelId, target.id),
                eq(message.providerMessageId, event.replyToProviderMessageId),
              ),
            )
            .limit(1)
        : [];

      const media = event.media;
      const pendingMedia = media?.providerMediaId && !media.storage ? media.providerMediaId : null;
      const mediaInfo: PendingMediaInfo | null = media
        ? { filename: media.filename, mime: media.mime }
        : null;

      const [created] = await sp
        .insert(message)
        .values({
          tenantId: scopeTenantId(scope),
          conversationId: thread.id,
          channelId: target.id,
          direction: echo ? "out" : "in",
          senderType: echo ? "device" : "contact",
          type,
          text: event.text,
          // Sem fonte utilizável (só a URL cifrada do CDN, por exemplo): falhou já na chegada.
          mediaStatus: media ? (pendingMedia ? "pending" : media.storage ? null : "failed") : null,
          providerMediaId: pendingMedia,
          providerMessageId: event.providerMessageId,
          replyToMessageId: quoted?.id ?? null,
          payload: mediaInfo ? { media: mediaInfo } : null,
          status: echo ? "sent" : null,
          providerTimestamp: event.occurredAt,
          createdAt: at,
        })
        .onConflictDoNothing({
          target: [message.channelId, message.providerMessageId],
          where: sql`provider_message_id is not null`,
        })
        .returning({ id: message.id });
      if (!created) throw new DuplicateMessage();

      if (media?.storage) {
        const stored = await storedMediaFile(sp, scope, created.id, media);
        await sp
          .update(message)
          .set(stored ? { fileId: stored.id, mediaStatus: "ready" } : { mediaStatus: "failed" })
          .where(eq(message.id, created.id));
      }

      if (pendingMedia) {
        const job = { messageId: created.id, tenantId: scopeTenantId(scope) };
        await defer(after, () => enqueueInboxMedia(job));
      }

      await notifyInbox(sp, {
        s: scopeTenantId(scope),
        c: thread.id,
        k: "message",
        m: created.id,
        a: thread.assignedUserId,
      });
      return true;
    });
  } catch (error) {
    if (!(error instanceof DuplicateMessage)) throw error;
    return false;
  }
}

/** Posição na escada de entrega. `failed` fica fora: só entra a partir de `queued` ou `sent`. */
const RANK: Record<Exclude<NormalizedStatus["status"], "failed">, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

const statusRank = sql`case ${message.status} when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 99 end`;

/** `(#131026) Título: mensagem` → `131026`. */
function errorCodeOf(error: string | null) {
  return error?.match(/^\(#(\w+)\)/)?.[1] ?? null;
}

/**
 * Evento `status`: só sobe a escada, em um `UPDATE` condicional, sem ler antes. Fora de ordem
 * (lida antes de entregue) termina certo; mensagem desconhecida ou status que não avança vira
 * `ignored`.
 */
export async function ingestStatus(
  tx: Tx,
  scope: Scope,
  target: ChannelRow,
  event: NormalizedStatus,
): Promise<boolean> {
  const failed = event.status === "failed";
  const where = and(
    eq(message.channelId, target.id),
    eq(message.providerMessageId, event.providerMessageId),
    eq(message.direction, "out"),
    event.status === "failed"
      ? inArray(message.status, ["queued", "sent"])
      : sql`${statusRank} < ${sql.raw(String(RANK[event.status]))}`,
  );

  const updated = await tx
    .update(message)
    .set(
      failed
        ? {
            status: "failed",
            errorCode: errorCodeOf(event.error),
            errorMessage: event.error?.slice(0, 500) ?? null,
          }
        : { status: event.status },
    )
    .where(where)
    .returning({ id: message.id, conversationId: message.conversationId });

  for (const row of updated) {
    await notifyInbox(tx, { s: scopeTenantId(scope), c: row.conversationId, k: "status", m: row.id });
  }
  return updated.length > 0;
}

/** Registrados em `applyChannelEvent` (`src/lib/channels/events.ts`). */
export const inboxHandlers: InboxHandlers = {
  message: ingestMessage,
  status: ingestStatus,
};
