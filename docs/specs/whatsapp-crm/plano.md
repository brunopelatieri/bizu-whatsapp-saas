# Plano mestre: WhatsApp CRM (canais, caixa de entrada, etiquetas e campos)

- **Status:** rascunho (aguarda aprovação dos PRDs)
- **Data:** 2026-11-09
- **Origem:** recursos do projeto `zap-crm-br-client` (Next.js + Supabase), portados para a
  stack deste repositório (React Router + Hono + Drizzle + Postgres com RLS).

> Este arquivo é o índice do programa. Guarda só o que vale para as três features: escopos,
> decisões transversais, ordem das fases e modelo recomendado. O detalhe fica no PRD e na SPEC
> de cada feature. Nada aqui foi implementado.

## Features

| Feature | PRD | SPEC | Entrega |
|---|---|---|---|
| Cadastro CRM | `docs/specs/crm-cadastro/prd.md` | `docs/specs/crm-cadastro/spec.md` | Etiquetas com cor, campos adicionais, telefone normalizado e e-mail opcional no cliente |
| Canais WhatsApp | `docs/specs/whatsapp-canais/prd.md` | `docs/specs/whatsapp-canais/spec.md` | Configuração da Cloud API e do Evolution Go (QR Code), webhooks e modelos de mensagem |
| Caixa de entrada | `docs/specs/caixa-de-entrada/prd.md` | `docs/specs/caixa-de-entrada/spec.md` | Chat, fila de atendimento, atribuição e tempo real |

Cada feature vale nos **dois escopos**:

| Escopo | Quem usa | Com quem fala | Cadastro principal | Fila |
|---|---|---|---|---|
| Tenant (`/app`) | owner, admins e membros | clientes do owner e a própria equipe | `customer` | sim |
| Plataforma (`/admin`) | proprietário e suporte do SaaS | owners, equipes dos owners e clientes dos owners | `organization` | não |

## Decisões transversais

Valem para as três SPECs. Cada SPEC só as cita.

| # | Decisão | Motivo | Alternativa descartada |
|---|---|---|---|
| T1 | **Um schema, dois escopos:** as tabelas novas têm `tenant_id` anulável; `NULL` é dado da plataforma | Já é o padrão de `audit_log` e `deletion_request`; evita duplicar ~12 tabelas | Tabelas `platform_*` espelhadas |
| T2 | **Política `scopedPolicy()`** no lugar de `tenantPolicy()` nessas tabelas: passa com `app.bypass_tenant`, com `tenant_id = app.tenant_id` ou com `tenant_id IS NULL` e `app.platform_scope = 'on'`. Helper novo `withPlatformData(fn)` liga só esse último | `withPlatformScope` atravessa tudo: um filtro esquecido mostraria conversas dos tenants no `/admin`. Com a política, o banco recusa | Filtrar `tenant_id IS NULL` à mão em cada query |
| T3 | Tipo `Scope = { kind: "tenant", tenantId } \| { kind: "platform" }` e `withScope(scope, fn)` em `src/db/rls.ts`. Os serviços de `src/lib/{crm,channels,inbox}/` recebem `Scope`; as rotas `/api/*` e `/api/admin/*` só montam o escopo e a autorização | Uma regra de negócio, duas portas de entrada | Dois serviços por feature |
| T4 | **Quem escreve no WhatsApp é um `chat_contact`**, não um `customer`. Nasce sozinho na primeira mensagem (telefone + nome do WhatsApp), não conta no limite do plano e pode ser ligado a um `customer` ou a um `user` | Resposta do proprietário: o atendente decide se o número vira cliente. Desconhecidos não enchem o cadastro nem consomem o plano | Criar `customer` `lead` a cada número novo |
| T5 | **`customer.email` passa a ser opcional**; o cliente precisa de e-mail ou telefone. Sem e-mail não há acesso ao portal | Cliente que chega pelo WhatsApp raramente informa e-mail | Manter obrigatório e impedir salvar pelo chat |
| T6 | **Telefone canônico:** só dígitos, com DDI, sem `+` (`5519999249658`), em coluna `phone_normalized`. Normalizador único em `src/lib/phone/` (porta do `br.ts` da origem). O 9º dígito nunca é inserido; a busca tenta as variantes com e sem ele | É o formato dos dois provedores; a origem mediu os casos do Brasil | E.164 com `+`; `libphonenumber` |
| T7 | **Etiquetas e campos da plataforma ficam na organização** (`organization_tag`, `organization_profile`), visíveis só em `/admin` | Resposta do proprietário. O owner nunca vê o que a plataforma anota sobre ele | Etiquetar usuários |
| T8 | **Servidor Evolution Go único, da plataforma**, por variáveis de ambiente. Tenant nunca informa URL | Resposta do proprietário; sem SSRF | URL por tenant |
| T9 | **Canais são módulos:** `src/lib/channels/providers/<id>/`, ligados por `CHANNEL_PROVIDERS` (`whatsapp_cloud,whatsapp_qr`). Apagar a pasta e tirar o id remove o motor | Regra do template para módulo opcional; `check:module-removal` prova | `switch` por tipo espalhado |
| T10 | **Webhook grava e enfileira; o job aplica.** Tabela `channel_event` + fila `channel.inbound`, como `payment_event` + `webhook.process` | A origem processava em `after()`, sem garantia. A Evolution desiste em ~2,5 min: o ack precisa ser rápido e o trabalho, durável | Processar dentro da requisição |
| T11 | **Tempo real por SSE + `LISTEN/NOTIFY`**, levando só ids; o cliente relê pela API, que aplica a autorização. Sem SSE, cai em polling | O projeto não tem Supabase Realtime. O webhook pode ser aplicado no processo `--worker`, então o aviso precisa atravessar processos | WebSocket; polling puro |
| T12 | **Segredos de canal cifrados** com `src/lib/crypto/secrets.ts` (AES-256-GCM, `aad` = canal + campo). A API nunca os devolve: só a dica dos 4 últimos caracteres | Mesmo padrão de `tenant_payment_credential` | Texto puro com RLS |
| T13 | **Autorização no servidor, em cada query.** A origem confiava na RLS por usuário (`auth.uid()`), que aqui não existe: o predicado de visibilidade da conversa vira função única (`src/lib/inbox/visibility.ts`) usada por toda leitura e escrita. Conversa que a pessoa não pode ver responde 404 | Regra inegociável do projeto; o RLS daqui isola tenant, não pessoa | `set_config('app.user_id')` + políticas por usuário |
| T14 | **Limites por plano:** `limits.channels_whatsapp_cloud` e `limits.channels_whatsapp_qr`. A plataforma não tem limite de plano, só o teto do servidor Evolution | Canal é o recurso que custa | Feature flag por plano (não existe `hasFeature` ainda) |

## O que não é portado

Existe na origem e fica fora deste programa: disparos em massa, automações, flows, IA,
pipelines e negócios, API pública `/api/v1`, webhooks de saída, formulários de captação, área do
contato, quadro de atribuição (kanban), "ver como", exportação de conversa, retenção automática
de mensagens, checagem e captação de números pela instância QR, teto de envio frio, monitor de
cobrança da Meta, criação e submissão de modelos de mensagem (só sincronizar e usar), mensagens
interativas de saída, reações, apagar mensagem e distribuição automática (rodízio).

## Fases

Cada fase cabe em um PR revisável e termina com `npm run lint`, `typecheck`, `test`,
`test:db`, `build`, `/code-review` e a atualização de `docs/context/`. Modelo conforme
`docs/context/ai-engineering.md`.

| # | Fase | Feature | Depende de | Entrega | LLM |
|---|---|---|---|---|---|
| F0 | Escopo de plataforma | todas | – | `scopedPolicy()`, `platformOnlyPolicy()`, `withPlatformData`, `withScope`, tipo `Scope`, teste de isolamento dos três modos | Opus + `/security-review` |
| A1 | Telefone e e-mail opcional | cadastro | – | `src/lib/phone/`, `customer.phone_normalized`, `user.phone_normalized`, e-mail anulável e os ajustes de portal, LGPD e admin | Sonnet; revisão Opus (toca o portal) |
| A2 | Etiquetas do tenant | cadastro | F0 | `tag`, `customer_tag`, migração das etiquetas de texto, API, tela de configuração, seletor e filtro em `/app/clientes` | Sonnet |
| A3 | Campos adicionais do tenant | cadastro | F0 | `custom_field`, `customer.custom_fields`, validação dinâmica, tela de configuração, formulário e detalhe do cliente | Sonnet |
| A4 | Etiquetas e campos da plataforma | cadastro | A2, A3 | `organization_tag`, `organization_profile`, telas em `/admin` | Sonnet + `/security-review` |
| B0 | Medição dos provedores | canais | – | Chamadas reais ao servidor Evolution Go e à Graph API; fixtures de webhook anonimizadas em `tests/fixtures/channels/` | Humano com Sonnet |
| B1 | Fundação de canais | canais | F0 | `channel`, `channel_event`, `ChannelProvider`, registro por `CHANNEL_PROVIDERS`, permissões, limites, fila `channel.inbound` | Opus + `/security-review` |
| B2 | Módulo WhatsApp Cloud | canais | B1 | Configuração, diagnóstico, webhook assinado, modelos sincronizados, tela em `/app/configuracoes/canais` | Opus (webhook) e Sonnet (tela) |
| B3 | Módulo Evolution Go | canais | B1, B0 | Instância, QR Code e código de pareamento, ciclo de vida, webhook | Sonnet com as fixtures; revisão Opus |
| B4 | Canais da plataforma | canais | B2, B3 | As mesmas telas em `/admin/configuracoes/canais` | Sonnet |
| C1 | Dados e ingestão | inbox | A1, B1 | `chat_contact`, `conversation`, `message`, ingestão de mensagens, status, eco e mídia | Opus |
| C2 | API do atendimento | inbox | C1 | Leitura paginada, envio de texto, fila, assumir, transferir, encerrar, janela de 24 h, visibilidade | Opus + `/security-review` |
| C3 | Tela do atendimento (tenant) | inbox | C2, A2, A3 | `/app/atendimento`: lista, conversa, composer, painel do contato | Sonnet |
| C4 | Tempo real | inbox | C2 | SSE, `NOTIFY`, ressincronização e contador de não lidas no menu | Opus |
| C5 | Mídia, modelos e resposta citada | inbox | C3, B2 | Anexos de saída, envio de modelo, citar mensagem | Sonnet |
| C6 | Atendimento da plataforma | inbox | C3, B4, A4 | `/admin/atendimento`, sem fila | Sonnet + `/security-review` |
| C7 | LGPD, contexto e fechamento | todas | todas | Exportação e exclusão cobrindo conversas, retenção de `channel_event`, `docs/context/`, rules, skills, README | Opus |

**Trilhas paralelas:** depois de F0, a trilha A (cadastro) e a trilha B (canais) não tocam os
mesmos arquivos e podem andar ao mesmo tempo. A trilha C começa quando A1 e B1 estiverem
entregues. B0 não depende de código e pode começar já.

**Primeira fase recomendada:** F0 e A1 (curtas, destravam as três trilhas), com B0 em paralelo.

## Contrato da fase F0 (escopo de plataforma)

É a única fase sem SPEC própria: o contrato inteiro está aqui. Não cria tabela; entrega as
peças que as três SPECs usam.

**`src/db/tenant-policy.ts`** ganha duas políticas ao lado de `tenantPolicy()`, que não muda:

```ts
const bypass = sql`current_setting('app.bypass_tenant', true) = 'on'`;
const sameTenant = sql`tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
const platformOn = sql`current_setting('app.platform_scope', true) = 'on'`;

/** Tabela com `tenant_id` anulável: linha de tenant ou linha da plataforma (`NULL`). */
export function scopedPolicy() {
  const rule = sql`${bypass} or ${sameTenant} or (tenant_id is null and ${platformOn})`;
  return pgPolicy("scope_isolation", {
    as: "permissive", for: "all", to: ["bizu_app", "bizu_owner"], using: rule, withCheck: rule,
  });
}

/** Tabela sem `tenant_id`, que só a plataforma lê e escreve (ex.: `organization_tag`). */
export function platformOnlyPolicy() {
  const rule = sql`${bypass} or ${platformOn}`;
  return pgPolicy("platform_only", {
    as: "permissive", for: "all", to: ["bizu_app", "bizu_owner"], using: rule, withCheck: rule,
  });
}
```

**`src/db/rls.ts`** ganha:

```ts
export type Scope = { kind: "tenant"; tenantId: string } | { kind: "platform" };

/** Só as linhas da plataforma (`tenant_id IS NULL`). Não enxerga dado de tenant. */
export function withPlatformData<T>(fn: (tx: Tx) => Promise<T>): Promise<T>; // app.platform_scope = 'on'

export function withScope<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T>;
// tenant → withTenant(scope.tenantId, fn); platform → withPlatformData(fn)
```

| Regra | Detalhe |
|---|---|
| Falha fechada | Sem nenhuma das três variáveis, a política não devolve linha: `tenant_id = NULL` é nulo, e linha da plataforma exige `app.platform_scope` |
| Um modo por transação | `withTenant` nunca liga `app.platform_scope`; `withPlatformData` nunca define `app.tenant_id`. Cada helper abre a própria transação (`set_config(..., true)`) |
| `withPlatformScope` segue existindo | Continua sendo o único que atravessa tenants, com motivo. As SPECs dizem onde ele é usado (webhook que acha o canal, busca de cliente pela plataforma) |
| `tenant_id` vem do `Scope` | O serviço preenche `tenant_id` a partir do escopo, nunca do corpo da requisição; tabela filha repete o `tenant_id` do pai |
| Unicidade com `tenant_id` nulo | Dois índices: o único normal, com `tenant_id`, e um parcial `WHERE tenant_id IS NULL` (o Postgres não considera dois nulos iguais) |
| `FORCE ROW LEVEL SECURITY` | Em migration customizada, como nas tabelas de tenant de hoje |
| Rotas | `/api/*` monta `{ kind: "tenant", tenantId }` a partir de `requireTenant`; `/api/admin/*` monta `{ kind: "platform" }` depois de `requirePlatform` |

**Teste (`tests/db/rls.test.ts`)**, com uma tabela de exemplo criada no próprio teste e depois
com cada tabela nova:

- [ ] `withTenant(A)` lê e grava linha de A; não lê linha de B nem da plataforma; não grava linha com `tenant_id` nulo.
- [ ] `withPlatformData` lê e grava linha da plataforma; não lê linha de tenant nenhum; não grava linha com `tenant_id` preenchido.
- [ ] Sem helper (`bizu_app` cru), zero linhas e escrita recusada.
- [ ] `withPlatformScope` lê tudo.
- [ ] `platformOnlyPolicy()`: `withTenant` não lê nem grava; `withPlatformData` sim.

## Verificação final do programa

- [ ] Todos os critérios de aceite dos três PRDs cobertos por teste ou roteiro manual.
- [ ] `tests/db/rls.test.ts` com as tabelas novas e os três modos de `scopedPolicy()`.
- [ ] `tests/db/rbac.test.ts` com as permissões novas (matriz papel × rota).
- [ ] `npm run check:module-removal -- whatsapp_cloud` e `-- whatsapp_qr` no CI.
- [ ] `/security-review` das fases marcadas, sem achado aberto.
- [ ] `docs/context/` com um arquivo por domínio novo (`tech/28-crm-cadastro.md`,
  `tech/29-canais-whatsapp.md`, `tech/30-caixa-de-entrada.md`), INDEX, `status.md`, rules em
  par (`.claude/rules/` e `.cursor/rules/`) e `lgpd.md`.

## Perguntas em aberto do programa

Cada PRD lista as suas. As que atravessam as três:

- **Plataforma falando com clientes dos owners.** O cliente é do owner (controlador); a
  plataforma é operadora. Falar com ele por iniciativa própria pede base legal e cláusula nos
  termos. A SPEC entrega o recurso atrás de `platform_setting.inbox_reach_customers`, **desligado
  por padrão**. Decide: proprietário, com o advogado.
- **Suporte respondendo.** Hoje `platform_support` só lê em `/admin`. A caixa de entrada da
  plataforma propõe que ele também responda (configurar canal, etiquetas e campos continua só
  com `platform_owner`). Decide: proprietário.
- **Quantidade de canais por plano** (`free`, `basic`, `pro`). Proposta na SPEC de canais.
  Decide: proprietário.
