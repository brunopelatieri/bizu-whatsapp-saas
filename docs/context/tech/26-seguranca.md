# Segurança

- **Escopo:** 2FA, sessões, personificação, CSP, CSRF, rate limit, criptografia de credenciais e leitura da auditoria.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-seguranca.md`, `spec-auth.md`
- **Paths do código:** `src/api/security.ts`, `src/api/impersonation.ts`, `src/api/sessions.ts`, `src/api/rate-limit.ts`, `src/api/rate-limit-postgres.ts`, `src/lib/crypto/secrets.ts`, `src/lib/tenant/credentials.ts`, `src/lib/tenant/support-grants.ts`, `src/lib/admin/impersonation.ts`, `src/lib/audit-log.ts`, `src/entry.server.tsx`, `src/lib/zod-config.ts`

## Ameaças cobertas

| Ameaça | Controle | Teste |
|---|---|---|
| Senha vazada | 2FA por TOTP, com lockout do plugin | `tests/db/two-factor.test.ts` |
| Conta da plataforma sem 2FA | `PLATFORM_2FA_REQUIRED` em produção | idem |
| Equipe sem 2FA | `tenant.settings.require_2fa` → `TENANT_2FA_REQUIRED` | idem |
| Token de sessão exposto por listagem | `/api/me/sessions` devolve o id da linha; as rotas do plugin ficam fechadas | `tests/db/sessions.test.ts` |
| Abuso de personificação | Consentimento, 1 h, bloqueios, banner, e-mail ao owner, auditoria dupla | `tests/db/impersonation.test.ts` |
| CSRF | `csrfGuard`, `sameOrigin` e a checagem do Better Auth | `src/api/security.test.ts`, `tenant-http.test.ts` |
| XSS | CSP com nonce, sem `unsafe-inline` nem `unsafe-eval` em `script-src` | `src/api/security.test.ts`; smoke no navegador |
| Clickjacking | `frame-ancestors 'none'`; em report-only, `X-Frame-Options: DENY` | `src/api/security.test.ts` |
| Rate limit dividido entre réplicas | `RATE_LIMIT_STORE=postgres`, obrigatório em produção | `tests/db/rate-limit-store.test.ts` |
| Banco ou backup vazado | Credenciais em AES-256-GCM, com a chave só no ambiente | `src/lib/crypto/secrets.test.ts`, `tests/db/credentials.test.ts` |

## CSP

`securityHeaders` (`src/api/security.ts`) gera um nonce por requisição. O caminho até o HTML:
`getLoadContext` (`src/server.ts`) → `cspNonceRouterContext` no `RouterContextProvider` → `src/entry.server.tsx` →
`ServerRouter nonce` (aplica aos scripts do React Router) e `CspNonceContext` (script anti-flash de
`src/root.tsx`). No navegador o contexto é `undefined`: o script já rodou, e `suppressHydrationWarning`
cobre a diferença.

- `CSP_REPORT_ONLY=true` (padrão): `Content-Security-Policy-Report-Only`, nada é bloqueado.
- `CSP_REPORT_ONLY=false`: `Content-Security-Policy`, o navegador bloqueia.

Para ligar em produção: suba em report-only, olhe os logs por `Violação de CSP` nas telas reais e
só então mude para `false`.

**Por que cada exceção existe:**

- `style-src 'unsafe-inline'`: Sonner e Base UI injetam `<style>` em tempo de execução, e o SSR escreve
  `style=""`. Sem isso, a interface quebra.
- `https://fonts.googleapis.com` em `style-src` e `https://fonts.gstatic.com` em `font-src`: as
  fontes de `src/root.tsx`. Hospedá-las no próprio app remove essas duas origens.
- `img-src https:`: imagens externas de conteúdo.
- `src/lib/zod-config.ts`: sem `jitless`, o Zod testa `new Function("")` e gera uma violação de
  `eval` em toda página com formulário. Precisa ser o primeiro import de `src/root.tsx`.

**Liberar uma origem:** acrescente-a à diretiva certa em `cspDirectives`, nunca em `default-src`
nem como `https:` em `script-src`. Um SDK que carrega script próprio (Stripe.js, por exemplo) pede
`script-src` e, em geral, `frame-src` e `connect-src`. Atualize o teste de cabeçalhos e registre aqui
o motivo.

`POST /api/csp-report`: 16 KB, 30 por minuto por IP, sempre 204. O log guarda a diretiva, a **origem**
bloqueada e o caminho da página com ids trocados por `:id`. Query string nunca entra: ela pode trazer
token ou e-mail.

## CSRF

`csrfGuard` roda em todo `/api/*`, depois dos webhooks e de `/api/csp-report`, que não vêm de uma
página do app e são autenticados por assinatura ou não têm efeito.

`hono/csrf` sozinho não basta: ele só olha tipos de formulário e deixa `application/json` passar,
confiando no preflight. A guarda soma uma regra: **toda mutação com `Origin` diferente de `APP_URL`
responde 403**, inclusive `Origin: null`. Requisição sem `Origin` e com JSON passa (não é navegador).
O `sameOrigin` de cada grupo de rotas continua, porque ele vale também para GET.

## Rate limit

`rateLimit({ name, limit, windowMs })`: `name` é obrigatório e único, porque separa os contadores no
store compartilhado.

| `RATE_LIMIT_STORE` | Onde | Quando |
|---|---|---|
| `memory` | `Map` por limite, janela a partir do primeiro acesso | só desenvolvimento e testes; **produção recusa na subida** |
| `postgres` | `rate_limit_bucket`, janela alinhada ao relógio, upsert atômico | obrigatório em produção |

A chave vai em hash com `AUDIT_SALT`, para o IP não ficar legível. Store fora do ar responde 503 (falha
fechada). Buckets com mais de 24 h saem no `maintenance.prune`: uma janela maior que isso exige
aumentar `RATE_LIMIT_RETENTION_MS`. `failureLimit`, dos webhooks, segue em memória: com N instâncias, o
teto real é N vezes o limite. O rate limit do Better Auth é outro, na tabela `rate_limit`.

## Criptografia de credenciais

`encryptSecret`/`decryptSecret` (`src/lib/crypto/secrets.ts`): AES-256-GCM, nonce de 12 bytes por
registro, formato `v<versão>:<nonce>:<tag>:<cifra>` em base64url. O `aad` amarra a cifra a
`tenant:provider`: copiar `encrypted_secret` para outra linha falha na leitura.

`src/lib/tenant/credentials.ts` é só repositório, sem rota nem tela (fluxo b é futuro). A lista mostra
os 4 últimos caracteres; segredo com menos de 8 não mostra nenhum.

**Rotação da chave:**

1. Gere a chave nova: `openssl rand -base64 32`.
2. No ambiente: `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` com a atual, `CREDENTIALS_ENCRYPTION_KEY` com a
   nova e `CREDENTIALS_KEY_VERSION` somado de 1. Suba: leitura aceita as duas, escrita usa a nova.
3. Rode `rotateCredentials()` uma vez, com as mesmas variáveis. É idempotente e transacional: se uma
   linha falhar, nada muda.
4. Confira `select key_version, count(*) from tenant_payment_credential group by 1`, com
   `app.bypass_tenant` ligado.
5. Remova `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` e suba de novo. Só depois descarte a chave antiga.

Os segredos de canal (`channel_whatsapp_cloud` e `channel_evolution`: token, segredo do aplicativo, token
de verificação, token da instância e segredo do webhook) usam o mesmo anel de chaves, com `aad =
channel:<id>:<campo>` (`src/lib/channels/credentials.ts`). `rotateCredentials()` recifra também essas
duas tabelas na mesma transação; confira `key_version` nelas com `app.bypass_tenant` ligado.

A rotação cobre uma versão por vez. Perder a chave atual significa recadastrar as credenciais: guarde-a
fora do banco e do backup do banco.

## Personificação

`POST /api/admin/impersonate { userId, tenantId, reason? }`, em `src/api/impersonation.ts`:

1. `requirePlatform()`; o alvo precisa ser membro do tenant (404), e conta de plataforma é recusada pelo plugin.
2. Sem `impersonation_grant` válido nem `impersonation_policy = allow_without_consent`: 403
   `IMPERSONATION_CONSENT_REQUIRED`, auditoria `platform.impersonation_requested` e e-mail
   `impersonation-requested` aos owners, no máximo um por hora por tenant. A tela mostra "Pedir acesso".
3. `auth.api.impersonateUser` cria a sessão. `bindImpersonation` a prende ao tenant e encurta a
   validade para o fim do grant, se ele acabar antes de 1 h.
4. Grava `used_by`, audita `platform.impersonation_started` com `grant_id` e avisa os owners
   (`impersonation-started`).

**Presa ao tenant:** `POST /api/tenant/active` é bloqueado, e `/api/me` não cai em outro tenant da
pessoa nem lista os demais. Sem isso, um consentimento do tenant A abriria o tenant B do mesmo usuário.

**Teto:** `session.impersonation_expires_at`, conferida em `resolveSession` a cada requisição. Não use
`expires_at` para isso: o `getSession` só deixa de renovar a sessão quando o cliente manda o cookie
`dont_remember`, e quem personifica pode apagá-lo. Teto vencido ou ausente apaga a sessão.

**Revogar** (`DELETE /api/tenant/support-grant/:id`) apaga as sessões personificadas do tenant na hora.

**Bloqueios** (403 `IMPERSONATION_BLOCKED`, com auditoria `platform.impersonation_blocked_action`).
Guarda nova decide por `resolveSession`, nunca por `getSessionCookie`: com o cookie repetido, um lê
o último valor e o Better Auth, o primeiro.

| Rotas | Como |
|---|---|
| Mutações de `/api/billing/*`, `/api/team/*`, `/api/roles/*`, `/api/inbox/*` e `/api/admin/inbox/*` (enviar, assumir, transferir, situação, marcar como lida, contato) | `blockMutationsWhileImpersonating` |
| `POST`/`DELETE /api/tenant`, `/api/tenant/active`, `/api/tenant/security`, `/api/tenant/support-grant*`, aceite de convite | `blockWhileImpersonating` |
| `/api/me/sessions/*`, inclusive a leitura | idem: IP e navegador são da pessoa |
| Todo `/api/auth/*`, exceto `get-session` e `sign-out` | `closedWhileImpersonating`, lista do que passa |

Convite e papéis entram na lista além do que a spec pede: quem personifica o owner poderia deixar um
acesso próprio para depois. O `DELETE /api/tenant` ainda não existe (fase 10), mas o bloqueio já está
montado. Rota nova sensível **precisa** entrar aqui e no `it.each` de `impersonation.test.ts`.

**Auditoria dupla:** `requireAuth` abre `withImpersonator`, um `AsyncLocalStorage`. Tudo que `audit()`
grava na requisição leva `impersonator_id`, sem cada rota lembrar disso.

`POST /api/admin/stop-impersonating` fica fora de `adminRoutes`: quem sai está na sessão da pessoa
personificada, sem papel de plataforma. `signOut()` do `useAuth` chama essa rota quando há personificação.

## Caixa de entrada

- **Visibilidade por pessoa** (o RLS isola tenant, não pessoa): `visibleConversation`
  (`src/lib/inbox/visibility.ts`) entra em toda consulta de conversa, mensagem, mídia e contato; fora
  dele, 404 igual a id inexistente. Teste de matriz em `tests/db/inbox-queue.test.ts`.
- **SSE** (`GET /api/inbox/events`, `src/api/inbox-events.ts`) é o segundo ponto de vazamento de
  visibilidade, e segue a mesma regra: `requireAuth` + `requireTenant` + `inbox:read`; o servidor
  entrega só avisos do tenant da sessão e, a quem não supervisiona, só de conversa cujo dono antes (`p`)
  ou depois (`a`) é nulo ou ele mesmo (`noticeVisibleTo`, que deriva do mesmo `reachOf` de
  `visibleConversation`). Aviso sem dono conhecido só vai a quem supervisiona (falha fechada). A carga
  é só de ids (`{ c, k, m?, a?, p?, u? }`; o `pg_notify` cru leva também `s`), conferida por
  `parseInboxNotice` (chave ou valor fora do formato é descartado), e a tela relê pela API. O fluxo é
  encerrado a cada 15 min, e a reconexão passa por `requireAuth` de novo: sessão revogada, papel
  trocado ou membro removido param de receber em até 15 min (limite conhecido). Até 3 fluxos por
  pessoa **por processo** (429 `TOO_MANY_STREAMS`); com várias réplicas, o teto é 3 por réplica. Teste
  em `tests/db/inbox-realtime.test.ts`.
- **Plataforma (C6):** `/api/admin/inbox/*` (`src/api/admin-inbox.ts`) usa `requireAuth` + `requirePlatform()` (leitura) e
  `requirePlatform(["platform_owner", "platform_support"])` (escrita), sempre em `withPlatformData`: o RLS recusa linha de tenant e a
  conversa de tenant responde 404 em toda rota (SSE incluído: `noticeVisibleTo` exige `s = null`). **Nenhuma rota, consulta ou vínculo
  alcança `customer` de tenant** (decisão do proprietário: o cliente é do owner): `selectConversationRows` não junta `customer`
  na plataforma, `customerId` é 400 e há teste que varre os arquivos (`withPlatformScope` e `customer` proibidos) e outro, de banco,
  com um cliente de tenant de mesmo telefone. O `platform_support` responde, mas canal, etiqueta e campo seguem `ownerOnly`; a
  sessão personificada não passa de `requirePlatform`. A auditoria sai com `actor_type = platform`, sem `tenant_id` e sem texto
  nem telefone. `GET /api/admin/inbox/events` tem os mesmos limites do SSE do tenant (batimento, 15 min, 3 por pessoa, 503 sem
  `LISTEN`).
- `ALREADY_ASSIGNED` (409) diz o nome do dono também a quem já não vê a conversa: só quem conhece o id
  (por tê-la visto na fila) chega a isso, e é o aviso que o PRD pede.
- Iniciar conversa com um membro (`userId`) mostra o telefone dele a quem tem `inbox:reply`: decisão
  do PRD ("iniciar conversa com um cliente ou membro que tem telefone"). Pelo cliente, exige
  `customer:read`, e ligar o contato ao cliente exige `customer:update`.
- O texto de erro do provedor fica em `message.error_message` e aparece ao atendente (como o
  `META_REJECTED` dos canais); nunca vai a log.
- Mídia recebida nunca por URL pública do armazenamento: rota autenticada, tipo pelo conteúdo, `inline`
  só para imagem, áudio e vídeo, `nosniff`.
- **Upload e token da C5** (`tech/30-caixa-de-entrada.md`, "Anexo de saída"): o anexo (`multipart`, 16 MB, 20/min por
  pessoa) tem limite de corpo próprio antes de ler o arquivo, o tipo decidido **pelo conteúdo** (lista fechada, sem SVG,
  HTML, GIF, WebM nem executável) e nada é gravado em qualquer recusa. `GET /api/inbox/media-out/:token` é a única rota
  do atendimento **sem sessão**: HMAC-SHA256 com `BETTER_AUTH_SECRET` e rótulo próprio sobre `<arquivo>.<prazo>`, um
  arquivo, 5 minutos, comparação em tempo constante, só mídia de mensagem enviada pela equipe, 404 igual para qualquer
  recusa, só as recusas contam no limite por IP (30/min, a Evolution é um IP só), `nosniff` e `no-store`. Testes em `inbox-media-send.test.ts` e `media-out.test.ts`. Limite
  conhecido: quem tem o endereço (o servidor Evolution, ou um log dele) baixa o arquivo por até 5 minutos; não é de uso único.
- Conteúdo de mensagem, telefone e nome não vão a log, auditoria nem Sentry; erro de provedor só por
  `logChannelError`. Detalhes em `tech/30-caixa-de-entrada.md`.

## 2FA

Plugin `twoFactor` em `getAuth()`: TOTP, 10 códigos de backup cifrados e dispositivo confiável por 30
dias. Segredo e códigos ficam cifrados com `BETTER_AUTH_SECRET`: **trocar esse segredo invalida todo
2FA ativo**.

Fluxo no login: `/sign-in/email` devolve `twoFactorRedirect`, sem sessão, e `/2fa` pede o código. A
página só renderiza no GET; quem consome é o botão.

- Rotas abertas: `enable`, `disable`, `get-totp-uri`, `verify-totp`, `verify-backup-code`,
  `generate-backup-codes`. `send-otp` e `verify-otp` ficam em `disabledPaths`, e um teste falha se o
  plugin trouxer rota nova.
- Limite do plugin em `/two-factor/*`: 3 por 10 s. Lockout: 10 falhas seguidas, 15 minutos.
- `requirePlatform` só exige 2FA com `NODE_ENV=production`, para o seed funcionar no desenvolvimento.
- `require_2fa` só liga quem é owner e já tem 2FA, para ninguém se trancar para fora.
- Quem não tem 2FA ainda lê `/api/me` e ativa por `/api/auth/two-factor/*`: nenhuma das duas passa
  por `requireTenant`.
- O portal tem o plugin e a tabela `portal_two_factor`, com as rotas fechadas em `disabledPaths`.
  Abri-las é uma decisão por tenant, de fase futura.

**Perdeu o aplicativo e os códigos?** Não há recuperação pela interface. Com acesso ao banco, depois de
confirmar a identidade: `delete from two_factor where user_id = ...` e
`update "user" set two_factor_enabled = false where id = ...`.

## Auditoria

`GET /api/audit` (`audit:read`, só o tenant ativo) e `GET /api/admin/audit` (filtra por tenant). Ambas
aceitam `actor`, `action` (prefixo) e `page`; `src/lib/audit-log.ts` nunca devolve `ip_hash`. O tenant
vê que foi o suporte, com `support: true`, mas não quem: o nome e o id do atendente ficam em
`/admin/auditoria`.

## Desenvolvimento

`npm run dev` funciona em report-only. Com `CSP_REPORT_ONLY=false`, o HMR do Vite pode ser bloqueado:
valide enforce no build de produção (`npm run build`, `npm run start`).

## LGPD e logs (fase 10)

- Dados pessoais fora dos logs: o pino mascara cookie, `authorization` e campos pessoais (`src/lib/logger.ts`), e `logError` tira a mensagem do erro do Drizzle e os e-mails dos demais; um teste (`src/lib/logger.test.ts`) loga um `DrizzleQueryError` com e-mail e confere a redação. Nada de `console.error` com dado pessoal.
- Exclusão da conta e da organização exigem senha e, com 2FA, o código (`confirmIdentity`), com 5 tentativas por 15 minutos por usuário, e nunca rodam em sessão personificada (`blockWhileImpersonating`). Vale o RISK-009: o TOTP também é reaproveitável dentro da janela.
- O link de download da exportação é assinado (HMAC com segredo derivado de `BETTER_AUTH_SECRET`) **e** exige a sessão do dono: o link, sozinho, não baixa nada. Trocar `BETTER_AUTH_SECRET` invalida os links já enviados (o usuário pede de novo).
- Token de confirmação da exclusão do portal: só o hash no banco, uso único, atrelado à pessoa da sessão, consumido por POST.
- Mecânica completa: `tech/27-lgpd-arquivos.md`; retenção: `docs/context/lgpd.md`.
