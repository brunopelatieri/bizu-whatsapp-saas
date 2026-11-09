import { and, count, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { withPlatformScope } from "@/db/rls";
import {
  auditLog,
  customer,
  invoice,
  member,
  organization,
  paymentEvent,
  plan,
  planPrice,
  subscription,
  subscriptionEvent,
  user,
} from "@/db/schema";
import { MANUAL_PROVIDER } from "@/lib/billing/constants";
import { listTenantOwners } from "@/lib/billing/notify";
import { isProviderManaged } from "@/lib/billing/state-machine";
import type { BillingState } from "@/lib/billing/state";
import { appLink } from "@/lib/auth/links";
import { sendEmail } from "@/lib/email/send";
import { tenantSuspendedTemplate } from "@/lib/email/templates/tenant-suspended";
import { isUniqueViolation } from "@/db/errors";
import { organizationIdsWithTags, tagsOfOrganizationPage, type OrgTagView } from "@/lib/crm/organization-profile";
import { PAGE_SIZE, type UpdateTenantInput } from "@/lib/schemas/admin";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/** Mesma regra de `billingState()`, para filtrar e contar no banco. */
const stateSql = sql<BillingState>`case
  when ${organization.status} <> 'active' or ${organization.accessMode} = 'locked' then 'locked'
  when ${organization.accessMode} = 'read_only' then 'read_only'
  when ${subscription.status} = 'trialing' then 'trialing'
  when ${subscription.status} = 'past_due' then 'past_due'
  else 'active' end`;

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export type AdminTenantRow = {
  id: string;
  name: string;
  slug: string;
  state: BillingState;
  status: string;
  planName: string | null;
  trialEndsAt: Date | null;
  members: number;
  createdAt: Date;
};

export async function listTenants(input: {
  q?: string;
  status?: BillingState;
  plan?: string;
  tags?: string[];
  page: number;
}) {
  // As etiquetas são dado da plataforma: lidas em `withPlatformData`, nunca no bypass da lista.
  let taggedIds: string[] | null = null;
  if (input.tags && input.tags.length > 0) {
    taggedIds = await organizationIdsWithTags(input.tags);
    if (taggedIds.length === 0) {
      return { items: [], total: 0, pageSize: PAGE_SIZE };
    }
  }

  const term = input.q ? `%${escapeLike(input.q)}%` : null;
  const filters: SQL[] = [];

  if (term) {
    filters.push(
      or(ilike(organization.name, term), ilike(organization.slug, term)) as SQL,
    );
  }
  if (input.status) filters.push(sql`${stateSql} = ${input.status}`);
  // admin-crud A: "+N" de /admin/planos leva às organizações do plano.
  if (input.plan) filters.push(eq(subscription.planId, input.plan));
  if (taggedIds) filters.push(inArray(organization.id, taggedIds));

  const where = filters.length ? and(...filters) : undefined;

  const page = await withPlatformScope("admin: lista tenants", async (tx) => {
    const base = tx
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        state: stateSql,
        status: organization.status,
        planName: plan.name,
        trialEndsAt: subscription.trialEndsAt,
        members: sql<number>`(select count(*)::int from ${member} where ${member.organizationId} = ${organization.id})`,
        createdAt: organization.createdAt,
      })
      .from(organization)
      .leftJoin(subscription, eq(subscription.tenantId, organization.id))
      .leftJoin(plan, eq(subscription.planId, plan.id))
      .where(where);

    const [totalRow] = await tx
      .select({ total: count() })
      .from(organization)
      .leftJoin(subscription, eq(subscription.tenantId, organization.id))
      .where(where);

    const items: AdminTenantRow[] = await base
      .orderBy(desc(organization.createdAt))
      .limit(PAGE_SIZE)
      .offset((input.page - 1) * PAGE_SIZE);

    return { items, total: totalRow?.total ?? 0, pageSize: PAGE_SIZE };
  });

  const tags = await tagsOfOrganizationPage(page.items.map(({ id }) => id));

  return {
    ...page,
    items: page.items.map((item): AdminTenantRow & { tags: OrgTagView[] } => ({
      ...item,
      tags: tags.get(item.id) ?? [],
    })),
  };
}

export async function getTenantDetail(tenantId: string) {
  return withPlatformScope("admin: detalhe do tenant", async (tx) => {
    const [row] = await tx
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        status: organization.status,
        accessMode: organization.accessMode,
        state: stateSql,
        createdAt: organization.createdAt,
        subscription,
        plan,
      })
      .from(organization)
      .leftJoin(subscription, eq(subscription.tenantId, organization.id))
      .leftJoin(plan, eq(subscription.planId, plan.id))
      .where(eq(organization.id, tenantId));

    if (!row) throw notFound("Organização não encontrada.");

    const members = await tx
      .select({
        id: member.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: member.role,
        banned: user.banned,
        createdAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, tenantId))
      .orderBy(member.createdAt);

    const events = await tx
      .select({
        id: subscriptionEvent.id,
        from: subscriptionEvent.fromStatus,
        to: subscriptionEvent.toStatus,
        reason: subscriptionEvent.reason,
        source: subscriptionEvent.source,
        createdAt: subscriptionEvent.createdAt,
      })
      .from(subscriptionEvent)
      .where(eq(subscriptionEvent.tenantId, tenantId))
      .orderBy(desc(subscriptionEvent.createdAt))
      .limit(10);

    const audit = await tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorType: auditLog.actorType,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId))
      .orderBy(desc(auditLog.createdAt))
      .limit(10);

    const { subscription: sub, plan: currentPlan, ...tenant } = row;

    // Cobrança manual: faturas para marcar pagas ou não pagas e os preços manuais do plano.
    const invoices = sub
      ? await tx
          .select({
            id: invoice.id,
            provider: invoice.provider,
            amountCents: invoice.amountCents,
            currency: invoice.currency,
            status: invoice.status,
            paymentMethod: invoice.paymentMethod,
            dueAt: invoice.dueAt,
            paidAt: invoice.paidAt,
            periodStart: invoice.periodStart,
            periodEnd: invoice.periodEnd,
            createdAt: invoice.createdAt,
          })
          .from(invoice)
          .where(eq(invoice.subscriptionId, sub.id))
          .orderBy(desc(invoice.createdAt))
          .limit(12)
      : [];
    const manualPrices = currentPlan
      ? await tx
          .select({
            id: planPrice.id,
            interval: planPrice.interval,
            amountCents: planPrice.amountCents,
            currency: planPrice.currency,
          })
          .from(planPrice)
          .where(
            and(
              eq(planPrice.planId, currentPlan.id),
              eq(planPrice.provider, MANUAL_PROVIDER),
              eq(planPrice.active, true),
            ),
          )
      : [];

    return {
      tenant,
      subscription: sub && {
        id: sub.id,
        status: sub.status,
        trialEndsAt: sub.trialEndsAt,
        planId: sub.planId,
        planPriceId: sub.planPriceId,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        graceUntil: sub.graceUntil,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        // `provider`: cobrada pelo módulo; `manual`: marcada aqui.
        billingMode: isProviderManaged(sub) ? "provider" : "manual",
      },
      plan: currentPlan && {
        id: currentPlan.id,
        name: currentPlan.name,
        isFree: currentPlan.isFree,
      },
      invoices,
      manualPrices,
      members,
      events,
      audit,
    };
  });
}

/**
 * Suspende (`suspended` + `locked`): `requireTenant` passa a responder 403 a todos. Já
 * suspenso é 409. Avisa os proprietários por e-mail; a falha do aviso fica no log: a
 * suspensão já valeu, e a rota ainda precisa responder e auditar.
 */
export async function suspendTenant(tenantId: string, reason?: string) {
  const updated = await withPlatformScope("admin: suspende tenant", (tx) =>
    tx
      .update(organization)
      .set({ status: "suspended", accessMode: "locked" })
      .where(and(eq(organization.id, tenantId), eq(organization.status, "active")))
      .returning({ id: organization.id, name: organization.name }),
  );

  const [tenant] = updated;
  if (!tenant) return failUpdate(tenantId, "ALREADY_SUSPENDED");

  try {
    for (const owner of await listTenantOwners(tenantId)) {
      await sendEmail({
        to: owner.email,
        ...tenantSuspendedTemplate({
          name: owner.name,
          tenantName: tenant.name,
          reason,
          url: appLink("/app"),
        }),
        tags: { template: "tenant-suspended" },
      });
    }
  } catch (error) {
    logError("Falha ao avisar a suspensão", error);
  }

  return tenant;
}

/** Reativa. Trial vencido volta como `read_only`, não como acesso total. */
export async function unsuspendTenant(tenantId: string) {
  const [tenant] = await withPlatformScope("admin: reativa tenant", async (tx) => {
    const [sub] = await tx
      .select({ status: subscription.status })
      .from(subscription)
      .where(eq(subscription.tenantId, tenantId));

    return tx
      .update(organization)
      .set({
        status: "active",
        accessMode: sub && ["expired", "unpaid", "canceled", "paused"].includes(sub.status)
          ? "read_only"
          : "full",
      })
      .where(
        and(eq(organization.id, tenantId), eq(organization.status, "suspended")),
      )
      .returning({ id: organization.id });
  });

  if (!tenant) return failUpdate(tenantId, "NOT_SUSPENDED");

  return tenant;
}

/** O `update` não achou linha: ou o tenant não existe (404) ou não estava no estado certo (409). */
async function failUpdate(tenantId: string, conflictCode: string): Promise<never> {
  const [row] = await withPlatformScope("admin: confere tenant", (tx) =>
    tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, tenantId)),
  );

  if (!row) throw notFound("Organização não encontrada.");

  throw new TenantRuleError(
    409,
    conflictCode,
    conflictCode === "ALREADY_SUSPENDED"
      ? "Esta organização não está ativa."
      : "Esta organização não está suspensa.",
  );
}

export async function getOverview(now = new Date()) {
  const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return withPlatformScope("admin: visão geral", async (tx) => {
    const byState = await tx
      .select({ state: stateSql, total: count() })
      .from(organization)
      .leftJoin(subscription, eq(subscription.tenantId, organization.id))
      .groupBy(stateSql);

    const [users] = await tx
      .select({
        total: count(),
        banned: sql<number>`count(*) filter (where ${user.banned})::int`,
      })
      .from(user);

    const [expiring] = await tx
      .select({ total: count() })
      .from(subscription)
      .innerJoin(organization, eq(subscription.tenantId, organization.id))
      .where(
        and(
          eq(subscription.status, "trialing"),
          eq(organization.status, "active"),
          sql`${subscription.trialEndsAt} <= ${soon.toISOString()}::timestamptz`,
        ),
      );

    const [customers] = await tx.select({ total: count() }).from(customer);

    const [plans] = await tx
      .select({ total: count() })
      .from(plan)
      .where(eq(plan.active, true));

    const [failed] = await tx
      .select({ total: count() })
      .from(paymentEvent)
      .where(
        and(eq(paymentEvent.status, "failed"), eq(paymentEvent.verified, true)),
      );

    const tenants: Record<BillingState, number> = {
      trialing: 0,
      active: 0,
      past_due: 0,
      read_only: 0,
      locked: 0,
    };
    for (const { state, total } of byState) tenants[state] = total;

    return {
      tenants,
      tenantsTotal: Object.values(tenants).reduce((sum, value) => sum + value, 0),
      users: { total: users?.total ?? 0, banned: users?.banned ?? 0 },
      customers: customers?.total ?? 0,
      trialsExpiringSoon: expiring?.total ?? 0,
      activePlans: plans?.total ?? 0,
      failedWebhooks: failed?.total ?? 0,
    };
  });
}

// admin-crud A: editar organização ---------------------------------------------------------

/**
 * Nome e slug pela plataforma. O plugin `organization` só deixa editar quem é membro, e a
 * plataforma não é; como não há `organizationHooks`, ele não faz mais que conferir o slug e
 * gravar. Aqui vale a mesma regra (`slugSchema` na entrada, `organization.slug` único no
 * banco), por Drizzle. Organização em exclusão não se edita.
 */
export async function updateTenantAsPlatform(
  tenantId: string,
  patch: UpdateTenantInput,
) {
  try {
    return await withPlatformScope("admin: edita organização", async (tx) => {
      const [before] = await tx
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
        })
        .from(organization)
        .where(eq(organization.id, tenantId))
        .for("update");

      if (!before) throw notFound("Organização não encontrada.");

      if (before.status === "deleting" || before.status === "deleted") {
        throw new TenantRuleError(
          409,
          "TENANT_DELETING",
          "Esta organização está em exclusão e não pode ser editada.",
        );
      }

      const changes = {
        ...(patch.name !== undefined && patch.name !== before.name
          ? { name: patch.name }
          : {}),
        ...(patch.slug !== undefined && patch.slug !== before.slug
          ? { slug: patch.slug }
          : {}),
      };

      if (Object.keys(changes).length === 0) return { before, after: before, changes };

      const [after] = await tx
        .update(organization)
        .set(changes)
        .where(eq(organization.id, tenantId))
        .returning({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
        });

      return { before, after: after ?? before, changes };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TenantRuleError(
        409,
        "SLUG_TAKEN",
        "Este identificador já está em uso por outra organização.",
      );
    }

    throw error;
  }
}
