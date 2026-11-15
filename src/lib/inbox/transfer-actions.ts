import { and, asc, eq, ne, sql } from "drizzle-orm";
import { scopeTenantId, type Tx, withScope } from "@/db/rls";
import { channel, conversation, message } from "@/db/schema";
import { requireChannelRow, scopeWhere } from "@/lib/channels/service";
import { auditInbox } from "@/lib/inbox/assignment";
import { openConversation } from "@/lib/inbox/contact-actions";
import { permissionDenied, requireVisibleConversation } from "@/lib/inbox/conversations";
import { dispatch, type Prepared, queueMessage, textDraft } from "@/lib/inbox/send";
import { eligibleTransferChannels, type TransferDestination } from "@/lib/inbox/transfer";
import { conversationScope, type InboxActor, visibleConversation } from "@/lib/inbox/visibility";
import type { TransferConversationInput } from "@/lib/schemas/inbox";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * "Continuar por outro número" (X2, `docs/specs/pre-producao/spec.md`): a conversa com o mesmo contato
 * segue por outro número do escopo. Nada muda no envio: a mensagem sai pelo número da conversa de
 * **destino**, pelo mesmo `queueMessage` + `dispatch` do envio normal (número conectado, janela de 24 h,
 * `clientId`, dono, reabertura). A conversa de origem não é tocada. Serve ao tenant e à plataforma.
 */

/**
 * A conversa de origem (no alcance do ator, senão 404 igual a id inexistente) e os outros números do
 * escopo com a elegibilidade de cada um. Das outras conversas do contato só saem o número, se o ator a
 * alcança e a última mensagem recebida: é o que `eligibleTransferChannels` precisa.
 */
async function transferContext(tx: Tx, actor: InboxActor, conversationId: string) {
  const current = await requireVisibleConversation(tx, actor, conversationId);

  const channels = await tx
    .select({
      id: channel.id,
      tenantId: channel.tenantId,
      name: channel.name,
      type: channel.type,
      status: channel.status,
    })
    .from(channel)
    .where(scopeWhere(actor.scope))
    .orderBy(asc(channel.name), asc(channel.id));

  const others = await tx
    .select({
      channelId: conversation.channelId,
      lastInboundAt: conversation.lastInboundAt,
      visible: sql<boolean>`${visibleConversation(actor)}`,
    })
    .from(conversation)
    .where(
      and(
        conversationScope(actor.scope),
        eq(conversation.contactId, current.contactId),
        ne(conversation.id, current.id),
      ),
    );

  const destinations = new Map<string, TransferDestination>(
    others.map((row) => [row.channelId, { visible: row.visible, lastInboundAt: row.lastInboundAt }]),
  );

  return {
    current,
    options: eligibleTransferChannels({
      scopeTenantId: scopeTenantId(actor.scope),
      currentChannelId: current.channelId,
      channels,
      destinations,
    }),
  };
}

/** `GET .../conversations/:id/transfer-channels`: o que a tela oferece. Só para quem responde. */
export async function listTransferChannels(actor: InboxActor, conversationId: string) {
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => ({
    items: (await transferContext(tx, actor, conversationId)).options,
  }));
}

/**
 * `POST .../conversations/:id/transfer`: revalida a elegibilidade, acha ou cria a conversa do contato no
 * número de destino e grava a primeira mensagem, tudo em **uma** transação (recusa não deixa conversa
 * vazia para trás); o provedor é chamado depois, fora dela. Recusas:
 *
 * - origem fora do alcance: 404, igual a id inexistente;
 * - o próprio número da conversa: 400 `SAME_CHANNEL`;
 * - número inexistente ou de outro escopo: 404; desativado: 409 `CHANNEL_DISABLED`;
 * - desconectado: 409 `CHANNEL_NOT_CONNECTED`; janela fechada no destino: 409 `SESSION_WINDOW_CLOSED`;
 * - conversa de destino de outro atendente: 409 `ALREADY_ASSIGNED` (só o dono, como em "iniciar conversa").
 *
 * `clientId` repetido devolve a mesma mensagem, sem enviar de novo e **antes** das recusas de estado
 * (número que caiu ou janela que fechou depois do envio); a conversa é única por contato e número, então
 * dois cliques nunca criam duas.
 */
export async function continueOnChannel(
  actor: InboxActor,
  conversationId: string,
  input: TransferConversationInput,
) {
  if (!actor.can.reply) throw permissionDenied();

  const { prepared, created } = await withScope(actor.scope, async (tx) => {
    const { current, options } = await transferContext(tx, actor, conversationId);

    if (input.channelId === current.channelId) {
      throw new TenantRuleError(400, "SAME_CHANNEL", "A conversa já está neste número.");
    }
    const target = await requireChannelRow(tx, actor.scope, input.channelId);

    // Pedido repetido (dois cliques, resposta perdida): a mensagem já gravada volta como está, antes de
    // qualquer recusa. O número pode ter caído ou a janela fechado depois do envio, e recusar agora
    // faria a pessoa mandar de novo o que o contato já recebeu.
    const [repeated] = await tx
      .select({ messageId: message.id, conversationId: message.conversationId })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .where(
        and(
          visibleConversation(actor),
          eq(conversation.contactId, current.contactId),
          eq(conversation.channelId, target.id),
          eq(message.clientId, input.clientId),
        ),
      );
    if (repeated) {
      const prepared: Prepared = {
        ...repeated,
        channelId: target.id,
        to: "",
        delivery: { kind: "text", text: "" },
        quotedProviderMessageId: null,
        created: false,
      };
      return { prepared, created: false };
    }

    if (target.status === "disabled") {
      throw new TenantRuleError(409, "CHANNEL_DISABLED", "Este número foi desativado.");
    }

    const option = options.find((item) => item.channel.id === target.id);
    // Falha fechada: número do escopo que a lista não trouxe não é destino.
    if (!option) throw new TenantRuleError(409, "CHANNEL_DISABLED", "Este número foi desativado.");
    if (option.reason === "disconnected") {
      throw new TenantRuleError(
        409,
        "CHANNEL_NOT_CONNECTED",
        "Este número não está conectado. Reconecte para enviar mensagens.",
      );
    }
    if (option.reason === "window_closed") {
      throw new TenantRuleError(
        409,
        "SESSION_WINDOW_CLOSED",
        "A janela de 24 horas neste número está encerrada. Por ele, só um modelo aprovado.",
      );
    }

    // `assigned_to_other` sai daqui como 409 `ALREADY_ASSIGNED`, com o dono, igual a "iniciar conversa".
    const destination = await openConversation(tx, actor, target.id, current.contactId, "transfer");

    // Confere de novo, com a conversa travada: visibilidade, número conectado e janela de 24 h.
    const queued = await queueMessage(tx, actor, destination.id, {
      clientId: input.clientId,
      requiresWindow: true,
      build: () => textDraft(input.text),
    });

    if (queued.created) {
      await auditInbox(
        tx,
        actor,
        "inbox.conversation_continued",
        { type: "conversation", id: destination.id },
        { fromConversationId: current.id, channelId: target.id, created: destination.created },
      );
    }

    return { prepared: queued, created: destination.created };
  });

  const outcome = await dispatch(actor, prepared);
  return { conversationId: prepared.conversationId, created, ...outcome };
}
