# Índice de Contexto

Leia só o arquivo da tarefa. Caminhos relativos a `docs/context/`. Os paths do código
estão nas rules e no cabeçalho de cada arquivo.

| Tarefa | Ler |
|---|---|
| Decisão de arquitetura ou regra | `core.md` |
| O que está pronto ou pendente | `status.md` |
| Erro de setup local | `onboarding.md` |
| Criar tabela, rota, tela ou página | `receitas.md` |
| PRD/SPEC, modelo, tokens, novo projeto | `ai-engineering.md`, `docs/specs/README.md` |
| Retenção e limpeza de mensagens (bloco R, fases R1 a R3): `retention_policy`, `message_retention_state`, `message.is_favorite`, `src/lib/inbox/retention-policy.ts` (precedência e piso), `MESSAGE_RETENTION_*`; limpeza e prévia `src/lib/inbox/retention.ts`, job `inbox.retention`, rotas `/api/admin/retention/*` (`src/api/admin-retention.ts`, `src/lib/schemas/retention.ts`); tela no `/admin` (R3b: `src/components/admin/retention-card.tsx`, `retention-scope.tsx`, `src/lib/inbox/retention-format.ts`) | `docs/specs/pre-producao/spec.md` ("Bloco R", "R1: o que foi feito", "R2: o que foi feito" e "R3b: o que foi feito", com o roteiro manual), `tech/30-caixa-de-entrada.md`, `tech/07-banco-drizzle.md`, `tech/22-admin.md` |
| Fase atual da transformação em SaaS | `status.md`, `docs/specs/saas-foundation/spec-plano.md` |
| Programa WhatsApp CRM: fases, decisões transversais e modelo recomendado | `docs/specs/whatsapp-crm/plano.md` e a SPEC da feature tocada |
| Caixa de entrada (atendimento por WhatsApp, fases C1 a C7): `chat_contact`, `conversation`, `message`, ingestão dos avisos (`src/lib/inbox/`), `/api/inbox/*` e `/api/admin/inbox/*`, telas `/app/atendimento` e `/admin/atendimento`, visibilidade por pessoa (`visibility.ts`), fila, envio, tempo real (SSE `/api/inbox/events`, `realtime.ts`, `use-inbox-events.ts`, `REALTIME_DATABASE_URL`), estrela na mensagem (`favorite.ts`, `PUT .../messages/:id/favorite`, R3a) e aviso da conversa esvaziada, permissão `inbox`, jobs `inbox.media` e `inbox.sweep`, `file` com `tenant_id` anulável, anexo de saída, modelo, citação, `GET /api/inbox/media-out/:token`, LGPD das conversas (`privacy.ts`: exclusão, anonimização, exportação) e limites conhecidos de todas as fases. Skill `ctx-inbox` | `tech/30-caixa-de-entrada.md` e `docs/specs/caixa-de-entrada/spec.md` |
| Rota, loader, `meta`, SSR, blog | `tech/05-react-router.md` |
| Endpoint `/api/*`, `requireAuth` | `tech/06-hono-api.md` |
| Schema, migration, query, RLS, escopo de plataforma (`Scope`, `withScope`, `withPlatformData`, `scopedPolicy`) | `tech/07-banco-drizzle.md` |
| Login, sessão, provedor de autenticação, verificação de e-mail opcional; perfil da própria conta (`PATCH /api/me`, foto em `/api/me/avatar` e `/api/avatars/:userId`, `src/lib/profile/avatar.ts`, `AVATAR_MAX_KB`; página "Perfil" `/app/perfil` e `/admin/perfil`, `src/components/profile/`) | `tech/08-auth.md` (foto: `tech/27-lgpd-arquivos.md`) |
| 2FA, sessões, personificação, CSP, CSRF, rate limit, criptografia de credenciais, leitura da auditoria | `tech/26-seguranca.md` |
| LGPD: consentimento, `/legal/*`, exportação, exclusão com carência (inclusive das conversas da caixa de entrada), retenção (`CHANNEL_EVENT_RETENTION_DAYS`), arquivos (`StorageProvider`), logs, Sentry, backup | `tech/27-lgpd-arquivos.md`, `lgpd.md` |
| Canais WhatsApp: `src/lib/channels/`, módulos `whatsapp_cloud` e `whatsapp_qr`, `channel_event`, webhooks de canal, jobs `channel.*`, limites por plano | `tech/29-canais-whatsapp.md` e `docs/specs/whatsapp-canais/spec.md` |
| Tenant, equipe, convite, papéis, permissões, auditoria | `tech/21-tenant-rbac.md` |
| Admin da plataforma: `/admin`, `/api/admin/*`, suspender, banir, planos na tela (excluir e arquivar), editar organização, detalhe e edição de usuários, exclusão (agendada ou imediata) de organização, usuário e pessoa do portal | `tech/22-admin.md` |
| Planos, preços, trial, limites (inclusive organizações por dono), features, estado `read_only`, `checkLimit`, seed | `tech/23-billing-planos.md` |
| Clientes, portal, `portalAuth`, magic link, `/app/clientes`, `/portal/**`, `requirePortalAuth` | `tech/25-portal-clientes.md` |
| Cobrança manual (padrão sem provedor), checkout, assinatura, edição de datas e status pelo admin, webhooks de pagamento, faturas, dunning, reconciliação, módulo de provedor | `tech/24-billing-cobranca.md`, `src/lib/payments/providers/README.md` |
| Telefone obrigatório e máscara (`PhoneField`), `phone_key`, e-mail opcional do cliente, etiquetas e campos adicionais do tenant e da plataforma (A1 a A4), telefone verificado e único (`src/lib/phone/`: `verification.ts`, `uniqueness.ts`, `confirmed.ts`, `requests.ts`), pedido de verificação (`phone_verification`), liberação de organização (`phone_tenant_vouch`), `/api/me/phone-verification`, `/api/phone-verifications`, `/api/admin/phone-verifications`, telas das filas de liberação (`src/components/phone/phone-release-*`, T4) e da troca de telefone (`phone-change-section.tsx`, F2), `PHONE_VERIFICATION_TTL_MINUTES`; envio do link (`delivery.ts`, `dispatch.ts`, `notify.ts`, job `phone.verify`, `PHONE_VERIFICATION_CHANNELS`), reenvio (`…/resend`), modelo de verificação da Cloud (`PUT /api/channels/:id/verification-template`), página `/verificar-telefone`; troca de telefone pelo pedido (`…/phone-change` na equipe, no portal e na ficha, `purpose = change`); bloqueio com telefone pendente (`PHONE_VERIFICATION_REQUIRED`, `PHONE_UNVERIFIED`, `src/lib/phone/gate.ts`, `src/api/phone-gate.ts`, tela "Confirme seu WhatsApp" em `src/components/phone/`) | `tech/28-crm-cadastro.md` e `docs/specs/pre-producao/spec.md` (bloco T) |
| Tokens de design, Tailwind, dark mode | `tech/09-tema-css.md` |
| Landing, header, páginas públicas | `tech/10-site-publico.md` |
| Áreas `/app/**`, `/admin/**`, `/portal/**` | `tech/11-dashboard.md` |
| E-mail transacional, templates, bounces, Mailpit | `tech/19-email.md` |
| Jobs em segundo plano, pg-boss, filas, `JOBS_MODE`, worker | `tech/20-jobs.md` |
| Componentes base | `tech/12-shadcn-ui.md` |
| Docker, VPS, `compose.prod.yml`, Caddy, variáveis de ambiente, backup e restauração | `infra-deploy.md`, `tech/14-deploy.md` |
| Receber atualizações do template em um projeto derivado, CHANGELOG, versão | `atualizar-template.md` |
| Lint, testes, CI | `tech/15-qualidade.md` |
| Bug ou risco conhecido | `tech/16-bugs-riscos.md` |

**Consulta eventual, em `tech/`:** `01-visao-geral.md`, `02-stack.md`,
`03-estrutura-pastas.md`, `04-scripts.md`, `17-roadmap.md`,
`18-conclusao.md`.

**Arquivo morto:** `archive/`, só por pedido explícito.
