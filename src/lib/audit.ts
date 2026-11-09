import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { logError } from "@/api/log";
import { auditLog } from "@/db/schema";
import type { AuditActorType } from "@/db/schema/audit";
import { type Tx, withPlatformScope, withTenant } from "@/db/rls";
import { getEnv } from "@/lib/env";

export type AuditAction =
  | "auth.signed_up"
  | "auth.email_verified"
  | "auth.email_changed"
  | "auth.password_reset"
  | "auth.2fa_enabled"
  | "auth.2fa_disabled"
  | "auth.session_revoked"
  | "auth.consent_accepted"
  | "lgpd.export_requested"
  | "lgpd.deletion_requested"
  | "lgpd.deletion_canceled"
  | "lgpd.deletion_executed"
  | "tenant.created"
  | "tenant.updated"
  | "tenant.security_updated"
  | "support.grant_created"
  | "support.grant_revoked"
  | "member.invited"
  | "member.invitation_canceled"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "file.uploaded"
  | "file.deleted"
  | "customer.created"
  | "customer.updated"
  | "customer.deleted"
  | "customer.invited"
  | "portal.signed_up"
  | "portal.profile_updated"
  | "portal.password_set"
  | "billing.trial_expired"
  | "billing.checkout_started"
  | "billing.subscription_changed"
  | "billing.plan_change_requested"
  | "billing.profile_updated"
  | "billing.invoice_refunded"
  | "billing.chargeback_opened"
  | "admin.tenant_suspended"
  | "admin.tenant_unsuspended"
  | "admin.tenant_plan_changed"
  | "admin.plan_created"
  | "admin.plan_updated"
  | "admin.settings_updated"
  | "admin.user_banned"
  | "admin.user_unbanned"
  | "admin.subscription_canceled"
  | "admin.subscription_synced"
  | "admin.manual_payment_recorded"
  | "admin.manual_payment_missed"
  // admin-crud B
  | "admin.subscription_updated"
  | "admin.webhook_reprocessed"
  | "admin.portal_sessions_revoked"
  // admin-crud A
  | "admin.plan_deleted"
  | "admin.plan_price_updated"
  | "admin.plan_price_deleted"
  | "admin.tenant_updated"
  // admin-crud C: exclusões e edição de pessoas pelo /admin.
  | "admin.tenant_deletion_requested"
  | "admin.tenant_deletion_executed"
  | "admin.tenant_deletion_canceled"
  | "admin.user_deletion_requested"
  | "admin.user_deletion_executed"
  | "admin.user_deletion_canceled"
  | "admin.user_updated"
  | "admin.user_sessions_revoked"
  | "admin.portal_user_deletion_requested"
  | "admin.portal_user_deletion_executed"
  | "admin.portal_user_deletion_canceled"
  | "admin.portal_user_updated"
  // whatsapp-canais
  | "channel.created"
  | "channel.updated"
  | "channel.connected"
  | "channel.disconnected"
  | "channel.disabled"
  | "channel.deleted"
  | "channel.default_changed"
  | "channel.webhook_rotated"
  | "platform.impersonation_requested"
  | "platform.impersonation_started"
  | "platform.impersonation_stopped"
  | "platform.impersonation_blocked_action";

export type AuditEntry = {
  actor: { type?: AuditActorType; id: string | null };
  /** Padrão: quem personifica nesta requisição (`withImpersonator`). */
  impersonatorId?: string;
  /** Sem tenant, o evento só aparece com `withPlatformScope`. */
  tenantId?: string | null;
  target?: { type: string; id: string };
  /** Só ids e enums: nunca e-mail, nome ou texto livre. */
  metadata?: Record<string, string | number | boolean | null>;
  ip?: string | null;
};

/** O IP nunca é gravado em claro. Sem `AUDIT_SALT`, o hash seria reversível por tabela. */
export function hashIp(ip: string) {
  return createHash("sha256")
    .update(ip + getEnv().AUDIT_SALT)
    .digest("hex");
}

const impersonator = new AsyncLocalStorage<string>();

/**
 * `requireAuth` envolve a requisição personificada: tudo o que for auditado nela leva
 * `impersonator_id` (auditoria dupla), sem cada rota precisar lembrar disso.
 */
export function withImpersonator<T>(id: string, fn: () => Promise<T>) {
  return impersonator.run(id, fn);
}

function toRow(action: AuditAction, entry: AuditEntry) {
  const ip = entry.ip && entry.ip !== "unknown" ? entry.ip : null;

  return {
    tenantId: entry.tenantId ?? null,
    actorType: entry.actor.type ?? ("user" as const),
    actorId: entry.actor.id,
    impersonatorId: entry.impersonatorId ?? impersonator.getStore(),
    action,
    targetType: entry.target?.type,
    targetId: entry.target?.id,
    metadata: entry.metadata ?? {},
    ipHash: ip ? hashIp(ip) : null,
  };
}

/**
 * Grava na transação de quem chama: se a auditoria falhar, a mudança volta junto. Use
 * quando a ação acontece dentro de `withTenant`.
 */
export async function auditInTransaction(
  tx: Tx,
  action: AuditAction,
  entry: AuditEntry,
) {
  await tx.insert(auditLog).values(toRow(action, entry));
}

/**
 * Para ações já concluídas por outra transação, como as do Better Auth. A falha vai
 * para o log e não desfaz nem esconde o que já aconteceu.
 */
export async function audit(action: AuditAction, entry: AuditEntry) {
  const write = (tx: Tx) => auditInTransaction(tx, action, entry);

  try {
    await (entry.tenantId
      ? withTenant(entry.tenantId, write)
      : withPlatformScope("auditoria sem tenant", write));
  } catch (error) {
    logError("Falha ao gravar auditoria", error);
  }
}
