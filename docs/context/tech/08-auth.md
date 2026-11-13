# Autenticação

- **Escopo:** Better Auth da equipe e da plataforma, verificação de e-mail, sessão e papéis. A instância do portal está em `tech/25-portal-clientes.md`.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-auth.md`, `spec-seguranca.md`
- **Paths do código:** `src/lib/auth/`, `src/api/auth.ts`, `src/api/auth-ext.ts`, `src/api/guards.ts`, `src/api/verification-guard.ts`, `src/db/schema/auth.ts`, `src/lib/schemas/auth.ts`, `src/lib/email/templates/auth/`, `src/providers/auth-provider.tsx`, `src/components/auth/`, `src/pages/*-page.tsx`, `src/routes/auth/`

## Estado atual

Instância `auth`, para plataforma e equipe, com sessão em cookie no Postgres e o plugin
`organization` (`tech/21-tenant-rbac.md`). Clientes e leads usam outra instância, `portalAuth`,
com cookies, tabelas e segredo próprios (`tech/25-portal-clientes.md`): um cookie nunca vale
pelo outro. 2FA, sessões e personificação estão em `tech/26-seguranca.md`. Ainda não existe
`consent_log` (fase 10): o aceite de termos é exigido, mas não registrado.

| Peça | Arquivo | Papel |
|---|---|---|
| Instância | `src/lib/auth/server.ts` | `getAuth()`, criada na primeira chamada porque `src/server.ts` só carrega `.env.local` depois dos imports |
| Rotas | `src/api/auth-ext.ts` | `/api/auth/*` e `/api/auth-ext/*`, montadas em `src/api/app.ts` |
| Uso único | `src/api/verification-guard.ts`, `src/lib/auth/verification-issue.ts` | `email_verification_issue` guarda `sha256(token)` da emissão vigente |
| E-mails | `src/lib/auth/emails.ts` | monta link com `APP_URL`, grava a emissão e chama `sendEmail` |
| Servidor | `src/api/auth.ts` | `requireAuth` e `requirePlatform` |
| Cliente | `src/lib/auth/client.ts`, `src/providers/auth-provider.tsx` | `authClient`, `useAuth()` |
| Papéis | `src/lib/auth/permissions.ts` | plataforma em `user.role`; catálogo e papéis do tenant, compartilhados com o cliente |
| Portal | `src/lib/auth/portal.ts`, `src/api/portal-auth.ts` | `getPortalAuth()`, `requirePortalAuth`, `requirePortalTenant` |

## Rotas

| Rota | Quem responde | Regra |
|---|---|---|
| `POST /api/auth/sign-up/email` | `auth-ext.ts` + Better Auth | exige `signupSchema`; corpo sempre `{ ok: true, verifyEmail }`, nunca abre sessão |
| `POST /api/auth/verify-email` | `auth-ext.ts` + guard + Better Auth | só POST; devolve `{ step }` (`verified`, `change-approved`, `change-done`) |
| `GET /api/auth/verify-email` | `auth-ext.ts` | 405: o token nunca é consumido em GET |
| `POST /api/auth-ext/resend-verification` | `auth-ext.ts` | `{ ok: true }`; 3 por 15 min por IP, 3 por hora por e-mail |
| `POST /api/auth-ext/forgot-password` | `auth-ext.ts` | `{ ok: true }`; 3 por 15 min por IP |
| `/api/auth/organization/*` | `auth-ext.ts` | 404: as regras de tenant ficam nas rotas próprias; use `auth.api.*` |
| `/api/auth/two-factor/*` | Better Auth | `enable`, `disable`, `get-totp-uri`, `verify-totp`, `verify-backup-code`, `generate-backup-codes` |
| demais `/api/auth/*` | Better Auth | `sign-in/email`, `sign-out`, `reset-password`, `change-email`, `get-session`, leituras de `admin/*` |

Desligados por HTTP em `disabledPaths`, disponíveis em `auth.api.*`:
`/send-verification-email`, `/request-password-reset`, `/list-sessions`, `/revoke-session`,
`/revoke-sessions`, `/revoke-other-sessions`, `/two-factor/send-otp`, `/two-factor/verify-otp`,
`/admin/impersonate-user`, `/admin/stop-impersonating` e toda escrita do plugin admin (`set-role`, `create-user`,
`update-user`, `ban-user`, `unban-user`, `revoke-user-session`, `revoke-user-sessions`,
`remove-user`, `set-user-password`). Ação sobre usuário passa por `/api/admin/*`, com
`assertBannable` e auditoria. Continuam por HTTP só as leituras (`list-users`, `get-user`,
`list-user-sessions`, `has-permission`), que exigem papel de plataforma. Atualizou o Better
Auth e surgiu rota em `/admin/*` ou `/two-factor/*`? Os testes em `tests/db/auth.test.ts` e
`tests/db/two-factor.test.ts` falham até ela ser classificada.

## Verificação de e-mail

**Opcional:** `EMAIL_VERIFICATION_REQUIRED` (padrão `false`), variável e não `platform_setting`,
porque muda a construção da instância (`docs/specs/cobranca-manual/spec.md`).

| | Ligada | Desligada (padrão) |
|---|---|---|
| Cadastro | `{ ok: true, verifyEmail: true }`, tela "Confirme seu e-mail" | `{ ok: true, verifyEmail: false }`; o cliente entra com a mesma senha |
| `requireAuth` | 403 `EMAIL_NOT_VERIFIED` | aceita não verificado |
| Cadastro pendente de 24 h | apagado no novo cadastro | nunca apagado: a conta já é usável |
| Criar organização, aceitar convite | só verificado | qualquer conta; aceitar exige o id do convite (que só chega por e-mail) |
| `GET /api/me/invitations` | verificado | **verificado**, senão `[]`: quem cadastrasse o e-mail alheio veria os convites |

Nas duas posições o cadastro tem `autoSignIn: false`: a resposta não tem cookie e é a mesma para
e-mail novo e existente (o Better Auth devolve a resposta genérica e `onExistingUserSignUp` avisa o
dono). Desligada, o login logo após o cadastro revela se o e-mail já tinha conta: é o custo de
entrar direto. `/verificar-email` continua igual e serve para confirmar depois, mas o link só sai
nas primeiras 24 h do cadastro (`isPendingSignupExpired`, nas duas posições): depois disso, um
link que a pessoa não pediu e clicasse verificaria a conta de quem cadastrou o e-mail dela
(RISK-006) e entregaria a essa pessoa os convites do endereço. Quem passou do prazo sem
confirmar recebe convites pelo link do e-mail, que aceita sem verificação. Os testes de banco
rodam com a verificação ligada; `tests/db/auth-no-verification.test.ts` cobre o padrão.

Com a verificação ligada:

1. Cadastro, reenvio ou login sem verificação chamam `sendVerificationLink`, que ignora
   a `url` do Better Auth, grava `sha256(token)` e envia `/verificar-email?token=`.
2. A página só renderiza. O botão faz `POST /api/auth/verify-email`.
3. `verificationGuard` apaga a linha em um único `DELETE ... RETURNING`: token anterior,
   usado ou desconhecido responde 400 sem chamar o Better Auth.
4. A rota remonta um GET interno para o Better Auth, que valida o JWT (1 h), marca
   `email_verified` e abre a sessão.

Sem verificação, não há sessão: login com a senha certa responde o mesmo 401 de senha errada e
dispara um novo link (`sendOnSignIn`). `hideUnverified` (`auth-ext.ts`) faz a troca em todo o
proxy para o Better Auth, que confere a senha antes da verificação: sem ela, cadastrar um e-mail
com uma senha qualquer e tentar entrar diria se ele já existia. A tela de login não sabe por que
a entrada falhou, então o reenvio fica fixo nela, em "Não recebeu o link de confirmação?".
`requireAuth` também recusa `emailVerified = false` (só com a verificação ligada).

A linha é consumida antes do Better Auth rodar. Se ele falhar nesse instante, o link
se perde e a pessoa pede outro: a falha é fechada.

Reenvio dentro do mesmo segundo gera o mesmo JWT e, portanto, o mesmo hash.

Cadastro pendente expira em 24 h (`src/lib/auth/pending-signup.ts`): não recebe mais link,
e um novo cadastro apaga a conta e recomeça. Sem isso, quem cadastrasse o e-mail de outra
pessoa deixaria uma senha à espera do clique do dono (RISK-006). Conta sem verificar criada
por outro caminho, como uma CLI, cai na mesma regra.

## Troca de e-mail

`authClient.changeEmail` responde sucesso mesmo para endereço em uso. O link de aprovação
vai ao endereço atual; aprovado, o Better Auth envia a verificação ao novo; concluída, o
endereço antigo recebe `change-email-done`. As duas etapas usam a mesma tabela, com
`kind = "change"`, e a mesma página. O e-mail antigo vem das claims do token, porque
quando `afterEmailVerification` roda o usuário já tem o novo.

## Política de senha

Uma regra só, em `src/lib/auth/password-policy.ts` (módulo puro, com teste): 10 a 128
caracteres, com maiúscula, minúscula, número e um especial de `!@#$%^&*()_+-=[]{}:;,.?/~`, sem
caractere de controle (U+0000 a U+001F e U+007F). Espaço no meio vale. A senha é gravada e
conferida **normalizada** (`normalizePassword`: `trim` + NFC). O máximo é em caracteres porque
o hasher é o scrypt padrão do Better Auth (`@better-auth/utils/password`), sem o corte de 72
bytes do bcrypt; trocar o hasher por bcrypt obriga a rever esse limite.

Onde a regra é cobrada:

| Ponto | Cobre |
|---|---|
| `newPassword` de `src/lib/schemas/auth.ts` (Zod) | Formulários e rotas próprias: cadastro, convite, redefinição (`resetPasswordSchema`), autocadastro e `set-password` do portal |
| `passwordPolicyHook` (`src/lib/auth/password-hook.ts`), `hooks.before` de `auth` e `portalAuth` | Toda chamada ao Better Auth, por HTTP ou `auth.api.*`: `/sign-up/email`, `/reset-password`, `/change-password` e, se um dia abertas, `/admin/set-user-password` e `/admin/create-user`. É o que barra a rota chamada direto (`/reset-password` e `/change-password` não têm Zod próprio) |
| `setPortalPassword` (`src/lib/portal/profile.ts`) | O `set-password` do portal grava o hash direto, fora do Better Auth: normaliza e valida de novo |
| `assertSeedAllowed` (`src/db/seed.ts`) | `SEED_PASSWORD` |

Senha fora da regra responde 400 com `code: "PASSWORD_POLICY"` e só o texto da regra
(`PASSWORD_POLICY_MESSAGE`, traduzido também em `src/lib/auth/client.ts`).

**Medidor (S2):** `PasswordStrengthMeter` (`src/components/auth/password-strength-meter.tsx`) mostra
a barra (`role="progressbar"`, regras cumpridas sobre cinco) e a checklist ao vivo logo abaixo do
campo de senha nova, e some com o campo vazio; `maxLength` e `noControl` só entram na lista quando
violadas. Quais linhas aparecem sai de `passwordChecklist` (`src/lib/auth/password-checklist.ts`,
puro, com teste). Está em `SignupForm` (cadastro e convite), `/redefinir-senha`,
`/portal/cadastro` e `PasswordCard` de `/portal/conta`; o botão de enviar fica desabilitado até a
senha cumprir a regra (e, na redefinição, até coincidir com a confirmação). O `LoginForm` não tem
medidor. O medidor só orienta: quem recusa senha fraca é o Zod e o servidor.

O hook normaliza `password`, `newPassword` e `currentPassword` em **toda** rota do Better Auth,
inclusive `/sign-in/email` e as confirmações de 2FA; `confirmIdentity` faz o mesmo. Sem isso,
quem cadastrou a senha com espaço no fim deixaria de entrar. **O login não cobra complexidade**:
senha gravada antes da regra continua entrando e só é cobrada na próxima troca. A exceção é a
senha antiga gravada com espaço nas pontas: passa a ser conferida sem ele e só volta pelo
reset (só existem contas de desenvolvimento anteriores à regra).

Rota nova que grave senha entra em `NEW_PASSWORD_FIELD` (se for do Better Auth) ou chama
`normalizePassword` + `isPasswordValid(evaluatePassword())` antes do hash. Isso inclui
`auth.api.setPassword`: é só de servidor, sem `path`, e o hook normaliza mas não a reconhece
para cobrar a política (ninguém a chama hoje).

## Recuperação de senha

`/esqueci-senha` chama `/api/auth-ext/forgot-password`, que envia
`/redefinir-senha?token=`. A página só renderiza; o envio do formulário chama
`authClient.resetPassword`. O token é de uso único, fica em hash
(`verification.storeIdentifier: "hashed"`), encerra todas as sessões e dispara
`password-changed`.

Concluir o reset prova o e-mail: o link só chega ao endereço da conta, então
`onPasswordReset` marca `emailVerified = true`. É por aí que entra quem teve o e-mail trocado
pelo `/admin` (`PATCH /api/admin/users/:id`), que volta como não verificado e recebe o link de
definir senha no endereço novo (`tech/22-admin.md`). Essa troca também apaga a senha e os
tokens de reset da conta: só o link enviado ao endereço novo define a senha, e a conta não
vira "cadastro pendente" — `purgeExpiredPendingSignup` só apaga conta não verificada **com
senha**, que é o que um cadastro nunca confirmado tem.

## Sessão e `requireAuth`

- Cookies `bizu.session_token` e `bizu.session_data`: `HttpOnly`, `SameSite=Lax`, e
  `Secure` com prefixo `__Secure-` em produção.
- `requireAuth` responde 401 sem cookie, sem consultar nada; 401 com sessão inválida; 503
  se o Auth falhar; 403 sem e-mail verificado, com `EMAIL_VERIFICATION_REQUIRED=true`.
- `requireAuth` lê a sessão com `disableCookieCache`: sessão revogada cai na hora. O cache
  de 5 min do cookie vale só para `/get-session`, que alimenta a interface.
- `apiFetch`, ao receber 401 em `/app`, encerra a sessão antes de ir ao login. Sem isso o
  cache do cookie devolveria para `/app`, em ciclo.
- `requireAuth` expõe `activeOrganizationId`; `requireTenant` e `requirePermission` ficam em
  `src/api/permissions.ts`.
- O cache do cookie guarda o tenant ativo antigo por até 5 minutos: nada lê esse valor, e
  chamadas a `auth.api.*` passam `organizationId`.
- Sessão nova abre no último tenant usado (`databaseHooks.session.create.before`).
- `requirePlatform()` vem depois de `requireAuth`; passe `["platform_owner"]` nas rotas que
  o suporte não pode usar. Em produção, sem 2FA responde 403 `PLATFORM_2FA_REQUIRED`.
- `AuthUser.twoFactorEnabled` e `impersonatedBy` vêm da sessão, e `/api/me` soma
  `security: { tenantRequires2fa, platformRequires2fa }` para a interface levar à tela de ativar.
- Sessão personificada só usa `/get-session` e `/sign-out` do Better Auth (`closedWhileImpersonating`).
- Em `/api/auth/admin/*`, ninguém escreve por HTTP, nem `platform_owner`: o plugin não compara
  o papel do alvo. No servidor, `platform_support` também não tem `ban` nem `revoke`.

## Rate limit e IP

- Better Auth, no banco (`rate_limit`): `/sign-in/email` e `/sign-up/email` 3 por 10 s,
  `/reset-password` 5 por min, `/change-email` 3 por min, `/two-factor/*` 3 por 10 s.
  `/get-session` fica de fora.
- Rotas próprias: `rateLimit`, em memória no desenvolvimento e em `rate_limit_bucket` com
  `RATE_LIMIT_STORE=postgres`, obrigatório em produção.
- `X-Forwarded-For` vem do cliente. `auth-ext.ts` resolve o IP com `TRUSTED_PROXY_HOPS` e
  sobrescreve `x-bizu-client-ip`, o único cabeçalho que o Better Auth lê.
- O Better Auth só confere `Origin` quando há cookie. `sameOrigin` confere em todo
  `/api/auth/*` e `/api/auth-ext/*`; sem esse middleware, cadastro e login aceitariam
  envio de outro site.

## Telefone da conta

A conta da equipe só aceita número que recebe WhatsApp (`whatsappPhoneSchema`), e o telefone do
cadastro nasce **pendente** (`phone_verified_at` nulo): não conta na unicidade nem atrai o vínculo
automático das conversas até ser confirmado. O hook de cadastro abre o pedido de verificação na
plataforma, e o aceite do convite abre o da organização (`ensureUserVerification`). A confirmação
pelo link é `POST /api/me/phone-verification/confirm`, só na sessão da própria conta, com o token
no corpo (nunca em GET nem em rota pública) e bloqueada em personificação. Detalhe em
`tech/28-crm-cadastro.md`, "Telefone verificado e único" e "Pedido de verificação e liberação".

## Bloqueio de login por tentativas

Além do limite por IP, o login conta as senhas erradas por e-mail e bloqueia por um tempo
(`docs/specs/pre-producao/spec.md`, bloco B). Vale para a equipe e para o portal, com contadores
separados (`realm` `team` e `portal`).

| Variável | Padrão | O que faz |
|---|---|---|
| `LOGIN_LOCKOUT_SCOPE` | `email` | `email`: bloqueia o e-mail, de qualquer IP. `email_ip`: só o par e-mail e IP (o dono nunca fica trancado por outro IP). `off`: desliga |
| `LOGIN_MAX_ATTEMPTS` | 5 | Falhas, dentro da janela, que abrem o bloqueio |
| `LOGIN_ATTEMPT_WINDOW_MINUTES` | 15 | Janela em que as falhas se somam |
| `LOGIN_LOCKOUT_MINUTES` | 15 | Duração do bloqueio |

- **Onde:** `throttledSignIn` (`src/api/login-throttle.ts`) é a rota de `POST
  /api/auth/sign-in/email` (`auth-ext.ts`) e do `sign-in/email` do portal (`portal.ts`, rota
  própria, fora de `PORTAL_AUTH_PATHS`). A decisão é pura (`src/lib/auth/login-throttle.ts`); o
  estado fica em `login_throttle`, por `login-throttle-store.ts`.
- **Só JSON, e só o validado:** a rota exige `Content-Type: application/json` (415 fora disso),
  valida com `signInRequestSchema` (400) e repassa ao Better Auth o JSON validado. O endpoint
  dele também aceita `application/x-www-form-urlencoded`: com o corpo cru repassado, um
  formulário entraria sem passar pelo bloqueio nem pelo `barredSignIn` do portal. Rota nova que
  repasse corpo ao Better Auth segue a mesma regra.
- **A tentativa é contada antes de conferir a senha** (`reserveLoginAttempt`, uma transação sob
  trava por chave): tentativas simultâneas não passam todas pela leitura "ainda não bloqueado",
  e no máximo `LOGIN_MAX_ATTEMPTS` chegam a conferir a senha por janela.
- **O que fica contado:** a resposta 401 (senha errada, e-mail sem conta, conta não verificada;
  no portal, também a conta em carência de exclusão: por fora são a mesma). 200 zera a chave.
  Qualquer outra (429 do limite por IP, 400, 5xx, e o 403 `BANNED_USER` da equipe, que só sai com
  a senha certa) devolve a tentativa.
- **Bloqueado:** 429 com `Retry-After` e o corpo do rate limit, sem conferir a senha. E-mail sem
  conta bloqueia igual: a resposta não diz se ele existe.
- **Como sai:** o tempo passa, ou a pessoa redefine a senha (`onPasswordReset` zera todas as
  chaves do e-mail, de qualquer IP; no portal, `setPortalPassword`, depois de entrar por magic
  link).
- **Limites conhecidos:**
  - Com `email` (padrão, decisão do proprietário), quem sabe o e-mail de alguém consegue mantê-lo
    bloqueado errando a senha. Redefinir a senha zera o contador, mas não abre sessão: contra
    quem insiste, o atacante fecha de novo antes de o dono entrar. A saída de operação é
    `LOGIN_LOCKOUT_SCOPE=email_ip`, que não segura ataque vindo de muitos IPs. Sessões já
    abertas continuam valendo durante o bloqueio.
  - O login certo zera o contador, então quem chega a N-1 falhas e espera consegue notar que
    alguém entrou no intervalo (a próxima falha não bloqueia). Revela atividade de uma conta
    que o atacante já tenta adivinhar; aceito.
  - `email_ip` depende de `TRUSTED_PROXY_HOPS` certo: errado para mais, o cliente escolhe o IP;
    zero atrás de proxy, todos dividem o IP do proxy e o escopo vira `email`.
- **IP:** em `email_ip`, IPv6 conta pelo /64 e IPv4 mapeado vira IPv4 (`throttleIp`), como no
  limite do Better Auth.
- **Limite por IP da rota:** `signInRateLimit` (20 por minuto), na frente do bloqueio: o caminho
  bloqueado não chega ao limite do Better Auth.
- **Dados:** e-mail e IP só entram em HMAC com `AUDIT_SALT`. A falha que fecha o bloqueio é
  auditada como `auth.login_locked`, sem ator e sem o hash do e-mail (a auditoria dura muito
  mais que o contador). Linhas vencidas saem no `maintenance.prune`.
- **Falha fechada:** sem conseguir reservar a tentativa, o login responde 503. Falha ao zerar ou
  devolver depois da resposta deixa a tentativa contada.
- **Testes:** `src/lib/auth/login-throttle.test.ts`, `tests/db/login-throttle.test.ts` (inclui
  formulário, corpo inválido, concorrência e os dois escopos) e `tests/db/auth-http.test.ts`.
  Não há teste para o 503 da falha de banco.

## Primeiro proprietário

`npm run db:seed` cria `owner@bizu.local` (`platform_owner`) e `suporte@bizu.local`
(`platform_support`), com a senha de `SEED_PASSWORD`. Sem o seed (ou em produção), cadastre-se em
`/cadastro`, confirme e promova pelo banco:

```sql
update "user" set role = 'platform_owner' where email = 'voce@empresa.com';
```

## Regras

- `ProtectedRoute` faz o gate no cliente e não protege dados.
- Toda rota privada usa `authRateLimit` e `requireAuth`.
- Falha fechada: Auth indisponível não abre rota.
- Respostas de cadastro, login sem verificação, reenvio, reset e troca de e-mail não revelam se o e-mail existe.
- Trabalho que depende de o e-mail existir roda em `runInBackground`: a resposta sai antes.
- Handler novo em `/api/auth/*` passa por `forwardedHeaders` e remonta o `Request`, para
  mandar o IP resolvido. Teste em `tests/db/auth-http.test.ts`: `api.request()` entrega um
  `Request` nativo, e o servidor Node, um objeto próprio.
- `audit_log` recebe `auth.signed_up`, `auth.email_verified`, `auth.email_changed`,
  `auth.password_reset`, `auth.2fa_enabled`, `auth.2fa_disabled` e `auth.session_revoked`.
- O log de requisições passa por `redactTokens` (`src/api/request-logger.ts`).
- **Telefone obrigatório em toda conta** (`signupSchema.phone`). O `POST /api/auth/sign-up/email`
  leva o telefone no contexto de `withSignupConsent`; `databaseHooks.user.create.before` (nas duas
  instâncias) grava `phone`, `phone_normalized` e `phone_key` por `signupPhoneValues` e **recusa** a
  criação sem telefone válido, então chamar o Better Auth direto falha fechado. Os `additionalFields`
  de telefone têm `input: false`. Os `INSERT` diretos (convite do portal, seed) gravam o telefone
  eles mesmos. O banco reforça com `CHECK` (`tech/28-crm-cadastro.md`).
- Schema do Better Auth é escrito à mão a partir de `getAuthTables`. `@better-auth/cli`
  1.4 não acompanha a 1.7 e traz Prisma e `better-sqlite3` como dependências.

## Consentimento e exclusão (fase 10)

- O cadastro das duas instâncias grava `consent_log` no hook `databaseHooks.user.create.after`, lendo o contexto aberto pela rota (`withSignupConsent`); `/api/auth/sign-up/email` e o autocadastro do portal repassam `termsVersion` e `marketing`. Cadastro de e-mail existente não grava aceite.
- `/api/me` e `/api/portal/me` devolvem `consentRequired`; o re-aceite é `POST /api/me/consent` (equipe) e `POST /api/portal/me/consent` (portal), nunca durante a personificação.
- Excluir a conta confirma a identidade com `confirmIdentity` (`src/lib/lgpd/identity.ts`): senha pelo `internalAdapter`/`password.verify` do Better Auth e TOTP decifrado com `symmetricDecrypt` e conferido por `@better-auth/utils/otp`. Chamadas diretas a `auth.api` não passam pelo rate limit do plugin: o freio é o `rateLimit` por usuário das rotas.
- A anonimização remove `account` (senha), `two_factor` e `session`. Detalhes em `tech/27-lgpd-arquivos.md`.
