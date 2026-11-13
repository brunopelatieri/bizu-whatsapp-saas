import { and, eq, sql } from "drizzle-orm";
import { type Tx, withScope } from "@/db/rls";
import { chatContact, conversation, user } from "@/db/schema";
import { requireChannelRow } from "@/lib/channels/service";
import type { PlatformRole } from "@/lib/auth/types";
import { auditInbox } from "@/lib/inbox/assignment";
import {
  contactForStart,
  contactResponse,
  notifyContactConversations,
  phoneRequired,
  requireVisibleContact,
} from "@/lib/inbox/contact-actions";
import { conversationItem, permissionDenied } from "@/lib/inbox/conversations";
import { platformReplyRoles } from "@/lib/inbox/constants";
import { notifyInbox } from "@/lib/inbox/notify";
import type { InboxActor, InboxCapabilities } from "@/lib/inbox/visibility";
import { normalizePhone, phoneErrorMessage } from "@/lib/phone/br";
import type { PlatformLinkContactInput, PlatformStartConversationInput } from "@/lib/schemas/inbox";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Atendimento da plataforma (SPEC da caixa de entrada, "Plataforma", C6): conversas com `tenant_id`
 * nulo, em `withPlatformData`. Sem fila, dono, assumir, transferir nem candidatos, e **sem acesso a
 * clientes dos owners** (decisão do proprietário): nenhuma função daqui lê `customer` nem usa
 * `withPlatformScope`. O contato se vincula só a `user`.
 */

/** Quem responde: o proprietário e o suporte da plataforma (decisão do proprietário). */
export const PLATFORM_REPLY_ROLES: readonly PlatformRole[] = platformReplyRoles;

/** Leitura é de qualquer papel de plataforma; enviar e mudar a situação, de `PLATFORM_REPLY_ROLES`. */
export function platformCapabilities(role: PlatformRole): InboxCapabilities {
  const staff = role === "platform_owner" || role === "platform_support";

  return {
    read: staff,
    reply: PLATFORM_REPLY_ROLES.includes(role),
    // Sem dono nem supervisão: a plataforma só tem a lista.
    assign: false,
    supervise: false,
  };
}

/** O ator da plataforma. Sem permissões de tenant (`customer:*` não existe aqui) nem catálogo. */
export function platformActor(user: { id: string; platformRole: PlatformRole }, ip?: string): InboxActor {
  return {
    scope: { kind: "platform" },
    userId: user.id,
    can: platformCapabilities(user.platformRole),
    permissions: [],
    ip,
  };
}

const assertPlatform = (actor: InboxActor) => {
  if (actor.scope.kind !== "platform") throw permissionDenied();
};

/**
 * Vincular o contato a um usuário (qualquer usuário não banido, já que o e-mail e o telefone
 * conferem fora daqui) ou desfazer. Sem cliente: o schema só aceita `userId`.
 */
export async function linkPlatformContact(
  actor: InboxActor,
  contactId: string,
  input: PlatformLinkContactInput,
) {
  assertPlatform(actor);
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    await requireVisibleContact(tx, actor, contactId);

    if (input.userId) {
      const [target] = await tx
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.id, input.userId), eq(user.banned, false)));
      if (!target) throw new TenantRuleError(400, "INVALID_LINK", "Escolha um usuário.");
    }

    await tx
      .update(chatContact)
      .set({ customerId: null, userId: input.userId, updatedAt: sql`now()` })
      .where(eq(chatContact.id, contactId));

    await auditInbox(tx, actor, "inbox.contact_linked", { type: "chat_contact", id: contactId }, {
      customerId: null,
      userId: input.userId,
    });
    await notifyContactConversations(tx, actor, contactId);

    return contactResponse(tx, actor, contactId);
  });
}

/** O telefone do destino: o do usuário ou o digitado. Número avulso não procura cliente de owner. */
async function destinationOf(tx: Tx, input: PlatformStartConversationInput) {
  let raw: string;
  let link: { userId?: string } = {};

  if (input.userId) {
    const [row] = await tx
      .select({ phone: user.phoneNormalized, verifiedAt: user.phoneVerifiedAt })
      .from(user)
      .where(and(eq(user.id, input.userId), eq(user.banned, false)));
    if (!row) throw notFound("Usuário não encontrado.");
    if (!row.phone) throw phoneRequired();
    raw = `+${row.phone}`;
    // Só telefone confirmado liga o contato ao usuário (como no tenant, `destinationPhone`).
    if (row.verifiedAt) link = { userId: input.userId };
  } else {
    raw = input.phone ?? "";
  }

  const result = normalizePhone(raw);
  if (!result.ok) {
    throw new TenantRuleError(400, "INVALID_PHONE", phoneErrorMessage(result.reason), {
      reason: result.reason,
    });
  }
  return { phone: result.phone, key: result.key, kind: result.kind, link };
}

/**
 * Acha ou cria a conversa da plataforma com um usuário ou um telefone, pelo número de saída (da
 * plataforma) escolhido. Não envia nada. Mesmas regras do tenant para o número (`canWhatsApp` ou já
 * ter escrito), mas sem dono: a conversa nasce `open`, para qualquer papel de plataforma. Telefone
 * avulso sem usuário correspondente fica "não identificado", mesmo que seja de um cliente de owner.
 */
export async function startPlatformConversation(
  actor: InboxActor,
  input: PlatformStartConversationInput,
) {
  assertPlatform(actor);
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    const target = await requireChannelRow(tx, actor.scope, input.channelId);
    if (target.status === "disabled") {
      throw new TenantRuleError(409, "CHANNEL_DISABLED", "Este número foi desativado.");
    }

    const destination = await destinationOf(tx, input);
    const contactId = await contactForStart(tx, actor.scope, destination);

    const [inserted] = await tx
      .insert(conversation)
      .values({
        tenantId: null,
        channelId: target.id,
        contactId,
        status: "open",
        lastMessageAt: sql`now()`,
        unreadCount: 0,
      })
      .onConflictDoNothing({
        target: [conversation.contactId, conversation.channelId],
        where: sql`tenant_id is null`,
      })
      .returning({ id: conversation.id });

    if (inserted) {
      await notifyInbox(tx, {
        s: null,
        c: inserted.id,
        k: "conversation",
        a: null,
        p: null,
        u: actor.userId,
      });
      return { conversation: await conversationItem(tx, actor, inserted.id), created: true };
    }

    const [existing] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(
        and(
          sql`${conversation.tenantId} is null`,
          eq(conversation.contactId, contactId),
          eq(conversation.channelId, target.id),
        ),
      );
    if (!existing) throw new Error("Conversa não encontrada depois do conflito.");
    return { conversation: await conversationItem(tx, actor, existing.id), created: false };
  });
}
