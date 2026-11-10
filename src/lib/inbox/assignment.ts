import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { scopeTenantId, type Tx, withScope } from "@/db/rls";
import { conversation, member, user } from "@/db/schema";
import { type AuditAction, auditInTransaction } from "@/lib/audit";
import { permissionsOf } from "@/lib/auth/permissions";
import type { ConversationStatus } from "@/lib/inbox/constants";
import {
  CONVERSATION_NOT_FOUND,
  conversationItem,
  permissionDenied,
  requireVisibleConversation,
} from "@/lib/inbox/conversations";
import { notifyInbox } from "@/lib/inbox/notify";
import {
  conversationScope,
  type InboxActor,
  inboxCapabilities,
  visibleConversation,
} from "@/lib/inbox/visibility";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Fila e situação (SPEC, "Fila e visibilidade"). Assumir é um `UPDATE ... WHERE assigned_user_id
 * IS NULL`: dois cliques ao mesmo tempo, um assume e o outro recebe 409. A plataforma não tem dono
 * nem fila: assumir e transferir só existem no tenant.
 */

export async function auditInbox(
  tx: Tx,
  actor: InboxActor,
  action: AuditAction,
  target: { type: "conversation" | "chat_contact"; id: string },
  metadata?: Record<string, string | number | boolean | null>,
) {
  await auditInTransaction(tx, action, {
    actor: { type: actor.scope.kind === "platform" ? "platform" : "user", id: actor.userId },
    tenantId: scopeTenantId(actor.scope),
    target,
    metadata,
    ip: actor.ip,
  });
}

const conversationTarget = (id: string) => ({ type: "conversation" as const, id });

function assertTenant(actor: InboxActor) {
  // A plataforma não tem fila (SPEC): a rota nem existe em `/api/admin/inbox`.
  if (actor.scope.kind !== "tenant") throw permissionDenied();
}

export function alreadyAssigned(owner: { id: string; name: string | null }) {
  return new TenantRuleError(
    409,
    "ALREADY_ASSIGNED",
    owner.name ? `${owner.name} já assumiu esta conversa.` : "Esta conversa já tem um responsável.",
    { assignedTo: { id: owner.id, name: owner.name } },
  );
}

/**
 * Assumir da fila. Perdeu a corrida ou a conversa já tem outro dono: 409 `ALREADY_ASSIGNED` com o
 * nome dele (quem pede viu a conversa na fila; um id que nunca viu não se adivinha). Já é sua:
 * devolve a conversa, sem erro.
 */
export async function claimConversation(actor: InboxActor, conversationId: string) {
  assertTenant(actor);
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    const [claimed] = await tx
      .update(conversation)
      .set({ assignedUserId: actor.userId, assignedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(conversation.id, conversationId),
          visibleConversation(actor),
          isNull(conversation.assignedUserId),
        ),
      )
      .returning({ id: conversation.id });

    if (!claimed) {
      const [current] = await tx
        .select({ assignedUserId: conversation.assignedUserId, name: user.name })
        .from(conversation)
        .leftJoin(user, eq(user.id, conversation.assignedUserId))
        .where(and(eq(conversation.id, conversationId), conversationScope(actor.scope)));

      if (!current?.assignedUserId) throw notFound(CONVERSATION_NOT_FOUND);
      if (current.assignedUserId !== actor.userId) {
        throw alreadyAssigned({ id: current.assignedUserId, name: current.name });
      }
      return conversationItem(tx, actor, conversationId);
    }

    await auditInbox(tx, actor, "inbox.conversation_claimed", conversationTarget(conversationId));
    await notifyInbox(tx, {
      s: scopeTenantId(actor.scope),
      c: conversationId,
      k: "conversation",
      a: actor.userId,
      p: null,
      u: actor.userId,
    });
    return conversationItem(tx, actor, conversationId);
  });
}

/** Papel do membro ativo (não banido) do tenant; `null` para quem não é. */
export async function activeMemberRole(tx: Tx, tenantId: string, userId: string) {
  const [row] = await tx
    .select({ role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, tenantId), eq(member.userId, userId), eq(user.banned, false)));
  return row?.role ?? null;
}

/**
 * Membro ativo do tenant cujo papel responde no atendimento. Fora disso, 400
 * `INVALID_ASSIGNEE`, sem dizer se a pessoa existe.
 */
async function assertAssignable(tx: Tx, actor: InboxActor, tenantId: string, userId: string) {
  const role = await activeMemberRole(tx, tenantId, userId);
  const replies = role !== null && inboxCapabilities(permissionsOf(actor.catalog ?? {}, role)).reply;
  if (!replies) {
    throw new TenantRuleError(
      400,
      "INVALID_ASSIGNEE",
      "Escolha alguém da equipe que atende conversas.",
    );
  }
}

/**
 * `userId = null` devolve à fila: o dono, com `inbox:reply`; a de outro, com `inbox:assign`.
 * `userId` transfere, com `inbox:assign`, para membro ativo que responde.
 */
export async function assignConversation(
  actor: InboxActor,
  conversationId: string,
  userId: string | null,
) {
  assertTenant(actor);
  const tenantId = scopeTenantId(actor.scope) as string;

  return withScope(actor.scope, async (tx) => {
    const current = await requireVisibleConversation(tx, actor, conversationId, true);
    const previous = current.assignedUserId;

    if (userId === null) {
      // Já está na fila: nada a fazer (dois cliques, ou outro devolveu antes).
      if (previous === null) return conversationItem(tx, actor, conversationId);
      const own = previous === actor.userId;
      if (own ? !actor.can.reply : !actor.can.assign) throw permissionDenied();

      await tx
        .update(conversation)
        .set({ assignedUserId: null, assignedAt: null, updatedAt: sql`now()` })
        .where(eq(conversation.id, conversationId));
      await auditInbox(tx, actor, "inbox.conversation_released", conversationTarget(conversationId), {
        from: previous,
      });
    } else {
      if (!actor.can.assign) throw permissionDenied();
      await assertAssignable(tx, actor, tenantId, userId);
      if (previous === userId) return conversationItem(tx, actor, conversationId);

      await tx
        .update(conversation)
        .set({ assignedUserId: userId, assignedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(conversation.id, conversationId));
      await auditInbox(tx, actor, "inbox.conversation_assigned", conversationTarget(conversationId), {
        from: previous,
        to: userId,
      });
    }

    await notifyInbox(tx, {
      s: tenantId,
      c: conversationId,
      k: "conversation",
      a: userId,
      p: previous,
      u: actor.userId,
    });
    return conversationItem(tx, actor, conversationId);
  });
}

/**
 * Encerrar, pendente, reabrir à mão: só a situação (e `closed_*`); o dono não muda, como na
 * origem. Só a mensagem do contato devolve a conversa encerrada à fila.
 */
export async function setConversationStatus(
  actor: InboxActor,
  conversationId: string,
  status: ConversationStatus,
) {
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    const current = await requireVisibleConversation(tx, actor, conversationId, true);
    if (current.status === status) return conversationItem(tx, actor, conversationId);

    const closing = status === "closed";
    await tx
      .update(conversation)
      .set({
        status,
        closedAt: closing ? sql`now()` : null,
        closedBy: closing ? actor.userId : null,
        updatedAt: sql`now()`,
      })
      .where(eq(conversation.id, conversationId));

    if (closing) {
      await auditInbox(tx, actor, "inbox.conversation_closed", conversationTarget(conversationId));
    } else if (current.status === "closed") {
      await auditInbox(tx, actor, "inbox.conversation_reopened", conversationTarget(conversationId), {
        to: status,
      });
    }

    await notifyInbox(tx, {
      s: scopeTenantId(actor.scope),
      c: conversationId,
      k: "conversation",
      a: current.assignedUserId,
      p: current.assignedUserId,
    });
    return conversationItem(tx, actor, conversationId);
  });
}

/** Zera as não lidas. Fora do predicado, 404 (o membro não marca a conversa de outro). */
export async function markConversationRead(actor: InboxActor, conversationId: string) {
  return withScope(actor.scope, async (tx) => {
    const [updated] = await tx
      .update(conversation)
      .set({ unreadCount: 0 })
      .where(
        and(
          eq(conversation.id, conversationId),
          visibleConversation(actor),
          gt(conversation.unreadCount, 0),
        ),
      )
      .returning({ id: conversation.id, assignedUserId: conversation.assignedUserId });

    if (!updated) {
      // Nada a zerar: confere a visibilidade para responder 404 a quem não vê.
      await requireVisibleConversation(tx, actor, conversationId);
      return;
    }

    await notifyInbox(tx, {
      s: scopeTenantId(actor.scope),
      c: conversationId,
      k: "conversation",
      a: updated.assignedUserId,
      p: updated.assignedUserId,
    });
  });
}

/** Quem pode receber uma conversa: membros ativos cujo papel responde no atendimento. */
export async function listAssignees(actor: InboxActor) {
  assertTenant(actor);
  if (!actor.can.assign) throw permissionDenied();
  const tenantId = scopeTenantId(actor.scope) as string;

  const rows = await withScope(actor.scope, (tx) =>
    tx
      .select({ id: user.id, name: user.name, role: member.role })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, tenantId), eq(user.banned, false)))
      .orderBy(asc(user.name)),
  );

  return rows
    .filter((row) => inboxCapabilities(permissionsOf(actor.catalog ?? {}, row.role)).reply)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * Gancho de quem deixa de atender (SPEC: membro removido ou sem acesso): as conversas dele voltam
 * à fila. Roda na transação de quem remove. Sem `tenantId` (exclusão da conta pela LGPD, com o
 * bypass do RLS), vale para todos os tenants.
 */
export async function releaseAssignments(tx: Tx, userId: string, tenantId?: string) {
  const released = await tx
    .update(conversation)
    .set({ assignedUserId: null, assignedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(conversation.assignedUserId, userId),
        tenantId ? eq(conversation.tenantId, tenantId) : undefined,
      ),
    )
    .returning({ id: conversation.id, tenantId: conversation.tenantId });

  for (const row of released) {
    await notifyInbox(tx, { s: row.tenantId, c: row.id, k: "conversation", a: null, p: userId });
  }
  return released.length;
}
