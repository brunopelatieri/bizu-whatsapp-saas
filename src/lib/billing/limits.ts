import { and, count, eq, gt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { channel, customer, invitation, member, organizationRole } from "@/db/schema";
import type { PlanLimits } from "@/db/schema/billing";
import { LIMIT_LABELS, type LimitMetric } from "@/lib/billing/constants";
import { withTenant } from "@/db/rls";
import { TenantRuleError } from "@/lib/tenant/errors";
import { storageUsedBytes } from "@/lib/files";
import { loadTenantPlan } from "@/lib/billing/subscription";

export type { LimitMetric };

export type LimitCheck = {
  metric: LimitMetric;
  /** `null`: sem limite. */
  limit: number | null;
  used: number;
  /** Cabe mais um? */
  allowed: boolean;
};

/**
 * Decisão pura: cabe mais um? `limit` ausente ou `null` é ilimitado. O limite vale para
 * criar o próximo: com 2 de 2 usados, não cabe.
 */
export function evaluateLimit(
  metric: LimitMetric,
  limit: number | null | undefined,
  used: number,
): LimitCheck {
  const resolved = limit ?? null;

  return {
    metric,
    limit: resolved,
    used,
    allowed: resolved === null || used < resolved,
  };
}

/** Convites que não ocupam um assento a mais: o próprio, ou os que serão substituídos. */
export type UsageOptions = {
  ignoreInvitationId?: string;
  ignoreInvitationEmail?: string;
};

export type LimitOptions = UsageOptions & { source?: LimitSource };

export type LimitSource = {
  limits(tenantId: string): Promise<PlanLimits>;
  used(tenantId: string, metric: LimitMetric, options: UsageOptions): Promise<number>;
};

/**
 * Uso corrente. `members` conta membros e convites pendentes e vigentes: o convite já
 * reserva o assento. `storage_mb` soma `file.size` em MB (arredondado para cima); o upload confere os bytes
 * exatos em `assertStorageAvailable` (`src/lib/files/index.ts`).
 */
export const databaseLimitSource: LimitSource = {
  async limits(tenantId) {
    return (await loadTenantPlan(tenantId))?.plan.limits ?? {};
  },

  async used(tenantId, metric, { ignoreInvitationId, ignoreInvitationEmail }) {
    switch (metric) {
      case "members":
        return withTenant(tenantId, async (tx) => {
          const [members] = await tx
            .select({ total: count() })
            .from(member)
            .where(eq(member.organizationId, tenantId));
          const [invitations] = await tx
            .select({ total: count() })
            .from(invitation)
            .where(
              and(
                eq(invitation.organizationId, tenantId),
                eq(invitation.status, "pending"),
                gt(invitation.expiresAt, new Date()),
                ignoreInvitationId
                  ? ne(invitation.id, ignoreInvitationId)
                  : undefined,
                ignoreInvitationEmail
                  ? ne(invitation.email, ignoreInvitationEmail)
                  : undefined,
              ),
            );

          return (members?.total ?? 0) + (invitations?.total ?? 0);
        });
      case "custom_roles": {
        const [row] = await getDb()
          .select({ total: count() })
          .from(organizationRole)
          .where(eq(organizationRole.organizationId, tenantId));

        return row?.total ?? 0;
      }
      case "customers": {
        const [row] = await withTenant(tenantId, (tx) =>
          tx.select({ total: count() }).from(customer),
        );

        return row?.total ?? 0;
      }
      case "channels_whatsapp_cloud":
      case "channels_whatsapp_qr": {
        // Canal desativado não conta (`docs/specs/whatsapp-canais/spec.md`).
        const type = metric === "channels_whatsapp_cloud" ? "whatsapp_cloud" : "whatsapp_qr";
        const [row] = await withTenant(tenantId, (tx) =>
          tx
            .select({ total: count() })
            .from(channel)
            .where(and(eq(channel.type, type), ne(channel.status, "disabled"))),
        );

        return row?.total ?? 0;
      }
      case "storage_mb":
        return Math.ceil((await storageUsedBytes(tenantId)) / (1024 * 1024));
      default:
        return 0;
    }
  },
};

/**
 * Compara o uso do tenant com o limite do plano da assinatura corrente (`trialing` usa
 * o plano do trial). Tenant sem assinatura não tem limite.
 */
export async function checkLimit(
  tenantId: string,
  metric: LimitMetric,
  options: LimitOptions = {},
): Promise<LimitCheck> {
  const source = options.source ?? databaseLimitSource;
  const limits = await source.limits(tenantId);
  const limit = limits[metric] ?? null;

  // Sem limite, a contagem seria trabalho jogado fora.
  if (limit === null) return evaluateLimit(metric, null, 0);

  const used = await source.used(tenantId, metric, options);

  return evaluateLimit(metric, limit, used);
}

/** Lança 403 `PLAN_LIMIT_REACHED` se não couber mais um. */
export async function assertWithinLimit(
  tenantId: string,
  metric: LimitMetric,
  options: LimitOptions = {},
) {
  const check = await checkLimit(tenantId, metric, options);

  if (!check.allowed) {
    throw new TenantRuleError(
      403,
      "PLAN_LIMIT_REACHED",
      `Seu plano permite até ${check.limit} ${LIMIT_LABELS[metric]}. Mude de plano para continuar.`,
    );
  }

  return check;
}
