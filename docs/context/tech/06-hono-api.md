# Hono API

- **Escopo:** Rotas `/api/*`, validação Zod e montagem no servidor único.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-rotas-api.md`
- **Paths do código:** `src/api/auth.ts`, `src/api/auth-ext.ts`, `src/api/guards.ts`, `src/api/permissions.ts`, `src/api/tenant-errors.ts`, `src/api/me.ts`, `src/api/tenant.ts`, `src/api/team.ts`, `src/api/roles.ts`, `src/api/invitations.ts`, `src/api/verification-guard.ts`, `src/api/rate-limit.ts`, `src/api/request-logger.ts`, `src/api/log.ts`, `src/api/app.ts`, `src/api/ready.ts`, `src/api/webhooks-email.ts`, `src/api/webhooks-payments.ts`, `src/api/billing.ts`, `src/api/admin.ts`, `src/api/customers.ts`, `src/api/portal.ts`, `src/api/portal-auth.ts`, `src/components/contact/contact-form.tsx`, `src/lib/schemas/contact.ts`, `src/server.ts`


## 6. Hono API

Arquivo: `src/api/app.ts`

Rotas atuais:

| Metodo | Rota | Funcao |
|--------|------|--------|
| GET | `/api/health` | Liveness simples |
| GET | `/api/ready` | Prontidão: `{ db, jobs, schema }` (`SELECT 1`, fila `email.send` e migrations do build, timeout 2 s cada); 503 se algum falhar (`src/api/ready.ts`) |
| POST | `/api/webhooks/email/:provider` | Eventos de entrega, bounce e reclamação do provedor de e-mail (`src/api/webhooks-email.ts`): corpo bruto, assinatura conferida antes do JSON (400 se inválida), 404 se `:provider` não for o configurado; hard bounce e reclamação criam `email_suppression` |
| POST | `/api/webhooks/payments/:provider` | Eventos do provedor de pagamento (`src/api/webhooks-payments.ts`): corpo bruto até 1 MB, assinatura antes do JSON, 400 + rastro sem corpo se inválida, 429 após 20 erros por IP no minuto, 404 fora de `PAYMENT_PROVIDERS`. Grava `payment_event` e enfileira `webhook.process`; repetido responde 200 `duplicate` |
| GET, POST | `/api/webhooks/whatsapp/cloud/:key` | Avisos da Meta por canal (`src/api/webhooks-channels.ts`): `GET` confere `hub.verify_token` (403 se errado); `POST` confere `X-Hub-Signature-256` com o segredo do aplicativo daquele canal, corpo cru até 3 MB, 401 sem assinatura válida; grava `channel_event` e enfileira `channel.inbound` |
| * | `/api/billing/*` | Assinatura do owner, liberada em `read_only` (`tech/24-billing-cobranca.md`) |
| GET | `/api/me` | Rota privada: `{ user, tenants, permissions, billing, features, limits }`; `billing` traz estado, plano, fim do trial e fim da carência do tenant ativo |
| GET | `/api/me/invitations` | Convites abertos para o e-mail da sessão |
| GET, POST, DELETE | `/api/me/sessions`, `/:id`, `/revoke-others` | Sessões da própria pessoa, com auditoria e sem token (`tech/26-seguranca.md`) |
| GET, POST, PATCH | `/api/tenant`, `/api/tenant/active` | Criar (aplica plano padrão e trial), ler, editar e trocar o tenant ativo |
| PATCH | `/api/tenant/security` | `require2fa`: só owner, que já precisa ter 2FA |
| GET, POST, DELETE | `/api/tenant/support-grant`, `/:id` | Consentimento para o suporte, com `support:grant` |
| GET | `/api/audit` | Log do tenant ativo, com `audit:read` |
| POST | `/api/admin/impersonate`, `/api/admin/stop-impersonating` | Personificação com consentimento, fora de `adminRoutes` (`src/api/impersonation.ts`) |
| POST | `/api/csp-report` | Relatório de CSP: 16 KB, sempre 204, sem URL completa no log |
| GET, POST, PUT, PATCH | `/api/admin/*` | Plataforma: visão geral, tenants (suspender, trocar plano), planos e preços, configurações, usuários (banir; `?scope=portal` lista clientes e `POST /api/admin/portal-users/:id/revoke-sessions` derruba as sessões deles). Só `requirePlatform`; escrita só `platform_owner` (`tech/22-admin.md`) |
| GET, POST, PATCH, DELETE | `/api/customers`, `/:id` | Clientes do tenant, com `customer:*`; `POST` passa por `assertWithinLimit(tenantId, "customers")`; fora do tenant responde 404; e-mail repetido responde 409 `CUSTOMER_EMAIL_TAKEN` |
| POST | `/api/customers/:id/invite` | `customer:invite`: cria `portal_user`, promove a `active`, grava `invited_at` e envia `portal-invite`; 409 `CUSTOMER_BLOCKED` |
| GET, POST, PATCH | `/api/portal/*` | API do cliente, com `requirePortalAuth` e `requirePortalTenant` (`tech/25-portal-clientes.md`) |
| GET, POST | `/api/portal/auth/*`, `/api/portal/auth-ext/*` | Better Auth do portal, por lista fechada, e rotas com resposta uniforme |
| GET, POST, PATCH, DELETE | `/api/team/*` | Equipe e convites |
| GET, POST, PATCH, DELETE | `/api/roles/*` | Papéis personalizados |
| GET, POST | `/api/invitations/:id`, `/:id/accept` | Lado de quem recebe o convite |
| POST | `/api/contact` | Persiste mensagem em `contact_messages` |
| POST | `/api/auth/sign-up/email` | Cadastro, com `signupSchema` e corpo uniforme |
| POST | `/api/auth/verify-email` | Consome o link, atras do `verificationGuard` |
| POST | `/api/auth-ext/resend-verification` | Reenvio, sempre `{ ok: true }` |
| POST | `/api/auth-ext/forgot-password` | Pedido de reset, sempre `{ ok: true }` |
| GET, POST | `/api/auth/*` | Demais rotas do Better Auth; `/api/auth/organization/*` responde 404 |

Ordem dos middlewares: `securityHeaders` (cabeçalhos e CSP com nonce) → `csrfGuard` → `rateLimit` →
`requireAuth` → `requireTenant` ou `requirePlatform` → `requirePermission` →
`blockWhileImpersonating` → `zValidator` → handler. Webhooks e `/api/csp-report` ficam antes do
`csrfGuard`. Detalhes em `tech/26-seguranca.md`.

Autenticacao:

- `requireAuth` (`src/api/auth.ts`) le o cookie de sessao do Better Auth, consulta a
  sessao no banco e coloca `user`, `session` e `activeOrganizationId` no contexto.
- Sem cookie ou com sessao invalida: 401. E-mail nao verificado: 403
  `EMAIL_NOT_VERIFIED`. Auth indisponivel: 503.
- `requirePlatform()` vem depois de `requireAuth` e recusa com 403 `PLATFORM_FORBIDDEN` quem nao e da plataforma; `requirePlatform(["platform_owner"])` restringe as escritas de `/api/admin/*`. Em producao, sem 2FA responde 403 `PLATFORM_2FA_REQUIRED`.
- Rota de tenant: `requireAuth` + `requireTenant` + `requirePermission(recurso, acao)`
  (`src/api/permissions.ts`). Regras e tabela de rotas em `tech/21-tenant-rbac.md`.
- Essas rotas nao importam `@/db`: o Biome recusa (`biome.json`), e os dados passam por
  `src/lib/tenant/`. Erros saem por `handleTenantError`.
- Limite do plano recusado: 403 `PLAN_LIMIT_REACHED` (`assertWithinLimit`, `tech/23-billing-planos.md`). `requireTenant` responde 403 `TENANT_SUSPENDED` (suspenso ou `locked`), 403 `TENANT_READ_ONLY` (mutação com `read_only`, exceto `/api/billing/*`) e 403 `TENANT_2FA_REQUIRED` (`settings.require_2fa`, membro sem 2FA).
- `rateLimit({ name, limit, windowMs })`: `name` é único por limite; sem o store, responde 503.
- Id de rota usa `validId`: malformado responde 404 sem chegar ao banco.
- Toda rota privada usa `authRateLimit` (60 por minuto) antes de `requireAuth`, porque
  cada sessao validada consulta o banco. O `ProtectedRoute` nao protege dados.
- No cliente, use `apiFetch` (`src/lib/api/client.ts`): envia cookies, padroniza erros em
  `ApiError` (com `code`) e, com 401 em `/app` ou `/admin`, encerra a sessao e vai ao login.
- Detalhes do fluxo: `docs/context/tech/08-auth.md`.

Protecoes:

- `secureHeaders` em todas as rotas, inclusive paginas SSR. Ainda nao ha CSP, e o HSTS
  fica com o reverse proxy, que conhece o dominio e seus subdominios.
- `/api/contact`: `rateLimit` (5 por 10 minutos, por cliente) e `bodyLimit` (16 KB).
- O rate limit usa o IP da conexao. Atras de proxies, defina `TRUSTED_PROXY_HOPS`
  com a quantidade deles; sem isso, todos os clientes dividem o IP do proxy.
- O limite fica em memoria: com varias instancias, use um store compartilhado.
- `rateLimit({ key })` conta por outra chave; `/api/auth-ext/resend-verification` usa o
  hash do e-mail.
- `/api/auth/*`, `/api/auth-ext/*` e as rotas de tenant usam `jsonBodyLimit` (16 KB) e
  `sameOrigin` (`src/api/guards.ts`).
- `src/server.ts` liga `overrideGlobalObjects`: sem `Content-Length`, como em todo DELETE do
  navegador, o `bodyLimit` remonta a `Request` e responderia 500. O `npm run dev` não passa por
  essa opção; por isso `jsonBodyLimit` pula a requisição sem `Content-Length` nem
  `Transfer-Encoding` (sem corpo no HTTP/1.1). Teste rota nova com corpo
  ou DELETE em `tests/db/tenant-http.test.ts`; `api.request()` nao passa por esse caminho.
- O log de requisicoes e `requestLogger` (`src/api/request-logger.ts`), que mascara
  `?token=`. O logger padrao do `react-router-hono-server` fica desligado.
- Respostas 5xx nao consomem tentativa; erros de validacao, sim.
- `logError` (`src/api/log.ts`) remove os parametros de query e credenciais de URL, e
  mantem o diagnostico dos demais erros. O cliente recebe mensagem generica.

Validacao:

- `src/lib/schemas/contact.ts` define `contactMessageSchema` com Zod.
- `src/api/app.ts` usa `@hono/zod-validator` em `/api/contact`.
- `src/components/contact/contact-form.tsx` reutiliza o mesmo schema antes do
  `fetch`, mantendo contrato consistente entre cliente e API.

O Hono e montado por `src/server.ts`:

```ts
export default await createHonoServer({
  configure(server) {
    server.route("/", api);
  },
});
```

Como tudo roda na mesma origem, o CORS antigo foi removido. Se o projeto expor a
API para outra origem no futuro (mobile app, CLI, integracoes externas), o CORS
deve voltar em escopo controlado.

---

## Canais WhatsApp

`src/api/channels.ts` escreve as rotas de canal uma vez (`buildChannelRoutes`) e as monta para os
dois escopos: `/api/channels/*` (`channel:read` e `channel:manage`, `Scope` de `requireTenant`) e
`/api/admin/channels/*` (`src/api/admin-channels.ts`: `Scope = platform`, leitura com
`requirePlatform()`, escrita com `requirePlatform(["platform_owner"])`, montado antes de
`adminRoutes`). O serviço (`src/lib/channels/service.ts`) abre `withScope`. As rotas de cada tipo
(`POST <base>/whatsapp-cloud`, `/whatsapp-qr`, `/:id/webhook`, `/:id/qr`, `/:id/templates`...) são
declaradas pelo módulo (`ChannelModule.routes`) e recebem base, escopo, ator e autorização pelo
`ChannelRouteKit`. O `name` de cada rate limit leva o prefixo da base (`admin-` na plataforma).

`src/api/webhooks-channels.ts` (`GET` e `POST /api/webhooks/whatsapp/<segmento>/:key`) fica antes do
`csrfGuard`, fora de `sameOrigin`, como os de pagamento: acha o canal pela chave, verifica sobre o
corpo cru (401; chave desconhecida responde igual; 429 após 20 falhas por IP no minuto; 413 acima
do teto do módulo), grava `channel_event` e enfileira `channel.inbound`. Ver
`tech/29-canais-whatsapp.md`.

- **QR Code (B3):** `POST /api/channels/whatsapp-qr`, `POST /:id/qr`, `/:id/pair`, `GET /:id/status`,
  `POST /:id/disconnect`, `/logout`, `/reconnect` e `PATCH /:id/advanced-settings`. Limite de taxa
  **por usuário** (`key` = id do usuário): criar 10, QR e código 15, estado 30, demais 30 por minuto.
  QR e código saem com `Cache-Control: no-store`. A regra de negócio está em
  `src/lib/channels/pairing.ts`; a rota só monta escopo, ator e validação.
- **Webhook da Evolution:** `src/api/webhooks-channels-evolution.ts` exporta `evolutionWebhooks`
  (`POST /api/webhooks/whatsapp/evolution/:secret`), montado em `app.ts` junto dos outros webhooks,
  antes do `csrfGuard`. `bodyLimit` de 25 MB, 401 sem detalhe, `failureLimit` de 20 por IP por minuto.
  O webhook da Cloud (B2) fica em `webhooks-channels.ts`.

## LGPD, arquivos e logs (fase 10)

- `src/api/lgpd.ts` (`lgpdRoutes`, `portalLgpdRoutes`): exportação (`/api/me/export`, `/api/portal/me/export`), exclusão (`DELETE /api/me`, `DELETE /api/portal/me`) e cancelamento. `DELETE /api/tenant` e `POST /api/tenant/deletion/cancel` ficam em `src/api/tenant.ts`; `GET/POST /api/me/consent*` em `src/api/me.ts`.
- `src/api/files.ts`: `POST /api/files` (multipart, `bodyLimit` de `MAX_UPLOAD_MB`), `GET` e `DELETE /api/files/:id`, com `requirePermission("file", ...)`.
- Rotas de exclusão: `sameOrigin` → `jsonBodyLimit` → `authRateLimit` → `requireAuth` → `blockWhileImpersonating` → `rateLimit` por usuário → `zValidator`. O DELETE leva corpo JSON (`password`, `totp`).
- `requestLogger` gera o `x-request-id` e loga só o caminho; `logError` usa o pino com redact. Ver `tech/27-lgpd-arquivos.md`.
