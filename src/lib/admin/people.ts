import { and, count, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { getDb } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { type Tx, withPlatformScope } from "@/db/rls";
import {
  account,
  customer,
  member,
  organization,
  plan,
  portalAccount,
  portalSession,
  portalUser,
  session,
  subscription,
  user,
  verification,
} from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { appLink } from "@/lib/auth/links";
import { getAuth } from "@/lib/auth/server";
import { billingState } from "@/lib/billing/state";
import { maskEmail } from "@/lib/email/address";
import { phoneValues } from "@/lib/phone/columns";
import { sendEmail } from "@/lib/email/send";
import { emailChangedTemplate } from "@/lib/email/templates/email-changed";
import { hasPortalPassword } from "@/lib/portal/profile";
import type { UpdatePersonInput } from "@/lib/schemas/admin";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";
import { findPendingDeletion } from "@/lib/lgpd/deletion";

/**
 * Detalhe e edição de pessoas pelo `/admin` (`docs/specs/admin-crud/spec.md`, seção 3).
 * Equipe e suporte são `user`; clientes e leads, `portal_user`, outra identidade. O
 * `platform_owner` não é editado nem excluído por aqui, e ninguém age sobre si mesmo.
 */

export type AdminActor = { id: string; ip?: string | null };

/**
 * As sessões da conta e as personificações que ela abriu (suporte): encerrar o acesso de uma
 * conta de plataforma derruba também o que ela faz em nome de outros.
 */
export const sessionsOf = (userId: string) =>
  or(eq(session.userId, userId), eq(session.impersonatedBy, userId));

/** Conta já anonimizada pela exclusão: para o admin, não existe mais. */
export const isGhost = (email: string) => /^deleted\+[^@]+@invalid$/.test(email);

const EMAIL_TAKEN = (tenants?: Array<{ id: string; name: string }>) =>
  new TenantRuleError(
    409,
    "EMAIL_TAKEN",
    tenants?.length
      ? `Já existe outro cliente com este e-mail em ${tenants.map(({ name }) => name).join(", ")}.`
      : "Este e-mail já está em uso por outra conta.",
    tenants?.length ? { tenants } : undefined,
  );

/** Só o e-mail atual, sem nome: o `update` ficaria vazio. */
const nothingToChange = () => new TenantRuleError(400, "NOTHING_TO_CHANGE", "Nada para alterar.");

/**
 * Alvo das ações de edição, sessões e exclusão: papel `user` ou `platform_support`. O plugin
 * `admin` não compara o papel do alvo; esta checagem evita que um proprietário derrube outro.
 */
export async function assertManageableUser(targetId: string, actorId: string) {
  if (targetId === actorId) {
    throw new TenantRuleError(409, "SELF_ACTION", "Você não pode fazer isso com a sua própria conta.");
  }

  const [target] = await getDb()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      banned: user.banned,
    })
    .from(user)
    .where(eq(user.id, targetId));

  if (!target || isGhost(target.email)) throw notFound("Usuário não encontrado.");

  if (target.role === "platform_owner") {
    throw new TenantRuleError(
      403,
      "PLATFORM_OWNER_PROTECTED",
      "O proprietário da plataforma não é editado nem excluído por aqui.",
    );
  }

  return { ...target, banned: target.banned ?? false };
}

const liveSessions = (table: typeof session | typeof portalSession, userId: string) =>
  getDb()
    .select({ total: count() })
    .from(table)
    .where(and(eq(table.userId, userId), gt(table.expiresAt, new Date())))
    .then(([row]) => row?.total ?? 0);

/** `GET /api/admin/users/:id`: perfil, organizações com o estado de cobrança e exclusão. */
export async function getUserDetail(userId: string) {
  const [profile] = await getDb()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      phoneNormalized: user.phoneNormalized,
      platformRole: user.role,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      banned: user.banned,
      banReason: user.banReason,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, userId));

  if (!profile || isGhost(profile.email)) throw notFound("Usuário não encontrado.");

  const rows = await withPlatformScope("admin: organizações do usuário", (tx) =>
    tx
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
        status: organization.status,
        accessMode: organization.accessMode,
        subscriptionStatus: subscription.status,
        planName: plan.name,
      })
      .from(member)
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .leftJoin(subscription, eq(subscription.tenantId, organization.id))
      .leftJoin(plan, eq(subscription.planId, plan.id))
      .where(eq(member.userId, userId))
      .orderBy(organization.name),
  );

  return {
    user: { ...profile, banned: profile.banned ?? false, sessions: await liveSessions(session, userId) },
    organizations: rows.map(({ status, accessMode, subscriptionStatus, ...row }) => ({
      ...row,
      status,
      state: billingState({ status, accessMode, subscriptionStatus }),
    })),
    deletion: await pendingDeletionOf({ type: "user", id: userId }),
  };
}

/**
 * `PATCH /api/admin/users/:id`. Trocar o e-mail desverifica a conta, encerra as sessões,
 * avisa o endereço antigo (`email-changed`) e manda ao novo o link de definir senha (reset do
 * Better Auth): quem conclui o reset provou o e-mail (`onPasswordReset`).
 */
export async function updateUserByAdmin(
  targetId: string,
  input: UpdatePersonInput,
  actor: AdminActor,
) {
  const target = await assertManageableUser(targetId, actor.id);
  const emailChanged = input.email !== undefined && input.email !== target.email;
  if (!emailChanged && input.name === undefined && input.phone === undefined) {
    throw nothingToChange();
  }

  if (emailChanged && input.email) {
    const [other] = await getDb()
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.email, input.email), ne(user.id, target.id)));
    if (other) throw EMAIL_TAKEN();
  }

  const updated = await withPlatformScope("admin: edita usuário", async (tx) => {
    const [row] = await tx
      .update(user)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? phoneValues(input.phone) : {}),
        ...(emailChanged ? { email: input.email, emailVerified: false } : {}),
      })
      .where(eq(user.id, target.id))
      .returning({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified });

    if (emailChanged) {
      await tx.delete(session).where(sessionsOf(target.id));
      // Como no portal: o endereço novo só entra pelo link de definir senha, que chega a ele.
      // Sem a senha antiga, a conta não vira "cadastro pendente" que qualquer um expurga
      // (`purgeExpiredPendingSignup` só apaga quem tem credencial), e um link de reset pedido
      // antes para o endereço antigo deixa de valer (`verification` só guarda o reset).
      await tx
        .delete(account)
        .where(and(eq(account.userId, target.id), eq(account.providerId, "credential")));
      await tx.delete(verification).where(eq(verification.value, target.id));
    }

    await auditInTransaction(tx, "admin.user_updated", {
      actor: { type: "platform", id: actor.id },
      target: { type: "user", id: target.id },
      // Telefone é dado pessoal: a auditoria só diz que mudou, nunca o número.
      metadata: {
        name: input.name !== undefined,
        email: emailChanged,
        phone: input.phone !== undefined,
      },
      ip: actor.ip,
    });

    return row;
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw EMAIL_TAKEN();
    throw error;
  });

  if (!updated) throw notFound("Usuário não encontrado.");

  if (emailChanged) {
    await notifyEmailChanged(target, updated.email);
    await getAuth()
      .api.requestPasswordReset({ body: { email: updated.email } })
      .catch((error: unknown) => logError("Falha ao enviar o link de definir senha", error));
  }

  return updated;
}

/** `POST /api/admin/users/:id/revoke-sessions`. */
export async function revokeUserSessions(targetId: string, actor: AdminActor) {
  const target = await assertManageableUser(targetId, actor.id);

  return withPlatformScope("admin: encerra sessões", async (tx) => {
    const removed = await tx
      .delete(session)
      .where(sessionsOf(target.id))
      .returning({ id: session.id });

    await auditInTransaction(tx, "admin.user_sessions_revoked", {
      actor: { type: "platform", id: actor.id },
      target: { type: "user", id: target.id },
      metadata: { revoked: removed.length },
      ip: actor.ip,
    });

    return { revoked: removed.length };
  });
}

function notifyEmailChanged(person: { name: string; email: string }, newEmail: string) {
  return sendEmail({
    to: person.email,
    ...emailChangedTemplate({
      name: person.name,
      maskedEmail: maskEmail(newEmail),
      url: appLink("/contato"),
    }),
    tags: { template: "email-changed" },
  }).catch((error) => logError("Falha ao avisar a troca de e-mail", error));
}

export async function loadPortalPerson(personId: string) {
  const [person] = await getDb()
    .select({
      id: portalUser.id,
      name: portalUser.name,
      email: portalUser.email,
      phone: portalUser.phone,
      phoneNormalized: portalUser.phoneNormalized,
      emailVerified: portalUser.emailVerified,
      createdAt: portalUser.createdAt,
    })
    .from(portalUser)
    .where(eq(portalUser.id, personId));

  if (!person || isGhost(person.email)) throw notFound("Pessoa não encontrada.");

  return person;
}

/** `GET /api/admin/portal-users/:id`: pessoa, vínculos com os tenants e exclusão pendente. */
export async function getPortalUserDetail(personId: string) {
  const person = await loadPortalPerson(personId);

  const links = await withPlatformScope("admin: vínculos do portal", (tx) =>
    tx
      .select({
        tenantId: organization.id,
        tenantName: organization.name,
        status: customer.status,
        lastLoginAt: customer.lastLoginAt,
      })
      .from(customer)
      .innerJoin(organization, eq(customer.tenantId, organization.id))
      .where(eq(customer.portalUserId, person.id))
      .orderBy(organization.name),
  );

  return {
    person: {
      ...person,
      hasPassword: await hasPortalPassword(person.id),
      sessions: await liveSessions(portalSession, person.id),
    },
    links: links.map(({ tenantId, tenantName, ...link }) => ({
      tenant: { id: tenantId, name: tenantName },
      ...link,
    })),
    deletion: await pendingDeletionOf({ type: "portal_user", id: person.id }),
  };
}

/**
 * O endereço novo só entra por magic link, que é onde a posse se prova: a conta volta a não
 * verificada, sem senha e sem sessões. Quem controlava o endereço antigo perde o acesso na hora.
 */
export async function revokeUnprovenAccountAccess(tx: Tx, personId: string) {
  await tx
    .update(portalUser)
    .set({ emailVerified: false })
    .where(eq(portalUser.id, personId));
  await tx
    .delete(portalAccount)
    .where(and(eq(portalAccount.userId, personId), eq(portalAccount.providerId, "credential")));
  await tx.delete(portalSession).where(eq(portalSession.userId, personId));
}

/**
 * `PATCH /api/admin/portal-users/:id`. O nome é o de `portal_user` (o `customer.name` de cada
 * tenant é do owner). O e-mail muda na pessoa e em **todos** os vínculos, numa transação: se
 * algum tenant já tem outro cliente com o endereço novo, nada muda (409 `EMAIL_TAKEN`).
 */
export async function updatePortalUserByAdmin(
  personId: string,
  input: UpdatePersonInput,
  actor: AdminActor,
) {
  const person = await loadPortalPerson(personId);
  const newEmail = input.email;
  const emailChanged = newEmail !== undefined && newEmail !== person.email;
  if (!emailChanged && input.name === undefined && input.phone === undefined) {
    throw nothingToChange();
  }

  const updated = await withPlatformScope("admin: e-mail do portal", async (tx) => {
    if (emailChanged) {
      const [other] = await tx
        .select({ id: portalUser.id })
        .from(portalUser)
        .where(and(eq(portalUser.email, newEmail), ne(portalUser.id, person.id)));
      if (other) throw EMAIL_TAKEN();

      const linked = tx
        .select({ tenantId: customer.tenantId })
        .from(customer)
        .where(eq(customer.portalUserId, person.id));

      const conflicts = await tx
        .selectDistinct({ id: organization.id, name: organization.name })
        .from(customer)
        .innerJoin(organization, eq(customer.tenantId, organization.id))
        .where(
          and(
            eq(customer.email, newEmail),
            inArray(customer.tenantId, linked),
            sql`${customer.portalUserId} is distinct from ${person.id}`,
          ),
        );
      if (conflicts.length > 0) throw EMAIL_TAKEN(conflicts);
    }

    const [row] = await tx
      .update(portalUser)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? phoneValues(input.phone) : {}),
        ...(emailChanged ? { email: newEmail } : {}),
      })
      .where(eq(portalUser.id, person.id))
      .returning({ id: portalUser.id, name: portalUser.name, email: portalUser.email });

    if (emailChanged && newEmail) {
      const customers = await tx
        .update(customer)
        .set({ email: newEmail })
        .where(eq(customer.portalUserId, person.id))
        .returning({ id: customer.id, tenantId: customer.tenantId });

      await revokeUnprovenAccountAccess(tx, person.id);

      for (const changed of customers) {
        await auditInTransaction(tx, "customer.updated", {
          actor: { type: "platform", id: actor.id },
          tenantId: changed.tenantId,
          target: { type: "customer", id: changed.id },
          metadata: { emailChanged: true },
          ip: actor.ip,
        });
      }
    }

    await auditInTransaction(tx, "admin.portal_user_updated", {
      actor: { type: "platform", id: actor.id },
      target: { type: "portal_user", id: person.id },
      metadata: {
        name: input.name !== undefined,
        email: emailChanged,
        phone: input.phone !== undefined,
      },
      ip: actor.ip,
    });

    return row;
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw EMAIL_TAKEN();
    throw error;
  });

  if (!updated) throw notFound("Pessoa não encontrada.");

  if (emailChanged) await notifyEmailChanged(person, updated.email);

  return { ...updated, emailVerified: emailChanged ? false : person.emailVerified };
}

/** Pedido pendente para as telas de detalhe: quando vence e quem pediu. */
export async function pendingDeletionOf(subject: {
  type: "user" | "portal_user" | "tenant";
  id: string;
}) {
  const pending = await findPendingDeletion(subject);

  return pending && { scheduledFor: pending.scheduledFor, origin: pending.origin };
}
