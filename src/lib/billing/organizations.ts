import { and, eq, ne, sql } from "drizzle-orm";
import { nestedSection } from "@/db/nested-section";
import { type Tx, withPlatformScope } from "@/db/rls";
import { member, organization, plan, subscription } from "@/db/schema";
import type { SubscriptionStatus } from "@/db/schema/billing";
import type { TenantStatus } from "@/db/schema/tenant";
import { isOwner } from "@/lib/auth/permissions";
import { LIMIT_LABELS } from "@/lib/billing/constants";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * Quantas organizações o dono pode ter (`plan.limits.organizations`). Não é limite de um
 * tenant, e sim da pessoa: conta as organizações em que ela é owner e vale o maior limite
 * entre elas. Só assinatura paga (`active` ou `past_due`, tenant ativo) libera o limite do
 * plano: em trial, vencida, cancelada, suspensa ou sem assinatura, a organização vale 1.
 *
 * Diferente dos outros limites, `organizations` sem valor (chave ausente ou `null`) vale 1, e
 * não ilimitado: plano criado antes desta regra, ou salvo com o campo vazio, não pode liberar
 * tenants sem fim. Para muitos, ponha um número alto.
 */

/** Limite de quem ainda não paga: trial, gratuito sem a chave, vencida ou sem assinatura. */
export const UNPAID_ORGANIZATIONS_LIMIT = 1;

export type OwnedOrganization = {
  tenantStatus: TenantStatus;
  subscriptionStatus: SubscriptionStatus | null;
  /** `plan.limits.organizations`. Ausente ou `null`: 1. */
  planLimit: number | null | undefined;
};

export type OrganizationAllowance = {
  /** `null`: ainda sem organização, a primeira sempre passa. */
  limit: number | null;
  used: number;
  /** Cabe mais uma? */
  allowed: boolean;
};

/**
 * O que uma organização libera: o limite do plano só com a assinatura em dia (gratuito ativo
 * conta, com o limite do próprio plano). Sem valor no plano, 1.
 */
export function organizationLimitOf(owned: OwnedOrganization): number {
  const paid =
    owned.tenantStatus === "active" &&
    (owned.subscriptionStatus === "active" || owned.subscriptionStatus === "past_due");

  if (!paid) return UNPAID_ORGANIZATIONS_LIMIT;
  return owned.planLimit ?? UNPAID_ORGANIZATIONS_LIMIT;
}

/** Decisão pura. Sem organização nenhuma, a primeira sempre passa. */
export function organizationAllowance(owned: OwnedOrganization[]): OrganizationAllowance {
  const used = owned.length;
  if (used === 0) return { limit: null, used, allowed: true };

  const limit = Math.max(...owned.map(organizationLimitOf));
  return { limit, used, allowed: used < limit };
}

/** Organizações (não excluídas) em que a pessoa é owner, com plano e assinatura. */
async function listOwnedOrganizations(tx: Tx, userId: string): Promise<OwnedOrganization[]> {
  const rows = await tx
    .select({
      role: member.role,
      tenantStatus: organization.status,
      subscriptionStatus: subscription.status,
      limits: plan.limits,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .leftJoin(subscription, eq(subscription.tenantId, organization.id))
    .leftJoin(plan, eq(subscription.planId, plan.id))
    .where(and(eq(member.userId, userId), ne(organization.status, "deleted")));

  return rows
    .filter(({ role }) => isOwner(role))
    .map(({ tenantStatus, subscriptionStatus, limits }) => ({
      tenantStatus,
      subscriptionStatus,
      planLimit: limits?.organizations,
    }));
}

/**
 * Confere o limite e cria a organização com um lock por pessoa (`pg_advisory_xact_lock`):
 * duas criações simultâneas da mesma pessoa esperam uma pela outra, e a segunda já conta a
 * primeira. A contagem roda na mesma transação do lock, com escopo de plataforma
 * (`subscription` tem RLS e a leitura cruza os tenants da pessoa); `create` grava pelo
 * adaptador do Better Auth, que confirma antes de devolver, e o lock cai no fim. É o único
 * caminho de criação: `/api/auth/organization/*` não responde por HTTP. Lança 403
 * `PLAN_LIMIT_REACHED`.
 */
export async function createOrganizationWithinLimit<T>(
  userId: string,
  create: () => Promise<T>,
): Promise<T> {
  // A seção segura uma conexão e `create` pede outra (o Better Auth grava pelo mesmo pool): sem o
  // teto de `nestedSection`, 10 criações simultâneas (da mesma pessoa, esperando o lock, ou de
  // pessoas diferentes) ocupariam o pool inteiro e o processo pararia.
  return nestedSection(() =>
    withPlatformScope("organizations: limite do dono", async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`organization-create:${userId}`}, 0))`,
      );
      const check = organizationAllowance(await listOwnedOrganizations(tx, userId));

      if (!check.allowed) {
        throw new TenantRuleError(
          403,
          "PLAN_LIMIT_REACHED",
          `Seu plano permite até ${check.limit} ${LIMIT_LABELS.organizations}. Mude de plano para criar outra.`,
        );
      }

      return create();
    }),
  );
}
