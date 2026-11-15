import { and, asc, eq, gt } from "drizzle-orm";
import { invitation, member, organization, session, user } from "@/db/schema";
import { logError } from "@/api/log";
import { getDb } from "@/db";
import { type Tx, withTenant } from "@/db/rls";
import { auditInTransaction } from "@/lib/audit";
import {
  canActOnRole,
  isOwner,
  permissionsOf,
  type RoleCatalog,
  roleLabel,
} from "@/lib/auth/permissions";
import { releaseAssignments } from "@/lib/inbox/assignment";
import { inboxCapabilities } from "@/lib/inbox/visibility";
import { normalizePhone } from "@/lib/phone/br";
import { phoneAfterMemberLeft, routeVerificationToPlatform } from "@/lib/phone/requests";
import { afterCustomerDeleted } from "@/lib/tenant/customers";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";
import {
  deleteMemberCustomer,
  teamCustomerWarnings,
} from "@/lib/tenant/team-customer-removal";

/** Quem está agindo: permissões já resolvidas em `requireTenant`. */
export type TeamActor = {
  userId: string;
  permissions: readonly string[];
  catalog: RoleCatalog;
  ip?: string;
};

const MEMBER_NOT_FOUND = "Membro não encontrado.";
const OUTRANKED = new TenantRuleError(
  403,
  "ROLE_OUTRANKED",
  "Você não pode alterar quem tem mais permissões que você.",
);
const LAST_OWNER = new TenantRuleError(
  409,
  "LAST_OWNER",
  "A organização precisa de ao menos um proprietário.",
);

export function assertCanGrant(actor: TeamActor, role: string) {
  if (!canActOnRole(actor.permissions, actor.catalog, role)) {
    throw new TenantRuleError(
      403,
      "ROLE_NOT_GRANTABLE",
      "Você não pode conceder um papel com mais permissões que o seu.",
    );
  }
}

export function assertKnownRole(catalog: RoleCatalog, role: string) {
  if (!Object.hasOwn(catalog, role)) {
    throw new TenantRuleError(400, "ROLE_NOT_FOUND", "Papel não encontrado.");
  }
}

/**
 * `phoneKind` diz se o membro tem telefone e de que tipo (a tela decide se oferece "Conversar");
 * o número em si não sai: o servidor o lê pelo `userId` ao iniciar a conversa.
 *
 * `customerRecord` (só com `withCustomerRecord`, para quem pode remover membros): a pessoa tem ficha
 * de cliente ligada a ela nesta organização, e a remoção a apagaria (D-11) com `conversationCount`
 * conversas. Sem o id nem o nome da ficha: quem remove não precisa de `customer:read` para saber.
 */
export async function listMembers(tenantId: string, options: { withCustomerRecord?: boolean } = {}) {
  const { rows, warnings } = await withTenant(tenantId, async (tx) => {
    const found = await tx
      .select({
        id: member.id,
        userId: member.userId,
        name: user.name,
        email: user.email,
        role: member.role,
        createdAt: member.createdAt,
        phoneNormalized: user.phoneNormalized,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, tenantId))
      .orderBy(asc(member.createdAt));

    const warned = options.withCustomerRecord
      ? await teamCustomerWarnings(
          tx,
          tenantId,
          found.map(({ userId }) => userId),
        )
      : new Map<string, never>();

    return { rows: found, warnings: warned };
  });

  return rows.map(({ phoneNormalized, ...row }) => {
    const parsed = phoneNormalized ? normalizePhone(`+${phoneNormalized}`) : null;
    return {
      ...row,
      phoneKind: parsed?.ok ? parsed.kind : null,
      ...(options.withCustomerRecord ? { customerRecord: warnings.get(row.userId) ?? null } : {}),
    };
  });
}

/**
 * O id do convite funciona como link: só vê quem pode criar convites, e só os de papel
 * que poderia conceder.
 */
export async function listInvitations(tenantId: string, actor: TeamActor) {
  if (!actor.permissions.includes("invitation:create")) return [];

  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, tenantId),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(invitation.createdAt)),
  );

  return rows.filter((row) =>
    canActOnRole(actor.permissions, actor.catalog, row.role),
  );
}

/** Convite pendente deste tenant que o autor pode gerir. Fora disso, 404. */
export async function findManageableInvitation(
  tenantId: string,
  invitationId: string,
  actor: TeamActor,
) {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.id, invitationId),
          eq(invitation.organizationId, tenantId),
          eq(invitation.status, "pending"),
        ),
      ),
  );

  if (!row || !canActOnRole(actor.permissions, actor.catalog, row.role)) {
    throw notFound("Convite não encontrado.");
  }

  return row;
}

/**
 * Reconvidar cancela o convite anterior, e o plugin faz isso sem olhar o papel dele nem
 * `invitation:cancel`. Sem esta checagem, reconvidar derrubaria um convite que a pessoa
 * não pode revogar. A resposta não diz qual é o papel do convite existente.
 */
export async function assertCanReplaceInvitation(
  tenantId: string,
  email: string,
  actor: TeamActor,
) {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ role: invitation.role })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, tenantId),
          eq(invitation.email, email),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      ),
  );

  const replaceable = rows.every(
    ({ role }) =>
      actor.permissions.includes("invitation:cancel") &&
      canActOnRole(actor.permissions, actor.catalog, role),
  );

  if (!replaceable) {
    throw new TenantRuleError(
      409,
      "ALREADY_INVITED",
      "Esta pessoa já tem um convite pendente.",
    );
  }
}

/**
 * Trava os membros do tenant até o fim da transação: dois owners se rebaixando ao mesmo
 * tempo veriam um ao outro e deixariam a organização sem nenhum.
 */
function lockMembers(tx: Tx, tenantId: string) {
  return tx
    .select({ id: member.id, userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, tenantId))
    .for("update");
}

function isLastOwner(
  members: { id: string; role: string }[],
  target: { id: string; role: string },
) {
  return (
    isOwner(target.role) &&
    members.filter((candidate) => isOwner(candidate.role)).length === 1
  );
}

export async function changeMemberRole(
  tenantId: string,
  memberId: string,
  role: string,
  actor: TeamActor,
) {
  let promotedUserId: string | null = null;

  const result = await withTenant(tenantId, async (tx) => {
    const members = await lockMembers(tx, tenantId);
    const target = members.find(({ id }) => id === memberId);

    if (!target) throw notFound(MEMBER_NOT_FOUND);
    if (isOwner(role)) promotedUserId = target.userId;
    if (!canActOnRole(actor.permissions, actor.catalog, target.role)) {
      throw OUTRANKED;
    }
    assertCanGrant(actor, role);
    if (isLastOwner(members, target) && !isOwner(role)) throw LAST_OWNER;

    await tx.update(member).set({ role }).where(eq(member.id, memberId));
    // Papel novo sem atendimento: as conversas dele voltam à fila.
    if (!inboxCapabilities(permissionsOf(actor.catalog, role)).reply) {
      await releaseAssignments(tx, target.userId, tenantId);
    }
    await auditInTransaction(tx, "member.role_changed", {
      actor: { id: actor.userId },
      tenantId,
      target: { type: "member", id: memberId },
      metadata: { from: target.role, to: role },
      ip: actor.ip,
    });

    return { id: memberId, role };
  });

  // Owner responde à plataforma pelo telefone: o pedido sai da fila das organizações.
  if (promotedUserId) {
    await routeVerificationToPlatform(promotedUserId).catch((error: unknown) =>
      logError("Falha ao encaminhar o pedido de verificação à plataforma", error),
    );
  }

  return result;
}

export async function removeMember(
  tenantId: string,
  memberId: string,
  actor: TeamActor,
) {
  let removedUserId: string | null = null;

  const customerRemoval = await withTenant(tenantId, async (tx) => {
    const members = await lockMembers(tx, tenantId);
    const target = members.find(({ id }) => id === memberId);

    if (!target) throw notFound(MEMBER_NOT_FOUND);
    removedUserId = target.userId;
    if (!canActOnRole(actor.permissions, actor.catalog, target.role)) {
      throw OUTRANKED;
    }
    if (isLastOwner(members, target)) throw LAST_OWNER;

    await tx.delete(member).where(eq(member.id, memberId));
    // As conversas dele voltam à fila (caixa de entrada, RF-25).
    await releaseAssignments(tx, target.userId, tenantId);
    // D-11: a ficha de cliente ligada à própria pessoa, nesta organização, sai com ela (e só ela;
    // a equipe desfaz a ligação antes para mantê-la). Os objetos saem depois do commit.
    const removedCustomer = await deleteMemberCustomer(tx, tenantId, target.userId, {
      id: actor.userId,
      ip: actor.ip,
    });
    // `requireTenant` já recusaria; limpar deixa `/api/me` escolher outro tenant.
    await tx
      .update(session)
      .set({ activeOrganizationId: null })
      .where(
        and(
          eq(session.userId, target.userId),
          eq(session.activeOrganizationId, tenantId),
        ),
      );
    await auditInTransaction(tx, "member.removed", {
      actor: { id: actor.userId },
      tenantId,
      target: { type: "member", id: memberId },
      metadata: { role: target.role },
      ip: actor.ip,
    });

    return removedCustomer;
  });

  if (customerRemoval) {
    await afterCustomerDeleted(customerRemoval).catch((error: unknown) =>
      logError("Falha ao concluir a exclusão da ficha do membro removido", error),
    );
  }

  // Depois do commit, em outro escopo: a liberação que o owner daqui fez no telefone da pessoa
  // deixa de valer, e o pedido que estava na fila desta organização volta à plataforma.
  if (removedUserId) {
    await phoneAfterMemberLeft(removedUserId, tenantId).catch((error: unknown) =>
      logError("Falha ao encerrar a verificação de telefone do membro removido", error),
    );
  }
}

/**
 * Dados da página `/convite/:id`. O id é aleatório e só vai no e-mail, por isso a página
 * não exige sessão. Convite usado, vencido, revogado ou inexistente são iguais: `null`.
 */
export async function findOpenInvitation(invitationId: string) {
  const [row] = await getDb()
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      tenantName: organization.name,
      inviterName: user.name,
      tenantId: organization.id,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .innerJoin(user, eq(invitation.inviterId, user.id))
    .where(
      and(
        eq(invitation.id, invitationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
        eq(organization.status, "active"),
        eq(organization.accessMode, "full"),
      ),
    );

  return row ?? null;
}

/** Convites abertos para o e-mail verificado da sessão, mostrados no onboarding. */
export async function listInvitationsFor(email: string) {
  const rows = await getDb()
    .select({
      id: invitation.id,
      role: invitation.role,
      tenantName: organization.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .where(
      and(
        eq(invitation.email, email.toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
        eq(organization.status, "active"),
        eq(organization.accessMode, "full"),
      ),
    )
    .orderBy(asc(invitation.createdAt));

  return rows.map(({ role, ...row }) => ({
    ...row,
    roleLabel: roleLabel(role),
  }));
}
