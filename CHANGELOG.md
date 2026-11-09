# Changelog

Todas as mudanças relevantes deste projeto ficam aqui. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue o
[SemVer](https://semver.org/lang/pt-BR/). Em `0.x`, uma versão menor pode trazer mudança
incompatível: leia sempre a seção **Migração** antes de atualizar um projeto derivado
(`docs/context/atualizar-template.md`).

## [Não lançado]

### Adicionado

- **Cobrança manual como padrão** (`docs/specs/cobranca-manual/spec.md`): sem módulo de pagamento, o
  proprietário registra em `/admin/tenants/:id` quem pagou e quem não pagou
  (`POST /api/admin/subscriptions/:id/manual-payment` e `.../manual-unpaid`). Preço manual em
  `plan_price` (`provider = manual`), fatura manual em `invoice`, vencimento no job
  `billing.period_end` e carência no `billing.dunning`, com auditoria.
- **Limite de organizações por dono** no plano (`limits.organizations`), editável em
  `/admin/planos/:id` e conferido em `POST /api/tenant` (403 `PLAN_LIMIT_REACHED`). Trial, vencida e
  sem assinatura valem 1.
- **`EMAIL_VERIFICATION_REQUIRED`**: liga a verificação de e-mail. O padrão é desligada: o cadastro
  entra direto.
- Seed com preços manuais, limite de organizações e três tenants na cobrança manual (em dia, em
  atraso e vencido).
- **Telefone obrigatório em todo cadastro de pessoa** (`docs/specs/crm-cadastro/spec.md`, fase A1):
  conta de equipe e do portal, perfil, `/admin` e cliente. Validação no Brasil (DDD, 9º dígito, fixo e
  celular antigo com aviso) e em E.164 para outros países, campo `PhoneField` com máscara e seletor de
  país, colunas `phone_normalized` e `phone_key` com `CHECK` no banco e telefone **único por tenant**
  no cliente (409 `PHONE_IN_USE`). O e-mail do cliente passa a ser opcional (sem e-mail, sem convite
  nem conta acessível).
- **Etiquetas do cliente** (`docs/specs/crm-cadastro/spec.md`, fase A2): catálogo por tenant com
  cor (`#rrggbb`), nome único sem diferenciar maiúsculas, até 100 por organização e 20 por cliente.
  Tela em `/app/configuracoes/etiquetas`, seletor no cliente, filtro e chips em `/app/clientes`,
  permissão `tag:manage` (owner e admin; colaborador aplica). A coluna de texto `customer.tags`
  sai, sem migração de dados (projeto novo).
- **Campos adicionais do cliente** (`docs/specs/crm-cadastro/spec.md`, fase A3): definições por tenant
  (`custom_field`) com seis tipos (texto, número, data, sim ou não, lista e lista múltipla), `key`
  estável, ordem, obrigatório e arquivar; valores em `customer.custom_fields` (jsonb por id do campo,
  mesclado por chave no `PATCH`). Até 12 campos ativos e 50 opções; excluir pede a `key` e limpa o
  valor dos clientes. Tela em `/app/configuracoes/campos`, seção no formulário e no detalhe do cliente,
  permissão `custom_field:manage` (owner e admin; colaborador preenche), exportação e anonimização LGPD.
  O portal não vê campos adicionais. Migrations `0027` e `0028`.

### Alterado

- O cadastro nunca abre sessão (`autoSignIn: false`) e devolve `{ ok: true, verifyEmail }`.
- `GET /api/me/invitations` só lista convites com o e-mail verificado.
- Do gratuito para um plano pago, a troca de plano no `/admin` vence a cobrança na hora; trocar de
  plano anula as faturas manuais em aberto.
- O teto fixo de 3 organizações por usuário (`MAX_TENANTS_PER_USER`) sai: vale o do plano.

- **Node 24.19 ou superior** em `engines`, `Dockerfile` e CI, piso do `react-router-hono-server` 4.
- `.nvmrc` com a versão do Node (lida pelo CI via `node-version-file`) e `engine-strict=true` no
  `.npmrc`: `npm install` em Node antigo falha com `EBADENGINE` em vez de quebrar no dev server.
- **React Router 8**, `react-router-hono-server` 4, `@hono/node-server` 2, Vite 8 (Rolldown), React 19.3,
  TypeScript 7, postgres.js 4, dotenv 18 e `@hookform/resolvers` 7. `@types/node` fica no major do
  runtime (24), e o Dependabot deixa de propor majors dele.

### Removido

- `@vitejs/plugin-react`, que nada importava: o plugin do React Router já cuida do Fast Refresh.

### Segurança

- `npm audit` cai de 9 para 4 alertas moderados. Saem os de `serveStatic` e da cadeia do
  `react-router-hono-server`. Sobram os de `drizzle-kit`, sem efeito em produção
  (`docs/context/tech/16-bugs-riscos.md`, RISK-004).

### Migração

Cobrança manual e verificação opcional:

1. `npm run db:migrate` aplica `0020_cobranca_manual` (só colunas novas e nulas em `invoice`).
2. **A verificação de e-mail passa a ser desligada por padrão.** Para manter o comportamento antigo,
   ponha `EMAIL_VERIFICATION_REQUIRED=true` no `.env.local` e no `docker/.env.prod`.
3. Planos sem `limits.organizations` valem 1 organização por dono, como trial e vencida. Defina o
   valor em `/admin/planos/:id` (o seed preenche os planos dele).
4. Cadastre um preço `Manual` nos planos pagos para registrar pagamentos sem provedor.

Telefone obrigatório (migration `0024_telefone_email_opcional`):

1. A migration **aborta** se houver conta ou cliente já cadastrado (não há backfill de telefone). Em
   projeto novo, nada a fazer; em base de desenvolvimento, recrie o banco e rode `db:migrate` e
   `db:seed`. Em base com dados, preencha o telefone antes (decisão do projeto derivado).
2. `POST /api/auth/sign-up/email`, `/api/portal/auth-ext/sign-up` e `POST /api/customers` passam a
   exigir `phone`; o seed já traz telefone em todas as contas e clientes.
3. `customer.tags` (texto) foi removido (`0025_etiquetas`); `POST` e `PATCH /api/customers` trocam
   `tags: string[]` por `tagIds: uuid[]`.

Node e dependências (sem migration nem variável nova). Para projetos derivados:

1. **Node:** instale o Node 24.19+ antes de tudo, na máquina, no CI e em imagens próprias. Apague
   `node_modules` e rode `npm ci`.
2. **Load context:** `getLoadContext` passa a devolver um `RouterContextProvider`. Troque
   `declare module "react-router" { interface AppLoadContext }` por `createContext` do `react-router`
   e `context.chave` por `context.get(meuContexto)`. Veja `src/lib/csp-nonce.ts`.
3. **`meta`:** troque `({ data })` por `({ loaderData })`, também nos itens de `matches`.
4. **tsconfig:** remova `baseUrl`, que o TypeScript 7 recusa. `paths` continua igual. Código que
   usa a API do compilador (`import ts from "typescript"`) não funciona no pacote 7.
5. **SQL cru com postgres.js:** o servidor agora decide o tipo dos parâmetros. Um `Date` sem cast
   pode virar erro (`${data}::timestamptz` resolve) e o `PGSSLMODE` do ambiente passa a valer. Se
   você criou colunas `timestamp` sem fuso e escreve fora do Drizzle, leia o guia de atualização
   do postgres.js. `sql.array()` não existe mais.
6. **`overrides`:** mantenha o bloco do `package.json`; sem ele, voltam os alertas corrigidos.

## [0.1.0] - 2026-11-07

Primeira versão pública. O antigo Bizu Starter virou o **Bizu SaaS**, seguindo a spec
`docs/specs/saas-foundation/` (fases 0 a 11; a fase 7, módulo Asaas, ficou para depois).

### Adicionado

- **Plataforma:** React Router v7 (Framework Mode, SSR) e Hono em processo único, Drizzle sobre
  Postgres com dois papéis (`bizu_owner` para migrations, `bizu_app` no runtime, sem `BYPASSRLS`),
  variáveis validadas com Zod em `src/lib/env.ts`, logs JSON com `request_id` (pino).
- **Quatro níveis de acesso:** proprietário da plataforma (`/admin`), owner e colaboradores do
  tenant (`/app`) e clientes/leads (`/portal`), com Better Auth em duas instâncias (`auth` e
  `portalAuth`), verificação de e-mail de uso único, recuperação de senha, troca de e-mail e magic
  link no portal.
- **Multi-tenant e RBAC:** organizações com onboarding, equipe, convites, papéis personalizados,
  `requireTenant`, `requirePermission`, Row Level Security forçado com `withTenant` e `audit_log`.
- **Planos e trial:** planos, preços, trial configurável (inclusive gratuito), limites e features por
  plano, estados `read_only` e `locked`, job `billing.trial`, `/precos` público.
- **Cobrança em módulos:** `PaymentProvider` com registro por `PAYMENT_PROVIDERS` (vazio por
  padrão: só planos gratuitos e trial), máquina de estados, checkout, faturas, caixa de entrada de
  webhooks, dunning e reconciliação, e o módulo Stripe.
- **Portal do cliente:** `/app/clientes` com limite do plano, acesso por magic link ou senha, escolha
  de tenant para quem é cliente de mais de um.
- **Segurança:** 2FA (obrigatório para a conta de plataforma em produção), personificação com
  consentimento e auditoria dupla, CSRF, CSP com nonce (começa em report-only), rate limit em
  Postgres, credenciais de provedores cifradas (AES-256-GCM) com rotação de chave.
- **LGPD e arquivos:** registro de consentimento com re-aceite por versão, `/legal/termos` e
  `/legal/privacidade`, exportação dos dados em zip, exclusão de conta, de cliente e de organização
  com 30 dias de carência e anonimização, retenção (`maintenance.prune`), módulo de arquivos
  (`StorageProvider` `local` e `s3`).
- **E-mail e jobs:** fila `email.send` com retry e supressão, provedores `smtp`, `resend` e `memory`,
  14 templates, pg-boss no schema `pgboss` (`JOBS_MODE=inline|worker|off`), `/api/health` e
  `/api/ready`, Sentry opcional.
- **Operação:** `docker/compose.prod.yml` (app, worker, migrate, Postgres, Caddy com TLS e backup
  cifrado com `age`), `docker/.env.prod.example`, `npm run db:seed`, `npm run check:module-removal`.
- **Repositório público:** README em formato de tutorial, `CONTRIBUTING.md`, `SECURITY.md`,
  Dependabot, modelos de issue e de PR, `CODEOWNERS`, guia de atualização do template.

### Alterado

- `/dashboard` passou a `/app`. O projeto agora se chama `bizu-saas` (`package.json`) e os textos
  "Bizu Starter" foram trocados por "Bizu SaaS".
- `docker/postgres/init.sql` aceita as senhas dos papéis por variáveis do `psql` (padrão de
  desenvolvimento intacto) e cria o `bizu_backup` quando recebe `bizu_backup_password`.
- O estágio `build` do `Dockerfile` passou a levar `drizzle/` (antes excluído pelo
  `.dockerignore`), para o serviço `migrate` do compose de produção.

### Segurança

- Em produção, a subida é recusada com `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` ou
  `AUDIT_SALT` iguais aos exemplos, com `RATE_LIMIT_STORE=memory` ou com `EMAIL_PROVIDER=memory`.
- Nenhum token (verificação, reset, convite, magic link) é consumido em GET, e as respostas de
  cadastro, reenvio e reset não revelam se um e-mail existe.

### Migração

Esta é a primeira versão com migrations numeradas do SaaS. Para quem vinha do Bizu Starter ou de um
fork anterior:

1. **Banco:** crie os papéis com `docker/postgres/init.sql` (como superusuário) e rode
   `npm run db:migrate`, que aplica o journal inteiro (`0000` a `0018`), e depois
   `npm run jobs:install`. As migrations não criam papéis.
2. **Volume antigo do Starter:** o banco antigo se chamava `portal`. Em desenvolvimento, apague o
   volume (`docker compose down -v`); em produção, migre os dados à mão: o schema mudou por completo.
3. **Variáveis novas:** compare seu `.env` com `.env.example`. Passam a ser obrigatórias
   `DIRECT_URL`, `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` (32 bytes em base64) e
   `AUDIT_SALT`. Em produção também `RATE_LIMIT_STORE=postgres` e `TRUSTED_PROXY_HOPS=1` atrás de
   um proxy. Um `.env.local` antigo com `CREDENTIALS_ENCRYPTION_KEY` que não seja base64 de 32 bytes
   derruba a subida.
4. **Rotas:** `/dashboard` virou `/app`; ajuste links e favoritos.
5. **Antes de ir ao ar:** preencha o controlador em `src/lib/legal/termos.md` e `privacidade.md`,
   informe o e-mail do encarregado em `/admin/configuracoes`, ative o 2FA da conta do proprietário
   e passe `CSP_REPORT_ONLY` para `false` depois de validar.
6. **Compose:** em produção, use `docker/compose.prod.yml`; as migrations rodam no serviço `migrate`,
   nunca no start do app.

[Não lançado]: https://github.com/brunopelatieri/bizu-saas/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/brunopelatieri/bizu-saas/releases/tag/v0.1.0
