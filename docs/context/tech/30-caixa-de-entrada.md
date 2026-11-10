# Caixa de entrada (chat e fila de atendimento)

- **Escopo:** conversas de WhatsApp do tenant e da plataforma: contatos (`chat_contact`), conversas,
  mensagens, ingestão dos avisos de canal e mídia recebida. A configuração dos números é de
  `tech/29-canais-whatsapp.md`.
- **Specs relacionadas:** `docs/specs/caixa-de-entrada/spec.md` e `prd.md`; programa em
  `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T6, T10, T11, T13)
- **Paths do código:** `src/db/schema/inbox.ts`, `src/lib/inbox/` (`constants.ts`, `contacts.ts`,
  `ingest.ts`, `media.ts`, `notify.ts`, `channel-usage.ts`; da C2: `visibility.ts`, `cursor.ts`,
  `views.ts`, `conversations.ts`, `assignment.ts`, `media-access.ts`, `send.ts`, `window.ts`,
  `contact-actions.ts`), `src/api/inbox.ts`, `src/lib/schemas/inbox.ts`, `src/jobs/inbox.ts`,
  `drizzle/0032_caixa_de_entrada.sql`, `drizzle/0033_rls_caixa_de_entrada.sql`,
  `tests/db/inbox-ingest.test.ts`, `tests/db/inbox-{queue,send,contacts}.test.ts`,
  `tests/db/inbox-helpers.ts`, `tests/db/rls.test.ts` (bloco da caixa de entrada),
  `src/lib/channels/providers/*/inbox.db.test.ts`

## Estado

| Fase | Entrega | Estado |
|---|---|---|
| C1 | Dados e ingestão (mensagens, status, eco, LID, mídia de entrada) | **Feita** |
| C2 | API: leitura paginada, fila, assumir, transferir, envio de texto, janela de 24 h, visibilidade, contato | **Feita** |
| C3 | Tela `/app/atendimento` | Pendente |
| C4 | Tempo real (SSE + `LISTEN/NOTIFY`) | Pendente (`notifyInbox` já é chamado; corpo vazio) |
| C5 | Mídia de saída, modelos, citação no envio | Pendente |
| C6 | Atendimento da plataforma em `/admin` | Pendente |
| C7 | LGPD (exportação e exclusão cobrindo conversas) e fechamento | Pendente |

## Modelo

Quatro tabelas em `src/db/schema/inbox.ts`, todas com `tenant_id` anulável (`NULL` = plataforma),
`scopedPolicy()` e `FORCE` (`tech/07-banco-drizzle.md`). Unicidade com `tenant_id` tem dois índices: o
normal e o parcial `WHERE tenant_id IS NULL`.

| Tabela | O essencial |
|---|---|
| `chat_contact` | Quem escreve no WhatsApp (T4): `phone` (como o provedor entregou), `phone_key` (sem o 9º dígito; única por escopo), `wa_name`, `name`, `customer_id` **ou** `user_id` (`CHECK`), `created_via` (`inbound`, `outbound`, `device`). Na plataforma, `customer_id` é sempre nulo (`CHECK`) |
| `chat_contact_identity` | LID do WhatsApp (`kind = lid`) → contato; único por escopo |
| `conversation` | Uma por contato e número (`channel_id` `restrict`, **imutável** por gatilho na `0033`). `status` (`open`, `pending`, `closed`), `assigned_user_id` (sem dono = fila; na plataforma sempre nulo, `CHECK`), `last_message_*`, `last_inbound_at` (âncora da janela de 24 h, só avança), `unread_count >= 0` |
| `message` | `direction`, `sender_type`, `type`, `text`, `file_id`, `media_status` (`ready`, `pending`, `failed`), `provider_media_id`, `provider_message_id` (único parcial por canal), `client_id` (único parcial por conversa), `reply_to_message_id`, `payload` (nunca o corpo bruto do provedor), `status` (só nas enviadas), `error_code`, `error_message`, `provider_timestamp` |

- **`file`** passou a `tenant_id` anulável com `scopedPolicy()` (mídia da plataforma). Toda leitura
  de tenant continua em `withTenant` e não vê arquivo da plataforma; a mídia da mensagem tem
  `owner_type = 'message'` e `owner_id = message.id`.
- `message.created_at` da mensagem recebida é a hora do provedor (limitada a agora), para a conversa
  ficar em ordem quando a Evolution entrega o histórico depois de reconectar. A enviada usa `now()`.
- Canal com conversa não é apagado: o serviço de canais desativa (`channelHasConversations`, que
  consulta `src/lib/inbox/channel-usage.ts`). Apagar a organização leva tudo por cascade.
- Só `src/lib/inbox/` consulta estas tabelas (regra de visibilidade, T13). Toda leitura e escrita de
  rota passa por `visibleConversation` (`visibility.ts`, abaixo). Os ganchos de fora (remoção de
  membro em `src/lib/tenant/team.ts`, anonimização em `src/lib/lgpd/deletion.ts`) chamam
  `releaseAssignments` em vez de consultar a tabela.

## Ingestão (`src/lib/inbox/ingest.ts`)

`applyChannelEvent` (`src/lib/channels/events.ts`) chama `inboxHandlers` dentro de `withScope`, na
transação do aviso `channel.inbound`. `setInboxHandlers({})` desliga a caixa (testes da camada de
canais); `undefined` volta à ingestão real. Retorno `false` = aviso `ignored`.

**`message`:**

1. **Descartes** (`ignored`): eco em canal sem `deviceEcho`; sem telefone nem LID (grupo, transmissão,
   status do WhatsApp; o normalizador já os tira); LID sem contato conhecido em `chat_contact_identity`;
   id do provedor já gravado (reentrega, ou eco da mensagem que o próprio sistema enviou).
2. **Contato** (`contacts.ts`): `providerPhone` normaliza com `+` (a regra do Brasil só vale com DDI
   55; número que o normalizador recusa fica com os próprios dígitos). `upsertContact` acha ou cria pela
   `phone_key` em um comando (`xmax = 0` diz se nasceu). Só o recém-criado ganha vínculo automático
   (`autoLinkContact`), cada um **só com correspondência única**: membro do tenant (não banido), depois
   cliente do tenant; na plataforma, usuário, e nunca `customer` de tenant. `linkCandidates` é a mesma
   consulta que o painel (C2) usa para os candidatos. `wa_name` atualiza a cada mensagem recebida (no
   eco, não: o `PushName` é o do dono do número). LID que chega com telefone é gravado.
3. **Conversa** (`INSERT ... ON CONFLICT DO UPDATE`, um comando, dentro de um savepoint): prévia e
   `last_message_at` só se a mensagem for a mais nova, `unread_count + 1`, `last_inbound_at =
   GREATEST`, e encerrada volta a `open` **sem dono** (`assigned_*` e `closed_*` zerados).
4. **Mensagem** (`ON CONFLICT (channel_id, provider_message_id) DO NOTHING`): se não inseriu (corrida
   com outro aviso), o savepoint desfaz a conversa e o item vira `ignored`. A citação é resolvida pelo
   `provider_message_id`.
5. **Mídia** (`media.ts`): Evolution já gravou o objeto sob `inbound/` → `storedMediaFile` confere a
   chave (`isStoredMedia`) e cria o `file` (`ready`); Cloud → `pending` + `provider_media_id` +
   `payload.media` (nome e tipo declarados) e o job `inbox.media` é enfileirado **depois do commit**
   (lista `after` do aviso). Sem fonte utilizável, `failed` já na chegada.
6. **Eco do aparelho** (`fromMe` com `deviceEcho`): `direction = out`, `sender_type = device`,
   `status = sent`; não soma não lida nem mexe na situação, no dono e em `last_inbound_at`.
7. `notifyInbox(tx, { s, c, k, m, a })` na mesma transação: ponto de extensão da C4, hoje vazio.

Item descartado (repetido, LID desconhecido, eco sem `deviceEcho`) apaga a mídia que trouxe, se
nenhum `file` a cita, depois do commit, mesmo que outro item do aviso seja aplicado. O aviso inteiro
`ignored` já apaga a própria mídia (`deleteInboundMedia`).

Canal QR novo que já tem conversa não é readotado (`connection.ts`): o histórico não muda de número.

**`status`:** um `UPDATE` condicional, sem ler antes: `queued < sent < delivered < read`; `failed` só
a partir de `queued` ou `sent`, com `error_code` (o `#código` da Meta) e `error_message` (até 500).
Só mensagem `direction = out` do mesmo canal. Fora de ordem termina certo; desconhecida ou que não
avança vira `ignored`.

## Job `inbox.media`

`src/jobs/inbox.ts` → `processInboxMedia` (`src/lib/inbox/media.ts`). Fila `exclusive`
(`singletonKey` = `message.id`), 4 tentativas, de 1 min a 1 h, dead letter `inbox.media.dead`.

1. Carrega a mensagem `pending` e o contexto do canal (credenciais decifradas por `contextFor`).
2. `provider.fetchMedia` **fora da transação**; vazio ou acima de 25 MB é definitivo.
3. Tipo **pelo conteúdo** (`sniffMime`/`inboundMime`): o declarado só refina quando o conteúdo
   confirma (Office em ZIP/OLE, áudio MP4, texto sem byte nulo); o resto é
   `application/octet-stream`. HTML nunca vira tipo ativo.
4. Grava sob `inbox/<tenant | platform>/<chave aleatória>`, cria o `file` e passa a mensagem a
   `ready` com `WHERE media_status = 'pending'`; perdeu a corrida, apaga o objeto.
5. Recusa do provedor (4xx menos 429) ou `PermanentEventError`: `failed` na hora. Outra falha lança
   (o pg-boss repete), inclusive erro ao carregar e módulo fora de `CHANNEL_PROVIDERS`; a última
   tentativa marca `failed`. Log só por `logChannelError`, sem conteúdo.

**Limite conhecido:** se enfileirar o job falhar depois do commit do aviso (fila fora do ar), a
mensagem fica `pending` até alguém usar "Tentar de novo" (`POST .../media/retry`, C2). Não há varredura
de mídia `pending` (pediria um índice parcial novo em `message`).

O `file.mime` da mídia da Evolution é o declarado pelo remetente (filtrado por `safeMime`); quem
serve (`media-access.ts`, C2) confere os primeiros bytes de novo antes de decidir o tipo e o `inline`.

## API do atendimento (C2, `src/api/inbox.ts`)

Cadeia: `sameOrigin` → `jsonBodyLimit` → `authRateLimit` → `requireAuth` → `requireTenant` →
`blockMutationsWhileImpersonating` → `requirePermission("inbox", …)` → limite por pessoa → `validId` →
`zValidator`. A rota só monta o `InboxActor` (`inboxActor(c)`: escopo do tenant da sessão, usuário,
capacidades de `inboxCapabilities`, permissões e catálogo de papéis); quem decide o resto é o serviço.
Erros saem por `handleTenantError`.

| Rota | Permissão | Serviço |
|---|---|---|
| `GET /api/inbox/conversations?tab&status&unread&channelId&tagIds&assignedTo&q&cursor&limit` | `inbox:read`; `tab=all` e `assignedTo` pedem `supervise` (403); `tagIds` pede `customer:read` | `listConversations` |
| `GET /api/inbox/conversations/:id` | `inbox:read` | `getConversation`: `{ conversation, contact, link, window }` |
| `GET /api/inbox/conversations/:id/messages?before&limit` | `inbox:read` | `listMessages`, da mais nova para a mais antiga |
| `POST /api/inbox/conversations/:id/messages` | `inbox:reply`, 60/min | `sendText`: 201 (`sent` ou `queued`), 200 com a mensagem `failed` |
| `POST /api/inbox/messages/:id/retry` | `inbox:reply`, 60/min | `retryMessage` |
| `GET /api/inbox/messages/:id/media` | `inbox:read` | `openMessageMedia` |
| `POST /api/inbox/messages/:id/media/retry` | `inbox:read`, 20/min | `retryMessageMedia`: 202 |
| `POST /api/inbox/conversations/:id/claim` | `inbox:reply` | `claimConversation` |
| `POST /api/inbox/conversations/:id/assign` `{ userId \| null }` | `inbox:read` na rota; o serviço pede `reply` (devolver a própria) ou `assign` (o resto) | `assignConversation` |
| `POST /api/inbox/conversations/:id/status` | `inbox:reply` | `setConversationStatus` |
| `POST /api/inbox/conversations/:id/read` | `inbox:read` | `markConversationRead` |
| `POST /api/inbox/conversations` `{ channelId, customerId \| userId \| phone }` | `inbox:reply`, 20/min | `startConversation`: 201 nova, 200 existente |
| `GET /api/inbox/unread` | `inbox:read` | `unreadCounts`: `{ queue, mine }` (conversas com não lidas) |
| `GET /api/inbox/assignees` | `inbox:assign` | `listAssignees`: membros ativos cujo papel tem `inbox:reply` |
| `PATCH /api/inbox/contacts/:id` `{ name }` | `inbox:reply` | `updateContact` |
| `GET /api/inbox/contacts/:id/candidates` | `inbox:reply` | `contactCandidates` (clientes só com `customer:read`) |
| `POST /api/inbox/contacts/:id/link` | `inbox:reply`; com `customerId`, `customer:update` | `linkContact` |
| `POST /api/inbox/contacts/:id/customer` | `inbox:reply` + `customer:create` | `saveContactAsCustomer`: 201 |

Assumir, transferir, situação, lida, vínculo e nome: 60 por minuto por pessoa (`inbox-queue`).

### Visibilidade (`visibility.ts`)

`visibleConversation(actor)` é o predicado de **toda** consulta de conversa e mensagem; fora dele, 404
igual a id inexistente. Sem `inbox:read`, `false`. Com `supervise`, o tenant inteiro; senão, sem dono
ou com o próprio ator como dono. Na plataforma (C6), o escopo `tenant_id IS NULL`. Mensagem e mídia
são alcançadas pelo `JOIN` com a conversa (`findVisibleMessage`, `openMessageMedia`); o contato, pelas
conversas dele que o ator vê (`requireVisibleContact`). `readsCustomers(actor)` (`customer:read`)
decide se o nome do cliente vinculado, as etiquetas e o cadastro aparecem na lista e no painel.

### Fila (`assignment.ts`)

- **Assumir:** `UPDATE ... WHERE id AND visível AND assigned_user_id IS NULL RETURNING`. Zero linhas e
  a conversa tem outro dono: 409 `ALREADY_ASSIGNED` com `assignedTo { id, name }` (inclusive para quem
  já não a vê: o id só se conhece por tê-la visto na fila). Já é do ator: devolve a conversa.
- **Devolver** (`userId = null`): o dono com `reply`, a de outro com `assign`. **Transferir:** `assign`;
  o destino é membro ativo (não banido) cujo papel tem `inbox:reply`, senão 400 `INVALID_ASSIGNEE`.
- **Situação:** só `status`, `closed_at`, `closed_by`; o dono não muda.
- **Lida:** zera `unread_count` só se maior que zero; sem nada a zerar confere a visibilidade (404).
- **Gancho** `releaseAssignments(tx, userId, tenantId?)`: `removeMember`, `changeMemberRole` para papel
  sem `inbox:reply` e `anonymizeUser` (LGPD, todos os tenants) devolvem as conversas à fila. Editar um
  papel personalizado tirando `inbox:*` **não** devolve (limite conhecido).
- Auditoria: `inbox.conversation_claimed` (`via: reply | start` quando não é o botão), `_assigned`
  (`from`, `to`), `_released` (`from`), `_closed`, `_reopened` (`to`, `via`), `inbox.contact_linked`
  (`customerId`, `userId`), `inbox.contact_saved_as_customer` (`customerId`). Só ids.

### Listas e cursor (`cursor.ts`, `views.ts`)

Cursor opaco em base64url: `[instante, id]`, com o instante em texto UTC **com microssegundos**
(`to_char(... 'US')`); um `Date` cortaria para milissegundos e pularia linhas do mesmo instante.
Cursor adulterado é 400 `INVALID_CURSOR`. Ordem `last_message_at DESC NULLS LAST, id DESC` nas conversas
e `created_at DESC, id DESC` nas mensagens; `limit + 1` decide `nextCursor`. Etiquetas por página com
`tagsOfCustomers`. Busca `q`: nome do contato, do perfil, do membro e (com `customer:read`) do cliente
vinculado, dígitos do telefone e a `phone_key` do que foi digitado (com e sem DDI). `MessageView` nunca
traz `payload` (só nome e tipo da mídia pendente), e a mídia aponta para a rota autenticada.

### Envio (`send.ts`)

1. Transação curta com a conversa travada (`FOR UPDATE`): `clientId` já gravado na conversa devolve a
   mesma mensagem sem enviar; canal não `connected` → 409 `CHANNEL_NOT_CONNECTED`; janela fechada
   (`window.ts`: canal com `sessionWindow24h` e `last_inbound_at` nulo ou há mais de 24 h) → 409
   `SESSION_WINDOW_CLOSED`; citação de outra conversa → 400 `INVALID_REPLY`. Grava a mensagem `queued`,
   atualiza prévia e `last_message_at`, zera as não lidas, **assume** a conversa da fila (só no tenant;
   o supervisor que responde a de outro não toma o dono) e reabre a encerrada.
2. Fora da transação, `sendChannelText` (que reconfere o canal e marca `error` em 401/403) com prazo de
   20 s. Sucesso: `sent` + `provider_message_id`; antes, apaga o eco `device` com o mesmo id (a
   Evolution pode entregá-lo antes desta gravação). `ProviderError` com status: `failed` com o código e a
   mensagem do provedor (até 500), e a rota responde 200. Rede ou timeout (`status 0`) ou prazo
   esgotado: fica `queued`; o resultado tardio ainda é gravado (`runInBackground`), inclusive sobre um
   `UNKNOWN_RESULT` da varredura.
3. **Reenviar:** só `failed` de `sender_type = user` e tipo `text`; apaga a falha e cria a nova
   (`clientId = retry-<id antigo>`) na mesma transação.
4. **`inbox.sweep`:** `queued` há mais de 2 min vira `failed` com `UNKNOWN_RESULT`.

### Contato e início de conversa (`contact-actions.ts`)

- **Vincular:** cliente do tenant (`customer:update`), membro ativo (400 `INVALID_LINK`) ou os dois
  nulos; um vínculo só. **Salvar como cliente:** `createCustomer` com o telefone **como o WhatsApp
  entregou** (`+<phone>`, sem inserir o 9) e o vínculo no `afterCreate`, na mesma transação: limite do
  plano (403 `PLAN_LIMIT_REACHED`), `INVALID_PHONE`, `PHONE_IN_USE` (com `customerId` e, para quem lê
  clientes, `name`), `CUSTOMER_EMAIL_TAKEN`; contato já vinculado → 409 `CONTACT_ALREADY_LINKED`.
- **Iniciar conversa:** com `customerId`, também `customer:read` (a conversa mostra o telefone do
  cliente); canal do escopo (404), não `disabled` (409 `CHANNEL_DISABLED`); cliente ou
  membro sem telefone → 400 `PHONE_REQUIRED`; telefone avulso normalizado (400 `INVALID_PHONE`). Contato
  com a mesma `phone_key` é reaproveitado (e ligado ao cliente ou membro, se estava sem vínculo); sem ele,
  só `mobile` ou `foreign` (`canWhatsApp`), senão 400 `PHONE_NOT_WHATSAPP`. Conversa nova nasce `open`,
  sem `last_inbound_at` (a janela da Cloud fica fechada) e com **quem iniciou como dono**; a que já
  existe e é de outro atendente responde 409 `ALREADY_ASSIGNED` a quem não supervisiona.

### Mídia servida (`media-access.ts`)

Só o `file` da própria mensagem (`owner_type = message`, `owner_id = message.id`), de conversa visível.
Lê os primeiros 4 KB do fluxo, decide o tipo com `inboundMime` (conteúdo primeiro) e devolve o fluxo
inteiro. `inline` só para `INLINE_SAFE_MIME` (imagem, áudio e vídeo); o resto `attachment`. Sempre
`nosniff` e `private, max-age=300`. Objeto ausente no armazenamento: 404 e `logChannelError` sem dado.

## Segurança e privacidade

- Conteúdo de mensagem, telefone e nome nunca vão a `logError`, `audit_log` ou Sentry; o erro do
  `channel_event` continua passando por `sanitizeChannelError`.
- `tenant_id` sempre do `Scope`, nunca do aviso. O LID de um tenant não acha contato de outro.
- **Personificação:** toda escrita de `/api/inbox` (inclusive marcar como lida) passa por
  `blockMutationsWhileImpersonating` e responde 403 `IMPERSONATION_BLOCKED` (o código do projeto; a
  SPEC citava `IMPERSONATION_READ_ONLY`); a leitura segue liberada. Tenant `read_only` lê, mas não
  escreve (regra geral de `requireTenant`, inclusive "marcar como lida").
- Erro de envio vai a log só por `logChannelError` (tipo, status e código); a mensagem do provedor fica
  em `message.error_message`, para o atendente.
- **LGPD pendente (C7):** exportação e anonimização de `customer`, `user` e organização ainda não
  cobrem `chat_contact`, `conversation`, `message` e a mídia (`lgpd.md`). A exclusão de organização
  **anonimiza** a linha de `organization` (não a apaga), então o cascade não roda: a C7 precisa apagar
  as conversas e os objetos explicitamente.

## Testes

- `tests/db/rls.test.ts`: as cinco tabelas (inclusive `file`) nos três modos de `scopedPolicy()`;
  tenant não lê arquivo da plataforma; `channel_id` imutável; `restrict` do canal; cascade da
  organização.
- `tests/db/inbox-ingest.test.ts`: provedor que devolve eventos já normalizados, pelo job real.
  Número novo, repetida, 9º dígito, cliente e membro reconhecidos, dois membros com o mesmo número
  (candidatos), plataforma sem cliente de tenant, `mobile_legacy` achado pela `phone_key`, reabertura
  sem dono, eco, LID, status fora de ordem, mídia Evolution e Cloud (job com recusa e retry).
- `src/lib/channels/providers/whatsapp_cloud/inbox.db.test.ts` e `whatsapp_qr/inbox.db.test.ts`: as
  fixtures de B0 (simuladas) do webhook à mensagem gravada.
- C2, pela API: `inbox-queue.test.ts` (matriz de visibilidade: o membro não lê, não marca como lida,
  não muda a situação nem baixa mídia da conversa de outro; dois `claim` simultâneos, um 200 e um 409;
  transferir e devolver; paginação no mesmo instante; busca com e sem o 9º dígito; mídia disfarçada
  vira anexo; remoção e rebaixamento de membro), `inbox-send.test.ts` (provedor simulado: sucesso,
  recusa, sem resposta + varredura, `clientId` repetido, janela de 24 h, canal desconectado, eco
  antes do id, reenvio) e `inbox-contacts.test.ts` (vínculo, candidatos, salvar como cliente com
  limite do plano e `PHONE_IN_USE`, iniciar conversa). As rotas entram em `rbac.test.ts` e as escritas
  no `it.each` de `impersonation.test.ts`; `src/lib/inbox/window.test.ts` cobre a janela.

## Desvios da SPEC (C2)

- Personificação responde `IMPERSONATION_BLOCKED` (código do projeto), não `IMPERSONATION_READ_ONLY`.
- E-mail repetido no "salvar como cliente" é `CUSTOMER_EMAIL_TAKEN` (o código de `crm-cadastro`), não
  `CUSTOMER_EMAIL_IN_USE`.
- O envio aceita só `type: "text"`; modelo e anexo (`multipart`) entram na C5 com o contrato da SPEC.
- `POST /conversations/:id/assign` usa `inbox:read` na rota e decide `reply`/`assign` no serviço.
- Iniciar conversa dá o dono a quem iniciou (a SPEC não dizia; sem isso a conversa iria para a fila).
- Contato vinculado a cliente aparece sem nome, etiquetas nem campos para quem não tem `customer:read`.
