# Banco de dados com Drizzle

- **Escopo:** Schema, papéis do Postgres, variáveis e uso do Drizzle em qualquer Postgres.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-dados.md`, `spec-tenant-rbac.md`
- **Paths do código:** `src/db/index.ts`, `src/db/rls.ts`, `src/db/tenant-policy.ts`, `src/db/schema.ts`, `src/db/schema/`, `src/db/seed.ts`, `drizzle.config.ts`, `docker/postgres/init.sql`, `tests/db/`

## Arquivos

- `src/db/schema/<domínio>.ts`: um arquivo por domínio (`auth.ts`, `tenant.ts`, `audit.ts`,
  `contact.ts`, `email.ts`, `billing.ts`, `security.ts`).
- `src/db/rls.ts`: `withTenant`, `withPlatformScope`, `withPlatformData`, `withScope`, o tipo
  `Scope` e `scopeTenantId`.
- `src/db/tenant-policy.ts`: `tenantPolicy()`, `scopedPolicy()` e `platformOnlyPolicy()`, fora
  de `rls.ts` porque o Drizzle Kit carrega o schema sem o alias `@/` nem as variáveis de ambiente.
- `src/db/schema.ts`: reexporta os domínios. `drizzle.config.ts` e o adapter do Better
  Auth leem este arquivo, então domínio novo entra aqui com `export * from "./schema/<domínio>"`.
- `src/db/index.ts`: `getDb()`, conexão de runtime com `DATABASE_URL` lida de `getEnv()`.
- `drizzle.config.ts`: usa `DIRECT_URL` (fallback `DATABASE_URL`).
- `drizzle/`: migrations geradas; `npm run db:generate` e `npm run db:migrate`.
- `docker/postgres/init.sql`: papéis e banco, rodado uma vez pelo Docker ou à mão.

Schema atual:

```text
user                      Better Auth; role, banned e ban_* (plugin admin), two_factor_enabled,
                          phone, locale, last_tenant_id
two_factor                plugin twoFactor: secret e backup_codes cifrados, verified, lockout
portal_two_factor         o mesmo no portal, sem rotas abertas
impersonation_grant       consentimento do owner: expires_at, revoked_at, used_by (RLS)
tenant_payment_credential encrypted_secret bytea, key_version, sem tela (RLS)
rate_limit_bucket         key em hash, window_start, count (RATE_LIMIT_STORE=postgres)
session                   token unique, user_id, expires_at, impersonated_by,
                          impersonation_expires_at, active_organization_id
account                   provider_id = credential guarda a senha
verification              tokens de reset, em hash
rate_limit                key unique, count, last_request (rate limit do Better Auth)
email_verification_issue  user_id PK, token_hash unique, kind (verify, change), issued_at
organization              o tenant: slug unique, status, access_mode, settings, trial_ends_at
member                    unique (organization_id, user_id); role com papéis separados por vírgula
invitation                email, role, status, expires_at, inviter_id
organization_role         papéis personalizados; permission em texto, como o plugin grava
audit_log                 tenant_id nulo = fora de tenant; ip_hash; RLS forçado
customer                  unique (tenant_id, email); portal_user_id nulo até o envio; status lead|active|blocked; RLS forçado
portal_user               identidade do cliente, global, sem role nem ban (sem RLS)
portal_session            active_tenant_id: o tenant em uso no portal (sem RLS)
portal_account, portal_verification, portal_rate_limit   instância portalAuth (sem RLS)
plan                      slug unique, limits jsonb, features text[], is_free, active (sem RLS)
plan_price                unique (plan_id, provider, interval); amount_cents; provider_price_ref (sem RLS)
platform_setting          key pk, value jsonb: trial_plan_id, trial_days, grace_days (sem RLS)
subscription              unique tenant_id; plan_id, status, trial_ends_at, metadata; RLS forçado
subscription_event        histórico de status por assinatura; RLS forçado

contact_messages
  id uuid primary key defaultRandom
  name text not null
  email text not null
  message text not null
  created_at timestamp with timezone default now
```

Tabelas do Better Auth usam `uuid` e `timestamptz` e seguem `getAuthTables`, com o nome de
modelo como chave do export (`rateLimit`, não `rate_limit`). O adapter não usa transação:
os hooks de e-mail gravam por outra conexão e não veriam o usuário ainda não confirmado.

```text
email_message   (plataforma, sem tenant_id nem RLS)
  id uuid pk, to_hash (sha256), template, provider, provider_message_id (índice),
  status (queued|sent|delivered|bounced|complained|failed), error, sent_at,
  created_at (índice), updated_at
email_suppression
  email_hash text pk, reason (hard_bounce|complaint|manual), created_at
```

Nenhuma das duas guarda o endereço em claro nem o corpo. `email_message` segue sem
`tenant_id`: a spec a deixa fora do RLS, e o inventário de `tests/db/rls.test.ts` exige RLS em
toda tabela com essa coluna.

## Schema `pgboss`

A migration `0005_email_jobs` cria o schema `pgboss` e dá `USAGE` e privilégios padrão
ao `bizu_app` (`ALTER DEFAULT PRIVILEGES`). As tabelas do pg-boss são criadas por
`npm run jobs:install` (primeiro `start()` com `DIRECT_URL`), não pelo Drizzle: o
Drizzle Kit não conhece essas tabelas e não deve gerar migration para elas. Detalhes em
`tech/20-jobs.md`.

## RLS e `withTenant`

Toda tabela com `tenant_id` tem `.enableRLS()`, `tenantPolicy()` no schema e
`ALTER TABLE ... FORCE ROW LEVEL SECURITY` em migration customizada
(`npx drizzle-kit generate --custom --name <nome>`; ver `0007_rls_roles.sql`). Sem o `FORCE`, o
dono da tabela ignoraria o RLS. Entram nessa regra `audit_log`, `subscription` e `subscription_event` (migration `0009_rls_billing`), além de `customer` (`0013_rls_portal`).

```ts
await withTenant(tenantId, (tx) => tx.select().from(auditLog));
await withPlatformScope("motivo", (tx) => tx.select().from(auditLog));
```

- `set_config(..., true)` vale só para a transação; funciona em pooler no modo transaction.
- Fora de `withTenant`, `bizu_app` não lê nem grava nada: a query esquecida volta vazia.
- A policy vale para `bizu_app` e `bizu_owner`. Com `FORCE`, o dono sem policy não acessaria
  nada, e o seed precisa gravar; ele também usa `app.bypass_tenant`.
- As tabelas `portal_*` não têm RLS: a identidade do cliente atravessa tenants, e o vínculo fica em `customer`. Quem lê `customer` de vários tenants parte do `portal_user` da sessão, em `withPlatformScope`.
- `organization`, `member`, `invitation` e `organization_role` não têm RLS
  (`spec-tenant-rbac.md`); o isolamento fica em `requireTenant` e em `src/lib/tenant/`.

### Escopo de plataforma (`scopedPolicy`)

Para tabelas que servem o tenant (`/app`) e a plataforma (`/admin`) com o mesmo schema
(WhatsApp CRM, `docs/specs/whatsapp-crm/plano.md`, decisões T1 a T3). Nenhuma tabela usa ainda.

| Política | Tabela | Passa com |
|---|---|---|
| `tenantPolicy()` | `tenant_id` obrigatório ou nulo só por job | `app.bypass_tenant` ou `tenant_id = app.tenant_id` |
| `scopedPolicy()` | `tenant_id` anulável; `NULL` é dado da plataforma | o anterior ou `tenant_id is null and app.platform_scope = 'on'` |
| `platformOnlyPolicy()` | sem `tenant_id`, só da plataforma (ex.: `organization_tag`) | `app.bypass_tenant` ou `app.platform_scope = 'on'` |

```ts
await withScope(scope, (tx) => tx.insert(tag).values({ tenantId: scopeTenantId(scope), ... }));
await withPlatformData((tx) => tx.select().from(tag)); // só tenant_id nulo
```

- `withPlatformData` liga só `app.platform_scope`: não lê linha de tenant e o banco recusa gravar
  linha com `tenant_id`. `withTenant` não lê nem grava linha da plataforma. Um modo por transação.
- `withPlatformScope` continua sendo o único que atravessa tenants; o atendimento da plataforma
  não o usa.
- `tenant_id` vem do `Scope` (`scopeTenantId`), nunca do corpo da requisição; tabela filha repete o
  do pai. As rotas `/api/*` montam `{ kind: "tenant", tenantId }` depois de `requireTenant`, e
  `/api/admin/*` montam `{ kind: "platform" }` depois de `requirePlatform`.
- Unicidade com `tenant_id` nulo pede dois índices: o normal e um parcial `WHERE tenant_id IS NULL`.
- Tabela nova continua com `.enableRLS()` e `FORCE ROW LEVEL SECURITY` em migration customizada.
- `tests/db/rls.test.ts` prova os três modos em tabelas de prova que recebem o SQL renderizado
  das próprias políticas.

## Papéis do Postgres

| Papel | URL | Uso | Permissão |
|---|---|---|---|
| `bizu_owner` | `DIRECT_URL` | migrations e instalação da fila | dono do banco `bizu` e das tabelas |
| `bizu_app` | `DATABASE_URL` | aplicação em runtime | `NOBYPASSRLS`, sem `CREATE` em `public` |

- `init.sql` define `ALTER DEFAULT PRIVILEGES FOR ROLE bizu_owner`: toda tabela e
  sequência criadas pelas migrations ficam com `SELECT/INSERT/UPDATE/DELETE` para
  `bizu_app`, sem `GRANT` manual. O RLS continua valendo para `bizu_app`.
- Migration não cria papéis (precisa de superusuário). Em Postgres próprio, rode o
  `init.sql` com `psql` antes do `db:migrate`; ele usa `\gexec` e `\connect`.
- Senhas do `init.sql` são de desenvolvimento; em produção, troque-as e reflita nas URLs.
- Pooler em modo transaction (PgBouncer): acrescente `?prepare=false` à `DATABASE_URL`.
- postgres.js 4 deixa o servidor decidir o tipo de cada parâmetro (`infer: false`). Em SQL cru, envie
  `Date` como `${data.toISOString()}::timestamptz`: sem cast, o Postgres pode recusar a consulta.
  O `PGSSLMODE` do ambiente agora vale; a URL e a opção `ssl` têm precedência.

## Testes com banco

`npm run test:db` roda `tests/db/**/*.test.ts` (`vitest.db.config.ts`, que fixa
`EMAIL_PROVIDER=memory` e `TRUSTED_PROXY_HOPS=1`) contra o
Postgres do Docker com as migrations aplicadas, sem paralelismo entre arquivos.
`tests/db/roles.test.ts` prova que `DATABASE_URL` é `bizu_app` sem `BYPASSRLS`, que ele
não cria tabelas e que herda acesso às tabelas de `bizu_owner`. `auth.test.ts` cobre os
fluxos de autenticação com `api.request()` e `auth-http.test.ts` repete o principal sobre
o servidor Node. `rls.test.ts` prova o isolamento e faz o inventário de tabelas; `rbac.test.ts` é
a matriz papel × endpoint gerada do catálogo; `team.test.ts` e `tenant-http.test.ts` cobrem
convite, escalada, último owner e ids cruzados, este último sobre HTTP de verdade. `admin.test.ts`
e `billing.test.ts` cobrem `/api/admin/*`, trial, `read_only`/`locked`, limite de assentos, o job
`billing.trial` e o seed; eles guardam e devolvem `platform_setting` e apagam os planos `test-*`.
`billing-webhooks.test.ts` e `billing-lifecycle.test.ts` cobrem a cobrança com o provedor stub de
`billing-helpers.ts`, e também o isolamento de `invoice`, `billing_profile` e `payment_event`.

## Seed

`npm run db:seed` (`src/db/seed.ts`) é idempotente e recusa produção sem `SEED_ALLOW_PRODUCTION=1`;
usa `SEED_PASSWORD`. Conteúdo e regras em `tech/23-billing-planos.md`. Roda com `DATABASE_URL`
(`bizu_app`), que já escreve em todas as tabelas; o RLS vale via `withTenant`.

## Regras

- Dados da aplicação passam sempre pelo Drizzle, em qualquer Postgres.
- Toda tabela de tenant tem `tenant_id`, `enableRLS()`, `tenantPolicy()` e `FORCE`; toda query
  de tenant roda em `withTenant`. Tabela sem isso reprova `tests/db/rls.test.ts`.
- Mudança de schema é sempre migration; `db:push` só em dev descartável.

## Tabelas de canal (WhatsApp)

`channel`, `channel_whatsapp_cloud`, `channel_evolution`, `channel_event` e `message_template`
(`src/db/schema/channels.ts`): `tenant_id` anulável, `scopedPolicy()` e `FORCE` (migrations
`0022_canais_whatsapp` e `0023_rls_canais`). Unicidade global em `phone_number_id`,
`remote_instance_name`, `webhook_key` e `webhook_secret_hash`; padrão por escopo e tipo e
`message_template` por escopo têm dois índices (com `tenant_id` e parcial `WHERE tenant_id IS NULL`).
Colunas `*_enc` guardam o texto de `encryptSecret`. Teste: `tests/db/channels-schema.test.ts`.
Detalhes em `tech/29-canais-whatsapp.md`.

## Tabelas da fase 10

- `consent_log` (sem tenant, sem RLS): aceite e recusa por `subject_type`/`subject_id`, `kind`, `version`, hash de IP.
- `deletion_request` e `data_export` (RLS forçado; `tenant_id` nulo para pedidos de pessoa, que só se leem com `withPlatformScope`): índices únicos parciais garantem **um pendente por assunto**.
- `file` (tenant, RLS forçado): metadados do módulo de arquivos; `key` única.
- Migrations `0017_arquivos` e `0018_lgpd`, ambas com `FORCE ROW LEVEL SECURITY` e `GRANT` no fim do SQL, como `0015`.
- `0019_leitura_migracoes_runtime` dá ao `bizu_app` leitura de `drizzle.__drizzle_migrations`: `src/db/schema-status.ts` compara o registro mais recente com o último `when` do journal, que entra no bundle. Na subida em produção, faltar migration encerra o processo (`tech/14-deploy.md`); banco à frente do build é normal.
- `platform_setting` ganha `dpo_email` e `audit_retention_days`.
- Em testes, o dono (`bizu_owner`) também está sujeito ao RLS: leia essas tabelas com `set_config('app.bypass_tenant', 'on', true)`.
