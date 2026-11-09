# SPEC: Caixa de entrada (chat e fila de atendimento)

- **Status:** rascunho
- **PRD:** `docs/specs/caixa-de-entrada/prd.md`
- **Programa:** `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T6, T10, T11 e T13)
- **Depende de:** `docs/specs/crm-cadastro/spec.md` (telefone, etiquetas, campos) e
  `docs/specs/whatsapp-canais/spec.md` (`channel`, `ChannelProvider`, `channel_event`)
- **Contexto carregado:** `core.md`, `tech/06-hono-api.md`, `tech/07-banco-drizzle.md`,
  `tech/11-dashboard.md`, `tech/20-jobs.md`, `tech/21-tenant-rbac.md`, `tech/25-portal-clientes.md`,
  `tech/26-seguranca.md`, `tech/27-lgpd-arquivos.md`, `src/db/schema/files.ts`,
  `src/lib/files/types.ts`, `src/lib/storage/types.ts`, `src/lib/auth/permissions.ts`
- **Origem conferida:** tabelas `conversations`, `messages`, `contacts` e `contact_identities`
  do banco do `zap-crm-br-client`; a função `claim_conversation`; `src/app/(dashboard)/inbox/`
  e `src/lib/inbox/` de lá.

## Onde entra

- [x] API Hono: `src/api/inbox.ts`, `src/api/inbox-events.ts` (SSE), `src/api/admin.ts`
- [x] Jobs: `applyChannelEvent` (fila `channel.inbound`), `inbox.media`, `inbox.sweep`
- [x] Área client-only: `/app/atendimento`, `/admin/atendimento`
- [ ] Pública com SSR: nada

## O que muda em relação à origem

| Na origem | Aqui | Motivo |
|---|---|---|
| Toda mensagem de número novo cria um `contact` | Cria um `chat_contact`; virar `customer` é ação do atendente (T4) | Decisão do proprietário; desconhecido não consome o plano |
| Visibilidade por RLS com `auth.uid()` | Predicado único no servidor, em toda query (T13) | O RLS daqui isola tenant, não pessoa |
| Supabase Realtime entrega a linha inteira ao navegador | SSE leva só ids; o cliente relê pela API (T11) | A autorização fica em um lugar só |
| Janela de 24 h calculada só no cliente | Conferida no servidor antes do envio; a tela só antecipa | Regra de negócio não mora no navegador |
| `message_id` do provedor sem unicidade | Único parcial `(channel_id, provider_message_id)` | Reentrega não duplica |
| Lista e conversa carregadas inteiras | Paginação por cursor nas duas | Volume |
| `unread_count` por leitura e escrita separadas | Incremento atômico no `UPDATE` | Corrida entre duas mensagens |
| Mídia em bucket com URL assinada do Supabase | Tabela `file` + `StorageProvider`, servida por rota autenticada | Módulo de arquivos do projeto |
| Envio otimista só na tela | Linha `queued` gravada antes de chamar o provedor | A falha fica registrada e pode ser reenviada |

## Modelo de dados (Drizzle)

Arquivo `src/db/schema/inbox.ts`. Todas com `tenant_id` anulável, `scopedPolicy()` + `FORCE`.

| Tabela | Colunas principais | Observações |
|---|---|---|
| `chat_contact` | `id`, `tenant_id`, `phone` (canônico, T6), `wa_name`, `name`, `customer_id` → `customer` `set null`, `user_id` → `user` `set null`, `created_via` (`inbound` \| `outbound` \| `device`), `created_at`, `updated_at` | Único por escopo em `phone` (índice em `(tenant_id, phone)` e o parcial para `tenant_id IS NULL`). No tenant, `customer_id` **ou** `user_id`, nunca os dois (`CHECK`). Índices em `customer_id` e `user_id` |
| `chat_contact_identity` | `id`, `tenant_id`, `contact_id` → `chat_contact` `cascade`, `kind` (`lid`), `value`, `created_at` | Único `(tenant_id, kind, value)` e o parcial da plataforma. Liga o identificador oculto do WhatsApp ao telefone |
| `conversation` | `id`, `tenant_id`, `channel_id` → `channel` `restrict`, `contact_id` → `chat_contact` `cascade`, `status` (`open` \| `pending` \| `closed`), `assigned_user_id` → `user` `set null`, `assigned_at`, `last_message_at`, `last_message_preview` (até 120), `last_message_direction`, `last_inbound_at`, `unread_count` (int, `>= 0`), `closed_at`, `closed_by`, `created_at`, `updated_at` | Único `(tenant_id, contact_id, channel_id)` e o parcial da plataforma. Índices: `(tenant_id, status, last_message_at DESC, id DESC)`; parcial `(tenant_id, last_message_at DESC) WHERE assigned_user_id IS NULL AND status <> 'closed'` (fila); `(tenant_id, assigned_user_id, last_message_at DESC)` |
| `message` | `id`, `tenant_id`, `conversation_id` → `conversation` `cascade`, `channel_id`, `direction` (`in` \| `out`), `sender_type` (`contact` \| `user` \| `device` \| `system`), `sender_user_id` → `user` `set null`, `type` (`text` \| `image` \| `video` \| `audio` \| `document` \| `sticker` \| `location` \| `contacts` \| `template` \| `interactive` \| `unsupported`), `text`, `file_id` → `file` `set null`, `media_status` (`ready` \| `pending` \| `failed`), `provider_media_id`, `provider_message_id`, `client_id`, `reply_to_message_id` → `message` `set null`, `template_name`, `payload` jsonb, `status` (`queued` \| `sent` \| `delivered` \| `read` \| `failed`), `error_code`, `error_message`, `provider_timestamp`, `created_at`, `updated_at` | Único parcial `(channel_id, provider_message_id) WHERE provider_message_id IS NOT NULL`; único parcial `(conversation_id, client_id) WHERE client_id IS NOT NULL`. Índice `(conversation_id, created_at DESC, id DESC)`. Parcial `(created_at) WHERE status = 'queued'` para a varredura |

- `channel_id` da conversa é imutável (gatilho ou ausência do campo em todo `UPDATE`; teste
  cobre). Trocar de número é outra conversa, como na origem.
- `last_inbound_at` é a âncora da janela de 24 h: só avança (`GREATEST`), só com mensagem
  `direction = in`.
- `payload` guarda o que não tem coluna: coordenadas, cartão de contato, variáveis e texto
  renderizado do modelo, resposta de botão. Nunca o corpo bruto do provedor.
- **`file` (muda):** `tenant_id` passa a anulável e a política vira `scopedPolicy()`, para a
  mídia da plataforma. `owner_type = 'message'`, `owner_id = message.id`. Toda leitura
  existente de `file` roda em `withTenant` e segue vendo só as suas; o teste de RLS ganha o
  caso "tenant não lê arquivo da plataforma".
- **`platform_setting`:** chave `inbox_reach_customers` (boolean, padrão `false`).
- **Migrations:** `inbox.ts` + `db:generate`; customizada com `FORCE`, os índices parciais e a
  troca de política de `file`. Aditiva, sem backfill.

## Ingestão (`src/lib/inbox/ingest.ts`)

Chamada por `applyChannelEvent(scope, channel, event)` dentro de `withScope`, uma transação
por evento. Idempotente: repetir o evento não muda nada.

### Evento `message`

1. **Descartes:** grupo, status do WhatsApp, `fromMe` em canal sem `deviceEcho`, mensagem cujo
   remetente só tem LID sem telefone conhecido em `chat_contact_identity` → evento `ignored`.
2. **Contato:** `normalizePhone(fromPhone)` → busca `chat_contact` por `phoneVariants`
   (com e sem o 9º dígito). Não achou: cria com `created_via = inbound` e tenta o vínculo
   automático, nesta ordem: `user` da equipe do tenant com aquele `phone_normalized`; `customer`
   com aquele `phone_normalized`, **se for exatamente um**. Dois clientes com o mesmo número:
   fica sem vínculo e o painel mostra os candidatos. `wa_name` é atualizado a cada mensagem.
   Se veio LID, grava a identidade.
3. **Conversa:** `INSERT ... ON CONFLICT (escopo, contact_id, channel_id) DO UPDATE`, em um
   comando: `last_message_at`, prévia, `unread_count = unread_count + 1`,
   `last_inbound_at = GREATEST(...)`, e `status = 'open'` se estava `closed` (o dono é
   mantido se ainda for membro; senão `assigned_user_id = NULL`).
4. **Mensagem:** `INSERT ... ON CONFLICT (channel_id, provider_message_id) DO NOTHING`. Se nada
   foi inserido, os passos 3 e 5 são desfeitos (a transação aborta por erro controlado e o
   evento fica `processed`). `reply_to_message_id` é resolvido por `provider_message_id`.
5. **Mídia:** na Evolution, o conteúdo já está no armazenamento (`storageKey` do evento): vira
   linha em `file` e `media_status = ready`. Na Cloud, `media_status = pending` +
   `provider_media_id`, e o job `inbox.media` baixa depois.
6. **Eco do aparelho** (`fromMe` com `deviceEcho`): `direction = out`, `sender_type = device`,
   `status = sent`; não soma não lidas, não mexe no dono nem em `last_inbound_at`. Se o
   `provider_message_id` já existe (mensagem enviada pelo sistema), não insere.
7. `pg_notify` no `COMMIT` (seção "Tempo real").

### Evento `status`

`UPDATE message SET status = :novo WHERE channel_id = :c AND provider_message_id = :id AND
<ordem(status) < ordem(:novo)>`. A escada é `queued < sent < delivered < read`; `failed` só
entra a partir de `queued` ou `sent` e traz `error_code` e `error_message`. Status de mensagem
desconhecida fica `ignored`. Fora de ordem termina certo sem ler antes de escrever.

### Jobs

| Fila | Gatilho | Retry | O que faz |
|---|---|---|---|
| `inbox.media` | mensagem com `media_status = pending`; "tentar de novo" na tela | 4x, backoff de 1 min a 1 h | `provider.fetchMedia` → confere tamanho e MIME → `StorageProvider.put` → `file` → `ready`. Na última falha, `failed` |
| `inbox.sweep` | cron a cada 5 min | 1x | Mensagem `queued` há mais de 2 min vira `failed` com `UNKNOWN_RESULT` |

A exclusão de mensagens e conversas com arquivo usa a remoção de arquivo que já existe
(linha `file` + objeto no armazenamento).

## Envio (`src/lib/inbox/send.ts`)

1. Autoriza (visibilidade + `inbox:reply`); sessão personificada → 403 `IMPERSONATION_READ_ONLY`.
2. Canal `connected`, senão 409 `CHANNEL_NOT_CONNECTED`. Canal com `sessionWindow24h`, tipo
   diferente de modelo e `last_inbound_at` nulo ou há mais de 24 h → 409
   `SESSION_WINDOW_CLOSED`.
3. Transação curta: insere a mensagem `queued` com `client_id` (repetido devolve a mesma
   linha), atualiza prévia e `last_message_at`, zera `unread_count` e **assume** a conversa se
   estava sem dono e o escopo é tenant (`UPDATE ... WHERE assigned_user_id IS NULL`). Conversa
   `closed` volta a `open`.
4. Fora da transação, chama `provider.sendText | sendMedia | sendTemplate` com timeout.
5. Sucesso: `status = sent`, `provider_message_id`. Erro do provedor: `failed` com o código e
   a mensagem dele; a rota responde 200 com a mensagem `failed` (a falha é dado, não erro de
   API). Timeout: fica `queued` e a varredura decide.
6. **Reenviar:** só mensagem `failed` da própria conversa; cria uma mensagem nova com o mesmo
   conteúdo e apaga a que falhou.

**Anexos de saída:** `multipart/form-data`, até 16 MB, lista de MIME própria do atendimento em
`src/lib/inbox/media.ts` (imagens jpeg, png, webp; vídeo mp4 e 3gpp; áudio ogg, mpeg, mp4, aac,
amr; pdf e os formatos de escritório que a Meta aceita). O arquivo é gravado em `file` antes do
envio. Cloud: `uploadMedia` e envio pelo id. Evolution: `POST /send/media` com URL de curta
duração (5 min) assinada por HMAC, servida por `GET /api/inbox/media-out/:token`, que só
responde ao token válido (se o servidor aceitar base64 no envio, medido em B0, usa-se base64 e
a rota não é criada).

**Modelo:** só de `message_template` com status aprovado, do WABA do canal; as variáveis são
validadas contra `components`; `payload` guarda nome, idioma, variáveis e o texto renderizado.

## Fila e visibilidade

`src/lib/inbox/visibility.ts` exporta `visibleConversation(actor)`, um fragmento SQL usado por
**toda** leitura e escrita de conversa e mensagem.

| Quem | Vê |
|---|---|
| Tenant, com `inbox:supervise` | Todas as conversas do tenant |
| Tenant, com `inbox:read` | `assigned_user_id IS NULL` (fila) ou `assigned_user_id = eu` |
| Plataforma (`platform_owner`, `platform_support`) | Todas as do escopo plataforma |

Conversa fora do predicado responde 404, igual a id inexistente.

| Ação | Regra | SQL |
|---|---|---|
| Assumir | `inbox:reply`; só da fila | `UPDATE ... SET assigned_user_id = :eu WHERE id = :id AND assigned_user_id IS NULL RETURNING`; zero linhas → 409 `ALREADY_ASSIGNED` com o nome do dono |
| Responder | Assume se estava na fila; responder conversa de outro (supervisor) não troca o dono | passo 3 do envio |
| Devolver à fila | Dono da conversa ou `inbox:assign` | `assigned_user_id = NULL` |
| Transferir | `inbox:assign`; o destino é membro ativo com `inbox:reply` | `UPDATE` simples; 400 `INVALID_ASSIGNEE` |
| Encerrar, pendente, reabrir | Quem vê e tem `inbox:reply` | `status`, `closed_at`, `closed_by` |
| Membro removido ou sem acesso | Gancho na remoção de membro (`src/lib/tenant/`) | `UPDATE conversation SET assigned_user_id = NULL WHERE assigned_user_id = :user` no tenant |

A plataforma não tem dono nem fila: `assigned_user_id` fica sempre nulo e as rotas de
assumir e transferir não existem em `/api/admin/inbox`.

## Tempo real

- **Emissão:** `notifyInbox(tx, evento)` faz `pg_notify('inbox', json)` dentro da transação
  (sai no `COMMIT`). Carga só com ids:
  `{ s: tenantId | null, c: conversationId, k: "message" | "status" | "conversation", m?: messageId, a?: assignedUserId, p?: prevAssignedUserId }`.
- **Escuta:** `src/lib/inbox/realtime.ts` abre **uma** conexão `LISTEN inbox` por processo web,
  em `REALTIME_DATABASE_URL` (padrão `DATABASE_URL`; precisa ser conexão direta ou pooler em
  modo sessão). Reconecta com backoff. Sem conexão, `/api/inbox/events` responde 503 e a tela
  usa polling.
- **`GET /api/inbox/events`** (SSE): `requireAuth` + `requireTenant` + `inbox:read`. O servidor
  entrega ao assinante só os eventos do tenant dele e, sem `inbox:supervise`, só os de
  conversa em que `a` ou `p` é nulo ou é ele (entrar e sair da fila também interessa).
  Batimento a cada 25 s; a conexão é encerrada a cada 15 min para a sessão ser revalidada na
  reconexão. Limite de 3 conexões por usuário. Versão da plataforma em
  `/api/admin/inbox/events`.
- **Cliente:** `useInboxEvents()` invalida as queries do TanStack pelos ids; nunca escreve o
  evento direto no cache. Ao reconectar, ao voltar o foco e a cada 60 s refaz a lista (20 s em
  modo polling, com o aviso "Atualização em tempo real indisponível").
- Atribuição feita por outra pessoa (`a = eu`, `p ≠ eu`) vira toast.

## Contratos

Schemas em `src/lib/schemas/inbox.ts`. Rotas de tenant: `requireAuth` + `requireTenant` +
`requirePermission`. `:id` fora do predicado de visibilidade → 404.

| Método e rota | Entrada | Saída | Autorização |
|---|---|---|---|
| `GET /api/inbox/conversations` | `tab` (`queue` \| `mine` \| `all`), `status?`, `unread?`, `channelId?`, `tagIds?`, `assignedTo?`, `q?`, `cursor?`, `limit` (≤ 50, padrão 30) | `{ items: [ConversationItem], nextCursor }` | `inbox:read`; `tab=all` e `assignedTo` exigem `inbox:supervise` |
| `GET /api/inbox/conversations/:id` | – | `{ conversation, contact, link, window }` | `inbox:read` |
| `GET /api/inbox/conversations/:id/messages` | `before?` (cursor), `limit` (≤ 100, padrão 50) | `{ items: [MessageView], nextCursor }` | `inbox:read` |
| `POST /api/inbox/conversations/:id/messages` | JSON `{ type: "text", text, replyTo?, clientId }` ou `{ type: "template", templateId, variables, clientId }`; ou `multipart` com `file`, `caption?`, `clientId` | 201 `{ message }`; 409 `SESSION_WINDOW_CLOSED`, `CHANNEL_NOT_CONNECTED`; 413 | `inbox:reply` |
| `POST /api/inbox/messages/:id/retry` | – | `{ message }` | `inbox:reply` |
| `POST /api/inbox/messages/:id/media/retry` | – | 202 | `inbox:read` |
| `GET /api/inbox/messages/:id/media` | – | o arquivo; `private, max-age=300` | `inbox:read` |
| `POST /api/inbox/conversations/:id/claim` | – | `{ conversation }`; 409 `ALREADY_ASSIGNED` | `inbox:reply` |
| `POST /api/inbox/conversations/:id/assign` | `{ userId \| null }` | `{ conversation }` | `null` na própria conversa: `inbox:reply`; o resto: `inbox:assign` |
| `POST /api/inbox/conversations/:id/status` | `{ status }` | `{ conversation }` | `inbox:reply` |
| `POST /api/inbox/conversations/:id/read` | – | `{ ok }` (zera `unread_count`) | `inbox:read` |
| `POST /api/inbox/conversations` | `{ channelId, customerId \| userId \| phone }` | `{ conversation }` (acha ou cria; não envia nada) | `inbox:reply` |
| `GET /api/inbox/unread` | – | `{ queue, mine }` | `inbox:read` |
| `GET /api/inbox/assignees` | – | `{ users: [{ id, name }] }` | `inbox:assign` |
| `PATCH /api/inbox/contacts/:id` | `{ name }` | `{ contact }` | `inbox:reply` |
| `GET /api/inbox/contacts/:id/candidates` | – | `{ customers: [{ id, name, phone }] }` com o mesmo telefone | `inbox:reply` + `customer:read` |
| `POST /api/inbox/contacts/:id/link` | `{ customerId \| null }` | `{ contact, link }` | `inbox:reply` + `customer:update` |
| `POST /api/inbox/contacts/:id/customer` | `{ name, email?, tagIds?, customFields? }` | 201 `{ customer }`; 403 `PLAN_LIMIT_REACHED`; 409 `CUSTOMER_EMAIL_IN_USE` | `inbox:reply` + `customer:create` |
| `GET /api/inbox/events` | – | SSE | `inbox:read` |

- `ConversationItem`: `id`, `status`, `channel { id, name, type }`, `contact { id, displayName,
  phone, identified }`, `assignedTo { id, name } | null`, `lastMessageAt`, `lastMessagePreview`,
  `lastMessageDirection`, `unreadCount`, `tags` (do cliente vinculado; uma consulta por página,
  não por linha).
- `link`: `{ kind: "customer", customer, tags, customFields } | { kind: "member", user } |
  { kind: "none", candidates }`. As etiquetas e os campos são editados pelas rotas de
  `crm-cadastro`; o painel só as chama.
- `window`: `{ applies, open, expiresAt }`, calculada no servidor.
- `MessageView`: sem `payload` bruto do provedor; mídia como `{ url, mime, size, name, status }`
  apontando para a rota de mídia.
- **Busca (`q`):** nome do contato, nome do cliente vinculado e telefone (pelos dígitos, com as
  variantes). Conteúdo de mensagem não entra nesta entrega.
- **Cursor:** `(last_message_at, id)` na lista e `(created_at, id)` nas mensagens, opaco em
  base64.
- **Iniciar conversa:** `customerId` e `userId` precisam ter `phone_normalized`
  (400 `PHONE_REQUIRED`); `phone` avulso é normalizado. Em canal Cloud a conversa nasce com a
  janela fechada e a tela oferece o modelo.
- **Mídia:** `GET .../media` confere a visibilidade da conversa da mensagem e serve com
  `X-Content-Type-Options: nosniff`; `Content-Disposition: inline` só para a lista segura de
  imagem, áudio e vídeo; o resto, `attachment`. SVG e HTML nunca entram.
- Tenant `read_only`: leitura e recebimento seguem; envio, assumir e demais escritas seguem a
  regra geral de `requireTenant` (bloqueadas).
- Limites de taxa por usuário: envio 60 por minuto; iniciar conversa 20 por minuto.

### Plataforma (`/api/admin/inbox/*`)

As mesmas rotas, com `Scope = platform` e `withPlatformData`, **menos** `claim`, `assign`,
`assignees` e as abas `queue` e `mine` (só existe a lista). Diferenças:

| Ponto | Regra |
|---|---|
| Autorização | Leitura: qualquer papel de plataforma. Envio e mudança de situação: `platform_owner` e `platform_support` (pergunta aberta do plano; se a resposta for "não", só `platform_owner`) |
| Vínculo do contato | Com `user`, pelo `phone_normalized`. `link` = `{ kind: "user", user, organizations: [{ id, name, role, tags, customFields }] }`, com as etiquetas e os campos de `crm-cadastro` (`organization_tag`, `organization_profile`) |
| Clientes dos owners | `GET /api/admin/inbox/contacts/:id/customers` procura o telefone em `customer` de todos os tenants (`withPlatformScope("atendimento da plataforma")`, só `id`, nome, organização) e só responde com `inbox_reach_customers` ligado |
| Iniciar conversa | `{ channelId, userId \| phone }`; `{ customerId }` só com `inbox_reach_customers` ligado, senão 403 `REACH_CUSTOMERS_DISABLED`. Fica na auditoria (`inbox.platform_customer_contacted`) |
| Configuração | `PATCH /api/admin/settings` (já existe) ganha `inboxReachCustomers`, só `platform_owner` |

## Permissões

```ts
inbox: ["read", "reply", "assign", "supervise"],
```

| Papel | Tem |
|---|---|
| owner, admin | as quatro |
| member | `read`, `reply` |

Atribuíveis a papel personalizado. `supervise` sem `read` não tem efeito. Editar etiquetas e
campos no painel exige as permissões de `customer` que já existem.

## Interface

| Rota | Arquivo | O que tem |
|---|---|---|
| `/app/atendimento` e `/app/atendimento/:conversationId` | `routes/app.inbox.tsx`, `pages/inbox-page.tsx` | Três colunas: lista, conversa, painel do contato |
| `/admin/atendimento` e `/:conversationId` | `routes/admin/inbox.tsx` | Os mesmos componentes com `mode="platform"` |

Componentes em `src/components/inbox/`:

| Componente | Responsabilidade |
|---|---|
| `conversation-list.tsx` | Abas Fila, Minhas e Todas (a última só com `supervise`); filtros (situação, não lidas, número, etiqueta, atendente); busca com debounce; rolagem infinita |
| `conversation-item.tsx` | Nome ou telefone, "não identificado", prévia, hora, contador, `ChannelBadge`, `TagChip` (até 2 e "+n") |
| `message-thread.tsx` | Separador por dia, carregar anteriores ao rolar para cima, mantém a posição; rola para o fim só se já estava no fim |
| `message-bubble.tsx` | Um renderizador por tipo; citação; estado (relógio, ✓, ✓✓, ✓✓ lida, falhou com motivo e "Reenviar"); mídia `pending` e `failed` com "Tentar de novo" |
| `composer.tsx` | Texto (Enter envia, Shift+Enter quebra), anexo com prévia e legenda, citação ativa, faixa "Janela de 24 horas encerrada" com "Enviar modelo", canal desconectado desabilita |
| `template-dialog.tsx` | Modelos aprovados do WABA do canal, variáveis e prévia |
| `conversation-header.tsx` | Contato, número, dono; Assumir, Devolver à fila, Transferir (com `assign`), situação |
| `contact-panel.tsx` | Telefone, nome no WhatsApp; cliente vinculado com `TagPicker` e `CustomFieldInput` (de `crm-cadastro`); "Salvar como cliente", "Vincular a cliente", "Desvincular"; candidatos com o mesmo telefone |
| `new-conversation-dialog.tsx` | Cliente, membro ou telefone + número de saída |
| `use-inbox-events.ts` | SSE, invalidação, modo polling |

- **Entradas extras:** "Conversar" no detalhe do cliente (`/app/clientes/:id`) e na lista de
  equipe, visível com `inbox:reply` e telefone preenchido.
- **Menu:** "Atendimento" em `app-nav.ts` e `admin-nav.ts`, com o ponto de não lidas vindo de
  `GET /api/inbox/unread` (atualizado pelos eventos).
- **Estados:** carregando, vazio ("Nenhuma conversa na fila"; sem canal conectado, chamada para
  `/app/configuracoes/canais`), erro e sucesso por `QueryState`.
- **Tela estreita:** uma coluna por vez (lista → conversa → painel), com voltar.
- Sem `loader` server-side: TanStack Query + `apiFetch`, como as demais áreas autenticadas.

## Segurança

- **Visibilidade** é o risco central: nenhuma query de `conversation` ou `message` existe fora
  de `src/lib/inbox/`, e todas passam por `visibleConversation`. Teste de matriz: membro A não
  lê, não envia, não marca como lida, não baixa mídia nem recebe evento SSE de conversa do
  membro B.
- **Isolamento de escopo:** `scopedPolicy()` no banco; rotas de `/admin` em `withPlatformData`,
  que não enxerga linha de tenant. A consulta a clientes dos owners é a única com
  `withPlatformScope`, atrás da configuração e auditada.
- **Personificação:** `blockMutationsWhileImpersonating` em toda escrita; a leitura é liberada
  e já fica na auditoria da personificação.
- **SSE:** autenticado, filtrado no servidor, carga sem conteúdo; reautenticação periódica.
- **Mídia:** nunca servida do armazenamento por URL pública; MIME conferido pelo conteúdo, não
  pelo que o provedor diz; `nosniff`; tamanho máximo antes de gravar. O token de mídia de saída
  é de uso restrito (um arquivo, 5 min) e não lista nada.
- **Conteúdo de mensagem** não vai para `logError`, para `audit_log` nem para o Sentry. Texto
  da mensagem é renderizado como texto (sem HTML); link vira âncora com `rel="noopener
  noreferrer"` e só `http(s)`.
- **Auditoria:** `inbox.conversation_claimed`, `_assigned`, `_released`, `_closed`,
  `_reopened`, `inbox.contact_linked`, `inbox.contact_saved_as_customer`,
  `inbox.platform_customer_contacted`; `metadata` com ids, sem texto nem telefone.
- **LGPD:** a exclusão ou anonimização de `customer` apaga os `chat_contact` vinculados, com
  conversas, mensagens e arquivos; a exportação do cliente inclui as mensagens trocadas com
  ele. A exclusão de organização leva tudo por `cascade` e apaga os objetos do armazenamento.
  A exclusão de `user` desfaz o vínculo (`set null`) e mantém as mensagens que ele enviou sem
  autor. `chat_contact` sem vínculo é dado pessoal mesmo assim: entra no inventário de
  `lgpd.md`.
- `/security-review` obrigatório em C2, C4 e C6.

## Plano de implementação

1. **C1, dados:** schema, migrations, mudança de `file` → `rls.test.ts` (três modos, mais
   arquivo da plataforma).
2. **C1, ingestão:** `ingest.ts`, `inbox.media`, ligação em `applyChannelEvent` → testes com as
   fixtures de B0: número novo cria contato e conversa; cliente e membro reconhecidos; dois
   clientes com o mesmo número ficam sem vínculo; repetido não duplica nem soma não lida;
   status fora de ordem; eco do aparelho; conversa encerrada reabre; LID sem telefone ignorado.
3. **C2, leitura e fila:** `visibility.ts`, listas, mensagens, assumir, transferir, situação,
   lida, não lidas → matriz de visibilidade; dois `claim` simultâneos (um 200, um 409); RBAC.
4. **C2, envio de texto:** `send.ts`, janela de 24 h, `inbox.sweep`, reenviar → provedor
   simulado: sucesso, recusa (fica `failed`), timeout (varredura), `clientId` repetido,
   resposta assume, personificação 403.
5. **C2, contato:** vincular, salvar como cliente (limite do plano), iniciar conversa, gancho
   de remoção de membro.
6. **C3, tela do tenant** com polling de 20 s → smoke nos dois tipos de canal.
7. **C4, tempo real:** `realtime.ts`, SSE, `use-inbox-events.ts`, contador no menu → teste de
   filtro do SSE por pessoa; `JOBS_MODE=worker` (aviso atravessa processos); queda da conexão
   `LISTEN` cai em polling.
8. **C5, mídia de saída, modelo e citação.**
9. **C6, plataforma:** rotas e telas em `/admin`, configuração `inbox_reach_customers` →
   suporte e proprietário; nenhuma conversa de tenant aparece; 403 com a opção desligada.
10. **C7, LGPD e contexto.**

## Verificação

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db`, `npm run build`
- [ ] Testes de cada etapa acima
- [ ] Smoke com dois navegadores (owner e member do `acme`): mensagem chega nos dois em até 3 s;
  um assume e o outro vê sair da fila; o member não abre a conversa do owner por link
- [ ] Smoke com `JOBS_MODE=worker` e com o SSE bloqueado (modo polling)
- [ ] Cada critério de aceite do PRD marcado
- [ ] `/code-review` e `/security-review`

## Atualização de contexto

- [ ] `docs/context/tech/30-caixa-de-entrada.md` (novo) e linha no `INDEX.md`
- [ ] `tech/21-tenant-rbac.md`: recurso `inbox` e o gancho na remoção de membro
- [ ] `tech/27-lgpd-arquivos.md` e `lgpd.md`: `file.tenant_id` anulável, mídia de mensagem,
  exclusão e exportação cobrindo conversas
- [ ] `tech/20-jobs.md`: `inbox.media` e `inbox.sweep`
- [ ] `tech/26-seguranca.md`: SSE e regra de personificação no atendimento
- [ ] `tech/11-dashboard.md`, `tech/22-admin.md`, `tech/06-hono-api.md`, `tech/14-deploy.md`
  (`REALTIME_DATABASE_URL`; SSE atrás do Caddy sem buffer)
- [ ] `.env.example`, `status.md`, `README.md`
- [ ] Rules novas `inbox.md` com `paths: src/lib/inbox/**, src/components/inbox/**`, em
  `.claude/rules/` e `.cursor/rules/`; skill `ctx-inbox`

## Decisões

| Decisão | Motivo | Alternativa descartada |
|---|---|---|
| `chat_contact` separado de `customer` | Decisão do proprietário (T4); a plataforma fala com `user`, que não é `customer` | Contato = cliente, como na origem |
| Vínculo automático só com correspondência única | Dois clientes com o mesmo telefone são permitidos | Escolher o mais recente |
| Uma conversa por contato e canal, reaberta | Histórico contínuo, como na origem | Uma conversa por atendimento (ticket) |
| Fila = sem dono; sem distribuição automática | Pedido do PRD; a origem também não tem rodízio real | Rodízio |
| Mensagem `queued` gravada antes do envio | A falha fica visível e reenviável | Otimismo só na tela |
| Envio na requisição, não em job | O atendente vê o resultado na hora; a varredura cobre o timeout | Fila de saída |
| SSE com ids + releitura | Autorização em um lugar só; funciona com o worker separado | Mandar a linha no evento |
| Conexão `LISTEN` única por processo | Uma conexão por aba esgotaria o Postgres | `LISTEN` por assinante |
| Reabertura volta ao antigo dono | Continuidade do atendimento (pergunta aberta do PRD) | Sempre para a fila |
| `file` com `tenant_id` anulável | Reaproveita armazenamento, exclusão e LGPD | Tabela de mídia própria |
| Busca sem conteúdo de mensagem | Pede índice de texto e decisão de privacidade | `ILIKE` em `message.text` |
