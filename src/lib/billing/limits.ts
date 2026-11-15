import { and, count, eq, gt, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { nestedSection } from "@/db/nested-section";
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
 * usa `withinLimit` ou `withinLimitNested`.
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

/** A chave da trava de uma métrica de um tenant (os testes a seguram por ela). */
export const limitLockKey = (tenantId: string, metric: LimitMetric) =>
  `limit:${tenantId}:${metric}`;

/**
 * Trava (até o fim da transação) a métrica do tenant e confere o limite contando pela mesma
 * transação. **Ordem de travas do projeto:** esta é sempre a mais externa. As funções abaixo
 * abrem a própria transação e a tomam antes de qualquer outra trava (o número, `lockPhoneKey`;
 * a conta ou a ficha; o pedido) e nunca são chamadas dentro de uma transação que já segura uma
 * delas, então não fecham ciclo com nenhuma.
 */
const lockMetric = (tx: Tx, tenantId: string, metric: LimitMetric) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${limitLockKey(tenantId, metric)}, 0))`,
  );

async function lockAndCheck(
  tx: Tx,
  tenantId: string,
  metric: LimitMetric,
  limit: number,
  source: LimitSource,
  options: LimitOptions,
) {
  await lockMetric(tx, tenantId, metric);

  const used = await source.used(tenantId, metric, { ...options, tx });
  const check = evaluateLimit(metric, limit, used);
  if (!check.allowed) throw limitReached(check);
}

const limitOf = async (tenantId: string, metric: LimitMetric, source: LimitSource) =>
  (await source.limits(tenantId))[metric] ?? null;

/**
 * Confere o limite e deixa o chamador gravar **sob uma trava por organização e métrica**
 * (`pg_advisory_xact_lock`): duas requisições simultâneas esperam uma pela outra, e a segunda já
 * conta a primeira. A mesma regra de `assertWithinLimit` (403 `PLAN_LIMIT_REACHED`), sem mudar o
 * que conta nem a mensagem. `run` recebe a transação de tenant e **grava só por ela** (como
 * `customers`): o `COMMIT` solta a trava, e `run` nunca pede outra conexão do pool, que a
 * seção já segura uma. Quem grava por outra conexão (`members`: o Better Auth) usa
 * `withinLimitNested`.
 *
 * O limite é lido **antes** de abrir a transação (ler o plano por outra conexão, já segurando
 * uma, é o que esta função evita). Plano sem limite na métrica não trava nada. A trava é por
 * métrica: `customers` não segura `members`, nem um tenant segura outro. Quem espera a trava
 * segura uma conexão; como o dono da trava não pede outra, ele termina e a fila anda.
 */
export async function withinLimit<T>(
  tenantId: string,
  metric: LimitMetric,
  options: LimitOptions,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  const source = options.source ?? databaseLimitSource;
  const limit = await limitOf(tenantId, metric, source);

  return withTenant(tenantId, async (tx) => {
    if (limit !== null) await lockAndCheck(tx, tenantId, metric, limit, source, options);

    return run(tx);
  });
}

/**
 * Como `withinLimit`, para quem cria **vários de uma vez** (a importação de clientes, bloco I): em
 * vez de recusar com 403 quando falta vaga, entrega a `run` quantas restam (`room`, `0` com o plano
 * cheio, `null` sem limite) e deixa `run` decidir quais linhas entram. A trava, a ordem das travas, a
 * leitura do plano **antes** da transação e a regra de grava-só-pela-`tx` são as de `withinLimit`; plano
 * sem limite na métrica não toma a trava. A contagem é a mesma de `assertWithinLimit`, feita sob a trava.
 */
export async function withinLimitRoom<T>(
  tenantId: string,
  metric: LimitMetric,
  options: LimitOptions,
  run: (tx: Tx, room: number | null) => Promise<T>,
): Promise<T> {
  const source = options.source ?? databaseLimitSource;
  const limit = await limitOf(tenantId, metric, source);

  return withTenant(tenantId, async (tx) => {
    if (limit === null) return run(tx, null);

    await lockMetric(tx, tenantId, metric);
    const used = await source.used(tenantId, metric, { ...options, tx });

    return run(tx, Math.max(0, limit - used));
  });
}

/**
 * Como `withinLimit`, para quem grava **por outra conexão do pool** enquanto a trava está tomada
 * (`members`: `createInvitation` e `acceptInvitation` do Better Auth, que só devolvem depois de
 * gravar e confirmar). A seção segura uma conexão e `run` pede outra: sem teto, 10 pedidos
 * simultâneos ocupariam o pool inteiro e o processo pararia. Por isso:
 *
 * - plano sem limite na métrica **não abre transação** nem passa pelo teto: `run` roda direto;
 * - com limite, a seção passa por `nestedSection` (`src/db/nested-section.ts`), que limita quantas
 *   rodam ao mesmo tempo no processo; as demais esperam sem segurar conexão.
 */
export async function withinLimitNested<T>(
  tenantId: string,
  metric: LimitMetric,
  options: LimitOptions,
  run: () => Promise<T>,
): Promise<T> {
  const source = options.source ?? databaseLimitSource;
  const limit = await limitOf(tenantId, metric, source);

  if (limit === null) return run();

  return nestedSection(() =>
    withTenant(tenantId, async (tx) => {
      await lockAndCheck(tx, tenantId, metric, limit, source, options);

      return run();
    }),
  );
}
