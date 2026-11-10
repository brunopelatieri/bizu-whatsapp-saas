import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { type Scope, scopeTenantId, type Tx, withPlatformScope, withScope } from "@/db/rls";
import { channel, chatContact, conversation, file, message } from "@/db/schema";
import { runInBackground } from "@/lib/auth/background";
import { ChannelNotConfiguredError, ProviderError } from "@/lib/channels/errors";
import { logChannelError } from "@/lib/channels/log";
import { sendChannelMedia, sendChannelTemplate, sendChannelText } from "@/lib/channels/send";
import type { SendResult } from "@/lib/channels/types";
import { auditInbox } from "@/lib/inbox/assignment";
import {
  findVisibleMessage,
  messageView,
  permissionDenied,
  requireVisibleConversation,
} from "@/lib/inbox/conversations";
import type { MessageType, OutboundKind } from "@/lib/inbox/constants";
import { mediaOutUrl } from "@/lib/inbox/media-out";
import { notifyInbox } from "@/lib/inbox/notify";
import { previewOf } from "@/lib/inbox/preview";
import type { MessageView } from "@/lib/inbox/views";
import type { InboxActor } from "@/lib/inbox/visibility";
import { sessionWindow } from "@/lib/inbox/window";
import type { SendTextInput } from "@/lib/schemas/inbox";
import { getStorage } from "@/lib/storage";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Envio (SPEC, "Envio"). Texto, anexo (`send-media.ts`) e modelo (`send-template.ts`) passam pelo
 * mesmo caminho: `queueMessage` grava a mensagem `queued` numa transação curta, antes de falar com o
 * provedor, e `dispatch` o chama fora da transação, com prazo. A falha fica registrada e pode ser
 * reenviada; sem resposta no prazo, a mensagem fica `queued` e a varredura (`inbox.sweep`) decide.
 * Conteúdo de mensagem nunca vai a log nem à auditoria.
 */

/** Prazo da chamada ao provedor nesta requisição; o resultado tardio ainda é gravado. */
export const SEND_DEADLINE_MS = 20_000;
/** Anexo: a Meta recebe o upload e depois o envio; a Evolution baixa o arquivo na mesma chamada. */
export const MEDIA_DEADLINE_MS = 30_000;
/** `queued` há mais que isto vira `failed` com `UNKNOWN_RESULT` (`inbox.sweep`). */
export const QUEUED_TIMEOUT = "2 minutes";

export const UNKNOWN_RESULT = "UNKNOWN_RESULT";
const UNKNOWN_RESULT_MESSAGE = "Sem confirmação do provedor. Confira no celular antes de reenviar.";

/** O que sai pelo provedor: o texto, o anexo (já gravado em `file`) ou o modelo (já validado). */
export type Delivery =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      mediaKind: OutboundKind;
      fileId: string;
      key: string;
      name: string;
      mime: string;
      caption: string | null;
    }
  | { kind: "template"; name: string; language: string; components: unknown[] };

export type Prepared = {
  messageId: string;
  conversationId: string;
  channelId: string;
  /** Telefone do contato, como o provedor entregou. */
  to: string;
  delivery: Delivery;
  quotedProviderMessageId: string | null;
  /** `false`: o `clientId` já existia; nada novo a enviar. */
  created: boolean;
};

export type SendOutcome = { message: MessageView; failed: boolean };

/** Anexo novo: o objeto já está no armazenamento; a linha de `file` nasce na transação da mensagem. */
export type NewFile = { key: string; name: string; size: number; mime: string };

/** O que `build` decide depois de conferido o canal: tipo, texto, arquivo e o que vai ao provedor. */
export type Draft = {
  type: MessageType;
  /** Texto, legenda ou o modelo já preenchido: vai a `message.text` e à prévia. */
  text: string | null;
  templateName?: string | null;
  payload?: Record<string, unknown> | null;
  /** Anexo novo, ou `existingFileId` quando o reenvio reaproveita o arquivo da mensagem que falhou. */
  newFile?: NewFile;
  existingFileId?: string;
  delivery: (fileId: string | null) => Delivery;
};

export type QueueOptions = {
  clientId: string;
  replyTo?: string | null;
  /** `false` para modelo: é a única forma de falar com a janela de 24 h fechada. */
  requiresWindow: boolean;
  /** Roda com o canal conferido e a conversa travada; lança 4xx de regra. */
  build: (tx: Tx, target: typeof channel.$inferSelect) => Promise<Draft> | Draft;
};

/**
 * Grava a mensagem `queued` e atualiza a conversa: prévia, `last_message_at`, zera as não lidas,
 * reabre a encerrada (sem trocar o dono) e **assume** a que estava na fila (só no tenant).
 * `replacing` é o reenvio: apaga a que falhou na mesma transação.
 */
export async function queueMessage(
  tx: Tx,
  actor: InboxActor,
  conversationId: string,
  options: QueueOptions,
  replacing?: string,
): Promise<Prepared> {
  const current = await requireVisibleConversation(tx, actor, conversationId, true);
  const base = { conversationId, channelId: current.channelId };

  // Repetido (dois cliques, reenvio da tela depois de queda de rede): a mesma linha.
  const [existing] = await tx
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.clientId, options.clientId)));
  if (existing) {
    return {
      ...base,
      messageId: existing.id,
      to: "",
      delivery: { kind: "text", text: "" },
      quotedProviderMessageId: null,
      created: false,
    };
  }

  const [target] = await tx.select().from(channel).where(eq(channel.id, current.channelId));
  if (target?.status !== "connected") {
    throw new TenantRuleError(
      409,
      "CHANNEL_NOT_CONNECTED",
      "Este número não está conectado. Reconecte para enviar mensagens.",
    );
  }
  if (options.requiresWindow && !sessionWindow(target.type, current.lastInboundAt).open) {
    throw new TenantRuleError(
      409,
      "SESSION_WINDOW_CLOSED",
      "A janela de 24 horas desta conversa está encerrada. Envie um modelo aprovado.",
    );
  }

  const [contact] = await tx
    .select({ phone: chatContact.phone })
    .from(chatContact)
    .where(eq(chatContact.id, current.contactId));
  if (!contact) throw notFound("Conversa não encontrada.");

  let quotedProviderMessageId: string | null = null;
  if (options.replyTo) {
    const [quoted] = await tx
      .select({ providerMessageId: message.providerMessageId })
      .from(message)
      .where(and(eq(message.id, options.replyTo), eq(message.conversationId, conversationId)));
    if (!quoted) {
      throw new TenantRuleError(400, "INVALID_REPLY", "A mensagem citada não é desta conversa.");
    }
    quotedProviderMessageId = quoted.providerMessageId;
  }

  const draft = await options.build(tx, target);

  if (replacing) {
    const removed = await tx
      .delete(message)
      .where(and(eq(message.id, replacing), eq(message.status, "failed")))
      .returning({ id: message.id });
    if (removed.length === 0) throw notRetryable();
  }

  // O id nasce aqui para o `file` (dono = a mensagem) existir antes dela, sem segunda gravação.
  const messageId = randomUUID();
  const tenantId = scopeTenantId(actor.scope);
  let fileId: string | null = draft.existingFileId ?? null;

  if (draft.newFile) {
    const [created] = await tx
      .insert(file)
      .values({
        tenantId,
        ownerType: "message",
        ownerId: messageId,
        key: draft.newFile.key,
        name: draft.newFile.name,
        size: draft.newFile.size,
        mime: draft.newFile.mime,
        provider: getStorage().id,
        createdBy: actor.userId,
      })
      .returning({ id: file.id });
    if (!created) throw new Error("Arquivo não gravado.");
    fileId = created.id;
  }

  const [inserted] = await tx
    .insert(message)
    .values({
      id: messageId,
      tenantId,
      conversationId,
      channelId: current.channelId,
      direction: "out",
      senderType: "user",
      senderUserId: actor.userId,
      type: draft.type,
      text: draft.text,
      fileId,
      mediaStatus: fileId ? "ready" : null,
      templateName: draft.templateName ?? null,
      payload: draft.payload ?? null,
      clientId: options.clientId,
      replyToMessageId: options.replyTo ?? null,
      status: "queued",
    })
    .onConflictDoNothing({
      target: [message.conversationId, message.clientId],
      where: sql`client_id is not null`,
    })
    .returning({ id: message.id });
  if (!inserted) throw new Error("Mensagem não gravada.");

  // Reenvio de anexo: o arquivo é o mesmo (sem novo upload) e passa a pertencer à mensagem nova.
  if (draft.existingFileId) {
    await tx.update(file).set({ ownerId: messageId }).where(eq(file.id, draft.existingFileId));
  }

  const claims = actor.scope.kind === "tenant" && current.assignedUserId === null;
  const reopens = current.status === "closed";
  const owner = claims ? actor.userId : current.assignedUserId;

  await tx
    .update(conversation)
    .set({
      lastMessageAt: sql`now()`,
      lastMessagePreview: previewOf(draft.type, draft.text),
      lastMessageDirection: "out",
      unreadCount: 0,
      updatedAt: sql`now()`,
      ...(claims ? { assignedUserId: actor.userId, assignedAt: sql`now()` } : {}),
      // Responder a encerrada a reabre; o dono não muda (sem dono, quem respondeu assume acima).
      ...(reopens ? { status: "open" as const, closedAt: null, closedBy: null } : {}),
    })
    .where(eq(conversation.id, conversationId));

  const audited = { type: "conversation" as const, id: conversationId };
  if (claims) await auditInbox(tx, actor, "inbox.conversation_claimed", audited, { via: "reply" });
  if (reopens) {
    await auditInbox(tx, actor, "inbox.conversation_reopened", audited, { to: "open", via: "reply" });
  }

  await notifyInbox(tx, {
    s: tenantId,
    c: conversationId,
    k: "message",
    m: messageId,
    a: owner,
    p: current.assignedUserId,
    u: actor.userId,
  });

  return {
    ...base,
    messageId,
    to: contact.phone,
    delivery: draft.delivery(fileId),
    quotedProviderMessageId,
    created: true,
  };
}

/** Rascunho de texto: o mesmo no primeiro envio e no reenvio. */
const textDraft = (text: string): Draft => ({
  type: "text",
  text,
  delivery: () => ({ kind: "text", text }),
});

export const notRetryable = () =>
  new TenantRuleError(409, "NOT_RETRYABLE", "Só uma mensagem que falhou pode ser reenviada.");

/** Prazo da requisição: `timeout` não é falha, só falta de resposta. */
async function withDeadline<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });

  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: "ok" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sucesso do provedor: `sent` com o id dele. O eco do aparelho (Evolution) pode ter chegado antes
 * desta gravação e virado uma mensagem `device` com o mesmo id: ela é a mesma mensagem e sai, junto com
 * o `file` e o objeto que a ingestão gravou (anexo enviado por aqui). Vale também para o resultado tardio
 * de uma `queued` que a varredura já marcou `UNKNOWN_RESULT`.
 */
async function recordSent(scope: Scope, prepared: Prepared, result: SendResult) {
  const orphanKeys = await withScope(scope, async (tx) => {
    const echoes = await tx
      .delete(message)
      .where(
        and(
          eq(message.channelId, prepared.channelId),
          eq(message.providerMessageId, result.providerMessageId),
          eq(message.senderType, "device"),
          ne(message.id, prepared.messageId),
        ),
      )
      .returning({ id: message.id });

    const removedFiles =
      echoes.length > 0
        ? await tx
            .delete(file)
            .where(
              and(
                eq(file.ownerType, "message"),
                inArray(
                  file.ownerId,
                  echoes.map((echo) => echo.id),
                ),
              ),
            )
            .returning({ key: file.key })
        : [];

    const [updated] = await tx
      .update(message)
      .set({
        status: "sent",
        providerMessageId: result.providerMessageId,
        errorCode: null,
        errorMessage: null,
      })
      .where(
        and(
          eq(message.id, prepared.messageId),
          or(
            eq(message.status, "queued"),
            and(eq(message.status, "failed"), eq(message.errorCode, UNKNOWN_RESULT)),
          ),
        ),
      )
      .returning({ id: message.id });

    if (updated) {
      await notifyInbox(tx, {
        s: scopeTenantId(scope),
        c: prepared.conversationId,
        k: "status",
        m: prepared.messageId,
      });
    }
    return removedFiles.map((row) => row.key);
  });

  // Depois do commit: o objeto do eco só sai do armazenamento quando a linha já saiu do banco.
  await Promise.all(
    orphanKeys.map((key) =>
      getStorage()
        .delete(key)
        .catch((error) => logChannelError("Falha ao apagar mídia do eco", error)),
    ),
  );
}

/** O que a recusa vira na mensagem: código e texto para o atendente, nunca para o log. */
function failureOf(error: unknown): { code: string; message: string } | null {
  if (error instanceof ProviderError) {
    // Rede ou timeout (status 0): o provedor pode ter enviado. Fica `queued`; a varredura decide.
    if (error.status === 0) return null;
    return {
      code: String(error.code ?? error.status),
      message: error.message.slice(0, 500) || "O provedor recusou a mensagem.",
    };
  }
  if (error instanceof TenantRuleError) return { code: error.code, message: error.message };
  if (error instanceof ChannelNotConfiguredError) {
    return { code: "PROVIDER_UNAVAILABLE", message: "Este tipo de número não está disponível no servidor." };
  }
  return { code: "SEND_ERROR", message: "Não foi possível enviar a mensagem." };
}

async function recordFailure(scope: Scope, prepared: Prepared, error: unknown) {
  logChannelError("Falha no envio de mensagem", error);
  const failure = failureOf(error);
  if (!failure) return;

  await withScope(scope, async (tx) => {
    const [updated] = await tx
      .update(message)
      .set({ status: "failed", errorCode: failure.code, errorMessage: failure.message })
      .where(and(eq(message.id, prepared.messageId), eq(message.status, "queued")))
      .returning({ id: message.id });

    if (updated) {
      await notifyInbox(tx, {
        s: scopeTenantId(scope),
        c: prepared.conversationId,
        k: "status",
        m: prepared.messageId,
      });
    }
  });
}

async function outcomeOf(actor: InboxActor, messageId: string): Promise<SendOutcome> {
  const view = await withScope(actor.scope, (tx) => messageView(tx, actor.scope, messageId));
  return { message: view, failed: view.status === "failed" };
}

/** Lê o anexo inteiro do armazenamento (a Cloud API recebe o arquivo, não um endereço). */
async function readObject(key: string) {
  const stream = await getStorage().get(key);
  if (!stream) {
    throw new TenantRuleError(
      409,
      "MEDIA_MISSING",
      "O arquivo deste anexo não está mais disponível. Anexe de novo.",
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** A chamada ao provedor: texto, anexo (Cloud sobe o arquivo; Evolution baixa `url`) ou modelo. */
function attemptOf(scope: Scope, prepared: Prepared): Promise<SendResult> {
  const { delivery, channelId, to } = prepared;
  const quoted = prepared.quotedProviderMessageId
    ? { quotedProviderMessageId: prepared.quotedProviderMessageId }
    : {};

  switch (delivery.kind) {
    case "text":
      return sendChannelText(scope, channelId, { to, text: delivery.text, ...quoted });
    case "media":
      return sendChannelMedia(scope, channelId, {
        to,
        kind: delivery.mediaKind,
        // Evolution: endereço de 5 min assinado (só a ela serve). Cloud: o arquivo, enviado pelo id.
        url: mediaOutUrl(delivery.fileId),
        content: async () => ({ body: await readObject(delivery.key), mime: delivery.mime }),
        filename: delivery.name,
        ...(delivery.caption ? { caption: delivery.caption } : {}),
        ...quoted,
      });
    case "template":
      return sendChannelTemplate(scope, channelId, {
        to,
        name: delivery.name,
        language: delivery.language,
        components: delivery.components,
      });
  }
}

/**
 * Chama o provedor fora da transação e grava o resultado. A mensagem que já existia (`clientId`
 * repetido) só é devolvida: nunca vai ao provedor de novo.
 */
export async function dispatch(actor: InboxActor, prepared: Prepared): Promise<SendOutcome> {
  if (!prepared.created) return outcomeOf(actor, prepared.messageId);

  let attempt: Promise<SendResult>;
  try {
    attempt = attemptOf(actor.scope, prepared);
  } catch (error) {
    // Falha síncrona (URL do anexo sem `APP_URL`, por exemplo): é falha de envio, não de API.
    attempt = Promise.reject(error);
  }
  const deadline = prepared.delivery.kind === "media" ? MEDIA_DEADLINE_MS : SEND_DEADLINE_MS;
  const outcome = await withDeadline(attempt, deadline);

  if (outcome.kind === "ok") await recordSent(actor.scope, prepared, outcome.value);
  else if (outcome.kind === "error") await recordFailure(actor.scope, prepared, outcome.error);
  else {
    // Sem resposta no prazo: a tela recebe `queued`; o resultado tardio ainda é gravado.
    runInBackground(
      attempt.then(
        (result) => recordSent(actor.scope, prepared, result),
        (error: unknown) => recordFailure(actor.scope, prepared, error),
      ),
    );
  }

  return outcomeOf(actor, prepared.messageId);
}

/**
 * `POST /conversations/:id/messages` com texto. `clientId` repetido devolve a mesma mensagem, sem
 * enviar de novo. Recusa do provedor não é erro de API: a mensagem volta `failed`, com o motivo.
 */
export async function sendText(
  actor: InboxActor,
  conversationId: string,
  input: SendTextInput,
): Promise<SendOutcome> {
  if (!actor.can.reply) throw permissionDenied();

  const prepared = await withScope(actor.scope, (tx) =>
    queueMessage(tx, actor, conversationId, {
      clientId: input.clientId,
      replyTo: input.replyTo,
      requiresWindow: true,
      build: () => textDraft(input.text),
    }),
  );
  return dispatch(actor, prepared);
}

type StoredTemplate = { name: string; language: string; components: unknown[] };

/** O que `send-template.ts` guarda em `payload.template`; lido de volta no reenvio. */
function storedTemplate(payload: Record<string, unknown> | null): StoredTemplate | null {
  const raw = payload?.template as Partial<StoredTemplate> | undefined;
  if (!raw || typeof raw.name !== "string" || typeof raw.language !== "string") return null;
  return { name: raw.name, language: raw.language, components: Array.isArray(raw.components) ? raw.components : [] };
}

const MEDIA_TYPES: readonly MessageType[] = ["image", "video", "audio", "document"];

/**
 * Reenviar: só a mensagem `failed` enviada pela equipe, de conversa que o ator vê. Cria uma nova
 * com o mesmo conteúdo e apaga a que falhou, na mesma transação. O anexo reaproveita o `file` (sem novo
 * upload) e o modelo, a carga já validada; o de modelo vale com a janela fechada, como no primeiro envio.
 */
export async function retryMessage(actor: InboxActor, messageId: string): Promise<SendOutcome> {
  if (!actor.can.reply) throw permissionDenied();

  const prepared = await withScope(actor.scope, async (tx) => {
    const old = await findVisibleMessage(tx, actor, messageId);
    if (!old) throw notFound("Mensagem não encontrada.");
    if (old.direction !== "out" || old.senderType !== "user" || old.status !== "failed") {
      throw notRetryable();
    }

    const common = { clientId: `retry-${old.id}`, replyTo: old.replyToMessageId };

    if (old.type === "text" && old.text) {
      const text = old.text;
      return queueMessage(
        tx,
        actor,
        old.conversationId,
        { ...common, requiresWindow: true, build: () => textDraft(text) },
        old.id,
      );
    }

    if (old.type === "template") {
      const template = storedTemplate(old.payload);
      if (!template) throw notRetryable();
      return queueMessage(
        tx,
        actor,
        old.conversationId,
        {
          clientId: common.clientId,
          requiresWindow: false,
          build: () => ({
            type: "template",
            text: old.text,
            templateName: old.templateName,
            payload: old.payload,
            delivery: () => ({ kind: "template", ...template }),
          }),
        },
        old.id,
      );
    }

    if (MEDIA_TYPES.includes(old.type) && old.fileId) {
      const [stored] = await tx.select().from(file).where(eq(file.id, old.fileId));
      if (!stored) throw notRetryable();
      const fileId = stored.id;
      const mediaKind = old.type as OutboundKind;

      return queueMessage(
        tx,
        actor,
        old.conversationId,
        {
          ...common,
          requiresWindow: true,
          build: () => ({
            type: old.type,
            text: old.text,
            existingFileId: fileId,
            delivery: () => ({
              kind: "media",
              mediaKind,
              fileId,
              key: stored.key,
              name: stored.name,
              mime: stored.mime,
              caption: old.text,
            }),
          }),
        },
        old.id,
      );
    }

    throw notRetryable();
  });

  return dispatch(actor, prepared);
}

/**
 * `inbox.sweep` (cron de 5 min): `queued` há mais de 2 minutos vira `failed` com
 * `UNKNOWN_RESULT`. Atravessa os tenants (job), como os demais jobs de varredura.
 */
export async function sweepQueuedMessages() {
  return withPlatformScope("inbox.sweep", async (tx) => {
    const swept = await tx
      .update(message)
      .set({ status: "failed", errorCode: UNKNOWN_RESULT, errorMessage: UNKNOWN_RESULT_MESSAGE })
      .where(
        and(
          eq(message.status, "queued"),
          lt(message.createdAt, sql`now() - ${sql.raw(`interval '${QUEUED_TIMEOUT}'`)}`),
        ),
      )
      .returning({ id: message.id, conversationId: message.conversationId, tenantId: message.tenantId });

    for (const row of swept) {
      await notifyInbox(tx, { s: row.tenantId, c: row.conversationId, k: "status", m: row.id });
    }
    return swept.length;
  });
}
