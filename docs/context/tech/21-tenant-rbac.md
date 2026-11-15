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

**Plataforma (C6):** o atendimento de `/admin` não usa `inbox:*` do tenant: `platform_owner` e `platform_support` leem e respondem
(`platformCapabilities`, `src/lib/inbox/platform.ts`; `assign` e `supervise` não existem lá). É a única escrita do `platform_support`
em `/admin` (`tech/22-admin.md`); o papel de plataforma é conferido no servidor por `requirePlatform`.

`requireTenant` carrega o papel e as permissões a cada requisição (`loadRoleCatalog`), com
os papéis personalizados do tenant. Quem foi removido ou teve o papel trocado perde o acesso
na hora. `requirePermission` e `/api/me` usam a mesma lista, comparada com `hasPermission`
do plugin em `tests/db/rbac.test.ts`.

`channel:read` (owner, admin e membro) e `channel:manage` (owner e admin; atribuível a papel
personalizado) valem para os números de WhatsApp (`docs/specs/whatsapp-canais/spec.md`); as rotas
`/api/channels/*` entram com a etapa B1 e a matriz `tests/db/rbac.test.ts` as cobre então.

`phone:confirm` (liberar à mão o telefone de membros e clientes, `tech/28`) é **reservada**: só o
owner tem, e não entra em papel personalizado. Protege `GET /api/phone-verifications` e
`POST /api/phone-verifications/:id/confirm`. O que o owner libera vale **só na organização**
(`phone_tenant_vouch`), e ele não libera o próprio telefone nem o de quem é owner de alguma
organização. Sair da equipe ou virar owner mexe nos pedidos e nas liberações: `removeMember`
chama `phoneAfterMemberLeft`, e a troca de papel e a criação de organização chamam
`routeVerificationToPlatform`.

**`removeMember` e a ficha de cliente da própria pessoa (D-11):** além de apagar `member`, apaga, na mesma
transação, a ficha de cliente **ligada à pessoa** (`customer.user_id`) **naquela organização** e o conteúdo dela
(contatos do telefone confirmado da pessoa, conversas, mensagens, arquivos); os outros contatos da ficha só perdem o
vínculo. Nenhuma outra ficha é tocada, e trocar o papel não apaga nada. A equipe mantém a ficha desfazendo a ligação
antes (`DELETE /api/customers/:id/team-link`, `customer:update`). Ligar à mão também é `customer:update`
(`PUT /api/customers/:id/team-link`, só a membros desta organização com o telefone confirmado no sistema, nunca a si
mesmo, fora da personificação), e
a ligação feita à mão é apagada com a pessoa exatamente como a automática.

**`phone:confirm` e o `claim` (D-1):** a liberação à mão nunca fecha um `claim` (409 `CLAIM_LINK_ONLY`): sem prova de
posse, o owner não apaga a ficha de ninguém por ela. Não existe `claim` pedido pela equipe (decisão do proprietário de
2026-11-14): `customer:create` com número de outra ficha recebe 409 `PHONE_IN_USE`. `GET /api/team` devolve `customerRecord` por
membro só a quem tem `member:delete`, para o diálogo de remoção avisar (`tech/28-crm-cadastro.md`, "Ficha de
quem é da equipe: o que a remoção apaga").

`inbox:read`, `inbox:reply`, `inbox:assign` e `inbox:supervise` são da caixa de entrada
(`docs/specs/caixa-de-entrada/spec.md`, `tech/30-caixa-de-entrada.md`): owner e admin têm as quatro,
membro `read` e `reply`; todas atribuíveis a papel personalizado; `supervise` sem `read` não tem
efeito (`inboxCapabilities`, `src/lib/inbox/visibility.ts`). A visibilidade por pessoa não é do
RBAC: `requirePermission` só abre a rota, e `visibleConversation` decide qual conversa a pessoa vê.

**Gancho da caixa de entrada:** `removeMember` e `changeMemberRole` (para papel sem `inbox:reply`)
chamam `releaseAssignments` na mesma transação: as conversas da pessoa voltam à fila. Editar as permissões de um
papel personalizado (`PATCH /api/roles/:id`) chama `releaseAssignmentsWithoutReply` depois da gravação (C7): quem ficou
sem `inbox:reply` devolve as conversas (fora da transação do Better Auth; ver `tech/30`, "Limites conhecidos").
Anonimizar uma pessoa (`lgpd.delete`) também devolve as conversas dela e tira a autoria das mensagens (`tech/30`, "LGPD (C7)").

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
`customer.updated`, `customer.deleted`, `customer.invited`, `tag.created`, `tag.updated`,
`tag.deleted`, `custom_field.created`, `custom_field.updated`, `custom_field.archived`,
`custom_field.deleted` (só ids e `key`; valor de campo nunca), `inbox.conversation_claimed`,
`inbox.conversation_assigned`, `inbox.conversation_released`, `inbox.conversation_closed`,
`inbox.conversation_reopened`, `inbox.contact_linked`, `inbox.contact_saved_as_customer`, `inbox.conversation_continued` (X2), `inbox.message_favorited`, `inbox.message_unfavorited` (só ids;
texto e telefone nunca). Na plataforma os mesmos eventos levam o prefixo `admin.` (`admin.tag_created|updated|deleted`, `admin.custom_field_created|updated|archived|deleted`) e `admin.tenant_profile_updated`, com `actor_type = platform` e **sem `tenant_id`**: nunca aparecem em `/app/auditoria`. Ações do próprio cliente gravam
`actor_type = portal_user`: `portal.signed_up`, `portal.profile_updated`, `portal.password_set`.

Evento sem tenant só aparece com `withPlatformScope`. Ainda não há tela de leitura.

## Limites

`src/lib/auth/constants.ts`: 20 papéis por tenant e convite de 48 h, tetos fixos do plugin. O limite
de **assentos** vem do plano: convidar e aceitar passam por `withinLimit(tenantId, "members", …)`
(conferência e gravação do convite ou do membro sob `pg_advisory_xact_lock` por organização e métrica,
Q1) e respondem 403 `PLAN_LIMIT_REACHED` (`tech/23-billing-planos.md`). Reenvio, cancelamento e remoção
não tomam a trava. Quantas organizações o dono
pode ter também vem do plano (`limits.organizations`, `src/lib/billing/organizations.ts`), conferido
com lock por pessoa em `POST /api/tenant`, o único caminho de criação.

## Fora desta fase

`requireTenant` trata `status` e `access_mode`; quem os altera é `/admin` (suspender) e o job
`billing.trial` (`read_only`). O trial começa no onboarding (`tech/23-billing-planos.md`).
Ainda não existem: perfil de cobrança, `/app/auditoria`, `POST /api/team/transfer`, sair da organização por conta própria,
`/trocar-organizacao` e `DELETE /api/tenant` (fase 10).
