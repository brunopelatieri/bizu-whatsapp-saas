# SPEC: Cadastro CRM (etiquetas, campos adicionais e telefone)

- **Status:** rascunho
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
  `src/api/admin.ts` (soma `/api/admin/crm/*`)
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
| Telefone obrigatório e único por conta | Telefone opcional, não único | O cadastro daqui nasceu por e-mail e já pode ter números repetidos |

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
| `customer` (muda) | `email` passa a anulável; `phone_normalized text`; `custom_fields jsonb not null default '{}'`; `CHECK (email IS NOT NULL OR phone_normalized IS NOT NULL)` | Índice `(tenant_id, phone_normalized)`, não único. O único `(tenant_id, email)` fica como está: o Postgres aceita vários nulos |
| `user` (muda) | `phone_normalized text` (`additionalFields`, `input: false`) | Índice simples. Serve a caixa de entrada para reconhecer a equipe |

- `custom_fields` guarda `{ "<id do campo>": valor }`. A chave é o **id**, não a `key`: renomear
  rótulo não toca em valor nenhum. A `key` existe para importação, exportação e API futura.
- Valores por tipo: `text` string até 500; `number` número finito; `date` `AAAA-MM-DD`;
  `boolean`; `select` um `value` das opções; `multiselect` lista de até 20 `value`.
- Tetos em `src/lib/crm/constants.ts`: 200 etiquetas por escopo, 20 por cliente (já é o limite
  do schema atual), 30 campos ativos por entidade, 50 opções por campo.

### Migrations

Uma por fase, geradas com `npm run db:generate`; `FORCE ROW LEVEL SECURITY` e os índices de
expressão em migration customizada, como em `0007_rls_roles.sql`.

1. **`00xx_telefone_email_opcional` (A1):** colunas novas; `email` anulável; backfill de
   `phone_normalized` em SQL (`regexp_replace` para dígitos; 10 ou 11 dígitos ganham `55`; 12 a
   15 ficam; o resto vira `NULL`); `CHECK` criado `NOT VALID` e validado depois, pois todo
   cliente atual tem e-mail.
2. **`00xx_etiquetas` (A2):** cria `tag` e `customer_tag`; backfill com
   `app.bypass_tenant`: para cada tenant, um `tag` por `lower(btrim(valor))` distinto de
   `customer.tags` (fica a grafia do cliente mais antigo) e o `customer_tag` de cada cliente.
   A coluna `customer.tags` **fica**, sem leitura nem escrita, e sai na migration seguinte.
3. **`00xx_etiquetas_drop_legado`:** remove `customer.tags`, num deploy posterior.
4. **`00xx_campos_adicionais` (A3)** e **`00xx_crm_plataforma` (A4).**

- **Rollout:** A1 e A2 são compatíveis com o código anterior durante o deploy (colunas
  aditivas, `tags` antiga preservada). Só a migration 3 exige o código novo já no ar.

## Telefone (`src/lib/phone/`)

Porta de `normalizeContactPhone`, `formatPhoneForDisplay`, `phoneVariants` e `phonesMatch` da
origem, com os testes.

- `normalizePhone(raw, { strict })` → `{ ok, phone, kind, legacy }` ou `{ ok: false, reason }`.
  Só dígitos; tira um zero de tronco; 10 ou 11 dígitos recebem `55` depois de validar DDD (67
  códigos da Anatel) e o 9 do celular; 12 a 15 dígitos seguem como estrangeiro.
- **O 9º dígito nunca é inserido.** `phoneVariants(phone)` devolve o número e, para celular do
  Brasil, a forma com e sem o 9: é com ela que se busca.
- `phoneSchema` de `customer.ts` passa a chamar `normalizePhone` em modo estrito: número
  inválido é 400 no formulário. `customer.phone` guarda o que a pessoa digitou;
  `phone_normalized`, o canônico.
- Telefone repetido em outro cliente do tenant não bloqueia: a resposta traz
  `warnings: ["PHONE_IN_USE"]` e a tela avisa.
- `user.phone_normalized` é gravado onde `user.phone` é gravado hoje (perfil e `/admin`).

## E-mail opcional: onde encosta

| Arquivo | Ajuste |
|---|---|
| `src/lib/schemas/customer.ts` | `email` opcional (vazio vira `null`); `refine`: e-mail ou telefone |
| `src/lib/tenant/customers.ts` | Busca e conflito tolerantes a nulo; `POST .../invite` sem e-mail → 409 `EMAIL_REQUIRED` |
| `src/lib/portal/access.ts`, `login.ts` | Só casam cliente com e-mail; nulo nunca casa com nada |
| `src/lib/lgpd/deletion.ts`, `export.ts` | Anonimização segue gravando `deleted+<id>@invalid`; exportação aceita nulo |
| `src/lib/admin/people.ts` | Troca de e-mail da pessoa do portal só toca vínculos por `portal_user_id` |
| `customer-form-dialog.tsx`, `customers-page.tsx`, `customer-detail-page.tsx` | E-mail sem asterisco; "—" quando vazio; "Enviar acesso" desabilitado com a explicação |

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
| `POST`, `PATCH /api/customers[/:id]` | `tags: string[]` sai; entram `tagIds?: uuid[]` (substitui o conjunto) e `customFields?: Record<uuid, valor \| null>` | cliente com `tags`, `customFields` e `warnings?` | `customer:create`, `customer:update` |
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
| `/app/clientes/:id` e diálogo | `customer-detail-page.tsx`, `customer-form-dialog.tsx` | Seletor de etiquetas; seção "Campos adicionais" gerada das definições |
| `/admin/configuracoes/etiquetas`, `/admin/configuracoes/campos` | `routes/admin/crm-tags.tsx`, `crm-fields.tsx` | Os mesmos componentes, com a API da plataforma por props |
| `/admin/tenants`, `/admin/tenants/:id` | `tenants-page.tsx`, `tenant-detail-page.tsx` | Filtro e chips; cartão "Etiquetas e campos" no detalhe |

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
- `organization_tag` e `organization_profile` nunca saem em rota de tenant; teste dedicado.
- Rótulos, nomes e opções são texto puro: renderizados pelo React, sem HTML.
- Auditoria: `tag.created`, `tag.updated`, `tag.deleted`, `custom_field.created`,
  `custom_field.updated`, `custom_field.archived`, `custom_field.deleted`; na plataforma, com
  prefixo `admin.` e `actor_type = platform`.
- LGPD: `clientes-<slug>.json` da exportação passa a trazer etiquetas e campos (rótulo e
  valor). A anonimização de cliente zera `custom_fields` e apaga os `customer_tag`.

## Plano de implementação

1. **F0, escopo de plataforma** (contrato no plano) → `tests/db/rls.test.ts` com os três modos.
2. **A1, telefone:** `src/lib/phone/` com os testes da origem → `npm test`.
3. **A1, cliente:** migration 1, schema, `customers.ts`, portal, LGPD, admin e telas →
   `tests/db/customers.test.ts` (sem e-mail aceita com telefone; sem os dois recusa; convite
   sem e-mail 409) e `portal-auth.test.ts` sem regressão.
4. **A2, etiquetas (dados e API):** migration 2 com backfill, serviço, rotas, permissões →
   teste do backfill com grafias repetidas; unicidade sem diferenciar maiúsculas; id de outro
   tenant 404; matriz RBAC.
5. **A2, etiquetas (telas):** componentes de `src/components/crm/`, configurações, lista,
   detalhe e formulário → smoke com o seed.
6. **Migration 3** (drop de `customer.tags`) em PR e deploy próprios.
7. **A3, campos (dados e API):** migration, `buildCustomFieldsSchema`, merge por chave →
   testes unitários de cada tipo; teste de banco do merge concorrente e da exclusão que limpa
   valores.
8. **A3, campos (telas):** gestor, formulário e detalhe → smoke.
9. **A4, plataforma:** migration, rotas `/api/admin/crm/*`, telas → teste de que nenhuma rota de
   tenant devolve dado da plataforma; suporte recebe 403 nas escritas.
10. **Contexto e revisão.**

## Verificação

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db`, `npm run build`
- [ ] Testes de cada etapa acima
- [ ] Smoke com o seed (`acme`): criar etiquetas e campos, aplicar em `julia@cliente.local`,
  filtrar, renomear, excluir; cliente só com telefone; em `/admin`, etiquetar `acme` e conferir
  que `acme.owner` não vê
- [ ] Cada critério de aceite do PRD marcado
- [ ] `/code-review`; `/security-review` em A1 e A4

## Atualização de contexto

- [ ] `docs/context/tech/28-crm-cadastro.md` (novo) e linha no `INDEX.md`
- [ ] `tech/25-portal-clientes.md`: e-mail opcional, `tagIds`, o que o portal não vê
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
| Telefone não é único por tenant | O cadastro já aceita números repetidos (família, empresa) | Único, com fusão de duplicados |
| `customer.tags` sai em duas migrations | Deploy sem janela de erro | Trocar tudo de uma vez |
| Etiquetas e campos da plataforma em tabelas próprias, sem `tenant_id` | O owner nunca alcança, nem com `withTenant` | Colunas em `organization` |
| Filtro por campo adicional fora desta entrega | Não pedido; o `jsonb` permite depois com índice GIN | Fazer agora |
