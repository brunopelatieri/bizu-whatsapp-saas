# Status do projeto

- **Escopo:** O que está pronto hoje, por fase da spec, e pendências técnicas conhecidas.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-plano.md` (fases)
- **Paths do código:** `src/lib/content/posts.ts`, `src/root.tsx`, `src/lib/env.ts`, `src/lib/auth/`, `src/lib/billing/`, `src/lib/payments/`

## Fases da spec saas-foundation

| Fase | Entrega | Estado |
|---|---|---|
| 0 | Reposicionamento: textos, docs, rules, `/dashboard` → `/app`, stubs removidos | concluída |
| 1 | Infra local: papéis do Postgres, Mailpit, `.env.example`, `env.ts`, CI com Postgres, `test:db`, seams de e-mail | concluída |
| 2 | Auth núcleo: Better Auth, cadastro, verificação de uso único, reset, troca de e-mail, `requireAuth` por sessão, papéis de plataforma | concluída |
| 3 | E-mail transacional completo (fila, Resend, supressão, templates) e jobs (pg-boss) | concluída |
| 4 | Tenant, equipe, RBAC, RLS e `audit_log` | concluída |
| 5 | Admin e planos: `/admin`, planos, trial, limites, `read_only`, job `billing.trial`, `/precos`, seed | concluída |
| 6 | Billing núcleo + Stripe | concluída; falta o checklist em sandbox real do Stripe |
| 7 | Módulo Asaas | adiada: os provedores de pagamento seguem desligados (`PAYMENT_PROVIDERS` vazio) por decisão do usuário, e a fase 8 não depende dela |
| 8 | Portal do cliente | concluída |
| 9 | 2FA, personificação e segurança | concluída; `CSP_REPORT_ONLY` segue em `true` até validar em produção |
| 10 | LGPD, arquivos e observabilidade | concluída; falta preencher controlador e encarregado nos textos legais (`docs/context/lgpd.md`) |
| 11 | Repositório público e README final | concluída; falta o teste de onboarding com pessoa externa (checklist em `CONTRIBUTING.md`) |

## Programas em planejamento

- **WhatsApp CRM** (`docs/specs/whatsapp-crm/plano.md`): PRDs e SPECs aprovados em 2026-11-09
  para `crm-cadastro` (etiquetas, campos adicionais, telefone), `whatsapp-canais` (Cloud API e
  Evolution Go) e `caixa-de-entrada` (chat e fila); decisões do proprietário no fim do plano.
  **F0 (escopo de plataforma) implementada:** `scopedPolicy()`, `platformOnlyPolicy()`,
  `withPlatformData`, `withScope` e `Scope`, com teste dos três modos (`tech/07-banco-drizzle.md`).
  **`whatsapp-canais` em andamento (2026-11):** módulos puros de `src/lib/channels/` (tipos,
  capacidades, registro, Cloud e Evolution, normalizadores, webhook, schemas), permissão
  `channel:read/manage`, variáveis `CHANNEL_PROVIDERS`/`EVOLUTION_*`, limites de plano e a **B1**
  (tabelas com RLS, serviço, caixa de avisos, filas `channel.inbound`/`channel.health`, rotas comuns
  `/api/channels`; `tech/29-canais-whatsapp.md`); as fixtures de `tests/fixtures/channels/` são
  **simuladas** (a medição B0 real falta); B2 (rotas e webhook da Cloud) é a próxima etapa.
  **B4 parcial:** avisos de canal de todos os escopos em `/api/admin/channel-events` (listar sem
  `raw`, reprocessar só pelo proprietário) e aba "Canais" em `/admin/webhooks`; faltam
  `/api/admin/channels/*` e `/admin/configuracoes/canais`.
  **Fases A1, A2 e A3 do `crm-cadastro` implementadas** (telefone obrigatório, e-mail opcional do
  cliente, etiquetas e campos adicionais do tenant; `tech/28-crm-cadastro.md`); A4 segue pendente. Telefone obrigatório em todos os cadastros, também no banco (celular ou fixo com DDD
  válido, fixo com aviso de que não recebe WhatsApp; celular antigo de 8 dígitos aceito se
  validado; regra do Brasil só para DDI 55; máscara; único por tenant no cliente) e e-mail
  obrigatório para conta acessível. Projeto novo: sem cadastro anterior, sem backfill nem
  migração de dados. Dúvidas resolvidas seguindo o `zap-crm-br-client` (teto de 20 instâncias,
  mídia em S3 privado com URL pré-assinada). O S3 de produção é o SeaweedFS externo. Nenhuma
  pergunta em aberto.

## Estado atual do código

- React Router Framework Mode com `ssr: true`; Hono integrado via `react-router-hono-server`.
- Site público com SSR: landing reposicionada para SaaS, blog estático em
  `src/lib/content/posts.ts`.
- Autenticação de equipe e plataforma com Better Auth: `/login`, `/cadastro`,
  `/verificar-email`, `/esqueci-senha`, `/redefinir-senha` e troca de e-mail em
  `/app/configuracoes`.
- Multi-tenant com o plugin `organization`: onboarding, seletor de tenant, equipe, convite
  por e-mail em `/convite/:id`, papéis personalizados, `requireTenant`, `requirePermission`,
  `<Can>` e `audit_log` (`tech/21-tenant-rbac.md`).
- RLS forçado com `withTenant` e `withPlatformScope` (`tech/07-banco-drizzle.md`).
- `/app/**` com shell client-side: visão geral, clientes, equipe, assinatura e configurações.
  Banner de trial, pagamento pendente e somente leitura.
- Portal do cliente (`tech/25-portal-clientes.md`): instância `portalAuth` com cookies, tabelas
  e segredo próprios, magic link de uso único, senha opcional, autocadastro por tenant, `/portal/**`
  e `/app/clientes` com limite do plano.
- `/admin/**` (proprietário e suporte da plataforma): visão geral, organizações, usuários, planos,
  assinaturas, webhooks e configurações, com `requirePlatform` na API (`tech/22-admin.md`).
- Edição e exclusão no `/admin` (`docs/specs/admin-crud/`): editar nome e slug da organização;
  detalhe, edição e exclusão de usuários de equipe, suporte e portal; exclusão de organização,
  usuário e pessoa do portal agendada (30 dias, reversível) ou imediata; excluir plano e preço sem
  uso e arquivar em botão; editar datas e status da assinatura (manual e, com
  `updateSubscriptionSchedule`, no provedor); nome da organização em todas as listagens.
- Planos, preços, trial no onboarding, limites por plano (assentos), estado `read_only`/`locked` e job
  `billing.trial` (`tech/23-billing-planos.md`). `/precos` público com loader.
- Cobrança manual como padrão (`docs/specs/cobranca-manual/`): sem provedor, o proprietário marca em
  `/admin/tenants/:id` quem pagou e quem não pagou; vencimento, carência, `past_due`/`unpaid` +
  `read_only` e auditoria funcionam com `PAYMENT_PROVIDERS` vazio. Limite de organizações por dono
  no plano (`limits.organizations`). Verificação de e-mail opcional (`EMAIL_VERIFICATION_REQUIRED`,
  padrão desligada).
- Cobrança (`tech/24-billing-cobranca.md`): máquina de estados pura, `PaymentProvider` com registro por
  `PAYMENT_PROVIDERS`, módulo Stripe, checkout, `/api/billing/*`, faturas, caixa de entrada de
  webhooks, jobs `webhook.process`, `billing.dunning`, `billing.period_end` e `billing.reconcile`.
- `npm run db:seed`: proprietário, suporte, planos (com preço manual e limite de organizações), os
  tenants `acme` e `beta`, três tenants na cobrança manual (em dia, em atraso e vencido) e os
  clientes `julia@cliente.local` (ativa nos dois) e `lead@cliente.local`.
- `/api/health`, `/api/me`, `/api/tenant`, `/api/team`, `/api/roles`, `/api/invitations`,
  `/api/customers`, `/api/portal/*`, `/api/auth/*`, `/api/auth-ext/*` e `/api/contact` com rate
  limit, limite de corpo e headers de segurança.
- Variáveis de ambiente validadas em `src/lib/env.ts` na inicialização.
- Postgres do Docker com `bizu_owner` e `bizu_app` (`docker/postgres/init.sql`) e Mailpit.
- E-mail: `sendEmail` grava `email_message` e enfileira `email.send` (pg-boss, retry 5x,
  dead letter, supressão); provedores `smtp`, `resend` e `memory`; webhook
  `POST /api/webhooks/email/:provider`; 14 templates gerais; `npm run email:preview`
  (`tech/19-email.md`, `tech/20-jobs.md`).
- Jobs: pg-boss 12 no schema `pgboss` (`npm run jobs:install`), `JOBS_MODE=inline|worker|off`,
  `maintenance.prune` (retenção completa), `lgpd.export`, `lgpd.delete`, `GET /api/ready`.
- LGPD (`tech/27-lgpd-arquivos.md`, `lgpd.md`): `consent_log` gravado no cadastro das duas instâncias,
  re-aceite por versão (`consentRequired`), `/legal/termos` e `/legal/privacidade`, exportação em zip
  com link assinado, exclusão de conta, de cliente do portal e de organização com 30 dias de carência
  e anonimização pelo job, `/app/configuracoes/privacidade` e seção em `/portal/conta`.
- Módulo de arquivos (`src/lib/storage/`): `StorageProvider` `local` e `s3`, tabela `file`, `/api/files`,
  `storage_mb` contado. Sem tela de upload.
- Observabilidade: logs JSON com `request_id` e redação (pino), Sentry opcional, jobs mortos no `/admin`;
  backup cifrado com `age` no perfil `backup` do compose.
- Biome, Vitest (`npm test` sem banco, `npm run test:db` com banco) e CI com Postgres, mais o job `module-removal`.
- Dockerfile multi-stage para VPS e `docker/compose.prod.yml` (app, worker, migrate, postgres, caddy, backup), com `docker/.env.prod.example`.
- Repositório público: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` (0.1.0), Dependabot, modelos de issue e de PR, `CODEOWNERS`, README em formato de tutorial e `docs/context/atualizar-template.md`.

## Pendências Técnicas Conhecidas

- Fase 7 da spec (adiada).
- **`npm run test:db` com `npm run dev` no ar:** além de `billing-queue.test.ts`, `email-queue.test.ts`
  falha porque o dev (`JOBS_MODE=inline`) consome a fila do banco `bizu`. Rode com o dev parado.
- **Fase 11:** teste de onboarding com pessoa externa em até 30 minutos (checklist em `CONTRIBUTING.md`); tag `v0.1.0` e GitHub Release (notas do `CHANGELOG.md`); habilitar o relatório privado de vulnerabilidade e o Dependabot no GitHub; certificado real do Caddy e a stack no Portainer, sem teste num domínio real (a stack foi revalidada em `localhost` por HTTP, `tech/14-deploy.md`); `CODEOWNERS` usa o usuário do autor.
- Site público: `siteConfig.url`, `public/sitemap.xml` e `public/robots.txt` usam o placeholder `https://example.com` (estáticos, não leem `APP_URL`): derivados trocam os três.
- **Portal:** `organization.settings.portal_self_signup` liga o autocadastro, mas ainda não tem tela.
  Quem já tem conta no portal não se autocadastra em outro tenant: pede ao owner. O convite sai
  sem `Reply-To` do owner. `portal_rate_limit` e `rate_limit` (tabelas do Better Auth) seguem fora do
  `maintenance.prune`; sessões e verificações das duas instâncias já saem.
- `/api/customers` confere o limite do plano fora da transação do insert: requisições
  simultâneas podem passar um cliente do limite, como já acontece com `members`.
- **Stripe sem sandbox real:** o módulo foi validado com fixtures escritas a partir dos tipos do SDK e
  com webhooks assinados pelo SDK contra o build de produção, mas sem conta de teste. Rode o checklist de
  `src/lib/payments/providers/stripe/README.md` e troque as fixtures por capturas anonimizadas.
- `platform_setting.alert_email` não existe.
- Reembolso sem tela: sai pelo painel do provedor e chega por webhook.
- **LGPD:** os textos de `src/lib/legal/*.md` são modelos (controlador entre colchetes, `dpo_email` vazio): preencher e revisar com um advogado antes de ir ao ar. A exportação não inclui arquivos do módulo `file` nem faturas. O portal não tem o interruptor de marketing que a equipe tem. Backup antigo restaura quem foi excluído (RISK-011).
- `.env.local` antigo precisa de `CREDENTIALS_ENCRYPTION_KEY` em base64 de 32 bytes: o valor de exemplo anterior agora derruba a subida.
- Portal com o plugin `twoFactor` e a tabela, sem tela; rotas fechadas até haver decisão por tenant.
- `rotateCredentials()` é função, sem comando nem job: a spec fala em "rotação por job", e o fluxo (b) ainda não existe.
- Exportação CSV da auditoria segue fora (feature `audit_export`).
- Fontes vêm do Google Fonts: hospedá-las no app tiraria duas origens da CSP e o IP do visitante do caminho até o Google.
- Teto de tenants por usuário (3) e de papéis personalizados (20) seguem constantes do plugin; `members`, `custom_roles` e `customers` usam o limite do plano (`tech/23-billing-planos.md`).
- Overview do admin sem MRR; mostra o contador de jobs mortos, mas não há `/admin/jobs` com a lista e o botão de reexecutar.
- Evoluir blog estático para tabela Drizzle quando virar feature real.
- Sobram 4 alertas moderados do `npm audit`, todos em `drizzle-kit` (`tech/16-bugs-riscos.md`).

## Desvios da spec na fase 11

| Spec | Entregue | Motivo |
|---|---|---|
| `init.sql` com papéis "a partir de variáveis" | Mesmo `init.sql`, com variáveis do `psql` e padrão de desenvolvimento; `init-prod.sh` as passa | Um SQL só para dev, CI e produção, sem duplicar a lista de papéis |
| Papéis `bizu_owner` e `bizu_app` | Mais `bizu_backup` (`BYPASSRLS`, `pg_read_all_data`, `CREATEDB`), criado só com `BIZU_BACKUP_PASSWORD` | O `pg_dump` precisa atravessar o RLS, e o `restore-test.sh` cria um banco |
| Compose usa `.env` | `docker/.env.prod` com `--env-file` e interpolação `${VAR}` (sem `env_file`) | `DATABASE_URL` e `DIRECT_URL` são montadas das senhas; funciona igual no Portainer |
| Projeto do compose | `name: bizu-saas-prod` | Com o nome padrão, `up` da produção trataria os containers e o volume de dev como seus |
| `.dockerignore` | Deixa de excluir `drizzle/` | O serviço `migrate` usa o estágio `build`, que precisa das migrations |
| Perfis `worker` e `backup` inativos | Variáveis do `backup` com `:-`, validadas pelo `backup.sh` | O Compose interpola perfis inativos, e `config` falharia sem elas |
| `README` com demo | "Demo: em breve"; nota da Vercel removida | Nenhuma demo existe para este repositório |
| `dependabot.yml` (npm semanal) | npm e GitHub Actions, semanal, agrupados por menor/patch e major | Actions desatualizadas são a outra fonte comum de alerta |
| Migrations em job separado, sem automação no start | Mantido, e o app recusa subir em produção quando faltam migrations; `/api/ready` ganha `schema`; migration `0019` dá ao `bizu_app` leitura de `drizzle.__drizzle_migrations` | Sem o `migrate`, `/api/health` seguia 200 e o site ia ao ar quebrado. `depends_on` no `migrate` resolveria rodando migration a cada `up`, o que a spec proíbe |
| Job `module-removal` no CI | Entregue depois da fase 11, em matriz (`stripe`, `sentry`, `s3`) | Não estava no escopo da fase 11; o job só roda `npm run check:module-removal -- <id>`, sem banco |

## Desvios da spec na fase 9

Detalhes em `tech/26-seguranca.md`.

| Spec | Entregue | Motivo |
|---|---|---|
| `X-Frame-Options` substituído por `frame-ancestors` | Sai só com `CSP_REPORT_ONLY=false`; em report-only fica `DENY` | Report-only não bloqueia `frame-ancestors`: o padrão ficaria sem proteção contra iframe |
| `hono/csrf` com `origin: APP_URL` | `hono/csrf` mais recusa de toda mutação com `Origin` estranho | `hono/csrf` ignora `application/json`, e o teste pede 403 em POST de outro site |
| `style-src 'self' 'unsafe-inline'`, sem origem externa | Com `fonts.googleapis.com` e `font-src fonts.gstatic.com` | `src/root.tsx` carrega as fontes de lá |
| CSP sem ajuste no Zod | `z.config({ jitless: true })` em `src/lib/zod-config.ts` | Achado do smoke: o Zod testa `new Function` e gera violação de `eval` em toda página com formulário |
| Sessões por `listSessions`/`revokeSession` no cliente | `/api/me/sessions`, com as rotas do plugin fechadas | O plugin entrega os tokens ao navegador, exige sessão recente para listar e não audita |
| Botão "Personificar" em `/admin/usuarios/:id` e `/admin/organizacoes/:id` | Em `/admin/tenants/:id`, por membro | Não há detalhe de usuário, a rota de tenants é `/admin/tenants`, e personificar precisa do tenant |
| Botão só com grant ou política | Sem isso, o mesmo lugar mostra "Pedir acesso" | É por ele que nasce o e-mail `impersonation-requested` |
| `POST /api/admin/impersonate { userId }` | Com `tenantId` e `reason` opcional | O consentimento é do tenant, e o e-mail pede o motivo |
| Bloqueio em mutações de owner em `/api/team/*` | Toda mutação de `/api/team/*` e `/api/roles/*`, e aceite de convite | Convite e papel deixariam acesso para depois da personificação |
| `DELETE /api/tenant` bloqueado | Bloqueio montado; a rota é da fase 10 e responde 404 fora da personificação | A rota nasce protegida |
| `/api/me` com troca de e-mail e senha | Todo `/api/auth/*`, exceto `get-session` e `sign-out` | Lista do que passa: rota nova do plugin nasce fechada |
| `CREDENTIALS_ENCRYPTION_KEY` de exemplo `change-me...` | Base64 válido de um texto `change-me...`, recusado em produção | A validação de 32 bytes reprovaria o exemplo antigo |
| `RATE_LIMIT_STORE`: memória em dev | Produção **recusa** `memory` na subida | Com réplicas, o limite cairia em silêncio |
| `impersonator_id` só nas ações `platform.*` | `AsyncLocalStorage` leva `impersonator_id` a todo `audit()` da requisição | Auditoria dupla sem depender de cada rota |
| Personificação com 1 h do plugin (`impersonationSessionDuration`) | Mais `session.impersonation_expires_at`, conferida a cada requisição | Achado do security-review: apagar o cookie `dont_remember` renovava a sessão por 7 dias, além do grant |
| `tenant_payment_credential` | Com `aad` `tenant:provider`, `created_at` e `updated_at` | Cifra copiada de outra linha falha na leitura |

## Desvios da spec na fase 8

| Spec | Entregue | Motivo |
|---|---|---|
| `secret: BETTER_AUTH_SECRET` nas duas instâncias | `portalAuth` usa um segredo derivado por HMAC | Com o mesmo segredo, JWT de verificação de equipe confirmaria e-mail no portal, e o `session_data` renomeado passaria pelo cache de sessão |
| Botão chama `GET /api/portal/auth/magic-link/verify` | `POST`, que remonta o GET; o GET responde 405 | Regra inegociável: nenhum token consumido em GET. Mesmo desenho do `verify-email` da fase 2 |
| `api.on("/api/portal/auth/*", handler)` | Lista fechada `PORTAL_AUTH_PATHS` | `/sign-in/magic-link` aceitaria `metadata` e `callbackURL` do cliente, e `/sign-up/email` ignoraria o `portal_self_signup` |
| Cliente criado com `portal_user` já existente | `portal_user` nasce no primeiro envio | Sem acesso, a identidade seria dado pessoal sem uso |
| `customer` `lead` ao enviar acesso | Enviar acesso promove a `active` | `status` é o portão e `lead` não entra: o fluxo do owner precisa liberar alguém |
| `callbackURL: /portal?org=` no magic link | `/portal/entrar?token=&org=`, com o tenant escolhido na sessão pelo POST | A página não pode depender do redirect do Better Auth, que é GET |
| Reset de senha no portal | Sem reset: entra-se por magic link e troca-se em `/portal/conta` | A posse do e-mail já é o fator de recuperação |
| `requirePortalTenant` abre `withTenant` | Lê `customer` em `withTenant` e guarda em `c.var`; a rota abre a sua | Como `requireTenant`: não segura uma transação durante a requisição |
| Autocadastro cria `customer` junto com a conta | Cria depois da confirmação do e-mail, se o plano tiver vaga | Cadastro não verificado consumiria o limite do plano |
| `portalAuth` com troca de e-mail | Sem troca de e-mail no portal | `customer.email` é a chave do vínculo em cada tenant, e a troca pede regra própria |
| `/portal/entrar` e `/portal/escolher` | Mais `/portal/cadastro` e `/portal/confirmar` | O autocadastro pede tela e confirmação |
| `GET /api/portal/me` com `status` | Mais `available` e `GET /api/portal/customer` | Tenant suspenso fecha o portal mesmo com cliente `active`, e a tela precisa dos dados do cadastro |
| Login de conta não verificada responde 403 `EMAIL_NOT_VERIFIED`, e a tela de login oferece o reenvio nesse caso | Em `/api/auth` e no portal, responde o mesmo 401 de senha errada; na equipe, o reenvio fica sempre disponível na tela de login | Achado do security-review: cadastro + login revelariam se o e-mail existe (RISK-008) |
| Tenant `beta` no plano `free` no seed | `beta` em trial, por `startTrial` | Mesmo caminho do onboarding; o seed só precisa dele para provar dois tenants |

## Desvios da spec na fase 6

Decisões registradas com o motivo. Detalhes em `tech/24-billing-cobranca.md`.

| Spec | Entregue | Motivo |
|---|---|---|
| `Capabilities`, `PaymentProvider` e `NormalizedEvent` fechados | Campos aditivos, marcados "Além da spec" em `types.ts`: `nativeTrial`, `proration`, `requiresPriceRef`, `resumeSubscription`, `chargeOnce`, `enrichEvent`, `occurredAt`, `metadata`, `priceRef`, período e valor | O contrato da spec não ordena eventos, não resolve a assinatura por metadados e não traz valor em `invoice.created`. No Stripe atual, `Charge` não aponta para a fatura |
| `payment_event` sem RLS | Com RLS forçado | Tem `tenant_id` e `raw` com dado pessoal; `tests/db/rls.test.ts` exige |
| `invoice.provider_ref` unique | Unique `(provider, provider_ref)` | Referências de provedores diferentes podem coincidir |
| Assinatura inválida com `payment_event` | Com a linha, mas `raw` nulo | Não guardar corpo de quem não provou quem é |
| `status = duplicate` na linha | Só na resposta | A unique preserva a linha original |
| Ordem por `subscription_event` | Por `metadata.lastProviderEventAt` | Evento sem mudança de status também conta, e evento de job não pode descartar pagamento real |
| `invoice.paid` e `trialing → past_due` | Acrescentado para trial nativo | Falha na primeira cobrança real |
| Downgrade só em `current_period_end` | Plano local no fim do período, preço no provedor na hora | O job é horário: cobraria a renovação pelo preço antigo |
| Reconciliação gera evento e alerta | Também corrige o estado | Evento perdido deixaria tenant pago bloqueado até alguém agir |
| `GET /api/billing/portal` | `POST` | Abre sessão no provedor; pedido no brief da fase |
| `GET /api/billing/plans` só com `requireTenant` | Com `billing:read` | Pedido no brief da fase |
| Sem rota de pausa | `POST /api/billing/pause` | A spec expõe "pausar" e não tinha rota |
| Pausa sem regra de acesso | `paused` + `read_only`; retomar após o período pago cobra um ciclo novo | Achado do security-review: `pause_collection: void` anula as faturas e o plano seguiria de graça |
| Upgrade imediato | Imediato, mas só com a diferença paga (`error_if_incomplete`) | Achado do security-review: cartão recusado daria o plano maior até o fim da carência |
| Checkout `não personificado` | Sem a checagem | Personificação é da fase 9; desde ela, `blockMutationsWhileImpersonating` |

## Desvios da spec na fase 10

Detalhes em `tech/27-lgpd-arquivos.md`.

| Spec | Entregue | Motivo |
|---|---|---|
| `consent_log` na migration `0017` | `0017_arquivos` (tabela `file`) e `0018_lgpd` (`consent_log`, `deletion_request`, `data_export`) | O módulo de arquivos veio primeiro: a exportação depende do `StorageProvider` |
| `data_export` fora da lista do pedido | Criada (está em `spec-dados.md`) | O job `lgpd.export` precisa guardar o estado e a chave do arquivo |
| `DELETE /api/me` com "fresh session" | Senha (e código 2FA) a cada pedido, com limite de 5 por 15 min por usuário | A sessão do Better Auth não distingue "recente" sem o plugin; a prova de identidade explícita é mais forte |
| Cliente do portal sem senha: "confirmação por magic link" | Link próprio de confirmação (`deletion-confirm`, token de uso único em `portal_verification`, consumido por `POST`) | O magic link do plugin cria sessão, não confirma uma ação; template novo, fora da lista da spec |
| `maintenance.prune` semanal | Segue diário (04:30 UTC) | O cron já existia e a retenção por dias não depende da frequência |
| `/admin/jobs` com lista e "Reexecutar" | Só o contador de jobs mortos no `/admin` | Fora do escopo pedido; o botão fica para depois |
| `StorageProvider.signedUrl?` | Declarado na interface, nenhum provedor implementa | Todo download passa pelo app (sessão, tenant e permissão); URL pré-assinada do S3 exigiria `@aws-sdk/s3-request-presigner` |
| `POST /api/me/export` devolve `{ exportId }` | Mesmo corpo, com status `202` | O trabalho é assíncrono |
| Exclusão de tenant "suspende" | Estado `deleting` + `locked` (e `DELETE /api/tenant` vale em `read_only` e `locked` por cobrança) | Distingue suspensão da plataforma de exclusão pedida pelo owner; titular não pode ficar preso por inadimplência |
| Consentimento "hook ou rota própria" | Hook `user.create.after` com contexto da rota (`withSignupConsent`) | Só grava se o usuário nasce: e-mail existente não ganha aceite de terceiro |
| Sentry com `sendDefaultPii: false` | `dataCollection` zerado | Opção do `@sentry/node` 11 |
| `usage_counter` | Não criada; `storage_mb` soma `file.size` na hora | Fora do escopo: a soma é barata e exata |
| Backup "com `pg_dump`" | Exige usuário que atravesse o RLS (superusuário ou `BYPASSRLS` + `pg_read_all_data`) | `FORCE ROW LEVEL SECURITY` também vale para `bizu_owner`; sem isso o dump sairia vazio ou falharia |

