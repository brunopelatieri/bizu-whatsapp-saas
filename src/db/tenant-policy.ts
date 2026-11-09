import { type SQL, sql } from "drizzle-orm";
import { pgPolicy } from "drizzle-orm/pg-core";

/**
 * Só o que o schema precisa para declarar RLS. Fica fora de `src/db/rls.ts` porque o
 * Drizzle Kit carrega o schema sem o alias `@/` nem as variáveis de ambiente.
 *
 * Sem `set_config`, `current_setting` devolve vazio e nenhuma linha passa: a query
 * esquecida retorna vazio em vez de vazar.
 */
const bypass: SQL = sql`current_setting('app.bypass_tenant', true) = 'on'`;
const sameTenant: SQL = sql`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
const platformOn: SQL = sql`current_setting('app.platform_scope', true) = 'on'`;

const tenantMatches: SQL = sql`${bypass} or ${sameTenant}`;

/**
 * Política padrão de tabela com `tenant_id`. Vale também para `bizu_owner`: com `FORCE
 * ROW LEVEL SECURITY`, o dono sem política não leria nem gravaria nada, e o seed usa
 * esse papel. Ele também precisa de `app.bypass_tenant`.
 */
export function tenantPolicy() {
  return pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: ["bizu_app", "bizu_owner"],
    using: tenantMatches,
    withCheck: tenantMatches,
  });
}

const scopeMatches: SQL = sql`${bypass} or ${sameTenant} or (tenant_id is null and ${platformOn})`;

/**
 * Tabela com `tenant_id` anulável: linha de tenant ou linha da plataforma (`NULL`).
 * `withTenant` vê só o tenant; `withPlatformData` vê só as linhas sem tenant; sem
 * nenhum dos dois, nada passa (`tenant_id = NULL` é nulo). Ver `plano.md` do WhatsApp CRM.
 */
export function scopedPolicy() {
  return pgPolicy("scope_isolation", {
    as: "permissive",
    for: "all",
    to: ["bizu_app", "bizu_owner"],
    using: scopeMatches,
    withCheck: scopeMatches,
  });
}

const platformOnlyMatches: SQL = sql`${bypass} or ${platformOn}`;

/** Tabela sem `tenant_id`, que só a plataforma lê e escreve (ex.: `organization_tag`). */
export function platformOnlyPolicy() {
  return pgPolicy("platform_only", {
    as: "permissive",
    for: "all",
    to: ["bizu_app", "bizu_owner"],
    using: platformOnlyMatches,
    withCheck: platformOnlyMatches,
  });
}
