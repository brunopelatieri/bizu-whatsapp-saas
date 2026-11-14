import { and, count, eq, gt, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { channel, customer, invitation, member, organizationRole } from "@/db/schema";
import type { PlanLimits } from "@/db/schema/billing";
import { LIMIT_LABELS, type LimitMetric } from "@/lib/billing/constants";
import { type Tx, withTenant } from "@/db/rls";
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
  /**
   * Transação de tenant (`withTenant`) em que contar. `members` e `customers` leem por ela: na
   * trava de `withinLimit` a contagem enxerga o que a transação já gravou e não ocupa outra
   * conexão do pool enquanto segura a trava.
   */
  tx?: Tx;
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

  async used(tenantId, metric, { ignoreInvitationId, ignoreInvitationEmail, tx: given }) {
    const inTenant = <T>(read: (tx: Tx) => Promise<T>) =>
      given ? read(given) : withTenant(tenantId, read);

    switch (metric) {
      case "members":
        return inTenant(async (tx) => {
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
        const [row] = await inTenant((tx) => tx.select({ total: count() }).from(customer));

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

function limitReached(check: LimitCheck) {
  return new TenantRuleError(
    403,
    "PLAN_LIMIT_REACHED",
    `Seu plano permite até ${check.limit} ${LIMIT_LABELS[check.metric]}. Mude de plano para continuar.`,
  );
}

/**
 * Lança 403 `PLAN_LIMIT_REACHED` se não couber mais um. **Só confere**: não impede que duas
 * requisições simultâneas passem juntas pela última vaga. Quem cria `members` ou `customers`
 * usa `withinLimit`.
 */
export async function assertWithinLimit(
  tenantId: string,
  metric: LimitMetric,
  options: LimitOptions = {},
) {
  const check = await checkLimit(tenantId, metric, options);

  if (!check.allowed) throw limitReached(check);

  return check;
}

/**
 * Quanto uma requisição espera pela trava de limite antes de desistir. O dono da trava ainda
 * pode precisar de uma conexão do pool (o Better Auth grava convite e membro por outra
 * conexão); sem prazo, uma fila de esperas que ocupasse o pool inteiro o travaria para sempre.
 */
const LIMIT_LOCK_TIMEOUT = "15s";

/** A chave da trava de uma métrica de um tenant (os testes a seguram por ela). */
export const limitLockKey = (tenantId: string, metric: LimitMetric) =>
  `limit:${tenantId}:${metric}`;

/**
 * Trava (até o fim da transação) a métrica do tenant. **Ordem de travas do projeto:** esta é
 * sempre a mais externa. `withinLimit` abre a própria transação e a toma antes de qualquer
 * outra trava (o número, `lockPhoneKey`; a conta ou a ficha; o pedido) e nunca é chamada
 * dentro de uma transação que já segura uma delas, então não fecha ciclo com nenhuma.
 * O prazo de espera volta a `0` (o padrão do Postgres; o projeto não define outro) depois.
 */
async function lockLimit(tx: Tx, tenantId: string, metric: LimitMetric) {
  await tx.execute(sql`select set_config('lock_timeout', ${LIMIT_LOCK_TIMEOUT}, true)`);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${limitLockKey(tenantId, metric)}, 0))`,
  );
  // O prazo vale só para esta espera: as demais travas da transação seguem como eram.
  await tx.execute(sql`select set_config('lock_timeout', '0', true)`);
}

/**
 * Confere o limite e deixa o chamador gravar **sob uma trava por organização e métrica**
 * (`pg_advisory_xact_lock`): duas requisições simultâneas esperam uma pela outra, e a segunda já
 * conta a primeira. A mesma regra de `assertWithinLimit` (403 `PLAN_LIMIT_REACHED`), sem mudar o
 * que conta nem a mensagem. `run` recebe a transação de tenant: quem grava o cliente grava nela
 * e o `COMMIT` solta a trava. Quem grava por outra conexão (`members`: o Better Auth) só pode
 * devolver depois de a gravação confirmar, como em `createOrganizationWithinLimit`.
 *
 * O limite é lido **antes** de abrir a transação: ler o plano por outra conexão, já segurando
 * uma, esgotaria o pool sob concorrência. Plano sem limite na métrica não trava nada.
 * Trava por métrica: `customers` não segura `members`, nem um tenant segura outro.
 */
export async function withinLimit<T>(
  tenantId: string,
  metric: LimitMetric,
  options: LimitOptions,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  const source = options.source ?? databaseLimitSource;
  const limit = (await source.limits(tenantId))[metric] ?? null;

  return withTenant(tenantId, async (tx) => {
    if (limit !== null) {
      await lockLimit(tx, tenantId, metric);

      const used = await source.used(tenantId, metric, { ...options, tx });
      const check = evaluateLimit(metric, limit, used);
      if (!check.allowed) throw limitReached(check);
    }

    return run(tx);
  });
}
