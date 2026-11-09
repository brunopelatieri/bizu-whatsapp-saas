# Cadastro CRM: telefone, e-mail do cliente, etiquetas e campos

- **Escopo:** Telefone obrigatório em todo cadastro de pessoa, e-mail opcional do cliente,
  etiquetas e campos adicionais do tenant (A1 a A3) e da plataforma sobre as organizações (A4).
  Estado por fase na tabela abaixo.
- **Specs relacionadas:** `docs/specs/crm-cadastro/spec.md` e `prd.md`;
  `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T7, fase F0 e fases A1 a A4).
- **Paths do código:** `src/lib/phone/`, `src/lib/schemas/phone.ts`,
  `src/components/ui/phone-field.tsx`, `src/db/phone-check.ts`, `src/lib/tenant/customers.ts`,
  `src/lib/lgpd/consent.ts`, `src/lib/portal/`, `src/lib/admin/people.ts`, `src/lib/crm/`,
  `src/api/{tags,custom-fields}.ts`, `src/components/crm/`, `src/components/app/crm/`,
  `src/lib/crm/organization-profile.ts`, `src/api/admin.ts` (bloco `/api/admin/crm/*`),
  `src/components/admin/tenant-annotation-card.tsx`, `src/routes/admin/crm-{tags,fields}.tsx`

## Estado por fase

| Fase | Entrega | Estado |
|---|---|---|
| A1 | Telefone obrigatório (biblioteca, schema, `PhoneField`, banco, cadastros) e e-mail do cliente opcional | implementada |
| A2 | Etiquetas do tenant (`tag`, `customer_tag`) | implementada |
| A3 | Campos adicionais do tenant (`custom_field`, `customer.custom_fields`) | implementada |
| A4 | Etiquetas e campos da plataforma (`organization_tag`, `organization_profile`) | implementada |

## Telefone (A1)

- **Formato canônico:** só dígitos, com DDI, sem `+` (`5511987654321`), em `phone_normalized`.
  `phone_key` é a chave de comparação: para celular do Brasil, `55` + DDD + os 8 últimos dígitos
  (o número sem o 9º dígito), igual com e sem o 9; para fixo e estrangeiro, o próprio número.
  `phone` guarda o que a pessoa digitou. As três colunas existem em `customer`, `user` e
  `portal_user` e são calculadas **no servidor** por `phoneColumns`/`phoneValues`
  (`src/lib/phone/columns.ts`), nunca vindas do corpo.
- **`normalizePhone`** (`src/lib/phone/br.ts`, puro, serve formulário e API): com `+55` ou sem
  `+`, regra do Brasil (DDD entre os 67 da Anatel; celular de 11 dígitos com `9` depois do DDD;
  fixo de 10 dígitos; celular antigo de 8 dígitos começando em `9`, aceito com aviso e **nunca
  completado**). Qualquer outro DDI com `+` é `foreign`: só E.164 de 8 a 15 dígitos. Motivos de
  recusa (`PhoneRejectReason`) têm mensagem em português (`phoneErrorMessage`); fixo e celular
  antigo têm aviso (`phoneWarning`). Só `mobile` e `foreign` iniciam conversa (`canWhatsApp`).
  Referência das regras: `docs/references/mobile_number_brasil_guide.md`.
- **`phoneSchema`** (`src/lib/schemas/phone.ts`) é obrigatório em `signupSchema` (e, por herança,
  `portalSignupSchema`), `portalProfileSchema`, `customerSchema` e na edição de pessoa do
  `/admin` (`updateUserSchema`). O `PATCH` pode omitir o telefone, mas apagá-lo é 400.
- **Banco:** `CHECK` `*_phone_required` nas três tabelas: `phone_normalized` e `phone_key`
  não nulos, **exceto** a linha anonimizada pela LGPD (`coalesce(email,'') LIKE
  'deleted+%@invalid'`; o `coalesce` fecha o buraco do cliente sem e-mail). Índice único parcial
  `customer_tenant_phone_key_idx (tenant_id, phone_key)`: telefone **único por tenant** no
  cliente, também na variante com ou sem o 9º dígito. Em `user` e `portal_user` o índice não é
  único (duas pessoas podem dividir o número). A migration `0024` aborta com mensagem clara se
  houver cadastro anterior (o projeto é novo: sem backfill); em desenvolvimento, recrie o banco.
- **Cliente (`src/lib/tenant/customers.ts`):** `PHONE_IN_USE` (409, com `customerId` e, só para
  quem tem `customer:read`, o `name`) antes de gravar e `23505` do índice como rede de segurança;
  `INVALID_PHONE` (400, com `reason`) e `PHONE_REQUIRED`. O `phoneKey` não sai na resposta.
- **Cadastro de conta:** o telefone viaja no contexto de `withSignupConsent`
  (`src/lib/lgpd/consent.ts`, `AsyncLocalStorage`); `databaseHooks.user.create.before` das duas
  instâncias (`auth` e `portalAuth`) grava as três colunas por `signupPhoneValues` e **recusa** a
  criação sem telefone válido, então chamar o Better Auth direto também falha fechado.
  `additionalFields` de telefone têm `input: false`. `ensurePortalUser` (convite e ativação por
  `status`) e `confirmPortalSignup` gravam o telefone do cliente por `INSERT` direto, que não passa
  pelo hook. O seed grava as três colunas.
- **`PhoneField`** (`src/components/ui/phone-field.tsx`): `react-phone-number-input/min`, seletor de
  país (Brasil como padrão), máscara ao digitar e aviso do `phoneWarning`. O valor que sobe é o
  E.164 com `+`; quem valida é `phoneSchema`, no formulário e de novo no servidor. Montar o valor
  inicial com `toPhoneFieldValue(phoneNormalized)`; exibir com `displayPhone`/`formatPhoneForDisplay`.
- **Segurança:** telefone é dado pessoal. Nunca em `logError`, Sentry ou `metadata` da auditoria;
  o `admin.user_updated` só diz `phone: true`. Para citar, `maskPhoneForLog` (`55 11 9****-4321`).

## E-mail opcional do cliente (A1)

Só tem conta acessível quem tem e-mail. `customer.email` é anulável (índice único
`(tenant_id, email)` aceita vários nulos). Sem e-mail: `POST /api/customers/:id/invite` responde 409
`EMAIL_REQUIRED`, o magic link e o login nunca casam (comparação com nulo), e a tela mostra
"Enviar acesso" desabilitado com "Cadastre um e-mail para liberar o acesso do cliente". Tirar o
e-mail de quem já tinha acesso corta o acesso (mesma regra de trocar o e-mail). O código de erro
de e-mail repetido segue `CUSTOMER_EMAIL_TAKEN`.

## Etiquetas do tenant (A2)

- **Tabelas** (`src/db/schema/crm.ts`, migrations `0025_etiquetas` e `0026_rls_etiquetas`): `tag`
  (`tenant_id` anulável, `scopedPolicy()`; nome único por escopo em `lower(name)`, com dois
  índices, um por `tenant_id` e um parcial para `tenant_id IS NULL`; `CHECK` de `#rrggbb` e de 1 a
  40 caracteres) e `customer_tag` (PK `(customer_id, tag_id)`, `tenant_id` não nulo,
  `tenantPolicy()`). `customer.tags` (texto) saiu na mesma migration, sem backfill.
- **Serviço** `src/lib/crm/tags.ts`, genérico por `Scope` (`createTag`, `updateTag`, `deleteTag`,
  `listTags`, `replaceCustomerTags`, `addCustomerTag`, `removeCustomerTag`, `tagsOfCustomers`): o
  tenant vem do escopo, nunca do corpo; o teto de 100 por escopo é conferido sob
  `pg_advisory_xact_lock`; nome repetido é 409 `TAG_NAME_TAKEN` (nunca mescla); etiqueta de outro
  escopo é 404. Constantes em `src/lib/crm/constants.ts` (100 por escopo, 20 por cliente, cor
  padrão `#3b82f6`); cor normalizada por `normalizeHexColor` (`src/lib/crm/colors.ts`).
- **API** (`src/api/tags.ts`; vínculo em `src/api/customers.ts`): `GET /api/tags` (`customer:read`,
  com `usage`), `POST`, `PATCH`, `DELETE /api/tags[/:id]` (`tag:manage`; o `DELETE` devolve
  `removedFrom`), `PUT` e `DELETE /api/customers/:id/tags/:tagId` (`customer:update`, idempotentes,
  409 `CUSTOMER_TAG_LIMIT`). `POST` e `PATCH /api/customers` aceitam `tagIds` (substitui o conjunto;
  sem ele o `PATCH` não mexe nas etiquetas); `GET /api/customers?tags=<id>,<id>` filtra por qualquer
  uma e a resposta traz `tags: [{ id, name, color }]`. O portal nunca vê etiqueta.
- **Permissões:** `tag:manage` para owner e admin; colaborador aplica (`customer:update`) e lê.
- **Telas:** `/app/configuracoes/etiquetas` (`TagManager`, só com `tag:manage`), `TagPicker` no
  formulário e no detalhe do cliente, filtro por etiqueta e chips (até 3 e "+N") em
  `/app/clientes`; componentes em `src/components/crm/` (`TagChip`, `TagColorPicker`,
  `TagPicker`, `tags-api.ts`), reaproveitáveis pelo atendimento.
- **Auditoria:** `tag.created`, `tag.updated`, `tag.deleted`, só ids (nome e cor nunca). A
  exportação LGPD do owner (`clientes-<slug>.json`) traz `etiquetas` (nomes); a anonimização do
  cliente apaga os `customer_tag` por `cascade`/`customer`.
- Testes: `tests/db/tags.test.ts` (CRUD, isolamento, teto, vínculo, filtro, RBAC) e a matriz de
  `tests/db/rbac.test.ts`.

## Campos adicionais do tenant (A3)

- **Tabelas** (`src/db/schema/crm.ts`, migrations `0027_campos_adicionais` e `0028_rls_campos_adicionais`):
  `custom_field` (`tenant_id` anulável e `scopedPolicy()`; `entity` `customer` do tenant ou `organization`
  da plataforma, esta só na A4, com `CHECK` de escopo; `key` única por escopo e entidade com dois
  índices, um normal e um parcial `WHERE tenant_id IS NULL`; `options` jsonb `[{ value, label }]`;
  `required`, `position`, `archived_at`) e `customer.custom_fields` (jsonb `{ "<id do campo>": valor }`,
  `CHECK` de objeto). A chave é o **id**: renomear o rótulo não toca em valor; `type` e `key` não mudam.
- **Valores** (`src/lib/crm/values.ts`, puro, serve formulário e API): `text` até 500, `number` finito,
  `date` `AAAA-MM-DD` que existe, `boolean`, `select` (um `value` das opções) e `multiselect` (até 20,
  sem repetir). `buildCustomFieldsSchema(defs, { requireAll })` monta o Zod só das definições **ativas**
  (chave desconhecida ou arquivada é recusada); texto vazio, lista vazia e `null` viram "remova".
  O formulário usa `requireAll` (o `required` vale); a API valida os obrigatórios sobre o **estado final**
  do cadastro (`assertRequiredFilled`, 400 `FIELD_REQUIRED`), e só quando o corpo traz `customFields`.
- **Serviço** `src/lib/crm/custom-fields.ts`, genérico por `Scope` como `tags.ts`: teto de 12 campos
  ativos e 50 opções (arquivado não conta; reativar com a lista cheia é 409 `FIELD_LIMIT`), conferido sob
  `pg_advisory_xact_lock`; `FIELD_KEY_TAKEN` (inclui arquivado); `OPTION_IN_USE` (conta quem usa a opção
  tirada; renomear o rótulo mantém o `value`); exclusão pede a `key` digitada (`CONFIRMATION_MISMATCH`) e
  limpa o valor em todos os clientes na mesma transação (`clearedFrom`). Campo de outro escopo é 404. Quem grava valor
  trava as definições com `FOR SHARE` **antes** de travar a linha do cliente (`resolveCustomFields`); a exclusão e a
  edição de opções usam `FOR UPDATE` no campo: nenhum valor órfão e sem deadlock.
  O escopo `platform` já é aceito pelo serviço (a limpeza de valores na exclusão e a contagem de uso da
  plataforma entram na A4, com `organization_profile`).
- **API** (`src/api/custom-fields.ts`): `GET /api/custom-fields?entity=customer&archived=false|true|all&usage=true`
  (`customer:read`; `usage`, a contagem de cadastros com valor, só quando pedido: o gestor), `POST`, `PATCH /:id` (`label`, `options`, `required`, `archived`), `PUT /order` e
  `DELETE /:id { confirm }` (`custom_field:manage`). `customFields` em `POST` e `PATCH /api/customers`
  é **merge por chave** no mesmo `UPDATE` (`custom_fields || $set - $removidas`, com a linha travada):
  `null` remove, ausente não muda; 400 `UNKNOWN_FIELD`, `INVALID_FIELD_VALUE` e `FIELD_REQUIRED`. O
  cliente sai com `customFields`. O portal nunca vê campos (`findPortalCustomer` tem lista fechada).
- **Permissões:** `custom_field:manage` para owner e admin; colaborador preenche (`customer:update`).
- **Telas:** `/app/configuracoes/campos` (`CustomFieldManager`: lista ordenável por setas, diálogo de
  criar e editar, arquivar e reativar, excluir digitando a `key`), `CustomFieldInput` por tipo e
  `custom-fields-api.ts` em `src/components/crm/`, seção "Campos adicionais" no formulário do cliente
  (Zod da `buildCustomFieldsSchema`) e no detalhe (com "campos obrigatórios pendentes"). Filtro por
  campo na lista de clientes fica fora desta entrega.
- **Auditoria:** `custom_field.created|updated|archived|deleted`, só ids e `key` (valor, rótulo e opções
  nunca). **LGPD:** a exportação do owner traz `camposAdicionais` (rótulo, chave e valor legível, inclusive
  de campo arquivado); a anonimização do cliente zera `custom_fields`.
- **Seed:** o tenant `acme` tem três campos de exemplo (origem, nascimento e interesses).
- Testes: `src/lib/crm/values.test.ts` (cada tipo e `buildCustomFieldsSchema`),
  `tests/db/custom-fields.test.ts` (CRUD, teto, isolamento, merge concorrente, `OPTION_IN_USE`, exclusão,
  `required`, portal), `lgpd-export`/`lgpd-deletion` e a matriz de `tests/db/rbac.test.ts`.

## Etiquetas e campos da plataforma (A4)

A plataforma classifica e anota as **organizações** com as mesmas peças do tenant, sobre `Scope =
platform`. **Regra central: o owner e a equipe do tenant nunca veem a anotação.**

- **Tabelas** (migrations `0029_crm_plataforma`, `0030_rls_crm_plataforma` e
  `0031_audit_escopo_plataforma`): `organization_tag` (PK `(organization_id, tag_id)`) e
  `organization_profile` (`organization_id` PK, `custom_fields` jsonb por **id** do campo, `updated_by`),
  ambas **sem `tenant_id`**, com `platformOnlyPolicy()` + `FORCE`, `cascade` na organização. Só
  `withPlatformData` (ou o bypass de jobs e do seed) lê e grava; `withTenant` e o `bizu_app` cru leem
  vazio. As etiquetas e campos em si são `tag`/`custom_field` com `tenant_id` nulo (`entity =
  organization`), sob o `scopedPolicy()` da A2 e A3: o tenant nunca recebe linha de `tenant_id` nulo.
  A `0031` troca a política do `audit_log` por `scopedPolicy()`: sem isso, o evento da plataforma (sem
  `tenant_id`) era recusado dentro de `withPlatformData` (lacuna da F0).
- **Serviços:** `tags.ts` e `custom-fields.ts` ganharam o escopo da plataforma por inteiro: `usage`
  (conta `organization_tag` e `organization_profile`), `removedFrom` e `clearedFrom` reais, `OPTION_IN_USE`
  sobre `organization_profile`, `resolveCustomFieldsIn(tx, scope, raw)` e `customFieldsMergeSql(patch, column)`.
  `src/lib/crm/organization-profile.ts` é novo e só `/api/admin/*` o importa: `setOrganizationProfile`
  (etiquetas substituem o conjunto, campos fazem merge por chave, `required` sobre o estado final, lock
  por organização), `getOrganizationAnnotation`, `tagsOfOrganizationPage` e `organizationIdsWithTags`
  (filtro). Organização inexistente, em exclusão (`deleting`/`deleted`) e etiqueta de outro escopo ou
  inexistente respondem 404 igual, sem dizer qual. Nunca use `withPlatformScope` para ler a anotação.
- **API** (`src/api/admin.ts`): `GET`, `POST /api/admin/crm/tags` e `PATCH`, `DELETE .../:id`;
  `GET`, `POST /api/admin/crm/custom-fields` (`entity` padrão `organization`; `customer` é 400
  `INVALID_ENTITY`), `PATCH`, `DELETE .../:id` e `PUT .../order`; `PUT /api/admin/tenants/:id/profile
  { tagIds?, customFields? }`; `GET /api/admin/tenants` soma `tags` por linha e o filtro `tags=<id>,<id>`
  (qualquer uma; resolvido em `withPlatformData`, depois entra como `organization.id IN (...)`);
  `GET /api/admin/tenants/:id` soma `tags` e `customFields`. Leitura: `platform_owner` e
  `platform_support`; **toda escrita** é `ownerOnly` + `blockWhileImpersonating` antes da validação
  (suporte recebe 403).
- **Auditoria:** `admin.tag_created|updated|deleted`, `admin.custom_field_created|updated|archived|deleted`
  e `admin.tenant_profile_updated`, com `actor_type = platform` e **sem `tenant_id`** (com ele o owner
  leria o evento em `/app/auditoria`); só ids e `key` em `metadata` (nome, cor, rótulo e valor nunca).
- **Telas:** `/admin/configuracoes/etiquetas` e `/campos` (`routes/admin/crm-tags.tsx`, `crm-fields.tsx`,
  links no cartão "Organizações: etiquetas e campos" de `/admin/configuracoes`) reaproveitam `TagManager` e
  `CustomFieldManager` com a API por props (`platformTagsApi`, `platformFieldsApi` em
  `src/components/crm/`; `readOnly` para o suporte); `/admin/tenants` ganha filtro por etiqueta
  (`?tags=`) e chips; `/admin/tenants/:id` ganha o cartão "Etiquetas e campos"
  (`TenantAnnotationCard`: editável só por `platform_owner`, texto para o suporte). `TagPicker` e
  `CustomFieldInput` são os mesmos do cliente. Sem `loader` em `/admin`.
- **LGPD:** a anotação é dado da **plataforma** sobre a organização, não do titular: **não** entra na
  exportação do owner (`export.ts` nunca a lê; teste prova) e a anonimização da organização
  (`anonymizeTenant`) apaga `organization_tag` e `organization_profile` (a linha da organização fica,
  então o `cascade` não dispara e o texto livre dos campos poderia citar pessoas). Ver `lgpd.md`.
- Testes: `tests/db/crm-platform.test.ts` (RBAC: suporte lê e leva 403 nas escritas; CRUD; unicidade com
  `tenant_id` nulo; `usage` e `removedFrom` reais; anotação, filtro `tags=` e validações; 404 sem dizer
  qual; auditoria sem dado; **nenhuma rota de tenant devolve dado da plataforma**), `tests/db/rls.test.ts`
  (as duas tabelas e `tag`/`custom_field` nos modos), `admin.test.ts` (matriz de acesso),
  `lgpd-export`/`lgpd-deletion`.

## O que a SPEC pede e ainda não existe

Nada do `crm-cadastro`: o programa fecha com a A4. Não existe tela de perfil da equipe: o telefone
da equipe entra no `/cadastro` e é editado pelo proprietário da plataforma em `/admin/usuarios/:id`.
Filtro por campo adicional segue fora (decisão da SPEC).
