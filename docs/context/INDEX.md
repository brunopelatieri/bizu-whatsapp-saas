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
| Fase atual da transformação em SaaS | `status.md`, `docs/specs/saas-foundation/spec-plano.md` |
| Programa WhatsApp CRM (planejado, sem código): canais Cloud API e Evolution Go, caixa de entrada com fila, etiquetas e campos adicionais | `docs/specs/whatsapp-crm/plano.md` e a SPEC da feature tocada |
| Rota, loader, `meta`, SSR, blog | `tech/05-react-router.md` |
| Endpoint `/api/*`, `requireAuth` | `tech/06-hono-api.md` |
| Schema, migration, query | `tech/07-banco-drizzle.md` |
| Login, sessão, provedor de autenticação, verificação de e-mail opcional | `tech/08-auth.md` |
| 2FA, sessões, personificação, CSP, CSRF, rate limit, criptografia de credenciais, leitura da auditoria | `tech/26-seguranca.md` |
| LGPD: consentimento, `/legal/*`, exportação, exclusão com carência, retenção, arquivos (`StorageProvider`), logs, Sentry, backup | `tech/27-lgpd-arquivos.md`, `lgpd.md` |
| Tenant, equipe, convite, papéis, permissões, auditoria | `tech/21-tenant-rbac.md` |
| Admin da plataforma: `/admin`, `/api/admin/*`, suspender, banir, planos na tela (excluir e arquivar), editar organização, detalhe e edição de usuários, exclusão (agendada ou imediata) de organização, usuário e pessoa do portal | `tech/22-admin.md` |
| Planos, preços, trial, limites (inclusive organizações por dono), features, estado `read_only`, `checkLimit`, seed | `tech/23-billing-planos.md` |
| Clientes, portal, `portalAuth`, magic link, `/app/clientes`, `/portal/**`, `requirePortalAuth` | `tech/25-portal-clientes.md` |
| Cobrança manual (padrão sem provedor), checkout, assinatura, edição de datas e status pelo admin, webhooks de pagamento, faturas, dunning, reconciliação, módulo de provedor | `tech/24-billing-cobranca.md`, `src/lib/payments/providers/README.md` |
| Telefone obrigatório e máscara (`PhoneField`), `phone_key`, e-mail opcional do cliente, etiquetas e campos adicionais (A2 a A4 pendentes) | `tech/28-crm-cadastro.md` |
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
