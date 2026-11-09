# SPEC: Cadastro CRM (etiquetas, campos adicionais e telefone)

- **Status:** aprovada
- **PRD:** `docs/specs/crm-cadastro/prd.md`
- **Programa:** `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T7 e contrato da fase F0)
- **Contexto carregado:** `core.md`, `tech/07-banco-drizzle.md`, `tech/21-tenant-rbac.md`,
  `tech/22-admin.md`, `tech/25-portal-clientes.md`, `tech/27-lgpd-arquivos.md`,
  `src/db/schema/customer.ts`, `src/lib/schemas/customer.ts`, `src/lib/auth/permissions.ts`
- **Origem conferida:** tabelas `tags`, `contact_tags`, `custom_fields` e
  `contact_custom_values` do banco do `zap-crm-br-client`; `src/lib/tags.ts`, `src/lib/colors.ts`
  e `src/lib/phone/br.ts` do mesmo projeto.

## Onde entra

- [x] API Hono: `src/api/tags.ts`, `src/api/custom-fields.ts`, `src/api/customers.ts` (muda),
  `src/api/admin.ts` (soma `/api/admin/crm/*`); telefone obrigatório também em
  `src/api/auth-ext.ts`, `src/lib/auth/server.ts`, `src/lib/auth/portal.ts`, perfil e `/admin`
  (seção "Telefone obrigatório nos cadastros de pessoa")
- [x] Área client-only: `/app/clientes`, `/app/configuracoes/etiquetas`,
  `/app/configuracoes/campos`, `/admin/tenants`, `/admin/configuracoes/etiquetas`,
  `/admin/configuracoes/campos`
- [ ] Pública com SSR: nada

## O que muda em relação à origem

| Na origem | Aqui | Motivo |
|---|---|---|
| Vínculo e valores sem coluna de conta; a RLS faz `EXISTS` no contato | `tenant_id` em toda tabela | Regra do projeto; política simples e índice direto |
| Cor em texto livre, três padrões diferentes | `CHECK` de `#rrggbb` e um padrão só (`#3b82f6`) | Cor inválida quebrava o chip |
| Campo personalizado só de texto, sem chave, ordem ou obrigatoriedade; nome duplicável | Seis tipos, `key` estável e única, ordem, obrigatório, arquivar | O pedido é anexar campos de verdade ao cadastro |
| Valores em tabela, gravados com DELETE + INSERT sem transação | `jsonb` no próprio cadastro, gravado no mesmo `UPDATE` | Atômico; uma leitura; a origem perdia valores em escrita concorrente |
| Telefone obrigatório e único por conta | Telefone obrigatório em todo cadastro de pessoa e único por tenant no cliente | O WhatsApp é o canal da base; a unicidade mantém o vínculo do atendimento inequívoco (decisão do proprietário) |
| Telefone BR aceita fixo e celular de 8 dígitos (legado), com aviso | Igual (fixo e 8 dígitos aceitos com aviso), mas o telefone passa a ser obrigatório e só celular inicia conversa no atendimento | Decisão do proprietário: seguir a origem; o guia manda "apenas celulares para WhatsApp" no envio, não no cadastro |
| Campo `PhoneInput` (`react-phone-number-input`) só no formulário de contato | `PhoneField` único, usado em todos os formulários de pessoa | Máscara e regra iguais em `/cadastro`, portal, perfil, `/admin` e cliente |
| Telefone e e-mail do contato obrigatórios | Telefone obrigatório em todo cadastro; e-mail obrigatório só para conta; cliente sem e-mail não tem acesso | Decisão do proprietário (plano, T5) |

## Modelo de dados (Drizzle)

Arquivos: `src/db/schema/crm.ts` (novo), `customer.ts`, `auth.ts`. "Escopo" = `tenant_id`
anulável com `scopedPolicy()` (plano, T1 e T2).

| Tabela | Colunas principais | Observações |
|---|---|---|
| `tag` | `id`, `tenant_id` (nulo = plataforma), `name` (1 a 40), `color` (`CHECK ~ '^#[0-9a-f]{6}$'`, padrão `#3b82f6`), `created_by` → `user` `set null`, `created_at`, `updated_at` | Único por escopo em `lower(name)`: índice único em `(tenant_id, lower(name))` e outro parcial em `lower(name) WHERE tenant_id IS NULL`. `scopedPolicy()` + `FORCE` |
| `customer_tag` | `tenant_id` (não nulo), `customer_id` → `customer` `cascade`, `tag_id` → `tag` `cascade`, `created_at` | PK `(customer_id, tag_id)`; índice `(tenant_id, tag_id)`. `tenantPolicy()` + `FORCE` |
| `organization_tag` | `organization_id` → `organization` `cascade`, `tag_id` → `tag` `cascade`, `created_at` | PK composta. Sem `tenant_id`: é dado da plataforma **sobre** o tenant. `platformOnlyPolicy()` + `FORCE` |
| `custom_field` | `id`, `tenant_id` (nulo = plataforma), `entity` (`customer` \| `organization`), `key` (slug, imutável), `label` (1 a 60), `type` (`text` \| `number` \| `date` \| `boolean` \| `select` \| `multiselect`), `options` jsonb (`[{ value, label }]`), `required`, `position`, `archived_at`, `created_by`, `created_at`, `updated_at` | Único por escopo em `(entity, key)`. `entity = organization` só com `tenant_id` nulo e `customer` só com tenant (`CHECK`). `scopedPolicy()` + `FORCE` |
| `organization_profile` | `organization_id` PK → `organization` `cascade`, `custom_fields` jsonb `'{}'`, `updated_by`, `updated_at` | Valores dos campos da plataforma. `platformOnlyPolicy()` + `FORCE` |
| `customer` (muda) | `email` passa a anulável; `phone_normalized text`; `phone_key text`; `custom_fields jsonb not null default '{}'`; `CHECK` de telefone obrigatório (abaixo) | Índice **único parcial** `(tenant_id, phone_key) WHERE phone_key IS NOT NULL`: como `phone_key` é igual para o número com e sem o 9º dígito, o banco também barra a variante. O único `(tenant_id, email)` fica como está: o Postgres aceita vários nulos |
| `user` (muda) | `phone_normalized text`, `phone_key text` (`additionalFields`, `input: false`); mesmo `CHECK` | Índice simples em `phone_key`, **não único** (dois membros podem dividir o número da empresa). Serve a caixa de entrada para reconhecer a equipe. `email` já é `NOT NULL` e único |
| `portal_user` (muda) | `phone_normalized text`, `phone_key text`; mesmo `CHECK` | Mesmo tratamento do `user`; `email` já é `NOT NULL` |

- **Telefone obrigatório também no banco.** O projeto é novo: não há conta nem cliente
  anterior a esta regra (decisão do proprietário), então o banco fecha a porta. As três tabelas
  ganham `CHECK ((phone_normalized IS NOT NULL AND phone_key IS NOT NULL) OR email LIKE
  'deleted+%@invalid')`. Só a linha anonimizada pela LGPD (que já grava esse e-mail fantasma)
  fica sem telefone; não é `NOT NULL` puro porque a anonimização apaga o número. Um `INSERT` ou
  `UPDATE` que esqueça o telefone, em qualquer caminho (hook, `INSERT` direto, seed), falha.

- `custom_fields` guarda `{ "<id do campo>": valor }`. A chave é o **id**, não a `key`: renomear
  rótulo não toca em valor nenhum. A `key` existe para importação, exportação e API futura.
- Valores por tipo: `text` string até 500; `number` número finito; `date` `AAAA-MM-DD`;
  `boolean`; `select` um `value` das opções; `multiselect` lista de até 20 `value`.
- Tetos em `src/lib/crm/constants.ts`: 100 etiquetas por escopo, 20 por cliente (já é o limite
  do schema atual), 12 campos ativos por entidade, 50 opções por campo. Campo arquivado não
  conta para o teto.

### Migrations

Uma por fase, geradas com `npm run db:generate`; `FORCE ROW LEVEL SECURITY` e os índices de
expressão em migration customizada, como em `0007_rls_roles.sql`.

1. **`00xx_telefone_email_opcional` (A1):** colunas novas em `customer`, `user` e
   `portal_user`; `customer.email` anulável; os `CHECK` de telefone criados já validados e o
   índice único parcial de `customer`. **Sem backfill nem tratamento de repetidos:** o projeto
   é novo e não há cadastro anterior (decisão do proprietário). Se a base tiver linha sem
   telefone, a migration aborta com mensagem clara (`RAISE EXCEPTION` antes dos `CHECK`, sem
   dado pessoal na mensagem) em vez de inventar um número; em desenvolvimento, recrie o banco
   local e rode `npm run db:migrate` e `npm run db:seed`, que já trazem telefone em todos.
2. **`00xx_etiquetas` (A2):** cria `tag` e `customer_tag` e remove `customer.tags` na mesma
   migration, sem backfill: não há etiqueta de texto a migrar.
3. **`00xx_campos_adicionais` (A3)** e **`00xx_crm_plataforma` (A4).**

- **Rollout:** sem dado em produção, cada migration vai junto com o código da fase.

## Telefone (`src/lib/phone/`)

Porta de `normalizeContactPhone`, `formatPhoneForDisplay`, `phoneVariants`, `phonesMatch` e
`maskPhoneForLog` (`mask-for-log.ts`) da origem, com os testes (`br.test.ts`,
`mask-for-log.test.ts`). Regras do guia `docs/references/mobile_number_brasil_guide.md` da
origem, que passa a ser a referência (copiar para `docs/references/` daqui).

- `normalizePhone(raw)` → `{ ok, phone, key, kind, ddd, legacy }` ou `{ ok: false, reason }`,
  com `kind` = `mobile` \| `mobile_legacy` \| `landline` \| `foreign`. Pipeline, nesta ordem:
  1. guarda se o texto começa com `+` (depois de tirar espaços); fica só com os dígitos (tira
     espaço, parênteses, hífen e `+`); vazio → `empty`;
  2. **com `+`:** começando em `55` → remove o DDI e valida o número nacional (passo 5);
     senão → **estrangeiro**, E.164 de **8 a 15 dígitos** contando o DDI (`kind: 'foreign'`),
     sem regra de DDD; fora disso → `invalid_length`. É o caminho de todo número fora do Brasil,
     inclusive os de 11 dígitos dos EUA e do Canadá (`+1 415 555 2671`): o `PhoneField` sempre
     envia o E.164 com `+` quando o país escolhido não é o Brasil;
  3. **sem `+`:** tira **um** zero de tronco (`011…` → `11…`);
  4. 12 ou 13 dígitos começando em `55` → remove o DDI e valida o número nacional;
  5. 10 ou 11 dígitos → número nacional brasileiro, valida;
  6. 12 a 15 dígitos que não começam em `55` → estrangeiro (colado sem `+`), como no passo 2;
  7. senão → `invalid_length` (de 8 a 9 dígitos sem DDD → `missing_area_code`).

  **A regra do Brasil (DDD, 9º dígito, fixo) só vale para DDI `55`** (decisão do proprietário).
  Número com outro DDI é sempre `foreign` e só passa pela checagem de tamanho do E.164; número
  sem DDI é tratado como brasileiro porque o seletor de país do campo está no Brasil.
- **`key` (chave de comparação):** para `mobile` e `mobile_legacy`, `55` + DDD + os 8 últimos
  dígitos (o número sem o 9º dígito); para `landline` e `foreign`, o próprio `phone`. Número com
  e sem o 9º dígito tem a mesma chave. Gravada em `phone_key` junto com `phone_normalized`,
  sempre calculada no servidor.
- **Número nacional (Brasil):** o DDD precisa estar nos 67 da Anatel (`BR_AREA_CODES`,
  `invalid_ddd`). Com 11 dígitos, o primeiro depois do DDD é `9` (`mobile_invalid_ninth_digit`
  se não for) → `mobile`. Com 10 dígitos (local de 8): primeiro dígito de 2 a 8 → `landline`
  (fixo); iniciado em `9` → `mobile_legacy` (`legacy: true`, celular antigo); começando em
  `0` ou `1` → `invalid_local_prefix`. **Fixo e `mobile_legacy` são aceitos**, como na origem
  (decisão do proprietário), e a tela mostra o aviso não bloqueante. O celular antigo é
  aceito **se for informado assim, mas validado** (decisão do proprietário): DDD entre os 67,
  exatamente 8 dígitos locais e o primeiro deles `9`; o número nunca é completado com o 9
  automaticamente, e o aviso pede para conferir. Qualquer outra forma é recusada pelo motivo; `canWhatsApp(kind)` é
  verdadeiro só para `mobile` e `foreign`. Exceção na caixa de entrada: número que **já
  escreveu** pelo WhatsApp (existe `chat_contact` com a mesma `phone_key` no escopo) conta como
  WhatsApp, mesmo `mobile_legacy`, porque os provedores costumam entregar o celular do Brasil
  sem o 9º dígito (SPEC `caixa-de-entrada`). `0800` e afins caem em `invalid_ddd` ou
  `invalid_length`; não há tratamento especial.
- **Mensagens por motivo** (`phoneErrorMessage(reason)`, em português, usadas no formulário e na
  API): `empty` "Informe o telefone."; `invalid_length` "Número incompleto ou com dígitos a
  mais."; `invalid_ddd` "DDD inexistente."; `mobile_invalid_ninth_digit` "Celular precisa
  começar com 9 depois do DDD."; `invalid_local_prefix` "Número inválido.";
  `missing_area_code` "Informe o DDD." **Avisos** (não bloqueiam, `phoneWarning(kind)`):
  `landline` "Telefone fixo: este número não recebe WhatsApp."; `mobile_legacy` "Celular com 8
  dígitos (formato antigo): confira se falta o 9."
- **Máscara de exibição e de digitação:** `formatPhoneForDisplay` (`5519999249658` →
  `+55 (19) 99924-9658`; o fallback estrangeiro é `+` e os dígitos). Digitando no Brasil, o
  campo mostra `(19) 99924-9658`.
- **O 9º dígito nunca é inserido.** `phoneVariants(phone)` devolve o número e, para celular do
  Brasil, a forma com e sem o 9. As buscas por igualdade usam `phone_key`, que já junta as duas
  formas (mensagem recebida de contato antigo, duplicidade). O cadastro grava o número como veio
  e nunca converte o de 8 dígitos em 9.
- **`phoneSchema`** (`src/lib/schemas/phone.ts`, novo; `customer.ts` o reexporta) é obrigatório:
  `z.string()` com `superRefine` chamando `normalizePhone`; devolve o canônico (`transform`) e
  o erro do motivo no campo `phone`. `optionalText(phoneSchema)` **sai** de todos os schemas:
  `customerSchema`, `portalProfileSchema`, `signupSchema` (e, por herança, `portalSignupSchema`)
  e o schema de edição de usuário em `src/lib/schemas/admin.ts`. Quem tem `PATCH partial()`
  segue podendo omitir o campo, mas o serviço confere o **estado final**: cliente sem telefone
  válido depois do `PATCH` é 400 `PHONE_REQUIRED`. `customer.phone` e `user.phone` guardam o
  que a pessoa digitou; `phone_normalized` e `phone_key`, calculados **no servidor**, nunca
  vindos do corpo.
- **Telefone é único por tenant.** Antes de gravar, na mesma transação, o serviço procura a
  mesma `phone_key` em outro cliente (excluindo o próprio id) e responde 409 `PHONE_IN_USE` com
  `{ customerId, name? }`; o `name` só vai a quem tem `customer:read`. O índice único parcial em
  `(tenant_id, phone_key)` cobre a corrida, inclusive com a variante com ou sem o 9º dígito
  (`23505` vira o mesmo 409). Salvar o próprio cliente sem mudar o telefone nunca conflita: a
  chave do próprio cliente é excluída da busca, e como a regra vale desde o primeiro cadastro,
  não existe par de variantes gravado.
- A anonimização de cliente zera `phone_normalized` e `phone_key` e libera o número para outro
  cadastro.
- `phone_normalized` e `phone_key` de `user` e `portal_user` são gravados onde o telefone é
  gravado: cadastro, perfil, `/admin` e o convite do portal (tabela abaixo).

### Telefone obrigatório nos cadastros de pessoa

| Onde | Como entra |
|---|---|
| `/cadastro` (conta de owner, membro, admin e suporte) | `signupSchema` ganha `phone` obrigatório. A rota `POST /api/auth/sign-up/email` já passa por `auth-ext.ts`, que valida o schema e abre o contexto `withSignupConsent` (AsyncLocalStorage); o telefone viaja nesse mesmo contexto e é gravado em `user.phone` e `user.phone_normalized` pelo hook `databaseHooks.user.create.before/after`. O hook **recusa** a criação sem telefone válido, então chamar o Better Auth direto também falha fechado. `additionalFields.phone` segue `input: false`: nunca vem do corpo do Better Auth. O hook só cobre o que passa pelo Better Auth: os `INSERT` diretos (convite do portal e seed, abaixo) gravam o telefone eles mesmos |
| Convite da equipe (`/convite/:id`) | Não coleta telefone: aceitar exige conta, e a conta já nasceu com ele |
| Convite do portal (`ensurePortalUser`, `src/lib/portal/access.ts`) | Cria o `portal_user` por `INSERT` direto, sem passar pelo hook. Passa a receber o telefone do `customer` convidado (obrigatório nele) e grava `phone`, `phone_normalized` e `phone_key` ao criar. Se o `portal_user` já existe (mesmo e-mail em outro tenant), o telefone dele não é sobrescrito |
| Autocadastro do portal | `portalSignupSchema` herda `phone` obrigatório; mesmo mecanismo no hook de `portalAuth` e em `portal_user` |
| Perfil (`/app`, `/admin`) e perfil do portal | `portalProfileSchema` e o perfil da equipe trocam `optionalText(phoneSchema)` por `phoneSchema`; apagar o telefone é 400 |
| `/admin`, edição de usuário e de pessoa do portal | Mesmo schema; só `platform_owner` edita; vai para a auditoria como `user.phone_changed` (sem o número) |
| Cliente (`/app/clientes`, "Salvar como cliente" do atendimento) | `customerSchema`: `phone` obrigatório; `email` opcional |
| Seed e testes | Todos os usuários do seed (`platform_owner`, `owner`, `member`, clientes) ganham celular válido de exemplo (`11` + `9` + 8 dígitos), com `phone_normalized` e `phone_key` gravados pelo próprio `INSERT` do seed (ele não passa pelo hook) |

O e-mail segue obrigatório para todo `user` e `portal_user` (colunas `NOT NULL` e únicas hoje).

**Sem cadastros anteriores:** o projeto é novo e só terá cadastros depois desta implementação
(decisão do proprietário). Não há aviso de "telefone pendente", filtro "Sem telefone" nem
`phoneRequired` em `/api/me`: toda conta e todo cliente nascem com telefone, e o `CHECK` do
banco garante isso.

## Cliente sem e-mail e conta acessível

Regra de produto: **só tem conta acessível quem tem e-mail**. O cliente sem e-mail é um cadastro
(atendimento, etiquetas, campos), nunca um acesso.

- `customer.email` nulo: sem convite (`POST .../invite` → 409 `EMAIL_REQUIRED`), sem magic
  link, sem `portal_user`, sem login. `findPortalCustomer` e o magic link só casam cliente com
  e-mail; nulo não casa com nada, e a resposta ao visitante é a mesma de sempre (nunca revela
  se existe).
- A tela mostra "Enviar acesso" desabilitado com "Cadastre um e-mail para liberar o acesso do
  cliente". Salvar o e-mail depois libera o botão; o e-mail passa pela mesma regra de unicidade
  `(tenant_id, email)`.
- Quem tem e-mail mas ainda não aceitou o convite não tem conta até aceitar (regra existente do
  portal); a mudança aqui é só o caso sem e-mail.

## E-mail opcional do cliente: onde encosta

| Arquivo | Ajuste |
|---|---|
| `src/lib/schemas/customer.ts` | `email` opcional (vazio vira `null`); `phone` **obrigatório** (`phoneSchema`); o `refine` "e-mail ou telefone" deixa de existir: o telefone é sempre exigido, no schema e no `CHECK` do banco |
| `src/lib/tenant/customers.ts` | Busca e conflito tolerantes a nulo; `POST .../invite` sem e-mail → 409 `EMAIL_REQUIRED` |
| `src/lib/portal/access.ts`, `login.ts` | Só casam cliente com e-mail; nulo nunca casa com nada. `ensurePortalUser(email, name, phone)` grava o telefone do cliente convidado (seção "Telefone obrigatório nos cadastros de pessoa") |
| `src/lib/lgpd/deletion.ts`, `export.ts` | Anonimização segue gravando `deleted+<id>@invalid`; exportação aceita nulo |
| `src/lib/admin/people.ts` | Troca de e-mail da pessoa do portal só toca vínculos por `portal_user_id` |
| `customer-form-dialog.tsx`, `customers-page.tsx`, `customer-detail-page.tsx` | E-mail sem asterisco; **telefone com asterisco e `PhoneField`**; "—" quando o e-mail está vazio; "Enviar acesso" desabilitado com a explicação |
| `src/pages/signup-page.tsx`, `pages/portal/*` (cadastro e perfil), `profile` da equipe, `user-detail-page.tsx`, `portal-user-detail-page.tsx` | `PhoneField` obrigatório no lugar do campo de texto; `autoComplete="tel"`; erro do motivo no campo |

## Contratos

Schemas em `src/lib/schemas/crm.ts`. Erros por `handleTenantError`. Ordem dos middlewares de
`tech/21-tenant-rbac.md`. Os serviços ficam em `src/lib/crm/{tags,custom-fields,values}.ts` e
recebem `Scope`.

### Tenant

| Método e rota | Entrada | Saída | Autorização |
|---|---|---|---|
| `GET /api/tags` | – | `{ tags: [{ id, name, color, usage }] }`, por nome | `customer:read` |
| `POST /api/tags` | `tagSchema { name, color? }` | 201 `{ tag }`; 409 `TAG_NAME_TAKEN`, `TAG_LIMIT` | `tag:manage` |
| `PATCH /api/tags/:id` | `tagSchema.partial()` | `{ tag }`; 404; 409 `TAG_NAME_TAKEN` | `tag:manage` |
| `DELETE /api/tags/:id` | – | `{ ok, removedFrom }` | `tag:manage` |
| `PUT /api/customers/:id/tags/:tagId` | – | `{ ok }`, idempotente; 409 `CUSTOMER_TAG_LIMIT` | `customer:update` |
| `DELETE /api/customers/:id/tags/:tagId` | – | `{ ok }`, idempotente | `customer:update` |
| `GET /api/customers` | soma `tags=<id,id>` (qualquer uma) | cada cliente com `tags: [{ id, name, color }]` | `customer:read` |
| `POST`, `PATCH /api/customers[/:id]` | `tags: string[]` sai; entram `tagIds?: uuid[]` (substitui o conjunto) e `customFields?: Record<uuid, valor \| null>` | cliente com `tags` e `customFields`; 400 `PHONE_REQUIRED` e 400 `INVALID_PHONE` (com `reason` e a mensagem); 409 `PHONE_IN_USE`, 409 `CUSTOMER_EMAIL_IN_USE` | `customer:create`, `customer:update` |
| `GET /api/custom-fields?entity=customer&archived=` | – | `{ fields: [...] }`, por `position` | `customer:read` |
| `POST /api/custom-fields` | `customFieldSchema { entity, label, key?, type, options?, required? }` | 201 `{ field }`; 409 `FIELD_KEY_TAKEN`, `FIELD_LIMIT` | `custom_field:manage` |
| `PATCH /api/custom-fields/:id` | `{ label?, options?, required?, archived? }` | `{ field }`; 409 `OPTION_IN_USE` | `custom_field:manage` |
| `PUT /api/custom-fields/order` | `{ entity, ids: uuid[] }` | `{ ok }` | `custom_field:manage` |
| `DELETE /api/custom-fields/:id` | `{ confirm: key }` | `{ ok, clearedFrom }`; 400 `CONFIRMATION_MISMATCH` | `custom_field:manage` |

Regras:

- `name` de etiqueta: `trim`, espaços internos reduzidos a um, 1 a 40. A unicidade é do banco;
  o `23505` vira 409 `TAG_NAME_TAKEN` (nunca mescla nem devolve a existente).
- `color` passa por `normalizeHexColor`: aceita `#abc`, `abc`, `AABBCC` e grava `#aabbcc`.
- Id de etiqueta ou de campo de outro escopo é 404, pela política e pelo `where`.
- `tagIds` e `tags/:tagId` conferem, na mesma transação, que a etiqueta é do tenant.
- `key`: gerada do rótulo (`slugify`, `_` como separador, até 40) se não vier; nunca muda.
- `type` não muda depois de criado. `options` só nos dois tipos de lista; tirar uma opção
  ainda usada é 409 `OPTION_IN_USE` com a contagem (a tela oferece renomear o rótulo).
- `customFields` no `PATCH` é **merge por chave**: `null` remove, chave ausente não muda. O
  `UPDATE` usa `custom_fields || $patch` e `- $removidas` numa instrução só.
- Validação por `buildCustomFieldsSchema(defs)` (`src/lib/crm/values.ts`), que monta um Zod a
  partir das definições ativas, usado pelo formulário e pela API. Id desconhecido ou arquivado é
  400 `UNKNOWN_FIELD`.
- `required` vale quando o corpo traz `customFields` (o formulário completo sempre traz). Quem
  cria cliente sem esse bloco, como o "Salvar como cliente" do atendimento, passa; o detalhe
  mostra "campos obrigatórios pendentes".
- `DELETE /api/custom-fields/:id` apaga a definição e faz
  `UPDATE customer SET custom_fields = custom_fields - $id` na mesma transação.
- Portal: `findPortalCustomer` segue com a lista fechada de colunas. Etiquetas e campos **não**
  entram.

### Plataforma (`/api/admin/crm/*`)

Mesmos schemas e serviços, com `Scope = platform` e `withPlatformData`. Leitura para a
plataforma; toda escrita soma `requirePlatform(["platform_owner"])` e
`blockWhileImpersonating`.

| Método e rota | Observação |
|---|---|
| `GET`, `POST /api/admin/crm/tags`; `PATCH`, `DELETE .../:id` | Catálogo da plataforma |
| `GET`, `POST /api/admin/crm/custom-fields`; `PATCH`, `DELETE .../:id`; `PUT .../order` | `entity = organization` |
| `PUT /api/admin/tenants/:id/profile` `{ tagIds?, customFields? }` | Grava `organization_tag` e `organization_profile` |
| `GET /api/admin/tenants`, `GET /api/admin/tenants/:id` | Somam `tags` (lista e detalhe), `customFields` (detalhe) e o filtro `tags=` |

`GET /api/tenant`, `/api/me` e qualquer rota de tenant não leem essas duas tabelas: a política
`platformOnlyPolicy()` as recusa fora de `withPlatformData`.

## Permissões

Em `statements` (`src/lib/auth/permissions.ts`):

```ts
tag: ["manage"],
custom_field: ["manage"],
```

| Papel | `tag:manage` | `custom_field:manage` | Aplicar etiqueta e preencher campo |
|---|---|---|---|
| owner, admin | sim | sim | sim (`customer:update`) |
| member | não | não | sim (`customer:update`) |
| papel personalizado | atribuível | atribuível | conforme `customer:update` |

`tests/db/rbac.test.ts` gera a matriz do catálogo: as rotas novas entram na tabela do teste.

## Interface

| Rota | Arquivo | O que tem |
|---|---|---|
| `/app/configuracoes/etiquetas` | `routes/app.settings.tags.tsx`, `components/app/crm/tag-manager.tsx` | Lista de chips; criar em linha (nome + cor); editar em diálogo com prévia nos dois temas; excluir com contagem |
| `/app/configuracoes/campos` | `routes/app.settings.fields.tsx`, `components/app/crm/custom-field-manager.tsx` | Lista ordenável; diálogo de criar e editar (rótulo, tipo, opções, obrigatório); arquivar; excluir digitando a `key` |
| `/app/clientes` | `pages/customers-page.tsx` | Filtro de etiquetas (popover com busca e chips ativos); coluna de etiquetas com até 3 chips e "+N" |
| `/app/clientes/:id` e diálogo | `customer-detail-page.tsx`, `customer-form-dialog.tsx` | Seletor de etiquetas; seção "Campos adicionais" gerada das definições; `PHONE_IN_USE` vira erro no campo de telefone, com link para o cliente que já tem o número |
| `/admin/configuracoes/etiquetas`, `/admin/configuracoes/campos` | `routes/admin/crm-tags.tsx`, `crm-fields.tsx` | Os mesmos componentes, com a API da plataforma por props |
| `/admin/tenants`, `/admin/tenants/:id` | `tenants-page.tsx`, `tenant-detail-page.tsx` | Filtro e chips; cartão "Etiquetas e campos" no detalhe |

**`PhoneField`** (`src/components/ui/phone-field.tsx`, usado por todos os formulários de
pessoa, incluindo `/cadastro` e o portal): `react-phone-number-input` (a mesma biblioteca do
formulário de contato da origem), importada pelo build `min` para limitar o bundle, com seletor
de país (Brasil como padrão) e máscara nacional enquanto se digita. É só apresentação: o valor
que vai para a API é o texto digitado quando o país é o Brasil e **sempre o E.164 com `+`**
quando é outro país (sem o `+`, um número de 11 dígitos dos EUA seria lido como brasileiro), e
quem valida e normaliza é `normalizePhone`,
no cliente (mensagem do motivo no campo, ao sair do campo e ao enviar) e **de novo no
servidor**. Aceita colar `+55 (11) 98765-4321`, `5511987654321` e `011 98765-4321`. Rótulo
"Telefone / WhatsApp", aviso do `phoneWarning` abaixo do campo, asterisco de obrigatório, `inputMode="tel"`, `aria-invalid` e
`aria-describedby` apontando para o erro, componente de formulário do `shadcn/ui` do projeto.

Componentes compartilhados em `src/components/crm/`, reaproveitados pelo atendimento:

- `tag-chip.tsx`: fundo na cor com alfa `0x20`, texto na cor, borda com alfa `0x40`,
  `rounded-full`, sempre com o nome.
- `tag-color-picker.tsx`: 8 presets (`#ef4444`, `#f97316`, `#f59e0b`, `#10b981`, `#06b6d4`,
  `#3b82f6`, `#8b5cf6`, `#ec4899`), grade ampliada de 36 e campo hexadecimal. Aviso de contraste
  abaixo de 2:1 contra a superfície do tema (`src/lib/crm/colors.ts`), sem bloquear.
- `tag-picker.tsx`: diálogo com busca e caixas de seleção; alternar é otimista, com volta em
  caso de erro; "Criar '…'" só com `tag:manage`.
- `custom-field-input.tsx`: um controle por tipo.

- **Estados:** carregando, vazio ("Nenhuma etiqueta ainda"), erro e sucesso por `QueryState`.
- **Dados no cliente:** `useQuery(["tags"])`, `["custom-fields", entity]`; mutações invalidam
  `["customers"]`.
- **Navegação:** `app-nav.ts` e `admin-nav.ts` ganham os títulos das páginas novas; os links
  ficam dentro de Configurações.

## Segurança

- Catálogo é configuração: escrita só com permissão própria, conferida no servidor.
- Valor de campo e nome de etiqueta são dado pessoal em potencial: não entram em `logError` nem
  em `metadata` da auditoria (só ids e `key`).
- **Telefone é dado pessoal:** nunca em log, em `logError`, no Sentry nem em `metadata` da
  auditoria; quando for preciso citar, `maskPhoneForLog` (`55 11 9****-4321`). A auditoria de
  troca de telefone (`user.phone_changed`, `customer.phone_changed`) leva só o id.
- **Validação duas vezes:** a do `PhoneField` é conforto; a do servidor (`phoneSchema` e o hook de
  criação de conta) é a regra. Telefone com tamanho absurdo é cortado antes do `normalizePhone`
  (máximo 30 caracteres de entrada).
- `organization_tag` e `organization_profile` nunca saem em rota de tenant; teste dedicado.
- Rótulos, nomes e opções são texto puro: renderizados pelo React, sem HTML.
- Auditoria: `tag.created`, `tag.updated`, `tag.deleted`, `custom_field.created`,
  `custom_field.updated`, `custom_field.archived`, `custom_field.deleted`; na plataforma, com
  prefixo `admin.` e `actor_type = platform`.
- LGPD: `clientes-<slug>.json` da exportação passa a trazer etiquetas e campos (rótulo e
  valor). A anonimização de cliente zera `custom_fields`, `phone_normalized` e `phone_key` e
  apaga os `customer_tag`; a de conta (`anonymizeUser`) zera `phone_normalized` e `phone_key`
  junto com o `phone` que já zera. As duas gravam o e-mail `deleted+<id>@invalid` no mesmo
  `UPDATE`, que é o que o `CHECK` de telefone aceita.

## Plano de implementação

1. **F0, escopo de plataforma** (contrato no plano) → `tests/db/rls.test.ts` com os três modos.
2. **A1, telefone (biblioteca e campo):** `src/lib/phone/` com os testes da origem, mais os
   casos do guia (tabela abaixo), `phoneSchema` e `PhoneField` → `npm test`.
   Casos obrigatórios de `normalizePhone` (celular `11 98765-4321` como base): com `+55`,
   `55` sem `+`, `011` de tronco, parênteses, espaços e hífen → `5511987654321`; DDD `10`, `23`,
   `90` → `invalid_ddd`; DDD `55` (Santa Maria/RS) com 11 dígitos sem DDI → válido (não confunde
   com o DDI); `11 3456-7890` → válido como `landline` (aviso); `11 9876-5432` → válido como
   `mobile_legacy` (aviso); `11 0456-7890` e `11 1456-7890` → `invalid_local_prefix`; `11 88765-4321`
   → `mobile_invalid_ninth_digit`; `11 98765-43` → `invalid_length`; `0800 123 4567` → recusado;
   `9876-5432` sem DDD → `missing_area_code`; estrangeiro `+1 415 555 2671` (11 dígitos) e
   `+44 20 7946 0958` → válidos como `foreign`; `+1 115 555 2671` e `+351 912 345 678` →
   `foreign`, sem regra de DDD nem de 9º dígito (só DDI `55` usa a regra do Brasil);
   `+55 11 98765-4321` → `5511987654321`; `+55 10 98765-4321` → `invalid_ddd`; `+999`
   e `+1234567` → `invalid_length`; celular antigo `11 9876-5432` gravado como
   `551198765432` (sem inserir o 9), `10 9876-5432` → `invalid_ddd`, `11 9876-543` →
   `invalid_length`; vazio → `empty`; os 67 DDDs aceitos e os de fora da lista
   recusados; `phone_key` igual para `5511987654321` e `551187654321` e diferente entre fixos
   distintos.
2a. **A1, cadastros de conta (Opus):** `signupSchema`, `auth-ext.ts`, hooks de criação em
   `auth` e `portalAuth`, perfil, `/admin`, seed, `ensurePortalUser` → `tests/db`: criar conta
   sem telefone, com celular sem o 9 ou com DDD inexistente falha; com fixo é aceita (com o
   aviso na tela), como no cliente; chamar o Better Auth direto sem passar pelo `auth-ext`
   também falha; conta criada grava `phone_normalized` e `phone_key`;
   `additionalFields.phone` não aceita valor vindo do corpo; convite do portal de cliente com
   telefone cria `portal_user` com o telefone dele. `/security-review`.
3. **A1, cliente:** migration 1, schema, `customers.ts`, portal, LGPD, admin e telas →
   `tests/db/customers.test.ts` (sem e-mail aceita com telefone; **com e-mail e sem telefone
   recusa** `PHONE_REQUIRED`; sem os dois recusa; telefone inválido `INVALID_PHONE`; `PATCH` que
   deixaria o cliente sem telefone recusa; convite sem e-mail 409; sem e-mail não entra no
   portal por magic link; telefone repetido 409 `PHONE_IN_USE`, também escrito de outra forma e com ou
   sem o 9º dígito; o próprio cliente salva sem conflito; dois `POST` simultâneos, um 409 pelo
   índice, inclusive com um em cada variante do 9º dígito; `INSERT` direto sem telefone em
   `customer`, `user` e `portal_user` é barrado pelo `CHECK`; anonimização de cliente e de conta
   passa no `CHECK`; migration em base com linha sem telefone aborta com a mensagem) e
   `portal-auth.test.ts` sem regressão.
4. **A2, etiquetas (dados e API):** migration 2 (sem backfill, remove `customer.tags`),
   serviço, rotas, permissões → unicidade sem diferenciar maiúsculas; 101ª etiqueta
   `TAG_LIMIT`; id de outro tenant 404; matriz RBAC.
5. **A2, etiquetas (telas):** componentes de `src/components/crm/`, configurações, lista,
   detalhe e formulário → smoke com o seed.
6. **A3, campos (dados e API):** migration, `buildCustomFieldsSchema`, merge por chave →
   testes unitários de cada tipo; 13º campo ativo `FIELD_LIMIT` (arquivar libera vaga); teste
   de banco do merge concorrente e da exclusão que limpa valores.
7. **A3, campos (telas):** gestor, formulário e detalhe → smoke.
8. **A4, plataforma:** migration, rotas `/api/admin/crm/*`, telas → teste de que nenhuma rota de
   tenant devolve dado da plataforma; suporte recebe 403 nas escritas.
9. **Contexto e revisão.**

## Verificação

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db`, `npm run build`
- [ ] Testes de cada etapa acima
- [ ] Smoke de telefone: `/cadastro` recusa sem telefone, com DDD `10` e com celular sem o 9;
  aceita `+55 (11) 98765-4321`; fixo `(11) 3456-7890` é aceito com o aviso; a máscara aparece ao digitar; cliente sem e-mail e com
  telefone salva e "Enviar acesso" fica desabilitado; celular antigo `(11) 9876-5432` é aceito
  com o aviso de conferir o 9; `+1 415 555 2671` com o país EUA é aceito
- [ ] Smoke com o seed (`acme`): criar etiquetas e campos, aplicar em `julia@cliente.local`,
  filtrar, renomear, excluir; cliente só com telefone; em `/admin`, etiquetar `acme` e conferir
  que `acme.owner` não vê
- [ ] Cada critério de aceite do PRD marcado
- [ ] `/code-review`; `/security-review` em A1 e A4

## Atualização de contexto

- [ ] `docs/context/tech/28-crm-cadastro.md` (novo) e linha no `INDEX.md`
- [ ] `tech/25-portal-clientes.md`: e-mail opcional do cliente, cliente sem e-mail sem acesso,
  `tagIds`, o que o portal não vê
- [ ] `tech/08-auth.md`: telefone obrigatório no cadastro (`signupSchema`, `auth-ext.ts`, hook
  de criação) e o `CHECK` de telefone no banco
- [ ] `tech/12-shadcn-ui.md` (ou `tech/09`): `PhoneField`; `docs/references/` com o guia de
  telefones do Brasil; `docs/context/lgpd.md`: telefone como dado pessoal obrigatório
- [ ] `tech/07-banco-drizzle.md`: tabelas novas, `scopedPolicy()` e `platformOnlyPolicy()`
- [ ] `tech/21-tenant-rbac.md`: permissões e eventos de auditoria novos
- [ ] `tech/22-admin.md`: rotas e telas de etiquetas e campos
- [ ] `tech/27-lgpd-arquivos.md` e `lgpd.md`: exportação e anonimização
- [ ] `status.md`; seed com etiquetas e campos de exemplo
- [ ] Rules `banco-drizzle` (as duas políticas novas) em `.claude/rules/` e `.cursor/rules/`

## Decisões

| Decisão | Motivo | Alternativa descartada |
|---|---|---|
| Valores em `jsonb` no cadastro, chaveados pelo id do campo | Leitura única, gravação atômica, renomear não toca em valor | Tabela de valores, como na origem |
| `type` e `key` imutáveis | Converter valores entre tipos exigiria regra por par de tipos | Edição livre |
| Arquivar e excluir são ações diferentes | Excluir apaga dado de todos os clientes; arquivar é reversível | Só excluir |
| Excluir etiqueta apaga os vínculos (`cascade`) | Comportamento da origem, com contagem na confirmação | Exclusão lógica |
| Nome repetido é erro, não mescla | Mesclar em silêncio muda etiquetas de clientes sem ninguém pedir | "Criar ou reaproveitar" da origem |
| Telefone obrigatório na aplicação **e no banco** (`CHECK`, exceto linha anonimizada) | Projeto novo, sem cadastro anterior (decisão do proprietário): o banco pode fechar a porta desde o início | Só na aplicação, com aviso para contas antigas; `NOT NULL` puro (quebraria a anonimização) |
| Fixo e celular antigo aceitos com aviso; só celular inicia conversa | Decisão do proprietário, igual à origem. Há cliente que só tem fixo; o guia manda "apenas celulares para WhatsApp" no envio. O celular antigo é aceito se informado, mas validado (DDD, 8 dígitos, começa com 9) | Recusar fixo ou celular antigo no cadastro |
| Regra do Brasil só para DDI `55` | Decisão do proprietário: número de outro país só passa pelo tamanho do E.164 | Validar por país com `libphonenumber` |
| E-mail obrigatório só para conta; cliente sem e-mail sem acesso | Cliente que chega pelo WhatsApp raramente tem e-mail; acesso sem e-mail provado não é seguro | Exigir e-mail em todo cliente |
| `PhoneField` com `react-phone-number-input` | Mesma biblioteca da origem; país e máscara prontos | Máscara própria |
| Telefone único por tenant (quando preenchido) | Decisão do proprietário: um número identifica um cliente, e o atendimento liga o contato sem ambiguidade | Permitir repetidos com aviso; fusão de duplicados |
| Unicidade por `phone_key` (número sem o 9º dígito), não pelo canônico | O índice barra também a variante, sem depender só da checagem do serviço | Índice no canônico + checagem de variantes só no serviço |
| Sem backfill de telefone nem de etiquetas; `customer.tags` sai na própria A2 | Projeto novo, sem dado a migrar (decisão do proprietário); a migration aborta se achar linha sem telefone | Backfill com deduplicação e drop em duas etapas |
| Etiquetas e campos da plataforma em tabelas próprias, sem `tenant_id` | O owner nunca alcança, nem com `withTenant` | Colunas em `organization` |
| Filtro por campo adicional fora desta entrega | Não pedido; o `jsonb` permite depois com índice GIN | Fazer agora |
