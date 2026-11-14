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
  `src/components/admin/tenant-annotation-card.tsx`, `src/routes/admin/crm-{tags,fields}.tsx`,
  `src/api/phone-gate.ts`, `src/components/phone/` (portão e tela da T3)

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

## Telefone verificado e único (pré-produção, T1, T2a, T2b e T3)

SPEC: `docs/specs/pre-producao/spec.md`, bloco T. A T1 entrega o estado e a unicidade; a T2a, o
pedido de verificação, a confirmação pelo link e a liberação manual; a T2b, o **envio** do link
pelos canais e a página `/verificar-telefone`; a T3, o bloqueio de acesso com telefone pendente
(seções seguintes). As telas das filas e do modelo são da T4.

- **Estado de verificação:** `phone_verified_at` e `phone_verified_via` em `customer`, `user` e
  `portal_user` (`src/lib/phone/verification.ts`). Nulos = número só **declarado**. Formas:
  `whatsapp` (clique no link, T2), `manual` (liberado pelo responsável), `team` (telefone de
  cliente informado pela equipe) e `inbound` (cliente salvo de um contato que escreveu). O `CHECK`
  `*_phone_verified_consistent` (`src/db/phone-check.ts`) exige as duas colunas juntas, a forma
  conhecida e que exista número. **Nas contas (`user`, `portal_user`) só valem `whatsapp` e
  `manual`** (`CHECK` `*_phone_via_global`): a conta é global e a coluna só guarda o que vale
  no sistema inteiro; `team` e `inbound` são formas da ficha.
- **Quem grava o quê:**

  | Onde | Estado |
  |---|---|
  | Cliente criado ou com telefone trocado pela equipe (`customers.ts`) | `team` |
  | "Salvar como cliente" no atendimento, com o número de um contato que escreveu | `inbound` (`team` se o atendente corrigiu o número, ou se o contato foi aberto pela própria equipe) |
  | Cadastro da equipe (`/cadastro`, convite) | pendente |
  | Autocadastro do portal e a ficha que nasce dele (`confirmPortalSignup`) | pendente |
  | Conta do portal criada pelo convite da equipe (`ensurePortalUser`) | **sempre pendente**: a conta é global e outra identidade, e nada do que uma organização sabe da ficha a confirma |
  | Cliente troca o próprio telefone em `/portal/conta` | **volta a pendente**, decidido **por linha**: a conta quando o número dela muda, a ficha quando o dela muda (as duas podem ter números diferentes, e a confirmação de uma nunca serve à outra) |
  | Edição de pessoa em `/admin` | `manual` |
  | Seed e cadastros anteriores à migration `0035` | contas: `manual`; fichas de cliente: `team` (a `0036` converte as que a `0035` marcou `manual`, porque `manual` na ficha passou a ser "declarado pelo cliente e liberado pelo owner", que não atrai conversa) |
  | Anonimização (LGPD) | nulos, junto com o número |

- **Para que serve já na T1:** o vínculo da conversa só usa telefone confirmado, tanto o
  automático da ingestão (`autoLinkContact`) quanto o de "Conversar" pela ficha ou pelo membro
  (`destinationPhone`; com telefone pendente a conversa abre sem vínculo e a equipe decide no
  painel, onde cada candidato traz `phoneVerified`). A unicidade das contas só conta número
  confirmado.
- **Unicidade por grupo** (`src/lib/phone/uniqueness.ts`): owners no SaaS inteiro; equipe por
  organização (owner incluído); clientes por organização (índice único, como antes); equipe da
  plataforma entre si. **Cliente e equipe da mesma organização podem ter o mesmo número.** `user` é
  global e o papel fica em `member`, então nas contas não há índice: quem confirma um número chama
  `lockPhoneKey` e `accountPhoneConflicts` na mesma transação. Os pontos que confirmam número
  de conta são a edição pelo `/admin` e as confirmações de `src/lib/phone/requests.ts`; todos
  recusam com 409 `PHONE_IN_USE` quando outra conta do mesmo grupo já tem o número (menos o link
  do pedido da plataforma, em que quem provou fica com o número). Número só declarado não reserva
  nada. **Limite conhecido:** aceite de convite, criação de organização e transferência de posse
  não conferem a unicidade de quem **já** está confirmado, e o backfill da `0035` marcou como
  confirmados os números que já existiam; duas contas do mesmo grupo podem estar com o mesmo
  número confirmado. O efeito é seguro (com dois candidatos nada é vinculado nem ligado).
- **Conta da equipe só com WhatsApp:** `whatsappPhoneSchema` (`src/lib/schemas/phone.ts`) recusa
  fixo e celular antigo de 8 dígitos no `/cadastro`, no convite e na edição de `user` pelo
  `/admin`; `signupPhoneValues("user")` repete a regra no hook do Better Auth. Cliente e conta do
  portal continuam aceitando fixo.
- **Equipe que também é cliente** (`src/lib/tenant/team-customer.ts`): `customer.user_id` liga a
  ficha à conta da pessoa na mesma organização (uma ficha por pessoa, índice único parcial). São
  dois cadastros separados, que podem ter o mesmo telefone e e-mail. A ligação automática é **só
  pelo telefone da conta confirmado para o sistema inteiro** (`userPhoneConfirmedGlobally`; a
  liberação de uma organização não basta) (no aceite do convite, confirmado dos dois lados), ao criar
  o cliente (`matchingTeamMember`) e no aceite (`linkMemberCustomer`), e é auditada
  (`customer.team_linked`). O e-mail nunca liga sozinho: é texto de quem cadastra, e a ficha
  ligada será apagada quando a pessoa sair da equipe (D-11). A exclusão da conta desfaz a ligação
  (`anonymizeUser`). A API do cliente devolve `team: { userId, role } | null`, com o papel
  lido de `member` na hora, e `phoneVerified`; `GET /api/customers?team=true` filtra as fichas de
  quem é da equipe.
- **Permissão `phone:confirm`:** reservada ao owner (`tech/21`); é a das rotas de liberação
  manual da organização (seção seguinte).
- **Ainda não existe (T4, troca com pedido, `claim` e bloco E):** a troca de telefone que
  mantém o número antigo até a confirmação (`POST …/phone-change`; hoje a equipe troca direto e o
  cliente do portal volta a pendente, com link para o número novo), o `claim` do portal (D-1), as
  telas das filas e do modelo de verificação, o selo
  e o filtro na tela, ligar e desligar a ficha à mão, e apagar a ficha ligada quando a pessoa sai
  da equipe (D-11).
- **Testes:** `tests/db/phone-verified.test.ts`, `tests/db/phone-requests.test.ts`,
  `tests/db/phone-delivery.test.ts` (envio, T2b), `tests/db/inbox-ingest.test.ts` (vínculo),
  `tests/db/phone-accounts.test.ts`, `src/lib/schemas/phone.test.ts` e, no módulo Cloud,
  `verification.test.ts` e `verification.db.test.ts`.

## Pedido de verificação e liberação (pré-produção, T2a)

Código: `src/lib/phone/requests.ts` (regras), `src/lib/phone/confirmed.ts` (predicados),
`src/db/schema/phone.ts` (tabelas), `src/api/phone-verification.ts` (rotas da equipe e da
organização), mais as rotas em `src/api/portal.ts` e `src/api/admin.ts`. Migration `0036`.

**Regra central: a confirmação vale até onde vale o responsável do pedido.** Qualquer pessoa cria
uma organização, e o canal por QR Code dela é o WhatsApp do próprio owner (ele lê o link que a
organização envia). Então nem a liberação do owner nem o link de um pedido de organização provam
nada fora dela. Só o canal e o proprietário da **plataforma** valem para todos.

- **`phone_verification`** (`scopedPolicy()`, RLS forçado): um pedido aberto por (cadastro,
  responsável). `tenant_id` nulo = a plataforma responde. `subject_type` é `user` ou `customer`
  (`subject_id` sem FK: quem apaga o cadastro apaga os pedidos). Estados: `awaiting_manual`,
  `sent` (há link emitido), `confirmed`, `canceled`. O token (`randomBytes(32)`) só existe no
  link; no banco fica o SHA-256, com validade de `PHONE_VERIFICATION_TTL_MINUTES` (padrão 30).
- **`phone_tenant_vouch`** (`tenantPolicy()`, RLS forçado): a liberação de uma organização para
  a conta de um membro, uma linha por (conta, organização), presa à `phone_key` do momento. A
  conta (`user`) não muda.
- **Predicados (`confirmed.ts`):** `userPhoneConfirmedGlobally` (a conta, `whatsapp` ou
  `manual`), `userPhoneConfirmedIn(tenantId)` (global **ou** liberada naquela organização) e
  `userPhoneConfirmed(scope)`. Toda consulta que pergunta "o número desta conta vale?" usa um
  deles, nunca `phone_verified_at` direto. Use o global para o que cruza organizações (ligar a
  ficha de cliente, unicidade de owners) e o do escopo para o que é da organização (unicidade da
  equipe, vínculo automático da conversa).

| Pedido de | Fechado por | Efeito | Vale |
|---|---|---|---|
| Plataforma | Link, na sessão da conta | conta `whatsapp`; outra conta do grupo com o número volta a pendente (`phone.unverified`, `reason: claimed`) e ganha pedido novo; os outros pedidos da conta são encerrados; as fichas de cliente da pessoa são ligadas | sistema inteiro |
| Plataforma | Proprietário da plataforma | conta `manual`; 409 `PHONE_IN_USE` se outra conta do grupo tem o número | sistema inteiro |
| Organização, conta | Link ou owner (`phone:confirm`) | linha em `phone_tenant_vouch`; 409 `PHONE_IN_USE` se um colega tem o número; 409 `PLATFORM_ONLY` se a pessoa é owner de alguma organização ou da equipe da plataforma (e o pedido é encaminhado) | só na organização |
| Organização, ficha | Link, na sessão do portal | ficha `whatsapp`; liga o contato sem vínculo que já escreveu e a pessoa da equipe com o número | a ficha |
| Organização, ficha | Owner | ficha `manual`; não liga nada e **não atrai** as próximas conversas (`AUTO_LINK_CUSTOMER_VIAS` não inclui `manual`) | a ficha |

- **Quem abre o pedido:** o cadastro da equipe (hook do Better Auth) abre o da plataforma; o
  aceite do convite abre o da organização (`ensureUserVerification(userId, scope)`), só para
  quem não é owner de nenhuma organização nem da equipe da plataforma; o cliente que troca o
  telefone no portal, e a ficha que nasce do autocadastro, abrem o da organização
  (`ensureCustomerVerification`). Cliente criado pela equipe não abre pedido (`team`).
- **Quem fecha ou move:** virar owner (criar organização, troca de papel) tira a conta das filas
  de organização (`routeVerificationToPlatform`); sair da equipe apaga a liberação e o pedido
  daquela organização, com auditoria (`phoneAfterMemberLeft`); excluir a organização devolve
  tudo à plataforma (`releaseTenantPhoneResponsibility`); trocar o número encerra os pedidos do
  número antigo, e no `/admin` também apaga as liberações (`dropTenantVouchesOf`); excluir o
  cadastro apaga os pedidos.
- **O link só confirma na sessão do próprio cadastro:** `POST /api/me/phone-verification/confirm`
  e `POST /api/portal/me/phone-verification/confirm`, com `{ token }` no corpo; o cadastro vem
  da sessão. Não há rota pública nem token em URL de API. Uso único, com trava do cadastro e do
  pedido. Token inválido, usado, vencido, de outro cadastro ou de número já trocado: o mesmo 400
  `INVALID_OR_EXPIRED`. Bloqueada em personificação.
- **Filas de liberação:** `GET /api/phone-verifications` e `POST …/:id/confirm` (organização,
  `phone:confirm`); `GET /api/admin/phone-verifications` e `POST …/:id/confirm` (só o
  proprietário da plataforma). Paginadas (50), mais antigos primeiro. A da plataforma mostra só
  owners, a equipe da plataforma e quem não é de organização nenhuma. Ninguém libera o próprio
  telefone (403 `SELF_CONFIRMATION`); pedido de outro escopo é 404; cadastro que mudou é 409
  `VERIFICATION_STALE`.
- **Estado para a própria pessoa:** `GET /api/me/phone-verification` devolve `pending: { status,
  phoneHint } | null` (o resumo da T2a, 4 últimos dígitos) e, desde a T2b, a situação **por
  responsável**: `confirmedGlobally`, `answersTo` (`platform` ou `organization`), `phoneHint` e
  `responsibles: [{ responsible, tenantId, tenantName, status }]`, com `status` `confirmed`,
  `sent`, `awaiting_manual` ou `none` (`userPhoneOverview`). A plataforma vem sempre; cada
  organização em que a pessoa é membro comum vem depois (owner e equipe da plataforma só
  respondem à plataforma). No portal, `GET /api/portal/me/phone-verification` traz `pending` (a
  organização ativa, ou a primeira com pedido aberto) e uma linha por ficha da pessoa
  (`portalPhoneOverview`), **sem `requirePortalTenant`**.
- **Emissão do token:** `issueVerificationToken(requestId)` gera um token novo, invalida o anterior
  e tira do pedido a mensagem anterior (`provider_message_id`). O token é `u.` (conta da equipe) ou
  `c.` (ficha de cliente) seguido de 32 bytes em base64url: o prefixo só diz à página qual sessão
  pedir. Quem chama é o job `phone.verify` (seção seguinte); a função não confere o escopo do
  canal, quem envia confere.
- **Manutenção** (`prunePhoneVerifications`, no `maintenance.prune`): apaga pedidos encerrados
  há mais de 30 dias e os de cadastro que sumiu, devolve a `awaiting_manual` o pedido de link
  vencido, encerra o pedido de organização de quem não é mais da equipe dela e apaga liberações
  sem membro ou de número antigo.
- **Ordem de travas em `requests.ts`: o número (`lockPhoneKey`), a conta, o pedido.** Quem mexe
  em pedido ou liberação de uma conta trava a conta antes (`lockUser`); a ordem contrária fecha
  um ciclo com a confirmação. Nos fluxos de ficha de cliente a ordem é a ficha, depois o pedido.
- **Ficha liberada à mão (`manual`) fica de fora de tudo o que é automático:** não atrai
  conversa e não é ligada à pessoa que entra na equipe com o número (`AUTO_LINK_CUSTOMER_VIAS`,
  usado em `autoLinkContact` e em `linkExistingCustomer`).
- **Auditoria:** `phone.verified` (`via`: `whatsapp`, `manual` ou `tenant`; `demoted`) e
  `phone.unverified` (`reason`: `claimed` ou `left_tenant`). Só ids e enums, nunca o número.
- **Limites conhecidos, para a T4:** a conta do portal não tem pedido próprio (o portal avalia a
  ficha, inclusive no portão da T3); a fila não tem busca. Os da T2b estão na seção seguinte.

## Envio do link e página de confirmação (pré-produção, T2b)

Código: `src/lib/phone/delivery.ts` (cascata e aviso de falha), `src/lib/phone/dispatch.ts`
(enfileirar, sem dependência de canal), `src/lib/phone/notify.ts` (e-mails), `src/jobs/phone.ts`
(job), `src/lib/channels/providers/whatsapp_cloud/verification.ts` (modelo da Cloud),
`src/pages/verify-phone-page.tsx` (página). Migration `0037`.

- **Job `phone.verify`** (`tech/20-jobs.md`): payload `{ requestId, reason, afterChannelId?,
  failedMessageId? }`, **nunca o token**. Fila `singleton` por cadastro (`user:<id>` ou
  `customer:<id>`): os jobs da mesma pessoa rodam um de cada vez.
- **Cascata (D-3):** os canais `connected` **do responsável do pedido**, na ordem de
  `PHONE_VERIFICATION_CHANNELS` (o padrão do tipo primeiro, depois o mais antigo). Vazio: nenhum
  envio, todo pedido espera a liberação à mão. Cada canal pergunta ao módulo como levar o link
  (`ChannelModule.verificationDelivery`): a Cloud manda o modelo de verificação escolhido no canal
  (sem modelo, ou com modelo que deixou de valer, o canal é pulado); o QR Code, texto livre com o
  link. Cada tentativa chama `issueVerificationToken`. Erro na chamada passa ao próximo; sem canal
  apto, ou todos falharam, o pedido volta a `awaiting_manual`, sem token.
- **O canal é sempre do responsável:** pedido da plataforma só sai por canal da plataforma, pedido
  de organização só por canal dela. Conferido na lista de candidatos, em `sendVerificationMessage`
  (a função que envia; `VerificationScopeError`), no envio do canal (`requireChannelRow` pelo
  escopo) e num gatilho do banco (`phone_verification_channel_same_scope`, migration `0037`). Um
  pedido da plataforma pelo QR Code de uma organização daria ao owner dela o link que confirma a
  conta para o sistema inteiro.
- **Quem dispara:** o cadastro da equipe (hook do Better Auth), o aceite de convite, o autocadastro
  do portal e a troca de telefone no portal, depois do commit (`requestPhoneVerificationSend`). O
  job decide se é a vez do pedido:
  - **D-12:** o pedido da plataforma só sai sozinho para quem responde a ela (owner, equipe da
    plataforma, quem não é de organização nenhuma: `answersToPlatform`). O do membro comum espera
    ele pedir ("Reenviar" com `responsible: "platform"`).
  - **Um link por número (restrição (a)):** o pedido de organização não sai enquanto outro pedido
    da mesma conta tem link válido a caminho do mesmo número (o da plataforma sai primeiro). Se o
    da plataforma cai na liberação à mão, o da organização que esperava a vez (sem nenhuma
    tentativa) é disparado; o que já falhou em todos os canais não recebe outra mensagem sozinho.
  - **3 links por hora por cadastro** (`MAX_LINKS_PER_HOUR`, `src/lib/phone/dispatch.ts`), contados
    em `attempts` de todos os pedidos do cadastro, inclusive o link automático da abertura: o
    quarto vira `limited`, sem envio. A falha assíncrona que encontra o limite esgotado cai na
    liberação à mão (o link não chegou).
  - Quem perdeu a confirmação para quem provou o número **não** recebe link: o número agora é de
    outra pessoa.
- **Falha assíncrona:** o aviso `failed` de uma mensagem que não é da caixa de entrada (sem
  crédito, `131042`, modelo pausado) é procurado em `phone_verification` (`channel_id` +
  `provider_message_id`, no escopo do canal) por `applyVerificationStatus`, chamada por
  `applyChannelEvent` quando o tratador da caixa não achou a mensagem. Registra a falha e enfileira
  `phone.verify` com o motivo `failed`, que segue do próximo canal **se a mensagem que falhou ainda
  é a do pedido** (um reenvio no meio torna o aviso velho: `stale`).
- **Fora da caixa de entrada:** o envio não cria `chat_contact`, `conversation` nem `message`. O
  eco que o QR Code devolve (`fromMe` com `/verificar-telefone?token=`) é reconhecido por
  `isVerificationMessage`: pelo id da mensagem gravado no pedido e, para a corrida em que o eco
  chega antes desse id, pelo texto (`isVerificationEcho`). Não entra na caixa, e o `raw` do aviso
  com o texto do link é apagado.
- **Colunas novas em `phone_verification`:** `channel_id` (FK `set null`), `provider_message_id`,
  `attempts` (`jsonb`, as 20 últimas: canal, tipo, hora, `sent`/`failed`/`skipped`/`limited` e o
  código do erro, sem telefone nem token) e `manual_notified_at`.
- **Modelo de verificação da Cloud:** `verification_template_name` e
  `verification_template_language` em `channel_whatsapp_cloud` (`CHECK` de par). `PUT
  /api/channels/:id/verification-template` e `PUT /api/admin/channels/:id/verification-template`
  (`channel:manage`; na plataforma, o proprietário), com `{ template: { name, language } | null }`.
  Só modelo aprovado do WABA do canal, no mesmo escopo, com **um** botão de URL igual a
  `APP_URL/verificar-telefone?token={{1}}`, sem outra variável e com cabeçalho de texto (422
  `INVALID_VERIFICATION_TEMPLATE`, com o motivo). A regra é conferida de novo a cada envio.
- **Reenvio:** `POST /api/me/phone-verification/resend` (`{ responsible?: "platform" | <tenantId> }`)
  e `POST /api/portal/me/phone-verification/resend` (`{ tenantId? }`; padrão: a organização
  ativa). Corpo opcional. 202, ou 429 `PHONE_VERIFICATION_LIMIT` quando o cadastro já recebeu os 3
  links da hora (para não aceitar um reenvio que o job não cumpriria). 3 pedidos por hora **por
  cadastro**, além do `authRateLimit` por IP; bloqueado em personificação. Tenta o próximo canal da
  ordem e volta ao primeiro no fim; sem canal apto agora, o link que já saiu continua valendo.
  Responsável que não responde pela pessoa não envia nada (`userResendTarget`).
- **Página `/verificar-telefone?token=…`** (rota de auth, sem `loader`): sem sessão, vai a
  `/login?next=…` e volta; com sessão, um botão faz o `POST` de confirmação. Token `c.` vai para
  `/portal/verificar-telefone`, que pede a sessão do portal (`/portal/login?next=…`, só caminho
  `/portal/…`). Meta `referrer: no-referrer` e `noindex`.
- **Portal sem `requirePortalTenant` (restrição (d)):** a confirmação do portal acha a ficha pelo
  token entre as fichas da própria pessoa (`portalTokenSubject`, `customer.portal_user_id`), em
  qualquer organização: o lead do autocadastro confirma antes de virar cliente ativo. Só ficha
  `lead` ou `active` de organização `active` (a bloqueada e a organização suspensa ficam de fora,
  como no `requirePortalTenant`). A página trata o 401 sozinha: sai da sessão e volta ao login com
  o link (`/portal/verificar-telefone` está em `PORTAL_PUBLIC_PATHS` do `apiFetch`).
- **E-mails** (`tech/19-email.md`): `phone-verification-manual` ao responsável quando o pedido cai
  na liberação à mão (uma vez por pedido, e só se o pedido é da fila dele: o da plataforma de um
  membro comum não avisa o proprietário); `phone-number-claimed` à conta que perdeu a confirmação
  para quem provou o número. Só os 4 últimos dígitos.
- **Limites conhecidos:** o login por link mágico do portal não preserva o `next` (a pessoa abre o
  link do WhatsApp de novo); a ordem entre dois pedidos da mesma conta disparados juntos depende
  da fila `singleton`; o eco do QR Code é reconhecido pelo texto (`/verificar-telefone?token=`),
  então uma mensagem com esse texto mandada à mão pelo celular do canal também fica fora da caixa;
  o modelo Cloud precisa do smoke com conta real da Meta (formato do botão e do `index`) antes de
  fechar a T2; não há tela para escolher o modelo nem as filas (T4). O reenvio aparece na tela
  "Confirme seu WhatsApp" da T3.

## Bloqueio de acesso com telefone pendente (pré-produção, T3)

Código: `src/lib/phone/gate.ts` (predicado), `src/api/phone-gate.ts` (o que passa),
`src/api/auth.ts` e `src/api/portal-auth.ts` (onde o portão roda),
`src/components/phone/phone-verification-panel.tsx` (tela e aviso). Decisões a confirmar: T3-1 a
T3-9 na SPEC ("T3: o que foi feito").

- **`PHONE_VERIFICATION_REQUIRED`** (padrão `true`, D-2). Ligada, a sessão cujo telefone não vale
  recebe 403 `{ error, code: "PHONE_UNVERIFIED" }` de `requireAuth` e `requirePortalAuth` em tudo,
  menos na lista do que passa. Desligada, a pessoa entra: `/api/me` e `/api/portal/me` devolvem
  `phonePending` e a área mostra um aviso. O link sai nos dois modos, e o vínculo automático da
  conversa só usa telefone confirmado no escopo, nos dois modos.
- **Ordem das recusas:** 401 sem cookie, 503 Auth fora, 401 sessão inválida, 403
  `EMAIL_NOT_VERIFIED` (com `EMAIL_VERIFICATION_REQUIRED`; no portal, sempre), 403
  `PHONE_UNVERIFIED`. Falha do banco ao conferir o telefone: 503 (falha fechada).
- **Predicado:**

  | Quem | Passa com |
  |---|---|
  | Membro comum de organização | Conta confirmada no sistema, **ou** liberada pela organização **ativa** da sessão (`userPhoneConfirmedIn`) e ainda membro dela |
  | Owner de qualquer organização, equipe da plataforma | Só a confirmação do sistema (`userPhoneConfirmedGlobally`) |
  | Sem organização ativa | Só a confirmação do sistema |
  | Portal | A ficha de cliente da organização em uso (`customerPhoneConfirmed`), entre as `lead`/`active` de organização ativa; sem ficha na organização em uso, alguma confirmada; sem ficha que possa confirmar, passa |
  | Sessão personificada | O mesmo da conta personificada |

- **O que passa (`TEAM_PHONE_PENDING_ALLOWED` e `PORTAL_PHONE_PENDING_ALLOWED`):** casado pelo
  método e pelo caminho **da requisição** (barra a mais não casa). Equipe: `GET /api/me/phone-verification`,
  `POST /api/me/phone-verification/resend`, `POST /api/me/phone-verification/confirm`,
  `POST /api/tenant/active`, `POST /api/invitations/:id/accept`, `POST /api/admin/stop-impersonating`.
  `POST` e `DELETE /api/me/phone-change` (corrigir o número pela troca).
  Portal: `GET /api/portal/me/phone-verification`, `POST …/resend`, `POST …/confirm`,
  `POST` e `DELETE /api/portal/me/phone-change` (corrigir o número pela troca),
  `POST /api/portal/active-tenant`. `PATCH /api/portal/me` (nome e telefone) saiu da lista quando a
  troca ganhou rota própria. Sair é do Better Auth.
  **Exclusão da própria conta (LGPD, T3-7):** `DELETE /api/me`, `GET /api/me/deletion`,
  `POST /api/me/deletion/cancel` e, no portal, `DELETE /api/portal/me`,
  `POST /api/portal/me/deletion/confirm`, `GET /api/portal/me/deletion` (com `needsPassword`) e
  `POST /api/portal/me/deletion/cancel`. A tela de bloqueio traz "Excluir minha conta"
  (`GateDeletion`, em `phone-verification-panel.tsx`), fechado por padrão e aberto quando já há
  exclusão agendada; no portal, o link `?confirmar-exclusao=` é atendido na própria tela
  (`ConfirmDeletionCard`). A exportação e a exclusão da organização continuam bloqueadas.
  Rota nova entra bloqueada; pôr uma rota na lista exige motivo (campo `why`) e o teste confere que
  ela existe.
- **Better Auth:** `/api/auth/*` não passa por `requireAuth`. As leituras do plugin admin
  (`/api/auth/admin/*`) têm o portão (`phoneGateOnAdminReads`, `auth-ext.ts`); o resto é da própria
  conta (sessão, senha, e-mail, 2FA, sair) e fica aberto.
- **Tela "Confirme seu WhatsApp":** `ProtectedRoute` (cobre `/app`, `/admin` e `/app/onboarding`) e
  `PortalLayout` mostram só ela quando `/api/me` ou `/api/portal/me` responde `PHONE_UNVERIFIED`
  (`phoneBlocked` em `useAuth` e `usePortalAuth`). Mostra cada responsável de
  `GET …/phone-verification` (link enviado, aguardando liberação de quem, nenhum link), reenviar por
  responsável, "Usar esta organização" onde o número já vale, a correção do número no portal (pela
  troca, `POST /api/portal/me/phone-change`), "Já confirmei" e "Sair". A rota da equipe para corrigir o
  próprio número existe (`POST /api/me/phone-change`), mas a tela ainda manda à plataforma: o botão é
  da fase de telas.
  Qualquer 403 `PHONE_UNVERIFIED` no meio da sessão faz `apiFetch` emitir `bizu:phone-unverified`, e
  o provider relê a conta. As páginas de login e de escolha do portal e `/portal/verificar-telefone`
  tratam a sessão sem `/api/portal/me`.
- **Primeiro proprietário:** o seed cria as contas `manual`. A promoção pelo banco confirma o
  telefone junto (`tech/08-auth.md`, "Primeiro proprietário"); sem isso, o primeiro
  `platform_owner` ficaria na tela de confirmação sem ninguém para liberá-lo nem canal da plataforma
  configurado. O `maintenance.prune` encerra pedido aberto de conta já confirmada no sistema.
- **Testes:** `tests/db/phone-gate.test.ts` (percorre `api.routes` com contas pendentes da equipe e do
  portal; a lista de rotas públicas fica no teste), `tests/db/billing.test.ts` (seed), unitários em
  `src/api/auth.test.ts` e `src/api/portal-auth.test.ts` (ordem e falha fechada). O resto do
  `test:db` roda com a variável desligada (`vitest.db.config.ts`).
- **Limites conhecidos:** o SSE já aberto segue até 15 min depois que a confirmação cai; o login do
  portal pendente não escolhe a organização do `?org=`; a correção do número no portal exige ficha
  ativa (o lead não corrige sozinho).

## Telas da liberação à mão (pré-produção, T4)

Código: `src/components/phone/phone-release-api.ts` (rotas, tipos, mensagem de cada erro),
`src/components/phone/phone-release-card.tsx` (a lista, o diálogo e os dois cartões),
`src/pages/admin/users-page.tsx`, `src/pages/team-page.tsx`, `src/pages/customers-page.tsx`. Só tela sobre as
rotas da T2a; nada de servidor mudou. Decisões a confirmar: T4-1 a T4-4 na SPEC ("T4: o que foi feito").

- **Plataforma:** `PlatformPhoneReleaseCard`, aba "Telefones" de `/admin/usuarios?scope=telefones`, só quando
  `useIsPlatformOwner()` (a rota é `ownerOnly`). A contagem da aba é o `total` da página 1.
- **Organização:** `TenantPhoneReleaseCard subject="user"` em `/app/equipe` e `subject="customer"` em
  `/app/clientes`, envoltos em `<Can resource="phone" action="confirm">` (a rota que lista também exige a
  permissão). A rota devolve equipe e clientes juntos; a tela filtra a página por `subjectType`, e a
  paginação (e o `total`) é da fila toda.
- **Lista:** nome, número como a rota o devolve (`phone`, normalizado, sem máscara), estado ("Link enviado" ou
  "Aguardando liberação") e data. "Liberar" abre o diálogo com o aviso de que a liberação à mão não prova que
  o número é da pessoa e o alcance (plataforma: sistema inteiro; equipe e ficha: só a organização). A lista
  relê depois de cada tentativa, com sucesso ou erro.
- **Erros** (`releaseErrorMessage`): `SELF_CONFIRMATION`, `PHONE_IN_USE`, `PLATFORM_ONLY`, `VERIFICATION_STALE`
  e 404 têm texto próprio; outro código mostra a mensagem da API. `useAdminMutation` ganhou a opção
  `errorMessage` para isso.
- **Modelo de verificação** (Cloud): `VerificationTemplateCard` em "Gerenciar" do número
  (`tech/29-canais-whatsapp.md`); a leitura do canal passou a trazer `verificationTemplate`.
- **Fica de fora:** a tela da troca de telefone (as rotas já existem, seção seguinte), o `claim` e a ligação da
  ficha à equipe. Lista completa na SPEC. A fila agora traz `purpose` (`signup` ou `change`); a tela ainda não
  distingue a troca.

## Troca de telefone pelo pedido (pré-produção)

Código: `src/lib/phone/requests.ts` (seção "Troca de número"), `src/api/phone-verification.ts`
(`/api/me/phone-change`), `src/api/portal.ts` e `src/lib/portal/profile.ts` (portal),
`src/api/customers.ts` e `src/lib/tenant/customers.ts` (equipe sobre a ficha), `src/lib/admin/people.ts`
(`/admin`), `src/lib/phone/delivery.ts` (envio). Migration `0038_troca_telefone`. Decisões a confirmar:
TC-1 a TC-10 na SPEC ("Troca de telefone pelo pedido: o que foi feito").

- **Regra:** o cadastro mantém o número antigo, **e a confirmação dele**, até a troca se confirmar. O
  número novo vive só no pedido (`phone_verification` com `purpose = 'change'`, `phone` digitado,
  `requested_by_type`/`requested_by_id`). Uma troca aberta por cadastro (índice
  `phone_verification_open_change_idx`); a troca convive com o pedido do número atual (os índices de
  pedido aberto incluem `purpose`). Quem chama sempre entra por `requests.ts`.
- **Rotas:** `POST`/`DELETE /api/me/phone-change` (`userPhoneChangeSchema`, só WhatsApp, bloqueadas em
  personificação), `POST`/`DELETE /api/portal/me/phone-change` (ficha da organização ativa) e
  `POST`/`DELETE /api/customers/:id/phone-change` (`customer:update`). 202 / 204. Pedir de novo o mesmo
  número reenvia; outro número substitui; o número que o cadastro já tem é 400 `PHONE_UNCHANGED`. 5 pedidos
  por hora por cadastro. `PATCH /api/customers/:id` e `PATCH /api/portal/me` abrem a troca quando o número
  muda (`phone_key` diferente) e gravam direto quando é o mesmo número escrito de outro jeito.
- **Responsável:** ficha de cliente, a organização dela. Conta: a plataforma para quem responde a ela e
  para quem já tem o número confirmado no sistema; a organização em uso (ou a primeira) para o membro comum
  sem essa confirmação. Quem vira owner tem a troca da organização movida para a plataforma; quem sai da
  organização responsável perde a troca.
- **Unicidade:** a equipe recebe 409 `PHONE_IN_USE` ao pedir a troca da ficha para o número de outro
  cliente. A conta e a pessoa do portal recebem sempre 202 (o pedido não é oráculo). Na confirmação, sob a
  trava do número (conta) ou da ficha: conta pelo link da plataforma fica com o número e quem o tinha volta
  a pendente (`demote`, como no cadastro); pelo link da organização ou à mão, 409; ficha, 409 (o `claim` não
  existe ainda), com o índice único como rede (`phoneInUseOnUnique`).
- **Confirmação** (`confirmUserChange`, `confirmCustomerChange`): grava o número do pedido com o estado do
  responsável (conta pela plataforma: `whatsapp`/`manual`; conta pela organização: pendente no sistema e
  `phone_tenant_vouch` só nela; ficha: `whatsapp` pelo link; pelo owner, `team` se a equipe pediu a troca e
  `manual` se foi a própria pessoa no portal, TC-5), fecha os outros pedidos
  abertos (eram do número antigo), apaga as liberações de organização da conta e reabre o que a conta ainda
  deve ao número novo (plataforma e outras organizações; envio depois do commit). A ligação
  `customer.user_id` fica (é por id); a ficha que troca pelo link liga a pessoa da equipe e o contato do
  número novo, como na confirmação do cadastro. **O contato e as conversas do número antigo continuam na
  ficha** (P1). Na troca pedida pela pessoa do portal, a conta do portal recebe o número, só declarado.
  Auditoria: `phone.change_requested`, `phone.change_canceled` e `phone.verified` com `purpose`.
- **Envio:** o link sai ao número **novo**, pelo canal do responsável; a troca não espera a D-12. Ficha sem
  conta no portal não recebe link (ninguém o confirmaria): vai à liberação do owner, que é avisado. Liberada,
  a troca que a equipe pediu deixa a ficha `team`: ela atrai as próximas conversas do número
  (`AUTO_LINK_CUSTOMER_VIAS`), mas não é ligada a pessoa da equipe na hora da troca. A troca
  da plataforma aparece na fila do proprietário também para o membro comum.
- **`/admin`:** a edição do telefone de uma conta abre a troca e o proprietário a libera à mão na mesma
  transação (`changeUserPhoneByPlatform`, `manual`; 409 se outra conta do grupo tem o número). A edição da
  pessoa do portal continua gravando direto (`manual`), porque a conta do portal não tem pedido.
- **Leitura:** `GET /api/me/phone-verification` → `change` (`status`, `phoneHint` do número novo,
  `responsible`, `tenantId`, `tenantName`, `requestedAt`); portal → `responsibles[].change`;
  `GET /api/customers/:id` → `phoneChange`; filas → `purpose`. Reenviar a troca:
  `POST …/phone-verification/resend` com `{ purpose: "change" }`.
- **Testes:** `tests/db/phone-change.test.ts` e o bloco "troca de número" de `tests/db/phone-delivery.test.ts`.

### Telas da troca (F2, 2026-11-14)

Só tela, sobre as rotas acima: `PhoneChangeSection` (`src/components/phone/phone-change-section.tsx`, textos e erros em
`phone-change-api.ts`) serve ao Perfil da equipe e a "Confirme seu WhatsApp" (`team-phone-change.tsx`, chave
`["phone-verification","team"]`, a mesma do painel), ao portal (`src/components/portal/portal-phone-change.tsx`) e à ficha
(`src/components/app/customers/customer-phone-change-card.tsx`). A "Confirme seu WhatsApp" da equipe deixou de mandar
falar com a plataforma. As filas (`phone-release-card.tsx`) distinguem `purpose = change` ("Troca de número", "Número
novo", "Liberar a troca"). Decisões F2-1 a F2-8 a confirmar na SPEC ("F2 e telas da troca: o que foi feito").

## O que a SPEC pede e ainda não existe

Nada do `crm-cadastro`: o programa fecha com a A4. O telefone da equipe entra no `/cadastro`, e a troca pela própria
pessoa tem tela no Perfil (`/app/perfil`, `/admin/perfil`, bloco F, F2) e em "Confirme seu WhatsApp"; o proprietário
da plataforma também edita em `/admin/usuarios/:id`.
Filtro por campo adicional segue fora (decisão da SPEC).
