# Portal do cliente

- **Escopo:** Clientes e leads do tenant: `customer`, instância `portalAuth`, magic link, `/app/clientes` e `/portal/**`.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-auth.md`, `spec-dados.md`, `spec-tenant-rbac.md`, `spec-rotas-api.md`, `spec-seguranca.md`
- **Paths do código:** `src/lib/auth/portal.ts`, `src/lib/auth/portal-client.ts`, `src/lib/auth/portal-emails.ts`, `src/lib/portal/`, `src/lib/tenant/customers.ts`, `src/lib/tenant/customer-constants.ts`, `src/lib/schemas/{customer,portal}.ts`, `src/api/{portal,portal-auth,customers}.ts`, `src/db/schema/{portal-auth,customer}.ts`, `src/providers/portal-auth-provider.tsx`, `src/components/portal/`, `src/components/app/customers/`, `src/pages/portal/`, `src/pages/customer*-page.tsx`, `src/routes/portal/`, `src/lib/constants/portal-nav.ts`, `tests/db/{portal-auth,portal-isolation,customers}.test.ts`

## Modelo

| Peça | O que é |
|---|---|
| `portal_user` | A pessoa. Global, sem RLS: atravessa tenants |
| `customer` | O vínculo da pessoa com um tenant, com RLS forçado. `portal_user_id` é nulo até o primeiro envio |
| `portal_session.active_tenant_id` | O tenant em uso. Nunca vem da URL |
| `customer.status` | O portão: só `active` entra |

| Status | Significado | Portal |
|---|---|---|
| `lead` | Contato sem acesso | Com sessão, vê "cadastro em análise"; sem link por e-mail |
| `active` | Acesso liberado | Entra |
| `blocked` | Acesso cortado pelo owner | Cai na hora; sem link por e-mail e sem convite |

"Enviar acesso" promove `lead` a `active`: é a decisão do owner, e a posse do e-mail só se
prova no clique. Sair de `active`, por qualquer caminho, corta o acesso na próxima requisição.

## Duas instâncias

`portalAuth` é um Better Auth à parte, sobre o mesmo Drizzle.

| | `auth` | `portalAuth` |
|---|---|---|
| Base | `/api/auth` | `/api/portal/auth` |
| Tabelas | `user`, `session`, ... | `portal_*` |
| Cookie | `bizu.*` | `bizu_portal.*` |
| Segredo | `BETTER_AUTH_SECRET` | HMAC do mesmo segredo (`derivePortalSecret`) |
| Plugins | `organization`, `admin` | `magicLink` |

O segredo derivado não é detalhe. Com o mesmo segredo, um JWT de verificação de equipe
confirmaria e-mail no portal, e o `session_data` renomeado passaria pelo `getSession` com
cache. `tests/db/portal-isolation.test.ts` prova os dois casos, inclusive com cookie renomeado.

## O que responde por HTTP

`PORTAL_AUTH_PATHS` em `src/api/portal.ts` é uma lista fechada do Better Auth:
`sign-in/email`, `sign-out`, `get-session`, `list-sessions`, `revoke-session` e
`revoke-other-sessions`. O resto responde 404. Nada do plugin fala direto com a internet.

| Rota | Autorização | Observação |
|---|---|---|
| `POST /api/portal/auth/magic-link/verify` | token | `{ token, org? }`; só POST |
| `GET /api/portal/auth/magic-link/verify` | – | 405: GET nunca consome token |
| `POST /api/portal/auth/verify-email` | token | confirma o autocadastro; não abre sessão |
| `GET /api/portal/auth-ext/org/:slug` | pública | `{ name, selfSignup }`, para a tela de login |
| `POST /api/portal/auth-ext/magic-link` | pública | `{ ok: true }` sempre; 3/15 min por IP, 3/h por e-mail |
| `POST /api/portal/auth-ext/sign-up` | pública | `{ ok: true }` sempre; mesmos limites |
| `POST /api/portal/auth-ext/set-password` | `requirePortalAuth` | define ou troca; derruba as outras sessões |
| `GET /api/portal/me` | `requirePortalAuth` | `{ user, tenants, active }` |
| `POST /api/portal/active-tenant` | `requirePortalAuth` | só tenant disponível; o resto é 404 |
| `PATCH /api/portal/me` | `requirePortalTenant` | atualiza a pessoa e o `customer` do tenant ativo |
| `GET /api/portal/customer` | `requirePortalTenant` | dados do cliente, sem `notes` nem etiquetas (`customer_tag`) |
| `/api/customers/*` | `requireTenant` + `customer:*` | ver `tech/06-hono-api.md` |

## Magic link

1. O owner clica em "Enviar acesso" ou o cliente pede em `/portal/login?org=slug`.
2. A checagem vem antes do plugin. `requestPortalLogin` só segue com `customer` `active`
   em tenant aberto; sem isso, nada é gravado. A resposta já saiu: tudo roda em
   `runInBackground`.
3. O plugin grava o hash. `sendMagicLink` ignora a `url` da API e envia
   `/portal/entrar?token=&org=`. O convite estica a validade para 48 h: `expiresIn` é único
   no plugin, então a linha é atualizada na hora do envio.
4. A página só renderiza. O botão faz o POST, que remonta o GET do Better Auth.
5. O plugin consome o token de forma atômica. Dois cliques abrem uma sessão só.
6. Conta com `emailVerified = false` perde senha e sessões antes de ser promovida
   (`revokeUnprovenAccountAccess`): quem cadastrou o e-mail sem prová-lo não herda nada.
7. `org` escolhe o tenant entre os da pessoa. Adulterado, não dá acesso a nada.

`last_login_at` conta a entrada em cada tenant, não a sessão: sessão nova com um só tenant
grava no hook `session.create.after`; escolher o tenant grava em `enterPortalTenant`.

## Senha

Opcional. `POST /api/portal/auth-ext/set-password` define ou troca. Quem já tem senha confirma
a atual, salvo com sessão aberta há menos de 10 min: é assim que se recupera a senha, entrando
por um magic link. Por isso o portal não tem reset próprio. A troca derruba as outras sessões
e avisa por e-mail.

## Autocadastro

Desligado por padrão. Liga por tenant em `organization.settings.portal_self_signup = true`,
ainda sem tela.

1. `POST /api/portal/auth-ext/sign-up` responde `{ ok: true }` em qualquer caso.
2. Com o tenant aberto, chama `api.signUpEmail`; o e-mail leva a `/portal/confirmar`.
3. O POST da página confirma e cria o `customer` `lead`, se o plano tiver vaga. A linha nasce
   depois da prova do e-mail: cadastro em massa não consome o limite de quem paga.
4. Só o owner promove a `active`, e a confirmação nunca liga a identidade a uma linha ativa.

E-mail já cadastrado recebe só o aviso `existing-user-signup`: quem já é cliente de outro
tenant pede o acesso ao owner.

O login nunca responde `EMAIL_NOT_VERIFIED`: `hideUnverified` (`src/api/auth-ext.ts`) troca o 403
pelo 401 de senha errada. O Better Auth confere a senha antes da verificação, e sem isso bastaria
cadastrar um e-mail com uma senha qualquer e tentar entrar para saber se ele já existia. O link
de confirmação continua sendo reenviado.

## Isolamento

- `requirePortalAuth` olha só `bizu_portal`, lê a sessão no banco e falha fechado.
- `requirePortalTenant` lê `customer` a cada requisição, dentro de `withTenant`, a partir do
  `active_tenant_id` da sessão e do usuário dela. Nenhuma rota recebe `tenantId` para ler dados.
- `listPortalTenants` usa `withPlatformScope` porque atravessa tenants por natureza, e parte
  sempre do `portal_user` da sessão.
- O owner nunca vê dados de `portal_user`: `hasPortalAccess` é tudo o que sai, e
  `emailVerified` é global. Convidar quem já tem conta em outro tenant responde igual.
- Tenant suspenso fecha o portal; `read_only` mantém a leitura e recusa a escrita.
- Trocar o e-mail do cliente desfaz o vínculo: o endereço antigo perde o acesso e o novo
  precisa de um envio.
- Remover o último vínculo apaga a identidade (`dropOrphanPortalUser`): `portal_user` sem
  cliente é só dado pessoal parado.

## Como estender o portal

1. Página nova: rota em `src/routes.ts` dentro de `portal`, item em `portal-nav.ts`, dados com
   TanStack Query e `apiFetch`. Sem `loader`.
2. Rota nova em `src/api/portal.ts`: `authRateLimit` + `requirePortalAuth` +
   `requirePortalTenant`. Use `c.get("customer")`, nunca um id vindo do cliente.
3. Dado de tenant passa por `withTenant(customer.tenant.id, ...)`, com o id do `customer` no
   `where`.
4. Dado novo em `customer` só chega ao cliente se entrar em `findPortalCustomer`: a lista de
   colunas é fechada de propósito.
5. Rota do Better Auth só entra em `PORTAL_AUTH_PATHS` se não consumir token em GET nem
   revelar se um e-mail existe.

## `/app/clientes` (CRUD do owner)

Conferido na SPEC `admin-crud`: o CRUD já é completo, com todos os campos de `customer`.
Listar, buscar e filtrar por situação (`customer:read`), criar (`customer:create` e limite
`customers` do plano), editar (`customer:update`), bloquear e desbloquear por botão no detalhe,
enviar acesso (`customer:invite`, o único caminho de `lead` para `active`) e excluir
(`customer:delete`). O status fica fora do formulário de propósito. A lista
(`pages/customers-page.tsx`) mostra também telefone e etiquetas, que antes só apareciam no detalhe.

**E-mail opcional e telefone obrigatório (crm-cadastro, A1).** O cliente pode não ter e-mail
(chega pelo WhatsApp), mas **não tem conta acessível**: sem e-mail, `POST .../invite` responde 409
`EMAIL_REQUIRED`, o magic link e o login nunca casam, e o botão fica desabilitado com a explicação.
Tirar o e-mail de quem tinha acesso corta o acesso. O telefone é obrigatório e **único por tenant**
(409 `PHONE_IN_USE`, também na variante com ou sem o 9º dígito); `ensurePortalUser(email, name,
phone)` e `confirmPortalSignup` levam o telefone ao `portal_user` e ao `customer`. O portal segue
com a lista fechada de colunas (`findPortalCustomer`): nada de etiqueta ou campo adicional.
Detalhes: `tech/28-crm-cadastro.md`.

## Fora desta fase

2FA no portal (fase 9), exportação e exclusão LGPD (fase 10), `/portal/faturas` real (fluxo b),
subdomínio por tenant, troca de e-mail pelo cliente e `Reply-To` do owner no convite.

## Exportação e exclusão do cliente (fase 10)

- `POST /api/portal/me/export`, `GET /api/portal/me/export` e `GET /api/portal/me/export/:id/download?sig=` (sessão do portal **e** assinatura). O zip traz perfil, cadastros nas organizações, consentimentos e auditoria.
- `DELETE /api/portal/me`: com senha, confirma e agenda (30 dias); sem senha, envia link de confirmação e responde 202. `POST /api/portal/me/deletion/confirm { token }` consome o token (uso único, 1 hora, só para a mesma pessoa). `POST /api/portal/me/deletion/cancel` desiste.
- A anonimização troca o `portal_user` e **todos** os `customer` ligados a ele ou ao mesmo e-mail (nome "Cliente removido", e-mail `deleted+<id>@invalid`, `blocked`).
- `consentRequired` em `/api/portal/me` e re-aceite em `POST /api/portal/me/consent`. O autocadastro grava o aceite (`consent_log`, `subject_type = portal_user`).
- `portal_session` e `portal_verification` vencidos saem no `maintenance.prune`.

## Edição e exclusão pelo `/admin` (admin-crud)

- `GET /api/admin/portal-users/:id`: pessoa (verificado, senha definida, sessões vivas),
  vínculos `[{ tenant: { id, name }, status, lastLoginAt }]` e exclusão pendente. Tela em
  `/admin/usuarios/portal/:id`; a linha da lista de usuários leva até ela.
- `PATCH /api/admin/portal-users/:id { name?, email? }`: o nome é o de `portal_user` (o
  `customer.name` de cada tenant é do owner). O e-mail muda na pessoa e em **todos** os vínculos
  (`customer.portal_user_id`), numa transação (`withPlatformScope("admin: e-mail do portal")`):
  outra pessoa com o endereço é 409 `EMAIL_TAKEN`; algum tenant com outro cliente no endereço é
  409 `EMAIL_TAKEN { tenants: [{ id, name }] }`, e nada muda. Depois,
  `revokeUnprovenAccountAccess` (`src/lib/admin/people.ts`): não verificado, sem senha e sem
  sessões; o endereço novo entra por magic link, que prova a posse. Aviso `email-changed` ao
  antigo; auditoria `admin.portal_user_updated` e, em cada tenant, `customer.updated` com
  `actor_type = platform`.
- `DELETE /api/admin/portal-users/:id { mode, confirm, reason? }` e `.../deletion/cancel`
  (`tech/22-admin.md`). Agendar encerra as sessões; `customer.status` não muda, para o
  cancelamento não perder o estado.
- **Barreira na carência:** pedido `pending` com `origin = platform` (`portalAccessBarred`,
  `src/lib/lgpd/deletion.ts`) barra a sessão em `requirePortalAuth` (401, como sessão
  inexistente; falha da checagem é 503), o pedido de magic link (`requestPortalLogin` não envia;
  a resposta pública não muda), a criação de qualquer sessão (`databaseHooks.session.create.before` do
  `portalAuth` recusa: um link enviado antes responde o 400 de link inválido) e o `sign-in/email`: a senha vai trocada por uma aleatória ao
  Better Auth, que responde o mesmo 401 de senha errada (corpo, cabeçalhos e tempo). O pedido da
  própria pessoa (`origin = self`) não barra: ela entra para desistir.
