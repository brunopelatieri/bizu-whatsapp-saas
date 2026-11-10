# Admin da plataforma (/admin)

- **Escopo:** Área do proprietário da plataforma: rotas `/admin/**`, API `/api/admin/*`, papéis, suspensão, usuários, planos e configurações.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-rotas-api.md`, `spec-tenant-rbac.md`, `spec-billing.md`
- **Paths do código:** `src/api/admin.ts`, `src/api/admin-channels.ts`, `src/api/admin-channel-events.ts`, `src/lib/admin/` (`tenants.ts`, `users.ts`, `plans.ts`, `org-links.ts`, `people.ts`, `deletion.ts`), `src/lib/schemas/admin.ts`, `src/lib/constants/admin-nav.ts`, `src/components/admin/`, `src/pages/admin/`, `src/routes/admin/`, `tests/db/admin.test.ts`, `tests/db/admin-catalogo.test.ts`, `tests/db/admin-deletion.test.ts`

## Acesso

| Papel (`user.role`) | Lê | Escreve |
|---|---|---|
| `platform_owner` | tudo | planos, preços, configurações, suspender/reativar, trocar plano, banir |
| `platform_support` | tudo | nada (403) |
| `user` | nada | nada (403 `PLATFORM_FORBIDDEN`) |

`adminRoutes` aplica, em `/api/admin/*`: `sameOrigin` → `jsonBodyLimit` → `authRateLimit` →
`requireAuth` → `requirePlatform()`; cada escrita soma `requirePlatform(["platform_owner"])`
**antes** da validação. O `AdminLayout` manda quem não é da plataforma de volta a `/app`, mas é
só o caminho da interface. Sem `loader` de servidor. Em produção, sem 2FA, toda rota responde 403
`PLATFORM_2FA_REQUIRED`, e o layout leva a `/admin/configuracoes/seguranca`.

## API

| Rota | Quem | Observação |
|---|---|---|
| `GET /api/admin/overview` | plataforma | tenants por estado, usuários, testes acabando em 7 dias, planos ativos, webhooks com falha |
| `GET /api/admin/tenants?q&status&plan&tags&page` | plataforma | `status` é o estado de cobrança; `plan` (uuid) filtra as organizações de um plano; `tags=<id>,<id>` filtra por etiqueta da plataforma (qualquer uma); cada linha traz `tags`; 20 por página |
| `PATCH /api/admin/tenants/:id` `{ name?, slug? }` | owner | mesmas regras do owner (`slugSchema`); 409 `SLUG_TAKEN`, `TENANT_DELETING` (status `deleting`/`deleted`; suspensa edita); sem mudança real responde 200 e não audita; audita `admin.tenant_updated` no `tenant_id` com antes e depois. Gravação direta por Drizzle: o plugin `organization` só atualiza quem é membro, e a plataforma não é (ele só confere o slug, e o banco já tem `organization.slug` único). Trocar o slug quebra `/portal/login?org=` e magic links já enviados (a tela avisa); o `org` só escolhe entre os tenants da pessoa, então slug antigo reaproveitado não abre outra organização |
| `GET /api/admin/tenants/:id` | plataforma | membros, assinatura (período, vencimento, carência, `billingMode`), 12 últimas faturas, preços manuais do plano, últimos eventos e auditoria, e a anotação da plataforma (`tags`, `customFields`) |
| `GET /api/admin/crm/tags`, `GET /api/admin/crm/custom-fields?entity=organization&archived&usage` | plataforma | catálogo de etiquetas e campos das organizações (`tech/28-crm-cadastro.md`) |
| `POST`, `PATCH`, `DELETE /api/admin/crm/tags[/:id]`; `POST`, `PATCH`, `DELETE /api/admin/crm/custom-fields[/:id]`; `PUT .../custom-fields/order` | owner | `ownerOnly` + `blockWhileImpersonating` antes da validação; 409 `TAG_NAME_TAKEN`, `TAG_LIMIT`, `FIELD_KEY_TAKEN`, `FIELD_LIMIT`, `OPTION_IN_USE`; o `DELETE` devolve `removedFrom`/`clearedFrom` reais; audita `admin.tag_*` e `admin.custom_field_*` (só ids e `key`, sem `tenant_id`) |
| `PUT /api/admin/tenants/:id/profile` `{ tagIds?, customFields? }` | owner | grava `organization_tag` (substitui) e `organization_profile` (merge por chave); 404 sem dizer qual para organização inexistente ou em exclusão e etiqueta de outro escopo; audita `admin.tenant_profile_updated` sem `tenant_id` |
| `POST /api/admin/tenants/:id/suspend` `{ reason? }` | owner | `suspended` + `locked`; e-mail `tenant-suspended` aos proprietários (falha no aviso só vai para o log: a suspensão vale e é auditada); 409 `ALREADY_SUSPENDED` |
| `POST /api/admin/tenants/:id/unsuspend` | owner | volta `full`, ou `read_only` se a assinatura expirou; 409 `NOT_SUSPENDED` |
| `PUT /api/admin/tenants/:id/plan` `{ planId }` | owner | plano gratuito encerra o trial, destrava o `read_only`, limpa o período e larga a referência do provedor; plano pago mantém o estado, e do gratuito (sem período) vence **agora**; faturas manuais abertas viram `void`; 409 `PROVIDER_SUBSCRIPTION_ACTIVE` com assinatura viva no provedor (`unpaid` conta como viva: cancele antes) |
| `POST /api/admin/subscriptions/:id/manual-payment` `{ invoiceId?, planPriceId?, method? }` | owner | cobrança manual: fatura aberta (ou nova) paga, assinatura `active` com período novo; 409 `PROVIDER_SUBSCRIPTION_ACTIVE`, `FREE_PLAN`, `MANUAL_PRICE_REQUIRED`, `INVOICE_NOT_OPEN` |
| `POST /api/admin/subscriptions/:id/manual-unpaid` `{ invoiceId?, immediate? }` | owner | fatura `failed`, assinatura `past_due` com carência ou, com `immediate`, `unpaid` + `read_only`; 409 `ALREADY_PAST_DUE` |
| `GET /api/admin/subscriptions?status&q&page` | plataforma | sem referências do provedor; traz `alert` da reconciliação, `billingMode`, `planId`, `trialEndsAt`, `currentPeriodStart` |
| `PATCH /api/admin/subscriptions/:id` `{ status?, currentPeriodEnd?, trialEndsAt?, graceUntil?, reason }` | owner | datas e status pela tabela de `admin-edit-rules.ts` (`tech/24-billing-cobranca.md`, "Edição pelo admin"); com provedor, vai primeiro a ele. 409 `SUBSCRIPTION_CLOSED`, `FIELD_NOT_APPLICABLE`, `STATUS_NOT_ALLOWED`, `FREE_PLAN`, `PROVIDER_UNSUPPORTED`, `PROVIDER_STATUS_MANAGED`, `PROVIDER_UPDATE_FAILED`, `SUBSCRIPTION_CHANGED`; 400 `INVALID_DATE` |
| `POST /api/admin/subscriptions/:id/cancel` | owner | imediato, no provedor e aqui; 409 `ALREADY_CANCELED` |
| `POST /api/admin/subscriptions/:id/sync` | owner | busca do provedor, corrige e alerta; conferido e igual, o alerta sai; 409 `NO_PROVIDER_SUBSCRIPTION` |
| `GET /api/admin/webhooks?status&page` | plataforma | `payment_event` sem `raw`, que tem dado pessoal |
| `POST /api/admin/webhooks/:id/reprocess` | owner | só `failed` ou `ignored` e verificado; 409 `NOT_REPROCESSABLE` |
| `GET /api/admin/channel-events?status&page` | plataforma | `channel_event` de todos os escopos, sem `raw` nem `dedupe_key`; rotas em `src/api/admin-channel-events.ts`, sub-router com a própria cadeia de guardas, montado antes de `adminRoutes` (`tech/29-canais-whatsapp.md`) |
| `/api/admin/channels/*` | leitura: plataforma; escrita: owner | números de WhatsApp **da plataforma** (`tenant_id` nulo): as mesmas rotas de `/api/channels`, montadas por `buildChannelRoutes` em `src/api/admin-channels.ts` (sub-router com a própria cadeia, antes de `adminRoutes`); sem limite de plano; `blockMutationsWhileImpersonating`; auditoria `channel.*` com `actor_type = platform`; a lista traz `providers[tipo].missing` (nomes de variáveis). Ver `tech/29-canais-whatsapp.md` |
| `POST /api/admin/channel-events/:id/reprocess` | owner | só `failed` ou `ignored`; 409 `NOT_REPROCESSABLE`; `blockWhileImpersonating`; reenfileira `channel.inbound`; audita `admin.channel_event_reprocessed` |
| `GET`, `POST /api/admin/plans` | leitura plataforma; escrita owner | 409 `SLUG_TAKEN` |
| `PATCH /api/admin/plans/:id` | owner | parcial, o `slug` não muda; 409 `PLAN_HAS_PRICES` ao marcar gratuito com preço ativo; reativar preço de plano gratuito é 409 `FREE_PLAN_NO_PRICE`; audita `admin.plan_updated` com `fields`. `active: false` é "arquivar" (botão na lista e no detalhe) |
| `DELETE /api/admin/plans/:id` | owner | só plano que nunca chegou a um tenant, em transação com o plano travado: 409 `PLAN_IN_USE` `{ tenants: [{ id, name }] }` (qualquer assinatura, `plan_id` ou `pending_plan_id`; a FK `restrict` cobre a corrida), `PLAN_IS_TRIAL_DEFAULT`, `LAST_FREE_PLAN` (sem `trialPlanId` e único gratuito ativo); os preços saem em cascata; responde `{ ok, providerRefs }` (o que existe no provedor não é apagado; a tela avisa); audita `admin.plan_deleted` |
| `POST /api/admin/plans/:id/prices`, `PATCH .../prices/:priceId` | owner | 409 `PRICE_EXISTS`, 409 `FREE_PLAN_NO_PRICE`; o `PATCH` audita `admin.plan_price_updated` |
| `DELETE /api/admin/plans/:id/prices/:priceId` | owner | 404 se for de outro plano; 409 `PRICE_IN_USE` se `subscription.plan_price_id` ou `metadata.pendingPlanPriceId` o citam (o caminho é desativar); responde `providerRefs`; audita `admin.plan_price_deleted` |
| `GET`, `PATCH /api/admin/settings` | leitura plataforma; escrita owner | `trialPlanId: null` = primeiro plano gratuito ativo; 400 `PLAN_NOT_FOUND`, `TRIAL_PLAN_NOT_FREE` |
| `GET /api/admin/users?q&page&scope` | plataforma | equipe e portal trazem `organizations: [{ id, name, role \| status }]` (as 3 primeiras por nome) e `more` (as demais), no lugar da contagem |
| `POST /api/admin/users/:id/ban` `{ reason? }`, `.../unban` | owner | via `auth.api.banUser`, que encerra as sessões; 409 `SELF_BAN`, 403 `PLATFORM_USER_PROTECTED` |

O plugin `admin` não compara o papel do alvo; por isso `assertBannable` só deixa banir quem tem
papel `user`. Toda escrita grava `audit_log` com `actor_type = platform` (`admin.*`); as de um
tenant levam o `tenant_id`. Tabelas de tenant são lidas com `withPlatformScope(motivo, ...)`.

## Telas

| Rota | Arquivo |
|---|---|
| `/admin` | `pages/admin/overview-page.tsx` |
| `/admin/tenants`, `/admin/tenants/:id` | `tenants-page.tsx` (filtro `?plan=` e `?tags=`, chips de etiqueta), `tenant-detail-page.tsx` (cartão "Etiquetas e campos": `components/admin/tenant-annotation-card.tsx`, editável só por `platform_owner`; "Editar": `components/admin/edit-tenant-dialog.tsx`; excluir e cancelar exclusão com `components/admin/delete-dialog.tsx`); cobrança manual em `components/admin/manual-billing-card.tsx` |
| `/admin/usuarios` | `users-page.tsx`; o nome leva ao detalhe |
| `/admin/usuarios/:id`, `/admin/usuarios/portal/:id` | `user-detail-page.tsx`, `portal-user-detail-page.tsx` (rotas `routes/admin/user.tsx`, `portal-user.tsx`) |
| `/admin/planos`, `/admin/planos/:id` | `plans-page.tsx`, `plan-detail-page.tsx`: arquivar/reativar em botão, "Excluir plano" (desabilitado com uso, pede arquivar) e excluir preço, ambos com `confirm-dialog.tsx` |
| `/admin/assinaturas` | `subscriptions-page.tsx`; menu por linha em `components/admin/subscription-actions.tsx`: editar datas e status (só os destinos de `allowedTargets`, motivo obrigatório), trocar plano, marcar pago/não pago (o mesmo `manual-billing-card`, com os dados de `GET /api/admin/tenants/:id`), buscar do provedor e cancelar |
| `/admin/webhooks` | `webhooks-page.tsx`: abas "Pagamentos" e "Canais" (`?tab=canais`, em `channel-events-tab.tsx`, que abre nos avisos de canal com falha) |
| `/admin/configuracoes/etiquetas`, `/admin/configuracoes/campos` | `routes/admin/crm-tags.tsx`, `crm-fields.tsx`: `TagManager` e `CustomFieldManager` com a API da plataforma por props (suporte só lê); links em `/admin/configuracoes` |
| `/admin/configuracoes/canais` | `routes/admin/channels.tsx`: `ChannelManager` de `src/components/channels/` com `basePath = /api/admin/channels` (suporte só lê) e o aviso das variáveis que faltam no servidor; link em `/admin/configuracoes` e item "Canais" no menu |
| `/admin/auditoria` | `routes/admin/audit.tsx`: log global, por ação, nome da organização (`tenantQ`, `ilike` em `organization.name`) e pessoa |
| `/admin/configuracoes` | `settings-page.tsx`, inclusive a política de acesso do suporte |
| `/admin/configuracoes/seguranca` | `routes/admin/security.tsx`: 2FA de quem administra |

Reaproveitam o shell de `/app`: `AppSidebar`, `AppNav` e `AppTopbar` recebem o menu
(`admin-nav.ts`) por props. Dados por `useAdminQuery`/`useAdminMutation` (`admin-api.ts`);
escrita só aparece para `platform_owner` (`useIsPlatformOwner`). Listagem que cita organização usa `components/admin/org-list.tsx` (nome com link, "+N") sobre `lib/admin/org-links.ts`, que lê `member`, `customer` e `subscription` com função de janela em `withPlatformScope`: uma consulta por página, sem N+1. O menu do usuário mostra
"Administração" para quem tem papel de plataforma. Formulários validam com os schemas de
`src/lib/schemas/admin.ts`; `limits` vazio vira `null` (ilimitado).

## Personificação

`/admin/tenants/:id` mostra, por membro, "Personificar" (com grant ativo ou
`impersonation_policy = allow_without_consent`) ou "Pedir acesso". As duas chamam
`POST /api/admin/impersonate`, aberta a `platform_owner` e `platform_support`; sem consentimento, ela
responde 403 e avisa os owners. A política se edita em `/admin/configuracoes` e só
`platform_owner` a altera. Regras em `tech/26-seguranca.md`.

## Usuários do portal

`/admin/usuarios` tem duas abas. Clientes e leads são outra identidade (`portal_user`):
`GET /api/admin/users?scope=portal` traz as organizações (nome e status do vínculo) e as sessões em aberto, e
`POST /api/admin/portal-users/:id/revoke-sessions`, só do proprietário, derruba as sessões. Não
há banimento: o acesso é de cada tenant, por `customer.status`. O overview conta os clientes
de todos os tenants.

O proprietário da plataforma edita nome, e-mail e **telefone** (obrigatório, nunca apagado) de
usuários de equipe e do portal (`PersonEditCard`); a auditoria (`admin.user_updated`,
`admin.portal_user_updated`) diz só `phone: true`, nunca o número (`tech/28-crm-cadastro.md`).

## Ainda não existe

Overview sem MRR e jobs mortos; `/admin/jobs`.

## Fase 10

- `/admin/configuracoes` edita também `dpoEmail` (aparece em `/legal/*`) e `auditRetentionDays` (30 a 3650, padrão 365).
- `/admin` mostra "Jobs mortos": soma das filas `*.dead` do pg-boss (`src/lib/admin/jobs.ts`), `—` se a fila não responder.
- `/admin` mostra "Consumidores da fila": processos vivos por modo (`inline`, `worker`), com alerta para os dois juntos ou nenhum (`tech/20-jobs.md`).

## Exclusões e pessoas (admin-crud, trilha C)

SPEC: `docs/specs/admin-crud/spec.md` (seções 1 a 3). Lógica em `src/lib/admin/deletion.ts`
(exclusões) e `src/lib/admin/people.ts` (detalhe, edição, sessões); o núcleo LGPD é o de
`src/lib/lgpd/deletion.ts` (`tech/27-lgpd-arquivos.md`). Toda escrita é `ownerOnly` +
`blockWhileImpersonating`; sessão personificada já cai no `requirePlatform` (papel do alvo).

| Rota | Quem | Observação |
|---|---|---|
| `DELETE /api/admin/tenants/:id` `{ mode, confirm, reason? }` | owner | `confirm` = slug (400 `CONFIRMATION_MISMATCH`); encerra no provedor antes (409 `PROVIDER_CANCEL_FAILED`, nada agendado); aceita organização suspensa; 409 `DELETION_PENDING` |
| `POST /api/admin/tenants/:id/deletion/cancel` | owner | só pedido `origin = platform` (409 `DELETION_NOT_PLATFORM`, `NO_PENDING_DELETION`); devolve `active` (`read_only` se a assinatura foi encerrada) ou a suspensão anterior |
| `GET /api/admin/tenants/:id/deletion` | plataforma | `{ deletion: { scheduledFor, origin } | null }` |
| `GET /api/admin/users/:id` | plataforma | perfil, papel, 2FA, banido, sessões vivas, organizações (nome, slug, papel, estado de cobrança, plano), exclusão pendente |
| `PATCH /api/admin/users/:id` `{ name?, email? }` | owner | e-mail: 409 `EMAIL_TAKEN`; desverifica, encerra sessões, apaga a senha e os tokens de reset, `email-changed` ao antigo e link de definir senha ao novo (o reset marca verificado, `tech/08-auth.md`); auditoria `admin.user_updated` com os campos (sem valores) |
| `POST /api/admin/users/:id/revoke-sessions` | owner | `{ revoked }` |
| `DELETE /api/admin/users/:id` `{ mode, confirm, reason?, deleteSoleOrganizations }` | owner | `confirm` = e-mail; único owner sem a flag: 409 `LAST_OWNER { tenants }`; com ela, cada organização segue o mesmo `mode` (provedores encerrados antes de tudo). Agendar bane (motivo "Exclusão agendada pela plataforma"; já banido fica como estava) e encerra as sessões na mesma transação |
| `POST /api/admin/users/:id/deletion/cancel` | owner | desbaneia só se `metadata.wasBanned` era `false`; organizações agendadas junto têm o próprio cancelamento |
| `GET`, `PATCH`, `DELETE /api/admin/portal-users/:id`, `.../deletion/cancel` | leitura plataforma; escrita owner | regras em `tech/25-portal-clientes.md` |

- **Alvo:** `assertManageableUser` aceita papel `user` e `platform_support`; `platform_owner` é
  403 `PLATFORM_OWNER_PROTECTED` e o próprio ator, 409 `SELF_ACTION`. Banir continua em
  `assertBannable` (só papel `user`). Conta já anonimizada responde 404.
- **`mode`:** `scheduled` = 30 dias, reversível, acesso cortado na hora; `now` = mesma
  anonimização do job, na hora, sem volta (antecipa pedido pendente de qualquer origem). E-mail
  `deletion-scheduled` (variante da administração) ou `deletion-executed`.
- **Auditoria:** `admin.{tenant,user,portal_user}_deletion_{requested,executed,canceled}` com
  `metadata.mode`; o motivo (texto livre) fica em `deletion_request.metadata.reason`, nunca na
  auditoria. Respostas 409 com dados extras usam `TenantRuleError(..., details)`, que
  `handleTenantError` espalha na raiz do JSON.
- **Telas:** `components/admin/delete-dialog.tsx` (um diálogo para tudo: agendar ou excluir
  agora, digitar o slug ou o e-mail, motivo), `deletion-status.tsx` (faixa da exclusão pendente),
  `person-edit-card.tsx`, `tenant-deletion-card.tsx` (em `/admin/tenants/:id`).
