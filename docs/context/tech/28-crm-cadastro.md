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

## Telefone verificado e único (pré-produção, T1 e T2a)

SPEC: `docs/specs/pre-producao/spec.md`, bloco T. A T1 entrega o estado e a unicidade; a T2a, o
pedido de verificação, a confirmação pelo link e a liberação manual (seção seguinte). O **envio**
do link pelos canais é da T2b; o bloqueio de acesso, da T3; as telas, da T4.

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
- **Ainda não existe (T2b a T4 e bloco E):** o envio do link pelos canais e a página
  `/verificar-telefone`, a troca de telefone com verificação (hoje a equipe troca direto e o
  cliente do portal volta a pendente), o bloqueio de acesso com telefone pendente, as telas das
  filas, o selo e o filtro na tela, ligar e desligar a ficha à mão, e apagar a ficha ligada quando
  a pessoa sai da equipe (D-11).
- **Testes:** `tests/db/phone-verified.test.ts`, `tests/db/phone-requests.test.ts`,
  `tests/db/inbox-ingest.test.ts` (vínculo), `tests/db/phone-accounts.test.ts` e
  `src/lib/schemas/phone.test.ts`.

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
- **Estado para a própria pessoa:** `GET /api/me/phone-verification` e a do portal devolvem
  `{ pending: { status, phoneHint } | null }` (os 4 últimos dígitos).
- **Emissão do token:** `issueVerificationToken(requestId)` gera um token novo e invalida o
  anterior. Na T2a ninguém a chama fora dos testes: quem envia é o job da T2b.
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
- **Limites conhecidos, para a T2b e a T3:** sem envio, todo pedido espera a liberação manual; a
  conta com pedidos em vários responsáveis não deve receber um link por pedido no mesmo número;
  o modelo Cloud precisa ter a URL conferida contra `APP_URL`; a conta do portal não tem pedido
  próprio (o portal avalia a ficha); o lead sem ficha não passa por `requirePortalTenant`; não há
  e-mail ao responsável nem à conta que perdeu a confirmação; a fila não tem busca.

## O que a SPEC pede e ainda não existe

Nada do `crm-cadastro`: o programa fecha com a A4. Não existe tela de perfil da equipe: o telefone
da equipe entra no `/cadastro` e é editado pelo proprietário da plataforma em `/admin/usuarios/:id`.
Filtro por campo adicional segue fora (decisão da SPEC).
