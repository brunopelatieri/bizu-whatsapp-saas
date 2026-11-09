# SPEC: Multi-tenant, isolamento e RBAC

- **Parte de:** `docs/specs/saas-foundation/spec.md`
- **Paths previstos:** `src/db/tenant.ts`, `src/api/tenant.ts`, `src/api/permissions.ts`,
  `src/lib/auth/permissions.ts`, `src/components/auth/can.tsx`

## Modelo

- **Tenant** = `organization` do Better Auth (tabela `organization`, colunas extras
  por `schema.organization.additionalFields`: `status`, `access_mode`, `settings`,
  `billing_profile_id`, `trial_ends_at`).
- Usuário de equipe pertence a N tenants por `member`. O tenant ativo é
  `session.activeOrganizationId`. Troca por `authClient.organization.setActive`.
- Cliente/lead pertence a N tenants por `customer` (`portal_user_id`, `tenant_id`).

## Identificação do tenant

- Um domínio por instalação. Nada na URL identifica o tenant: `/app/**` usa a
  organização ativa da sessão; `/portal/**` usa `customer` ativo escolhido na
  sessão do portal (`portal_session.active_tenant_id`, campo adicional).
- SSR: rotas autenticadas não têm `loader`; nada de tenant vai ao HTML inicial.
- Cookies: `Domain` padrão (host), `SameSite=Lax`, `HttpOnly`, `Secure` em produção.
- Deploy: um certificado, um `APP_URL`. White label com subdomínio ou domínio
  próprio é módulo futuro (`tenant_domain`, resolução por `Host` no `requireTenant`,
  `crossSubDomainCookies` e TLS wildcard).

## Isolamento em profundidade

### Camada 1: aplicação

- Toda tabela de domínio tem `tenant_id uuid not null` com índice composto
  `(tenant_id, id)`.
- `requireTenant` (depois de `requireAuth`) carrega `member` do usuário na
  organização ativa, recusa com 403 se não houver, se `organization.status =
  "suspended"` ou se `access_mode = "locked"`. Em `read_only`, recusa mutações
  (exceto `/api/billing/*`).
- Toda query de tenant passa por `withTenant(tenantId, (tx) => ...)` em
  `src/db/tenant.ts`:

```ts
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
export function withPlatformScope<T>(reason: string, fn: (tx: Tx) => Promise<T>) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_tenant', 'on', true)`);
    return fn(tx);
  });
}
```

- Regra de lint (Biome `noRestrictedImports` ou teste): handlers em `src/api/tenant-*`
  não importam `getDb` direto; só `withTenant`. Jobs e rotas `/api/admin/*` usam
  `withPlatformScope` com `reason` auditado.

### Camada 2: Row Level Security

- Dois papéis no Postgres, criados por `docker/postgres/init.sql` no dev e
  documentados para produção:
  - `bizu_owner`: dono das tabelas, usado por `DIRECT_URL` (migrations, seed, pg-boss
    schema).
  - `bizu_app`: `NOBYPASSRLS`, `NOSUPERUSER`, `GRANT ALL ON ALL TABLES` do schema
    público, usado por `DATABASE_URL` (runtime).
- Toda tabela de tenant: `.enableRLS()` + `pgPolicy` e, em migration customizada
  (`drizzle-kit generate --custom`), `ALTER TABLE ... FORCE ROW LEVEL SECURITY`.
- Política padrão (função `tenantPolicy(table)` em `src/db/rls.ts`):

```sql
create policy tenant_isolation on <tabela>
  for all to bizu_app
  using (
    current_setting('app.bypass_tenant', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  with check (
    current_setting('app.bypass_tenant', true) = 'on'
    or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );
```

- Sem `set_config`, `current_setting` devolve vazio → nenhuma linha. A query
  esquecida retorna vazio.
- Tabelas do Better Auth (`user`, `session`, `organization`, `member`, `invitation`,
  `portal_*`) e de plataforma (`plan`, `platform_setting`, `payment_event`) **não**
  têm RLS: são multi-tenant por natureza e protegidas pela camada 1 e pelo plugin.
  `subscription`, `invoice`, `customer`, `audit_log`, `file`, `notification`,
  `usage_counter`, `tenant_feature_override`, `tenant_payment_credential`,
  `impersonation_grant`, `consent_log`, `deletion_request` têm RLS.
- pg-boss usa schema próprio `pgboss`, criado com `bizu_owner`; `bizu_app` recebe
  `GRANT` no schema.

### Como provar em teste

`src/db/rls.test.ts` (roda contra o Postgres do Docker, script `npm run test:db`):

1. Com `bizu_owner`, cria tenants A e B e um `customer` em cada.
2. Com `bizu_app` e `withTenant(A)`, `select` em `customer` retorna só A; `insert`
   com `tenant_id = B` falha com `42501` (policy).
3. Com `bizu_app` sem `set_config`, `select` retorna vazio.
4. Com `withPlatformScope`, retorna A e B.
5. Teste de API: usuário de A chama `GET /api/customers/:idDeB` → 404.
6. Teste de inventário: todas as tabelas em `src/db/schema.ts` com coluna
   `tenant_id` têm `enableRLS()` e policy (falha se alguém criar tabela sem).

## RBAC

### Papéis

| Escopo | Papel | Como é guardado |
|---|---|---|
| Plataforma | `platform_owner`, `platform_support`, `user` | `user.role` (admin plugin) |
| Tenant | `owner`, `admin`, `member` (estáticos) e personalizados | `member.role`; personalizados em `organization_role` (dynamic access control) |
| Portal | nenhum papel; `customer.status` = `lead`, `active`, `blocked` | `customer.status` |

### Catálogo de permissões

Definido uma vez em `src/lib/auth/permissions.ts` com `createAccessControl` e
exportado para servidor e cliente:

```ts
export const statements = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  role: ["create", "update", "delete"],
  billing: ["read", "manage"],
  customer: ["read", "create", "update", "delete", "invite"],
  settings: ["read", "update"],
  audit: ["read"],
  file: ["read", "upload", "delete"],
  support: ["grant"],
} as const;
```

### Matriz por papel

| Permissão | owner | admin | member | personalizado |
|---|---|---|---|---|
| `organization:update` | ✓ | ✓ | – | configurável |
| `organization:delete` | ✓ | – | – | nunca |
| `member:create/update/delete` | ✓ | ✓ (não sobre owner) | – | configurável |
| `invitation:create/cancel` | ✓ | ✓ | – | configurável |
| `role:*` | ✓ | – | – | nunca |
| `billing:read` | ✓ | ✓ | – | configurável |
| `billing:manage` | ✓ | – | – | nunca |
| `customer:read` | ✓ | ✓ | ✓ | configurável |
| `customer:create/update/invite` | ✓ | ✓ | ✓ | configurável |
| `customer:delete` | ✓ | ✓ | – | configurável |
| `settings:read` | ✓ | ✓ | ✓ | configurável |
| `settings:update` | ✓ | ✓ | – | configurável |
| `audit:read` | ✓ | ✓ | – | configurável |
| `file:*` | ✓ | ✓ | upload/read | configurável |
| `support:grant` | ✓ | – | – | nunca |
| `channel:read` | ✓ | ✓ | ✓ | configurável |
| `channel:manage` | ✓ | ✓ | – | configurável |

"Nunca" é garantido por `maximumRolesPerOrganization` + validação no
`beforeCreateOrgRole`/`beforeUpdateOrgRole` que rejeita permissões reservadas
(`organization:delete`, `role:*`, `billing:manage`, `support:grant`).

Plataforma: `platform_owner` tem tudo em `/api/admin/*`; `platform_support` tem
leitura, personificação com consentimento e reprocessar webhook; sem editar planos,
sem apagar tenant, sem alterar papéis de plataforma.

### Aplicação no servidor

- `requirePermission("customer:delete")` middleware: chama
  `auth.api.hasPermission({ headers, body: { permissions: { customer: ["delete"] } } })`,
  que resolve papéis estáticos e dinâmicos no servidor. Resultado em cache por
  requisição.
- `requirePlatform("platform_owner" | "platform_support")`: lê `user.role`.
- Regras de negócio além do RBAC ficam no handler: último owner não sai;
  `admin` não altera `owner`; transferência só por `owner`.

### Reflexo na interface

- `GET /api/me` devolve `permissions: string[]` já resolvidas para o tenant ativo
  (lista plana `recurso:ação`).
- `<Can permission="customer:delete">` e `useCan()` escondem ações; a API continua
  a fonte da verdade.
- `/app/equipe/papeis`: CRUD de papéis personalizados com checkboxes do catálogo,
  sem os reservados.

## Limites e feature flags

- `plan.limits` jsonb: `{ members, customers, storage_mb, custom_roles }`.
- `checkLimit(tenantId, "members")` compara `count` atual com o limite do plano
  ativo (ou do trial). Usado em `beforeAddMember`, `beforeCreateInvitation`,
  `POST /api/customers`, upload.
- `plan.features` string[] e `tenant_feature_override` (`feature`, `enabled`,
  `expires_at`). `hasFeature(tenantId, "audit_export")` no servidor; `features[]`
  em `/api/me` para a interface.
- `usage_counter` (`tenant_id`, `metric`, `period`, `value`) atualizado por job
  diário `billing.usage` e sob demanda para métricas de contagem.

## Ciclo de vida do tenant

| `status` | `access_mode` | Quando |
|---|---|---|
| `active` | `full` | trial ou assinatura em dia |
| `active` | `read_only` | fim da carência de inadimplência ou trial expirado |
| `suspended` | `locked` | suspensão pelo proprietário; `requireTenant` responde 403 |
| `deleting` | `locked` | exclusão pedida pelo owner; job apaga após 30 dias |
| `deleted` | – | linhas anonimizadas; `organization` mantida com `deleted_at` |

Exclusão do tenant: `DELETE /api/tenant` exige `owner`, senha e 2FA se ativo,
cria `deletion_request`, envia e-mail a todos os owners, bloqueia o acesso. Job
`lgpd.delete_tenant` apaga dados de tenant em ordem de FK dentro de
`withPlatformScope`, anonimiza `audit_log` e mantém `invoice` pelo prazo fiscal
(`platform_setting.invoice_retention_years`, padrão 5).
