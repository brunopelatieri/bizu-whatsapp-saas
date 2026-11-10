import { and, eq, lt, ne, or, sql } from "drizzle-orm";
import { type Scope, scopeTenantId, type Tx, withPlatformScope, withScope } from "@/db/rls";
import { channel, chatContact, conversation, message } from "@/db/schema";
import { runInBackground } from "@/lib/auth/background";
import { ChannelNotConfiguredError, ProviderError } from "@/lib/channels/errors";
import { logChannelError } from "@/lib/channels/log";
import { sendChannelText } from "@/lib/channels/send";
import type { SendResult } from "@/lib/channels/types";
import { auditInbox } from "@/lib/inbox/assignment";
import {
  findVisibleMessage,
  messageView,
  permissionDenied,
  requireVisibleConversation,
} from "@/lib/inbox/conversations";
import { previewOf } from "@/lib/inbox/preview";
import { notifyInbox } from "@/lib/inbox/notify";
import type { MessageView } from "@/lib/inbox/views";
import type { InboxActor } from "@/lib/inbox/visibility";
import { sessionWindow } from "@/lib/inbox/window";
import type { SendMessageInput } from "@/lib/schemas/inbox";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Envio de texto (SPEC, "Envio"). A mensagem nasce `queued` numa transação curta, antes de falar
 * com o provedor: a falha fica registrada e pode ser reenviada. O provedor é chamado fora da
 * transação, com prazo; sem resposta no prazo, a mensagem fica `queued` e a varredura
 * (`inbox.sweep`) decide. Conteúdo de mensagem nunca vai a log nem à auditoria.
 */

/** Prazo da chamada ao provedor nesta requisição; o resultado tardio ainda é gravado. */
export const SEND_DEADLINE_MS = 20_000;
/** `queued` há mais que isto vira `failed` com `UNKNOWN_RESULT` (`inbox.sweep`). */
export const QUEUED_TIMEOUT = "2 minutes";

export const UNKNOWN_RESULT = "UNKNOWN_RESULT";
const UNKNOWN_RESULT_MESSAGE = "Sem confirmação do provedor. Confira no celular antes de reenviar.";

type Prepared = {
  messageId: string;
  conversationId: string;
  channelId: string;
  /** Telefone do contato, como o provedor entregou. */
  to: string;
  text: string;
  quotedProviderMessageId: string | null;
  /** `false`: o `clientId` já existia; nada novo a enviar. */
  created: boolean;
};

export type SendOutcome = { message: MessageView; failed: boolean };

/**
 * Grava a mensagem `queued` e atualiza a conversa: prévia, `last_message_at`, zera as não lidas,
 * reabre a encerrada (sem trocar o dono) e **assume** a que estava na fila (só no tenant).
 * `replacing` é o reenvio: apaga a que falhou na mesma transação.
 */
async function queueText(
  tx: Tx,
  actor: InboxActor,
  conversationId: string,
  input: { text: string; replyTo?: string | null; clientId: string },
  replacing?: string,
): Promise<Prepared> {
  const current = await requireVisibleConversation(tx, actor, conversationId, true);
  const base = {
    conversationId,
    channelId: current.channelId,
    text: input.text,
  };

  // Repetido (dois cliques, reenvio da tela depois de queda de rede): a mesma linha.
  const [existing] = await tx
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.conversationId, conversationId), eq(message.clientId, input.clientId)));
  if (existing) return { ...base, messageId: existing.id, to: "", quotedProviderMessageId: null, created: false };

  const [target] = await tx.select().from(channel).where(eq(channel.id, current.channelId));
  if (target?.status !== "connected") {
    throw new TenantRuleError(
      409,
      "CHANNEL_NOT_CONNECTED",
      "Este número não está conectado. Reconecte para enviar mensagens.",
    );
  }
  if (!sessionWindow(target.type, current.lastInboundAt).open) {
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
  if (input.replyTo) {
    const [quoted] = await tx
      .select({ providerMessageId: message.providerMessageId })
      .from(message)
      .where(and(eq(message.id, input.replyTo), eq(message.conversationId, conversationId)));
    if (!quoted) {
      throw new TenantRuleError(400, "INVALID_REPLY", "A mensagem citada não é desta conversa.");
    }
    quotedProviderMessageId = quoted.providerMessageId;
  }

  if (replacing) {
    const removed = await tx
      .delete(message)
      .where(and(eq(message.id, replacing), eq(message.status, "failed")))
      .returning({ id: message.id });
    if (removed.length === 0) throw notRetryable();
  }

  const [inserted] = await tx
    .insert(message)
    .values({
      tenantId: scopeTenantId(actor.scope),
      conversationId,
      channelId: current.channelId,
      direction: "out",
      senderType: "user",
      senderUserId: actor.userId,
      type: "text",
      text: input.text,
      clientId: input.clientId,
      replyToMessageId: input.replyTo ?? null,
      status: "queued",
    })
    .onConflictDoNothing({
      target: [message.conversationId, message.clientId],
      where: sql`client_id is not null`,
    })
    .returning({ id: message.id });
  if (!inserted) throw new Error("Mensagem não gravada.");

  const claims = actor.scope.kind === "tenant" && current.assignedUserId === null;
  const reopens = current.status === "closed";
  const owner = claims ? actor.userId : current.assignedUserId;

  await tx
    .update(conversation)
    .set({
      lastMessageAt: sql`now()`,
      lastMessagePreview: previewOf("text", input.text),
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
    s: scopeTenantId(actor.scope),
    c: conversationId,
    k: "message",
    m: inserted.id,
    a: owner,
    p: current.assignedUserId,
  });

  return {
    ...base,
    messageId: inserted.id,
    to: contact.phone,
    quotedProviderMessageId,
    created: true,
  };
}

const notRetryable = () =>
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
 * desta gravação e virado uma mensagem `device` com o mesmo id: ela é a mesma mensagem e sai.
 * Vale também para o resultado tardio de uma `queued` que a varredura já marcou `UNKNOWN_RESULT`.
 */
async function recordSent(scope: Scope, prepared: Prepared, result: SendResult) {
  await withScope(scope, async (tx) => {
    await tx
      .delete(message)
      .where(
        and(
          eq(message.channelId, prepared.channelId),
          eq(message.providerMessageId, result.providerMessageId),
          eq(message.senderType, "device"),
          ne(message.id, prepared.messageId),
        ),
      );

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
  });
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
  const view = await withScope(actor.scope, (tx) => messageView(tx, messageId));
  return { message: view, failed: view.status === "failed" };
}

/**
 * Chama o provedor fora da transação e grava o resultado. A mensagem que já existia (`clientId`
 * repetido) só é devolvida: nunca vai ao provedor de novo.
 */
async function dispatch(actor: InboxActor, prepared: Prepared): Promise<SendOutcome> {
  if (!prepared.created) return outcomeOf(actor, prepared.messageId);

  const attempt = sendChannelText(actor.scope, prepared.channelId, {
    to: prepared.to,
    text: prepared.text,
    ...(prepared.quotedProviderMessageId
      ? { quotedProviderMessageId: prepared.quotedProviderMessageId }
      : {}),
  });
  const outcome = await withDeadline(attempt, SEND_DEADLINE_MS);

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
  input: SendMessageInput,
): Promise<SendOutcome> {
  if (!actor.can.reply) throw permissionDenied();

  const prepared = await withScope(actor.scope, (tx) =>
    queueText(tx, actor, conversationId, input),
  );
  return dispatch(actor, prepared);
}

/**
 * Reenviar: só a mensagem `failed` enviada pela equipe, de conversa que o ator vê. Cria uma nova
 * com o mesmo conteúdo e apaga a que falhou, na mesma transação. Anexo e modelo entram na C5.
 */
export async function retryMessage(actor: InboxActor, messageId: string): Promise<SendOutcome> {
  if (!actor.can.reply) throw permissionDenied();

  const prepared = await withScope(actor.scope, async (tx) => {
    const old = await findVisibleMessage(tx, actor, messageId);
    if (!old) throw notFound("Mensagem não encontrada.");
    if (old.direction !== "out" || old.senderType !== "user" || old.status !== "failed") {
      throw notRetryable();
    }
    if (old.type !== "text" || !old.text) throw notRetryable();

    return queueText(
      tx,
      actor,
      old.conversationId,
      { text: old.text, replyTo: old.replyToMessageId, clientId: `retry-${old.id}` },
      old.id,
    );
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
