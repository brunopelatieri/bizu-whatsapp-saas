# Planos, trial e limites

- **Escopo:** Planos e preços, configurações da plataforma, assinatura e trial, estado de cobrança do tenant, limites e features, job `billing.trial`, seed. A cobrança em si (checkout, webhooks, provedores) está em `tech/24-billing-cobranca.md`.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-billing.md`, `spec-dados.md`, `spec-tenant-rbac.md` (limites), `spec-email-jobs.md`
- **Paths do código:** `src/lib/billing/` (`constants.ts`, `trial.ts`, `state.ts`, `settings.ts`, `subscription.ts`, `limits.ts`, `organizations.ts`, `summary.ts`, `notify.ts`, `public-plans.server.ts`), `src/db/schema/billing.ts`, `src/jobs/billing.ts`, `src/db/seed.ts`, `src/lib/schemas/admin.ts`, `tests/db/{billing,admin,billing-manual}.test.ts`, `drizzle/0008_billing_planos.sql`, `drizzle/0009_rls_billing.sql`

## Tabelas

| Tabela | Escopo | Observações |
|---|---|---|
| `plan` | plataforma, sem RLS | `slug` único e imutável, `limits` jsonb, `features` text[], `is_free`, `active`, `sort_order`. Só se apaga sem uso (`DELETE /api/admin/plans/:id`: nenhuma assinatura, atual ou pendente, não é o padrão do trial nem o único gratuito ativo); senão arquiva: `active = false` tira de `/precos` e da oferta, e quem já usa segue nele |
| `plan_price` | plataforma, sem RLS | um por (plano, provedor, intervalo); `amount_cents` em centavos, `currency` `BRL`, `provider_price_ref` só como campo (preenchido em `/admin/planos`). `provider = manual`: preço da cobrança manual, sem referência (`tech/24-billing-cobranca.md`) |
| `platform_setting` | plataforma, sem RLS | uma chave por linha; ver abaixo |
| `subscription` | tenant, RLS forçado | uma por tenant. Estados e colunas do provedor em `tech/24-billing-cobranca.md` |
| `subscription_event` | tenant, RLS forçado | toda transição grava uma linha (`system`, `admin`, `job`, `owner`, `webhook`) |

`plan.limits`: `{ members, customers, storage_mb, custom_roles, organizations, channels_whatsapp_cloud, channels_whatsapp_qr }`. Chave ausente ou
`null` = ilimitado; `0` não deixa criar nada.

## Configurações da plataforma

`loadSettings()` (`settings.ts`) lê, com padrão se faltar ou vier malformado:

| Chave | Padrão | Significado |
|---|---|---|
| `trial_plan_id` | `null` | plano que o tenant novo recebe. `null`: o primeiro plano gratuito ativo |
| `trial_days` | 14 | `> 0`: `trialing` até `agora + dias`. `0`: sem teste |
| `grace_days` | 7 | dias de acesso total depois do fim do teste, antes do `read_only` |

`PATCH /api/admin/settings` valida contra o banco: plano ativo e, com `trial_days = 0`, plano
**gratuito** (senão o tenant nasceria com plano pago sem pagar). Mudar a configuração **não altera
tenants já criados**.

## Trial no onboarding

`POST /api/tenant` chama `startTrial(tenantId)` (`subscription.ts`) depois de criar a
organização. A decisão é a função pura `initialSubscription` (`trial.ts`):

| Plano escolhido | Dias | Resultado |
|---|---|---|
| gratuito | qualquer | `active`, sem `trial_ends_at` (gratuito sem fim) |
| pago | `> 0` | `trialing`, `trial_ends_at = agora + dias` |
| pago | `0` | cai no plano gratuito ativo; sem gratuito, nenhuma assinatura |

Sem assinatura (tenant anterior à fase 5, ou sem plano utilizável) o tenant não tem limites nem
features. Falha em `startTrial` vai para `logError` e não derruba o onboarding. É idempotente
(`ON CONFLICT DO NOTHING` em `tenant_id`). `organization.trial_ends_at` guarda a mesma data.

## Estado de cobrança

`billingState()` (`state.ts`), exposto em `GET /api/me` como `billing.state`:

| Estado | Quando |
|---|---|
| `locked` | `status <> active` ou `access_mode = locked` (suspenso): `requireTenant` responde 403 `TENANT_SUSPENDED` a tudo |
| `read_only` | `access_mode = read_only`: lê normal; mutações respondem 403 `TENANT_READ_ONLY`, exceto `/api/billing/*` |
| `trialing` | assinatura `trialing` |
| `past_due` | pagamento falhou, ainda na carência: acesso total, com aviso (`graceUntil` em `/api/me`) |
| `active` | o resto |

`/api/me` devolve `billing` (`state`, `plan`, `trialEndsAt`, `trialDaysLeft`, `graceUntil`), `features[]`
e `limits{}` (só os definidos) do plano da assinatura. Em `locked`, features e limites vêm vazios; em
`expired`, `canceled` e `unpaid`, as features.
O banner de `/app` (`BillingBanner`) só informa; quem barra é a API.

## Limites e features

`checkLimit(tenantId, metric)` (`limits.ts`) compara o uso com `plan.limits[metric]` e devolve
`{ limit, used, allowed }`; `assertWithinLimit` lança 403 `PLAN_LIMIT_REACHED`. A fonte de dados
é injetável (`LimitSource`) para testar sem banco.

- `members` conta membros **e convites pendentes e vigentes**: o convite já reserva o assento.
  Reconvidar o mesmo e-mail não ocupa um segundo (`ignoreInvitationEmail`); aceitar ignora o
  próprio convite (`ignoreInvitationId`).
- Aplicado em `POST /api/team/invitations` e `POST /api/invitations/:id/accept`.
- `custom_roles` conta `organization_role` e é aplicado em `POST /api/roles`; sem limite no plano,
  vale o teto fixo de 20 do plugin. `customers` conta as linhas de `customer` do tenant e é
  aplicado em `POST /api/customers`; `storage_mb` conta 0 até a fase 10.
- Features: `GET /api/me` entrega a lista; `hasFeature` no servidor e `tenant_feature_override`
  ficam para quando a primeira feature for cobrada.
- `organizations` é da **pessoa**, não do tenant (`organizations.ts`): conta as organizações não
  excluídas em que ela é owner e vale o maior limite entre elas. Só assinatura em dia (`active`
  ou `past_due`, tenant ativo) libera o limite do plano; trial, vencida, cancelada, suspensa ou
  sem assinatura valem 1. **Sem valor no plano (chave ausente ou `null`) também vale 1**, ao
  contrário dos outros limites: plano antigo ou salvo com o campo vazio não libera tenants sem
  fim. A primeira organização sempre passa. `POST /api/tenant` cria por
  `createOrganizationWithinLimit` (403 `PLAN_LIMIT_REACHED`): lock por pessoa
  (`pg_advisory_xact_lock`) e contagem na mesma transação, para duas criações simultâneas não
  furarem o limite. O plugin não tem `organizationLimit`: é o único caminho de criação.

## Job `billing.trial`

Cron diário 03:00 UTC (`src/jobs/billing.ts`, fila `billing.trial`, 3 tentativas, dead letter
`billing.trial.dead`). Para cada assinatura `trialing` de tenant ativo, `dueTrialNotice` devolve
o aviso mais urgente devido:

| Aviso | Quando | Efeito |
|---|---|---|
| `t3` / `t1` | faltam ≤ 3 / ≤ 1 dia | e-mail `trial-ending` |
| `t0` | o trial acabou, dentro da carência | e-mail `trial-ending` ("termina hoje") |
| `expired` | passou `trial_ends_at + grace_days` | `status = expired`, tenant `read_only`, evento, auditoria, e-mail `trial-expired` |

Idempotência: cada aviso é reservado em `subscription.metadata.trialNotices.<aviso>` por
`UPDATE` condicional **antes** de enviar; rodar duas vezes não repete e-mail. Se o envio falha
(enfileirar), a reserva é desfeita e o job relança no fim para o pg-boss tentar de novo; falha
de um tenant não impede os outros. `expired` faz transição, reserva e envio na mesma transação:
expirada, a assinatura sai da lista do job e um aviso falho não voltaria, então a falha desfaz
também a transição. Trial que já não pode expirar (pagamento chegou antes) não recebe o aviso. Quem já tem assinatura no provedor (trial nativo) fica fora: cobrar
e encerrar é com ele. Tenant suspenso não é tocado, e suspensão (`locked`) tem
precedência sobre `read_only`. `runBillingTrial(now, { tenantIds })` aceita um relógio e um
filtro, usados pelos testes. Destinatários: proprietários do tenant (`listTenantOwners`).

## Seed

`npm run db:seed` (`src/db/seed.ts`): idempotente, recusa `NODE_ENV=production` sem
`SEED_ALLOW_PRODUCTION=1`, exige `SEED_PASSWORD` (mín. 10). Cria planos `free` (1 organização),
`basic` (2) e `pro` (5), com preços `manual` e `stripe` (`provider_price_ref` nulo), as três
configurações (`trial_plan_id` = `pro`, 14 e 7 dias), `owner@bizu.local` (`platform_owner`),
`suporte@bizu.local` (`platform_support`), o tenant `acme` (`acme.owner`, `acme.admin`,
`acme.membro`, trial no `pro`) e três tenants na cobrança manual, cada um com owner próprio:
`cliente-em-dia` (pago), `cliente-atrasado` (`past_due`, fatura aberta) e `cliente-vencido`
(`unpaid` + `read_only`, fatura `failed`). Só cria o que falta: planos e configurações editados em
`/admin` não são sobrescritos; plano existente sem `organizations` ou sem as chaves de canal ganha só essas chaves.
Os limites de canal (`free` 1/1, `basic` 2/2, `pro` 3/3, oficial/QR) ainda não são **aplicados**: a contagem
em `databaseLimitSource.used` e o `assertWithinLimit` na criação entram com a tabela `channel` (B1 de
`docs/specs/whatsapp-canais/`). A página `/precos` só mostra o limite de canal cujo módulo está em
`CHANNEL_PROVIDERS`.
Conta já existente com o e-mail de um usuário do seed só tem o papel conferido se o e-mail estiver
confirmado; sem isso o seed para, porque a senha é de quem cadastrou. Em produção, recusa o
`SEED_PASSWORD` de `.env.example`.
Usa o papel de runtime (`DATABASE_URL`) e insere as contas já verificadas, com o hash do
próprio Better Auth.

## Fora desta fase

`billing.usage` e `usage_counter`; `tenant_feature_override`; perfil de cobrança no onboarding.
