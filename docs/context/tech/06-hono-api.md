# Hono API

- **Escopo:** Rotas `/api/*`, validação Zod e montagem no servidor único.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-rotas-api.md`
- **Paths do código:** `src/api/inbox.ts`, `src/api/admin-inbox.ts`, `src/api/admin-retention.ts`, `src/api/inbox-shared.ts`, `src/api/inbox-events.ts`, `src/api/inbox-media-out.ts`, `src/api/auth.ts`, `src/api/auth-ext.ts`, `src/api/guards.ts`, `src/api/permissions.ts`, `src/api/tenant-errors.ts`, `src/api/me.ts`, `src/api/tenant.ts`, `src/api/team.ts`, `src/api/roles.ts`, `src/api/invitations.ts`, `src/api/verification-guard.ts`, `src/api/rate-limit.ts`, `src/api/request-logger.ts`, `src/api/log.ts`, `src/api/app.ts`, `src/api/ready.ts`, `src/api/webhooks-email.ts`, `src/api/webhooks-payments.ts`, `src/api/billing.ts`, `src/api/admin.ts`, `src/api/customers.ts`, `src/api/portal.ts`, `src/api/portal-auth.ts`, `src/components/contact/contact-form.tsx`, `src/lib/schemas/contact.ts`, `src/server.ts`


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
| GET, POST | `/api/me/phone-verification`, `/resend`, `/confirm` | Telefone da própria conta: situação por responsável e `change` (troca aberta), reenvio (`{ responsible?, purpose? }`, 3/h), confirmação pelo link com o token no corpo (`tech/28-crm-cadastro.md`) |
| PATCH | `/api/me` | Perfil: `{ name }` (2 a 120), audita `user.profile_updated`, bloqueada em personificação (`src/api/profile.ts`). O `update-user` do Better Auth está desligado |
| POST, DELETE | `/api/me/avatar` | Foto de perfil (multipart, campo `file`): PNG, JPEG ou WebP pela assinatura, até `AVATAR_MAX_KB` (413 acima; 415 outro tipo); a troca apaga a anterior; `DELETE` 204. Bloqueadas em personificação |
| GET | `/api/avatars/:userId` | A foto, só para a própria pessoa, a equipe da plataforma e quem divide organização com ela (senão 404); tipo do registro, `nosniff`, cache privado |
| POST, DELETE | `/api/me/phone-change` | Troca do número da própria conta pelo pedido (`userPhoneChangeSchema`): 202 / 204, bloqueada em personificação, passa pelo portão de telefone |
| GET, POST, PATCH | `/api/tenant`, `/api/tenant/active` | Criar (aplica plano padrão e trial), ler, editar e trocar o tenant ativo |
| PATCH | `/api/tenant/security` | `require2fa`: só owner, que já precisa ter 2FA |
| GET, POST, DELETE | `/api/tenant/support-grant`, `/:id` | Consentimento para o suporte, com `support:grant` |
| GET | `/api/audit` | Log do tenant ativo, com `audit:read` |
| POST | `/api/admin/impersonate`, `/api/admin/stop-impersonating` | Personificação com consentimento, fora de `adminRoutes` (`src/api/impersonation.ts`) |
| POST | `/api/csp-report` | Relatório de CSP: 16 KB, sempre 204, sem URL completa no log |
| GET, POST, PUT, PATCH | `/api/admin/*` | Plataforma: visão geral, tenants (suspender, trocar plano), planos e preços, configurações, usuários (banir; `?scope=portal` lista clientes e `POST /api/admin/portal-users/:id/revoke-sessions` derruba as sessões deles). Só `requirePlatform`; escrita só `platform_owner` (`tech/22-admin.md`) |
| GET, POST, PATCH, DELETE | `/api/customers`, `/:id` | Clientes do tenant, com `customer:*`; `POST` passa por `assertWithinLimit(tenantId, "customers")`; fora do tenant responde 404; e-mail repetido responde 409 `CUSTOMER_EMAIL_TAKEN` |
| POST | `/api/customers/:id/invite` | `customer:invite`: cria `portal_user`, promove a `active`, grava `invited_at` e envia `portal-invite`; 409 `CUSTOMER_BLOCKED` |
| PUT | `/api/customers/:id/team-link` | `customer:update` + `blockWhileImpersonating`, corpo `teamLinkSchema { userId }`: liga a ficha à pessoa da equipe **desta** organização, à mão (200 `{ team: { userId, role } }`; idempotente; 403 `SELF_LINK`; 404 para ficha ou pessoa de outra organização; 409 `CUSTOMER_ALREADY_LINKED` ou `TEAM_MEMBER_HAS_CUSTOMER`; auditoria `customer.team_linked` com `via: manual`). A ligação decide o que a remoção da pessoa apaga (D-11, `tech/28`) |
| GET | `/api/customers/:id/team-candidates` | `customer:read` + `customer:update`: as pessoas da equipe para o diálogo de ligar (`userId`, `name`, `role`, `hasCustomer`; sem e-mail nem telefone); 404 para ficha de outra organização |
| DELETE | `/api/customers/:id/team-link` | `customer:update` + `blockWhileImpersonating`: desfaz a ligação da ficha com a pessoa da equipe (204, idempotente; 404 de outra organização; auditoria `customer.team_unlinked`). Sem ela, remover a pessoa ou excluir a conta apaga a ficha (D-11, `tech/28`). `GET /api/customers/:id` devolve `conversationCount` |
| POST, DELETE | `/api/customers/:id/phone-change` | `customer:update`: troca do número da ficha pelo pedido (202; 409 `PHONE_IN_USE` se é de outro cliente) e desistência (204). `PATCH /api/customers/:id` com outro número também abre a troca; a ficha segue com o antigo até a confirmação |
| GET, POST, PATCH, PUT | `/api/inbox/*` | Caixa de entrada do tenant (`src/api/inbox.ts`): conversas, mensagens, fila, envio, mídia, contato, com `inbox:*` e a visibilidade por pessoa em toda consulta; escrita bloqueada na personificação. `GET /api/inbox/events` é SSE (`src/api/inbox-events.ts`, `streamSSE` do Hono): só ids, filtrado por pessoa no servidor, batimento de 25 s, encerrado a cada 15 min, até 3 por pessoa (429) e 503 sem a conexão `LISTEN`; não entra no `rbac.test.ts` (o corpo não termina). `PUT /api/inbox/messages/:id/favorite` (`{ favorite: boolean }`, `inbox:reply`, idempotente) é a estrela da mensagem (retenção, R3a). `POST .../messages` aceita JSON (`text`, `template`) ou `multipart/form-data` (anexo de até 16 MB, limite de corpo próprio e 20/min por pessoa). `GET /api/inbox/media-out/:token` (`src/api/inbox-media-out.ts`) é a exceção **sem sessão**: montada antes do `csrfGuard`, autorizada por token HMAC de 5 min, para o servidor Evolution baixar o anexo (`tech/30-caixa-de-entrada.md`). Tabela completa em `tech/30-caixa-de-entrada.md` |
| GET, PUT | `/api/admin/retention/*` | Retenção de mensagens (bloco R, `src/api/admin-retention.ts`, montado antes de `adminRoutes`): política efetiva por organização e tipo de canal, prévia e última execução (leitura da plataforma); `PUT .../tenants/:id/:channelType` grava a linha (`platform_owner`, `blockWhileImpersonating`, Zod `retentionPolicySchema` em `src/lib/schemas/retention.ts`). Detalhe em `tech/22-admin.md` |
| GET, POST, PATCH, PUT | `/api/admin/inbox/*` | Atendimento da plataforma (`src/api/admin-inbox.ts`, montado antes de `adminRoutes`): as rotas de `/api/inbox` menos `claim`, `assign`, `assignees`, `candidates` e `customer`, com `Scope = platform`. Leitura de qualquer papel de plataforma; escrita de `platform_owner` e `platform_support`; `customerId` é 400; nenhuma consulta a `customer` de tenant. Também tem `PUT .../messages/:id/favorite` (a estrela, R3a). `GET .../events` é SSE (`streamInboxEvents`) |
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
  `EMAIL_NOT_VERIFIED`. Auth indisponivel: 503. Depois do e-mail, com
  `PHONE_VERIFICATION_REQUIRED=true`, telefone que nao vale na organizacao ativa: 403
  `PHONE_UNVERIFIED`, menos na lista fechada de `src/api/phone-gate.ts` (`requirePortalAuth` faz o
  mesmo com a ficha de cliente). Rota nova fica bloqueada sem marcacao (`tech/08-auth.md`).
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
