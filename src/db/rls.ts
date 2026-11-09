import { sql } from "drizzle-orm";
import { getDb } from "@/db";

export type Tx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

/**
 * Toda query de tenant roda aqui. `set_config(..., true)` vale só para esta transação:
 * nada vaza para a próxima requisição que pegar a mesma conexão, inclusive em pooler no
 * modo transaction. Quem esquece recebe vazio do RLS, não dados de outro tenant.
 */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Só as linhas da plataforma (`tenant_id IS NULL`) das tabelas com `scopedPolicy()` e as
 * tabelas com `platformOnlyPolicy()`. Não enxerga dado de tenant nem grava linha com
 * `tenant_id`: o banco recusa, mesmo que o filtro da query seja esquecido. Nunca define
 * `app.tenant_id`.
 */
export function withPlatformData<T>(fn: (tx: Tx) => Promise<T>) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.platform_scope', 'on', true)`);
    return fn(tx);
  });
}

/** Dono dos dados de uma operação: um tenant ou a plataforma (`tenant_id` nulo). */
export type Scope = { kind: "tenant"; tenantId: string } | { kind: "platform" };

/** Abre a transação do escopo. Os serviços recebem `Scope`; as rotas só o montam. */
export function withScope<T>(scope: Scope, fn: (tx: Tx) => Promise<T>) {
  return scope.kind === "tenant"
    ? withTenant(scope.tenantId, fn)
    : withPlatformData(fn);
}

/** `tenant_id` a gravar numa linha do escopo: nunca vem do corpo da requisição. */
export function scopeTenantId(scope: Scope): string | null {
  return scope.kind === "tenant" ? scope.tenantId : null;
}

/**
 * Atravessa tenants, para jobs, rotas `/api/admin/*` e eventos sem tenant. `reason` fica
 * em `app.bypass_reason`, ao alcance de um gatilho ou do log do Postgres.
 */
export function withPlatformScope<T>(reason: string, fn: (tx: Tx) => Promise<T>) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_tenant', 'on', true)`);
    await tx.execute(sql`select set_config('app.bypass_reason', ${reason}, true)`);
    return fn(tx);
  });
}
