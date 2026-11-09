# Cadastro CRM: telefone, e-mail do cliente, etiquetas e campos

- **Escopo:** Telefone obrigatório em todo cadastro de pessoa, e-mail opcional do cliente e
  (nas fases A2 a A4) etiquetas e campos adicionais. Estado por fase na tabela abaixo.
- **Specs relacionadas:** `docs/specs/crm-cadastro/spec.md` e `prd.md`;
  `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T7, fase F0 e fases A1 a A4).
- **Paths do código:** `src/lib/phone/`, `src/lib/schemas/phone.ts`,
  `src/components/ui/phone-field.tsx`, `src/db/phone-check.ts`, `src/lib/tenant/customers.ts`,
  `src/lib/lgpd/consent.ts`, `src/lib/portal/`, `src/lib/admin/people.ts`

## Estado por fase

| Fase | Entrega | Estado |
|---|---|---|
| A1 | Telefone obrigatório (biblioteca, schema, `PhoneField`, banco, cadastros) e e-mail do cliente opcional | implementada |
| A2 | Etiquetas do tenant (`tag`, `customer_tag`) | pendente (depende da F0, `scopedPolicy()`) |
| A3 | Campos adicionais do tenant (`custom_field`, `customer.custom_fields`) | pendente (depende da F0) |
| A4 | Etiquetas e campos da plataforma (`organization_tag`, `organization_profile`) | pendente (A2 e A3) |

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
  único (duas pessoas podem dividir o número). A migration `0022` aborta com mensagem clara se
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

## O que a SPEC pede e ainda não existe

Etiquetas, campos adicionais e os pedaços de `/admin` das fases A2 a A4 (esta página cresce com
elas). Não existe tela de perfil da equipe: o telefone da equipe entra no `/cadastro` e é editado
pelo proprietário da plataforma em `/admin/usuarios/:id`.
