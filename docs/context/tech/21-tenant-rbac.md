# Tenant, equipe e RBAC

- **Escopo:** Tenant ativo, isolamento, papéis e permissões, equipe, convites e auditoria.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-tenant-rbac.md`, `spec-dados.md`, `spec-seguranca.md`
- **Paths do código:** `src/lib/auth/permissions.ts`, `src/lib/tenant/`, `src/lib/audit.ts`, `src/lib/schemas/{tenant,team,roles}.ts`, `src/api/{permissions,tenant-errors,me,tenant,team,roles,invitations}.ts`, `src/db/rls.ts`, `src/db/tenant-policy.ts`, `src/db/schema/{tenant,audit}.ts`, `src/components/auth/can.tsx`, `src/components/app/`, `tests/db/{rls,rbac,team,tenant-http}.test.ts`

## Modelo

Tenant é a `organization` do Better Auth. Uma pessoa pertence a N tenants por `member`, e o
ativo fica em `session.active_organization_id`. Nada na URL identifica o tenant.

A sessão nova abre em `user.last_tenant_id`, se a pessoa ainda for membro, ou no tenant mais
antigo (`databaseHooks.session.create.before`). Removida do tenant ativo, `GET /api/me`
passa a sessão para o preferido, ou a nenhum, e a interface manda ao onboarding.

## O plugin não responde por HTTP

`/api/auth/organization/*` responde 404 (`src/api/auth-ext.ts`). As rotas do plugin pulam
`requireTenant`, permissões reservadas, a regra de não conceder papel maior que o seu e a
auditoria. Tudo passa pelas rotas próprias, que chamam `auth.api.*` no servidor.

O tenant ativo é gravado por `activateTenant`, sem `setActive`. O `session_data` do cookie
fica com o valor antigo por até 5 minutos, e por isso **nada lê o tenant ativo dele**:
`requireAuth` desliga o cache, a interface usa `/api/me`, e toda chamada a `auth.api.*`
passa `organizationId` explícito.

## Rotas

| Rota | Autorização | Observação |
|---|---|---|
| `GET /api/me` | `requireAuth` | `user`, `tenants[]`, `permissions[]`, `features[]`, `limits{}` |
| `GET /api/me/invitations` | `requireAuth` | convites abertos para o e-mail, só se verificado (senão `[]`) |
| `POST /api/tenant` | `requireAuth` | cria e ativa; slug gerado se não vier; 409 `SLUG_TAKEN`; 403 `PLAN_LIMIT_REACHED` acima de `limits.organizations` |
| `GET /api/tenant` | `requireTenant` | |
| `PATCH /api/tenant` | `organization:update` | só o nome; nome e slug pela plataforma: `PATCH /api/admin/tenants/:id` (`tech/22-admin.md`) |
| `POST /api/tenant/active` | `requireAuth` | troca o tenant; não membro recebe 404 |
| `GET /api/team` | `requireTenant` | `invitations` só com `invitation:create` |
| `POST /api/team/invitations` | `invitation:create` | |
| `POST /api/team/invitations/:id/resend` | `invitation:create` | mantém o link, renova o prazo |
| `DELETE /api/team/invitations/:id` | `invitation:cancel` | |
| `PATCH /api/team/members/:id` | `member:update` | |
| `DELETE /api/team/members/:id` | `member:delete` | |
| `GET`, `POST /api/roles` | `role:create` | |
| `PATCH`, `DELETE /api/roles/:id` | `role:update`, `role:delete` | 409 `ROLE_IN_USE` |
| `GET /api/invitations/:id` | pública | só lê; convite fechado e inexistente são iguais: 404 |
| `POST /api/invitations/:id/accept` | `requireAuth` | e-mail da sessão precisa ser o do convite |

Ordem: `sameOrigin` → `jsonBodyLimit` → rate limit → `requireAuth` → `requireTenant` →
`requirePermission` → `zValidator` → handler. Erros saem por `handleTenantError`.

## Permissões

`statements` em `src/lib/auth/permissions.ts` é o catálogo, para servidor e cliente. Junto
vem o recurso `ac`, que o plugin exige para gerir papéis: só o owner tem, e ele não aparece
em `/api/me`.

`requireTenant` carrega o papel e as permissões a cada requisição (`loadRoleCatalog`), com
os papéis personalizados do tenant. Quem foi removido ou teve o papel trocado perde o acesso
na hora. `requirePermission` e `/api/me` usam a mesma lista, comparada com `hasPermission`
do plugin em `tests/db/rbac.test.ts`.

`channel:read` (owner, admin e membro) e `channel:manage` (owner e admin; atribuível a papel
personalizado) valem para os números de WhatsApp (`docs/specs/whatsapp-canais/spec.md`); as rotas
`/api/channels/*` entram com a etapa B1 e a matriz `tests/db/rbac.test.ts` as cobre então.

Regras além da matriz, em `src/lib/tenant/team.ts`:

- **Só se age sobre quem não tem mais poder que você** (`canActOnRole`). Vale para conceder
  papel, trocar papel, remover e gerir convite. Generaliza "admin não toca owner" e impede
  um papel com `member:update` de promover alguém a `admin`.
- **Último owner** não sai nem é rebaixado: 409 `LAST_OWNER`. Troca e remoção travam os
  membros do tenant com `FOR UPDATE`; sem isso, dois owners se rebaixando ao mesmo tempo
  deixariam a organização sem nenhum.
- Reconvidar cancela o convite anterior: só passa com `invitation:cancel` e `canActOnRole`
  sobre ele. O plugin não confere isso, e a resposta seria derrubar um convite de papel maior.
- O id do convite funciona como link: `GET /api/team` só o mostra a quem pode criar convites
  e só para papéis que poderia conceder.

Reservadas, recusadas por `roleSchema` com 400: `organization:delete`, `role:*`,
`billing:manage`, `support:grant`. O plugin não tem hook para papéis, e por isso a validação
fica na rota. Nome de papel não aceita vírgula: `member.role` a usa como separador, e
`x,owner` valeria como dois papéis.

Renomear papel em uso é recusado, porque `member.role` guarda o nome. Excluir também,
contando convites pendentes.

## Convite

1. `POST /api/team/invitations` chama `auth.api.createInvitation`; `sendInvitationEmail`
   envia `invite-member` em segundo plano. Reconvidar cancela o convite anterior.
2. `/convite/:id` não tem `loader` nem `action`. A página lê `GET /api/invitations/:id`.
3. Sem sessão, mostra o cadastro com o e-mail travado e `Entrar` com `?next=`. Sessão de
   outro e-mail mostra "Saia e entre com esse e-mail".
4. O botão faz `POST /api/invitations/:id/accept`, que exige sessão e e-mail verificado.

Abrir o link não verifica o e-mail. Depois de confirmar o cadastro, a pessoa cai em
`/app/onboarding`, que lista os convites abertos para aquele e-mail: a confirmação pode
acontecer em outro aparelho, e assim o convite não se perde.

## Auditoria

`audit(action, entry)` grava depois de uma ação do Better Auth, e a falha vai para o log.
`auditInTransaction(tx, ...)` grava dentro de `withTenant`, e a falha desfaz a mudança.
`metadata` só leva ids e enums. O IP vira `sha256(ip + AUDIT_SALT)`.

Eventos: `auth.email_verified`, `auth.password_reset`, `tenant.created`, `tenant.updated`,
`member.invited`, `member.invitation_canceled`, `member.joined`, `member.role_changed`,
`member.removed`, `role.created`, `role.updated`, `role.deleted`, `customer.created`,
`customer.updated`, `customer.deleted`, `customer.invited`. Ações do próprio cliente gravam
`actor_type = portal_user`: `portal.signed_up`, `portal.profile_updated`, `portal.password_set`.

Evento sem tenant só aparece com `withPlatformScope`. Ainda não há tela de leitura.

## Limites

`src/lib/auth/constants.ts`: 20 papéis por tenant e convite de 48 h, tetos fixos do plugin. O limite
de **assentos** vem do plano: convidar e aceitar passam por `assertWithinLimit(tenantId, "members")`
e respondem 403 `PLAN_LIMIT_REACHED` (`tech/23-billing-planos.md`). Quantas organizações o dono
pode ter também vem do plano (`limits.organizations`, `src/lib/billing/organizations.ts`), conferido
com lock por pessoa em `POST /api/tenant`, o único caminho de criação.

## Fora desta fase

`requireTenant` trata `status` e `access_mode`; quem os altera é `/admin` (suspender) e o job
`billing.trial` (`read_only`). O trial começa no onboarding (`tech/23-billing-planos.md`).
Ainda não existem: perfil de cobrança, `/app/auditoria`, `POST /api/team/transfer`, sair da organização por conta própria,
`/trocar-organizacao` e `DELETE /api/tenant` (fase 10).
