# Caixa de entrada (chat e fila de atendimento)

- **Escopo:** conversas de WhatsApp do tenant e da plataforma: contatos (`chat_contact`), conversas,
  mensagens, ingestão dos avisos de canal e mídia recebida. A configuração dos números é de
  `tech/29-canais-whatsapp.md`.
- **Specs relacionadas:** `docs/specs/caixa-de-entrada/spec.md` e `prd.md`; programa em
  `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T6, T10, T11, T13)
- **Paths do código:** `src/db/schema/inbox.ts`, `src/lib/inbox/` (`constants.ts`, `contacts.ts`,
  `ingest.ts`, `media.ts`, `notify.ts`, `channel-usage.ts`; da C5: `media-out.ts`, `send-media.ts`, `send-template.ts`, `templates.ts`; da C2: `visibility.ts`, `cursor.ts`,
  `views.ts`, `conversations.ts`, `assignment.ts`, `media-access.ts`, `send.ts`, `window.ts`,
  `contact-actions.ts`; da C4: `realtime.ts`; da C7: `privacy.ts`), `src/api/inbox.ts`, `src/api/inbox-events.ts` (C4), `src/api/inbox-media-out.ts` (C5),
  `src/lib/schemas/inbox.ts`, `src/jobs/inbox.ts`,
  da C6: `src/api/admin-inbox.ts`, `src/api/inbox-shared.ts`, `src/lib/inbox/platform.ts`, `src/lib/inbox/platform-link.ts`,
  `src/components/inbox/inbox-scope.tsx`, `src/components/inbox/platform-contact-section.tsx`, `src/routes/admin/inbox.tsx`,
  `tests/db/inbox-platform.test.ts`, `src/lib/inbox/platform.test.ts`,
  da C3: `src/components/inbox/` (`inbox-api.ts`, `format.ts`, `labels.ts`, `conversation-list.tsx`,
  `conversation-item.tsx`, `conversation-header.tsx`, `message-thread.tsx`, `message-bubble.tsx`,
  `composer.tsx`, `contact-panel.tsx`, `contact-dialogs.tsx`, `new-conversation-dialog.tsx`; da C5: `template-dialog.tsx`; da C4:
  `use-inbox-events.ts`, `realtime-mode.ts`), `src/pages/inbox-page.tsx`, `src/routes/app.inbox.tsx`,
  `src/components/app/app-layout.tsx` (monta o `InboxEvents`),
  `drizzle/0032_caixa_de_entrada.sql`, `drizzle/0033_rls_caixa_de_entrada.sql`,
  `tests/db/inbox-ingest.test.ts`, `tests/db/inbox-{queue,send,contacts}.test.ts`,
  `tests/db/inbox-helpers.ts`, `tests/db/rls.test.ts` (bloco da caixa de entrada),
  `tests/db/inbox-realtime.test.ts` e `tests/db/fixtures/inbox-realtime-worker.ts` (C4),
  `tests/db/inbox-media-send.test.ts` (C5),
  `src/lib/channels/providers/*/inbox.db.test.ts`,
  da C7: `tests/db/inbox-lgpd.test.ts` e os ganchos em `src/lib/lgpd/deletion.ts`, `src/lib/lgpd/export.ts`,
  `src/lib/tenant/customers.ts` (`deleteCustomer`), `src/lib/channels/events.ts` (`purgeTenantChannelEvents`) e
  `src/api/roles.ts`

## Estado

| Fase | Entrega | Estado |
|---|---|---|
| C1 | Dados e ingestão (mensagens, status, eco, LID, mídia de entrada) | **Feita** |
| C2 | API: leitura paginada, fila, assumir, transferir, envio de texto, janela de 24 h, visibilidade, contato | **Feita** |
| C3 | Tela `/app/atendimento` (polling de 20 s, só tenant) | **Feita** |
| C4 | Tempo real (SSE + `LISTEN/NOTIFY`) | **Feita** |
| C5 | Mídia de saída, modelos, citação no envio | **Feita** |
| C6 | Atendimento da plataforma em `/admin` | **Feita** |
| C7 | LGPD (exportação e exclusão cobrindo conversas), retenção de `channel_event` e fechamento | **Feita** |

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
  consulta `src/lib/inbox/channel-usage.ts`). Apagar a **linha** da organização leva tudo por cascade, mas a
  exclusão LGPD a anonimiza (não apaga): quem apaga as conversas é `purgeTenantInbox` (seção "LGPD (C7)").
- Só `src/lib/inbox/` consulta estas tabelas (regra de visibilidade, T13). Toda leitura e escrita de
  rota passa por `visibleConversation` (`visibility.ts`, abaixo). Os ganchos de fora chamam o serviço em vez de consultar a tabela:
  remoção e troca de papel de membro (`src/lib/tenant/team.ts`) e edição de papel (`src/api/roles.ts`) usam
  `releaseAssignments`/`releaseAssignmentsWithoutReply`; a LGPD (`src/lib/lgpd/`) e a exclusão de cliente
  (`src/lib/tenant/customers.ts`) usam `privacy.ts`.

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
   (`autoLinkContact`), **só com correspondência única e só com telefone confirmado**
   (`phone_verified_at`, `tech/28`): cliente do tenant, depois membro do tenant (não banido); na
   plataforma, usuário, e nunca `customer` de tenant. O cliente vem antes porque quem é da equipe e
   também é cliente tem os dois cadastros com o mesmo número, e a conversa fica na ficha de cliente.
   `linkCandidates` é a mesma consulta que o painel (C2) usa para os candidatos, ali sem o filtro de
   confirmado: quem decide é a equipe. `wa_name` atualiza a cada mensagem recebida (no
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
7. `notifyInbox(tx, { s, c, k, m, a })` na mesma transação (`pg_notify` no `COMMIT`; seção "Tempo real").

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
| `POST /api/inbox/conversations/:id/messages` | `inbox:reply`, 60/min (anexo: 20/min) | JSON `text` (com `replyTo`) → `sendText`; JSON `template` → `sendTemplate`; `multipart/form-data` → `sendMedia`. 201 (`sent` ou `queued`), 200 com a mensagem `failed` |
| `GET /api/inbox/conversations/:id/templates` | `inbox:reply` | `listConversationTemplates`: modelos aprovados do WABA do canal, já analisados |
| `GET /api/inbox/media-out/:token` | **sem sessão**, token assinado | `openOutboundMedia` (só a Evolution chama; ver "Anexo de saída") |
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
ou com o próprio ator como dono. Na plataforma (C6), o escopo `tenant_id IS NULL` (ver "Atendimento da plataforma (C6)"). Mensagem e mídia
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
  sem `inbox:reply` e `anonymizeUser` (LGPD, todos os tenants) devolvem as conversas à fila. Editar as
  permissões de um papel personalizado (`PATCH /api/roles/:id`) chama `releaseAssignmentsWithoutReply(tenantId,
  catálogo)` (C7): quem ficou sem `inbox:reply` devolve as conversas. Roda depois da gravação do papel (que é do
  Better Auth, fora desta transação) e depois da auditoria: se falhar, vai ao `logError` (a edição já valeu, sem 500) e
  as conversas ficam com o dono até a próxima edição ou remoção.
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
2. Fora da transação, `attemptOf` chama `sendChannelText`, `sendChannelMedia` ou `sendChannelTemplate` (que reconferem o canal e marca `error` em 401/403) com prazo de
   20 s. Sucesso: `sent` + `provider_message_id`; antes, apaga o eco `device` com o mesmo id (a
   Evolution pode entregá-lo antes desta gravação). `ProviderError` com status: `failed` com o código e a
   mensagem do provedor (até 500), e a rota responde 200. Rede ou timeout (`status 0`) ou prazo
   esgotado: fica `queued`; o resultado tardio ainda é gravado (`runInBackground`), inclusive sobre um
   `UNKNOWN_RESULT` da varredura.
3. **Reenviar:** só `failed` de `sender_type = user`; apaga a falha e cria a nova
   (`clientId = retry-<id antigo>`) na mesma transação. Texto e modelo (carga de `payload.template`, vale com a janela
   fechada) refazem a chamada; o **anexo reaproveita o `file`** (sem novo upload: o dono do arquivo passa à mensagem nova).
4. **`inbox.sweep`:** `queued` há mais de 2 min vira `failed` com `UNKNOWN_RESULT`.

**Limites conhecidos:** (a) se o provedor responder depois de 2 min e o atendente já tiver usado
"Reenviar" na `UNKNOWN_RESULT`, o contato recebe duas vezes (a original sumiu; a tela avisa para
conferir no celular antes de reenviar). (b) O eco `device` apagado em `recordSent` levava só a mensagem; desde a C5 leva também o `file` e, depois do commit, o
objeto (teste em `inbox-media-send.test.ts`). (c) Aviso de
status que chega antes de gravarmos o `provider_message_id` fica `ignored` e a mensagem para em `sent`.

### Anexo de saída, modelo e citação (C5)

Uma só tubulação: `queueMessage` (transação curta, conversa travada) recebe um `Draft` (tipo, texto, arquivo novo
ou existente, o que vai ao provedor) montado por `build` **depois** de conferidos canal, janela e citação;
`dispatch` chama o provedor fora da transação (20 s; anexo 30 s). `send.ts` (núcleo, texto, reenvio),
`send-media.ts` e `send-template.ts`.

- **Anexo** (`multipart/form-data`: `file`, `caption?`, `replyTo?`, `clientId`): ordem para que a recusa nunca grave
  nada: permissão, tamanho (16 MB: `FILE_TOO_LARGE` 413, também no limite de corpo antes de ler), tipo **pelo
  conteúdo** (`classifyOutbound`: `inboundMime` sobre os bytes; o tipo do navegador só refina; fora de `OUTBOUND_MIME`
  é 415 `UNSUPPORTED_MEDIA_TYPE`; OOXML exige a pasta `word/`, `xl/` ou `ppt/` no ZIP), legenda em áudio (400), cota
  `storage_mb` do plano (403 `PLAN_LIMIT_REACHED`; a soma de `file` já inclui a mídia recebida) e só então grava o objeto
  (`inbox/<tenant | platform>/<chave aleatória>`). A linha de `file` (`owner_type = message`, `owner_id` = a mensagem,
  que nasce com id gerado antes) entra na mesma transação da mensagem. Se a transação recusar (janela, canal, citação)
  ou o `clientId` já existir, o objeto é apagado. Lista: imagem jpeg/png/webp; vídeo mp4 e 3gpp; áudio ogg, mpeg, mp4,
  aac, amr; pdf, doc/xls/ppt, docx/xlsx/pptx e text/plain. `OUTBOUND_MIME` e o teto estão em `constants.ts` (a tela os
  lê) e são reexportados por `media.ts`. Anexo respeita a janela de 24 h (só o modelo a ignora).
- **Como cada canal recebe o arquivo:** Cloud: `SendMedia.content` (função que lê o objeto), `uploadMedia` e envio pelo
  id, nunca por link. Evolution: `POST /send/media` com `url` assinada de 5 min. **Decisão (a B0 não mediu base64):** as
  fixtures de B0 são simuladas e o contrato medido na origem só tem `url`; por isso a rota existe. Se uma captura real
  mostrar que o servidor aceita base64 (ou data URI) em `url`, troque `mediaOutUrl` e apague `media-out.ts`,
  `inbox-media-out.ts` e a linha em `app.ts`. O servidor Evolution precisa alcançar `EVOLUTION_WEBHOOK_PUBLIC_URL`
  (padrão `APP_URL`), como no webhook.
- **`GET /api/inbox/media-out/:token`** (`src/api/inbox-media-out.ts`, antes do `csrfGuard`, fora da cadeia de sessão):
  token `<fileId>.<expira>.<HMAC-SHA256>` com `BETTER_AUTH_SECRET` e rótulo de domínio; um arquivo, 5 minutos (prazo
  assinado e limitado ao que emitimos), comparação em tempo constante. Só serve `file` que seja a mídia de mensagem
  **enviada pela equipe** (`direction = out`, `sender_type = user`); mídia recebida, arquivo de outro módulo, token
  vencido, adulterado ou de outro arquivo: 404 igual. Só as **recusas** contam no limite por IP (30/min, `failureLimit` como nos webhooks): a Evolution é um só IP e baixa um arquivo por envio de todos os tenants. Resposta `nosniff`,
  `Cache-Control: private, no-store`, `attachment` salvo imagem/áudio/vídeo seguros. Não lista nada.
- **Modelo** (`type: "template"`, `templateId`, `variables[]`): só de `message_template` aprovado, do WABA do canal e do
  escopo; fora disso 404 (outro WABA é igual a inexistente), pendente 409 `TEMPLATE_NOT_APPROVED`, canal sem `templates`
  400 `TEMPLATES_NOT_SUPPORTED`. `templates.ts` (puro, usado pela tela e pelo servidor) analisa os `components`:
  cabeçalho de texto, corpo, rodapé, botões sem parâmetro, variáveis numeradas (em sequência) **ou** nomeadas
  (`parameter_name`); cabeçalho de mídia, botão com variável, copy code, flow, carrossel e variável mista aparecem
  desabilitados com o motivo (`TEMPLATE_NOT_SUPPORTED` no envio). `variables` na ordem dos slots (cabeçalho, depois
  corpo); a contagem e cada valor (sem quebra de linha, tabulação nem 5 espaços, até 1024) são conferidos (400
  `INVALID_TEMPLATE_VARIABLES`). Grava `type = template`, `template_name`, `text` = texto preenchido e
  `payload.template = { id, name, language, variables, components }` (o reenvio usa `components`, sem reler a tabela).
  Vale com a janela fechada e não a abre.
- **Citação:** `replyTo` no texto e no anexo; mensagem de outra conversa (ou inexistente) é 400 `INVALID_REPLY` e não grava
  nada; o provedor recebe o `provider_message_id` dela (se ainda não tem, a citação só fica do nosso lado). A Evolution
  recebe `quoted` também no `/send/media`. Modelo não cita.

### Contato e início de conversa (`contact-actions.ts`)

- **Vincular:** cliente do tenant (`customer:update`), membro ativo (400 `INVALID_LINK`) ou os dois
  nulos; um vínculo só. **Salvar como cliente:** `createCustomer` com o telefone **como o WhatsApp
  entregou** (`+<phone>`, sem inserir o 9), ou o `phone` que o atendente corrigiu no formulário (C5; o contato continua
  com o número do provedor), e o vínculo no `afterCreate`, na mesma transação: limite do
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

## Tela do atendimento (C3)

Rota `/app/atendimento/:conversationId?` (`routes/app.inbox.tsx` → `pages/inbox-page.tsx`), client-only, sem
`loader`: TanStack Query + `apiFetch`. Item "Atendimento" em `app-nav.ts` (`inbox:read`), com o ponto de não
lidas de `GET /api/inbox/unread`. `AppLayout` tira o padding e o overflow do `<main>` nesta rota (a tela rola
por dentro). `mode="platform"` é a C6: ver "Atendimento da plataforma (C6)".

- **Camada de dados** (`inbox-api.ts`): tipos (datas em ISO), `inboxKeys` (todas sob `["inbox", tenantId, …]`),
  hooks de leitura (`useConversations` e `useMessages` com cursor, `useConversation`, `useInboxUnread`,
  `useAssignees`, `useContactCandidates`) e de escrita (`useInboxMutation`, `useSendText`). Erros de regra
  (409 `ALREADY_ASSIGNED`, `SESSION_WINDOW_CLOSED`, `CHANNEL_NOT_CONNECTED`, 403 `PLAN_LIMIT_REACHED`) chegam como
  `ApiError` e viram toast com a mensagem da API (`errorText`); `ApiError.details` carrega os campos extras do
  corpo (`assignedTo`, `customerId` e `name` do `PHONE_IN_USE`).
- **Atualização:** pelo SSE da C4 (seção "Tempo real"); sem ele, polling de `INBOX_POLL_MS` (20 s) em lista,
  conversa, mensagens e contador, pausado durante um envio (`useInboxRefetchInterval`).
- **Lista** (`conversation-list.tsx`): abas Fila, Minhas e Todas (a última só com `supervise`), situação, não
  lidas, número (com mais de um), etiqueta (com `customer:read`), atendente (`supervise` + `assign`, só em "Todas"),
  busca com espera de 300 ms e rolagem infinita por cursor (`IntersectionObserver` e botão "Carregar mais").
- **Conversa:** `message-thread` mostra da mais antiga para a mais nova, com separador por dia; ao rolar perto
  do topo busca a página anterior e restaura a posição; só rola ao fim se já estava no fim. `message-bubble` tem
  um renderizador por tipo; texto sempre como texto, links só `http(s)` com `rel="noopener noreferrer"`
  (`splitLinks`); mídia `pending` e `failed` com "Tentar de novo"; falha de envio com o motivo e "Reenviar".
- **Composer (C5):** além do texto, **anexo** (clipe e colar imagem; prévia, nome e tamanho, legenda no mesmo campo, sem legenda em áudio, 16 MB conferidos antes de subir), **citação** ("Responder" na bolha põe o chip "Respondendo ao contato / a você" acima do campo, com X; some ao enviar com sucesso e ao trocar de conversa) e **modelo** (`template-dialog.tsx`: aprovados do WABA, campos das variáveis, prévia pela mesma função do servidor, erro da API dentro do diálogo; botão no composer só em canal com `templates` e, com a janela fechada, o "Enviar modelo" da faixa). Anexo que falha volta ao composer com a legenda e reaproveita o `clientId`. A bolha "enviando" mostra a imagem local, o nome do arquivo ou o modelo. **Reenviar** vale para texto, anexo e modelo.
- **Envio:** o texto vai como bolha "enviando" local e some quando a releitura traz a
  mensagem do servidor; erro devolve o texto ao campo, e o `clientId` é reaproveitado no reenvio depois de
  erro de rede. Um envio por vez. O campo é bloqueado, com a explicação, para: sessão personificada, sem
  `inbox:reply`, tenant `read_only`, número não conectado e janela de 24 h encerrada. Rascunho por conversa só
  em memória.
- **Cabeçalho:** Assumir (sem dono, com `reply`), Devolver à fila (dono com `reply` ou `assign`), Transferir
  (`assign`, lista de `/api/inbox/assignees`) e Situação (pendente, encerrar, reabrir).
- **Painel do contato** (`contact-panel.tsx`, `contact-dialogs.tsx`): telefone, nome no WhatsApp, renomear;
  cliente vinculado com `TagPicker` e `CustomFieldInput` (gravam por `PATCH /api/customers/:id`, só com
  `customer:update`), "Desvincular"; sem vínculo, "Salvar como cliente" (`customer:create`; `PHONE_IN_USE`
  oferece "Vincular a ele"), "Vincular a cliente" (`customer:read` + `update`) e os candidatos do mesmo
  telefone. Sem `customer:read` o painel mostra só "vinculado a um cliente".
- **Novas conversas:** `new-conversation-dialog.tsx` (cliente, equipe ou telefone + número de saída) e o botão
  "Conversar" (`StartConversationButton`) no detalhe do cliente e na lista de equipe, com `inbox:reply` e telefone.
  Telefone fixo ou celular de 8 dígitos troca o botão pela explicação; com um só número conectado a conversa abre
  direto. `GET /api/team` passou a trazer `phoneKind` (só o tipo, nunca o número).
- **Erro de releitura:** só o erro **sem dados** troca a tela (`isError && !data`); uma releitura que falha no
  polling mantém a conversa, a lista e o rascunho abertos.
- **Releitura por escopo:** `invalidateInbox` sempre relê lista e contador; com `conversationId`, o detalhe e (salvo
  `messages: false`) as mensagens daquela conversa. Assumir, devolver, transferir, situação e marcar como lida
  passam `messages: false`.
- **Limite conhecido:** a releitura de `useInfiniteQuery` (polling, evento ou o ciclo de 60 s da lista) relê
  **todas** as páginas já carregadas, em sequência. Com o SSE de pé, as mensagens só são relidas quando chega
  evento daquela conversa; no modo polling, a cada 20 s.
  Rascunhos do composer ficam em memória, com chave de tenant, pessoa e conversa.
- **Tela estreita:** uma coluna por vez (lista → conversa → painel, com "voltar"); a partir de `xl` o painel é
  a terceira coluna.

## Tempo real (C4)

Plano T11: o aviso leva só ids e a tela relê pela API, que aplica a visibilidade; funciona com o worker
separado porque o aviso sai do banco, não do processo.

- **Emissão** (`notify.ts`): `notifyInbox(tx, aviso)` faz `pg_notify('inbox', json)` na transação de quem
  grava; sai no `COMMIT` (rollback não avisa) para todo processo que escuta, inclusive quando quem grava é o
  `--worker`. Carga `{ s, c, k, m?, a?, p?, u? }`, montada só com essas chaves (`noticePayload`): `s` tenant
  ou `null`, `c` conversa, `k` (`message`, `status`, `conversation`), `m` mensagem, `a` dono depois, `p`
  dono antes (omitido = não mudou), `u` quem mudou (assumir, transferir, responder, iniciar). Sem `a` (status
  de entrega, `inbox.sweep`, mídia), `notifyInbox` lê o dono atual na mesma transação; sem achar, o aviso
  sai sem `a` e só vai a quem supervisiona. Toda escrita da C1/C2 já chamava aqui.
- **Escuta** (`realtime.ts`): **uma** conexão `LISTEN inbox` por processo web, aberta na primeira
  assinatura (o `--worker` nunca assina), em `REALTIME_DATABASE_URL` (padrão `DATABASE_URL`; direta ou
  pooler em modo sessão). `max_lifetime` desligado, `select 1` a cada 30 s para achar conexão meio aberta,
  reconexão com backoff de 1 s a 30 s. Caiu: `lost()` a todo assinante (o SSE se encerra) e
  `realtimeAvailable()` falso até voltar. A carga é conferida por `parseInboxNotice` (só ids e as chaves
  conhecidas, até 1 KB); o resto é descartado. Log só da mudança de estado da conexão.
- **SSE** (`GET /api/inbox/events`, rota em `inbox.ts`, lógica em `inbox-events.ts`): `requireAuth` +
  `requireTenant` + `inbox:read`. Assina o escopo do ator e entrega o aviso só se
  `noticeVisibleTo(actor, aviso)`: mesmo escopo e dono antes **ou** depois visível pelo mesmo predicado de
  `visibleConversation` (`reachOf`, em `visibility.ts`; `ownerVisible` é a forma em memória). O evento
  `inbox` leva `{ c, k, m?, a?, p?, u? }` (sem `s`). Ao abrir, `event: ready` com `retry: 5000`; batimento
  `: ping` a cada 25 s; encerrado a cada 15 min (a reconexão passa por `requireAuth`); até 3 fluxos por pessoa
  **neste processo** (429 `TOO_MANY_STREAMS`); escuta fora do ar → 503 `REALTIME_UNAVAILABLE` (na primeira
  assinatura do processo espera até 3 s a conexão abrir); cliente que não lê (100 escritas pendentes) é
  desligado. `Cache-Control: no-cache, no-transform` e `X-Accel-Buffering: no`. A plataforma (C6) só chama
  `streamInboxEvents(c, atorDaPlataforma)` em `GET /api/admin/inbox/events`.
- **Cliente** (`use-inbox-events.ts`, `InboxEvents` no `AppLayout` para quem tem `inbox:read`):
  `connectInboxEvents` fecha o `EventSource` no erro e decide a reconexão: fluxo que chegou a abrir (fim dos
  15 min) reconecta em 1 s sem mudar de modo; falha ao abrir (503, 429, rede) ou tentativa sem resposta em
  10 s → modo `polling` e nova tentativa em 2, 5, 10, 30 e 60 s. O modo fica em `realtime-mode.ts`
  (`useInboxRealtimeMode`) e `refetchIntervalFor` o traduz: `live` = lista, contador e detalhe da conversa (a
  janela de 24 h expira sem evento) a cada 60 s, mensagens só por evento; `polling`/`connecting` = 20 s em
  tudo, com o aviso "Atualização em tempo real indisponível" no topo da tela. Os eventos de uma rajada
  (250 ms) viram uma chamada de `invalidateInboxChanges` (a mesma fonte de chaves de `invalidateInbox`), por
  tipo (`changeOf`): `message` relê lista, contador, detalhe e mensagens; `conversation`, lista, contador e
  detalhe; `status`, só as mensagens. Com envio em andamento, espera (a releitura duplicaria a bolha
  otimista). Nunca escreve o evento no cache. A **cada abertura** do fluxo e ao voltar o foco, relê tudo da
  caixa (e, no foco, tenta reconectar já). `a = eu`, `p ≠ eu` e `u ≠ eu` em `conversation` → toast "Uma
  conversa foi atribuída a você." com "Abrir".
- **Limites conhecidos:** (a) sessão revogada, papel trocado ou membro removido seguem recebendo **ids** por
  até 15 min (a releitura pela API já os barra); (b) o teto de 3 fluxos é por processo (com réplicas, 3 por
  réplica); (c) evento perdido na queda é coberto pela releitura ao reconectar, não por reenvio; (d) aviso
  sem `a` (status de entrega, `inbox.sweep`) custa um `SELECT` do dono por aviso na transação de quem grava.

## Atendimento da plataforma (C6)

A caixa de entrada da plataforma (`tenant_id` nulo, `Scope = platform`, sempre em `withPlatformData`) é a mesma
tubulação do tenant com três diferenças: **sem fila** (não há dono, `claim`, `assign`, `assignees`, abas `queue` e
`mine`, `supervise`), **sem clientes dos owners** (decisão do proprietário: o cliente é do owner, controlador; a
plataforma é operadora) e **o `platform_support` responde**. Nada do atendimento da plataforma usa `withPlatformScope`.

**API** (`src/api/admin-inbox.ts`, montada em `app.ts` antes de `adminRoutes`, como `admin-channels`; traz a própria
cadeia: `sameOrigin` → `inboxBodyLimit` → `authRateLimit` → `requireAuth` → `requirePlatform()` →
`blockMutationsWhileImpersonating`). `src/api/inbox-shared.ts` guarda o que as duas APIs repartem (limite de corpo,
leitura do envio JSON ou `multipart`, resposta da mídia).

| Rota | Quem | Serviço |
|---|---|---|
| `GET /api/admin/inbox/conversations?status&unread&channelId&q&cursor&limit` | plataforma | `listConversations` com `tab = all` fixo (a rota não tem `tab`, `tagIds` nem `assignedTo`; `platformConversationsQuerySchema`) |
| `GET .../conversations/:id`, `.../messages`, `.../templates` | plataforma (`templates`: quem responde) | `getConversation`, `listMessages`, `listConversationTemplates` |
| `GET .../unread` | plataforma | `unreadCounts` (`{ queue, mine }`: a plataforma só usa `queue`, o total com não lidas) |
| `GET .../events` | plataforma | `streamInboxEvents` com o ator da plataforma: só avisos `s = null`; batimento, 15 min, 3 por pessoa, 503 sem `LISTEN` |
| `GET .../messages/:id/media` | plataforma | `openMessageMedia` (a mídia da mensagem aponta para `/api/admin/inbox/messages/:id/media`: `inboxBase(scope)`) |
| `POST .../conversations/:id/messages` (JSON ou `multipart`), `POST .../messages/:id/retry`, `.../media/retry`, `POST .../conversations/:id/status`, `.../read`, `POST .../conversations`, `PATCH .../contacts/:id`, `POST .../contacts/:id/link` | `platform_owner` e `platform_support` (`PLATFORM_REPLY_ROLES`) | `sendText`/`sendMedia`/`sendTemplate` (`queueMessage` + `dispatch`), `retryMessage`, `setConversationStatus`, `markConversationRead`, `startPlatformConversation`, `updateContact`, `linkPlatformContact` |

Limites por pessoa: `admin-inbox-send` 60/min, `-upload` 20/min, `-start` 20/min, `-queue` 60/min, `-media-retry` 20/min.
`claim`, `assign`, `assignees`, `candidates` e `customer` **não existem** (404, teste de matriz).

- **Ator** (`platform.ts`): `platformActor(user, ip)` monta o `InboxActor` com `scope = platform`, `permissions = []` e
  `platformCapabilities(role)`: `read` para qualquer papel de plataforma, `reply` para `PLATFORM_REPLY_ROLES`
  (`platform_owner`, `platform_support`), `assign` e `supervise` sempre falsos. A rota confere o papel
  (`requirePlatform([...PLATFORM_REPLY_ROLES])`) e o serviço confere `actor.can.reply` de novo.
- **Visibilidade:** `visibleConversation` na plataforma é `tenant_id IS NULL` para quem lê (`reachOf = all`); conversa de
  tenant responde 404 em toda rota, e a da plataforma responde 404 em `/api/inbox`. O SSE usa o mesmo `noticeVisibleTo`
  (`s` do aviso precisa ser `null` para o escopo da plataforma). Teste em `tests/db/inbox-platform.test.ts`.
- **Sem `customer`:** `selectConversationRows(tx, scope)` **não faz a junção** com `customer` no escopo da plataforma
  (o nome do cliente sai `null`); `linkOf` na plataforma devolve `platformLinkOf`; `linkCandidates` já não consulta cliente
  fora do tenant. `customerId` na criação de conversa e no vínculo é 400 (`.strict()` nos schemas da plataforma).
  Número avulso que pertença a um cliente de owner fica "não identificado".
- **Vínculo** (`platform-link.ts`): `{ kind: "user", user, organizations: [{ id, name, role, tags, customFields }] }` com as
  organizações do usuário (até 50, sem as apagadas) e a anotação de `organization_tag` e `organization_profile`
  (`annotationsOfOrganizations`, em `src/lib/crm/organization-profile.ts`, na mesma `withPlatformData`); `{ kind: "none" }`
  sem vínculo, **sem candidatos**. `linkPlatformContact` aceita `{ userId }` (usuário existente e não banido, senão 400
  `INVALID_LINK`) ou `{ userId: null }`; audita `inbox.contact_linked` (`customerId: null`). A ingestão já vincula só com
  `user` de número único (C1); o vínculo manual escolhe o usuário pela busca de `/api/admin/users`.
- **Iniciar conversa** (`startPlatformConversation`): `{ channelId, userId | phone }`; canal do escopo (404 para canal de tenant),
  não `disabled`; `userId` exige telefone (400 `PHONE_REQUIRED`); mesma regra de `canWhatsApp` ou "já escreveu" do tenant
  (`contactForStart`, extraído de `startConversation` e usado pelos dois). A conversa nasce `open`, sem dono (`tenant_id` nulo).
- **Envio:** nenhum atendente assume ao responder (`claims` só no tenant); a conversa continua sem dono. Anexos, modelos
  (WABA do canal da plataforma), citação, reenvio e janela de 24 h são os do tenant. Mídia da plataforma grava em
  `inbox/platform/…`, sem cota de plano (`storage_mb` é do tenant).
- **Auditoria:** `actor_type = platform`, sem `tenant_id`, só ids (`inbox.conversation_closed`, `_reopened`,
  `inbox.contact_linked`); a conversa da plataforma não tem `claimed`, `assigned` nem `released`.
- **Escrita do suporte:** responder, mudar a situação, iniciar conversa, vincular e renomear são a **única** escrita do
  `platform_support` em `/admin`. Canal, etiqueta e campo seguem só com o `platform_owner` (`ownerOnly`; teste em
  `inbox-platform.test.ts` e nos de `admin-channels` e `crm-platform`). A sessão personificada (o suporte dentro do
  tenant) nem passa de `requirePlatform` (o usuário da sessão é o do tenant): 403 na leitura e na escrita.
- **Tela** (`/admin/atendimento`, `routes/admin/inbox.tsx` → `InboxPage mode="platform"`): os componentes de
  `src/components/inbox/` leem o escopo de `inbox-scope.tsx` (`InboxModeProvider`, `useInboxScope`: raiz da API, rota, chave das
  queries `["inbox", "platform", …]`, caminho dos canais; `useInboxCan`: no tenant, as permissões; na plataforma, só `inbox:read`,
  `inbox:reply` e `channel:read` por papel). Sem abas, sem "Assumir", "Devolver", "Transferir", "Salvar como cliente"; o título
  da lista mostra o total de não lidas. Painel: `PlatformContactSection` (usuário e organizações com etiquetas e campos
  **somente leitura**, links para `/admin/usuarios/:id` e `/admin/tenants/:id`; "Vincular a usuário" busca em
  `/api/admin/users`). "Nova conversa" por usuário ou telefone; "Conversar" na lista `/admin/usuarios` (`phoneKind` do usuário
  vem em `GET /api/admin/users`, o número não). Item "Atendimento" em `admin-nav.ts` com o ponto de não lidas
  (`useInboxUnread(…, "platform")`); `InboxEvents mode="platform"` monta o SSE no `AdminLayout`.

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
- **LGPD:** seção "LGPD (C7)" abaixo; a política (prazo e base legal) está em `docs/context/lgpd.md`.

## LGPD (C7, `src/lib/inbox/privacy.ts`)

Só `privacy.ts` apaga e exporta conversas fora das rotas (T13). Quem chama passa a própria transação e apaga os objetos
do armazenamento **depois do commit**, com as chaves devolvidas (falha ao apagar = objeto órfão no log, nunca a pessoa
nos dados). Apagar o `chat_contact` leva por cascata a identidade, as conversas e as mensagens; a linha de `file` (a
mensagem só aponta para ela, `set null`) sai na mesma transação, pelo `owner_type = message` **e** pelo `message.file_id`
(mídia recebida, anexo de saída e eco do aparelho). Antes de procurar a mídia, os contatos e as conversas são
travados (`FOR UPDATE`): a ingestão e o envio que chegam no meio esperam o commit, e nenhuma mensagem nova cai na
cascata com o arquivo órfão.

| Gatilho | O que acontece | Função |
|---|---|---|
| Excluir o cliente (`DELETE /api/customers/:id`, `deleteCustomer`) | Os contatos vinculados a ele saem com conversas, mensagens, `file` e objeto; o RLS do tenant limita tudo ao tenant da sessão (cliente de outro tenant é 404 e nada muda). Aviso `conversation` às telas abertas | `purgeCustomerContacts` |
| Anonimizar a pessoa do portal (`lgpd.delete`) | Os cadastros dela (pela conta ou pelo e-mail, em todas as organizações) viram "Cliente removido" e os contatos vinculados a eles saem como acima | `purgeCustomerContacts` |
| Anonimizar `user` (`lgpd.delete`, inclusive a exclusão pela plataforma) | As conversas que atendia já voltaram à fila (`releaseAssignments`); as mensagens que enviou ficam **sem autor** (`sender_user_id` nulo; o anexo, sem `file.created_by`) e as que encerrou sem `closed_by`; os contatos vinculados a ele, no tenant **e na plataforma**, só perdem o vínculo (SPEC): nenhuma conversa é apagada por esse vínculo, porque ele nasce do telefone que a pessoa declarou no cadastro, sem verificação (ver "Por que o vínculo com `user` não decide nada") | `detachUserFromInbox` |
| Excluir a organização (`lgpd.delete`, `anonymizeTenant`) | Todos os contatos do tenant (com ou sem vínculo), conversas e mensagens; os `channel_event` do tenant (o `raw` tem telefone e texto) e a mídia `inbound/` que eles citam (o aviso pendente não deixa objeto órfão); todo `file` do tenant (já existia). Os canais ficam (sem avisos), com as credenciais cifradas e a instância no provedor: ver "Limites conhecidos" | `purgeTenantInbox`, `purgeTenantChannelEvents` |

- **Exportação** (`conversationsForExport`, arquivo `conversas-whatsapp.json` no zip de `lgpd.export` **do portal**): as
  conversas com os cadastros de cliente da pessoa, ligados pela conta **ou pelo e-mail** (o mesmo critério da anonimização,
  que os apagaria). O zip da **equipe** não traz conversas. Cada conversa traz organização, telefone, nome no WhatsApp, situação e as mensagens (`recebida` ou
  `enviada`, tipo, texto, nome do modelo, situação de entrega, anexo por **nome, tipo e tamanho**, nunca o conteúdo).
  Fica de fora o que é de terceiros ou interno: quem atendeu, o nome dado pela equipe, `payload` e erro do provedor.
  Teto de **20.000 mensagens** (as mais recentes; `truncated: true` e o `LEIA-ME.txt` orientam a pedir o resto ao
  encarregado). As mensagens que um atendente enviou **não** entram na exportação dele (são conversas com terceiros).
- **Por que o vínculo com `user` não decide nada** (`/security-review` da C7): o `autoLinkContact` liga um contato novo ao
  usuário de `phone_key` única, e o telefone do usuário é só declarado no cadastro aberto (sem verificação nem unicidade).
  Quem se cadastra com o número de outra pessoa é vinculado sozinho à conversa dela com a plataforma (ou, se for membro, à
  conversa do tenant). Por isso a exportação da equipe não traz conversas e a anonimização de `user` só desfaz o vínculo:
  usar o vínculo entregaria a conversa de terceiros ao atacante, ou a apagaria a pedido dele. Para o **cliente**, a SPEC
  exige exportar e apagar pelo vínculo. O risco equivalente (a pessoa do portal trocar o próprio telefone para o de um
  terceiro e receber a conversa dele) foi **fechado na pré-produção (T1)**: o vínculo automático só usa telefone
  confirmado, e o número que a pessoa troca em `/portal/conta`, ou declara no cadastro, fica pendente até ser confirmado
  (`tech/28`, "Telefone verificado e único"). A regra de não exportar nem apagar pelo vínculo com `user` continua.
- **Retenção:** `channel_event` tratado sai depois de `CHANNEL_EVENT_RETENTION_DAYS` (padrão 30, de 1 a 365) no
  `maintenance.prune`. Conversas e mensagens não têm prazo automático (o PRD deixa a retenção automática fora do
  escopo): ficam enquanto o owner as mantiver, e saem com o cliente, a pessoa ou a organização. **Decisão pendente do
  proprietário** se quiser um prazo (`lgpd.md`).

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
- C5: `tests/db/inbox-media-send.test.ts` (Postgres real, provedor e armazenamento simulados): anexo Cloud (arquivo
  gravado antes, conteúdo enviado ao provedor, legenda, mídia aberta pela rota) e Evolution (URL assinada baixada sem
  sessão); recusas que não gravam nada (HTML como imagem, 16 MB + 1 e 20 MB, áudio com legenda, janela fechada, canal
  desconectado, tenant `read_only`, conversa de outro, sem `inbox:reply`, 429 do 21º anexo, citação de outra conversa);
  token vencido, adulterado, de outro arquivo e de mídia recebida; `clientId` repetido; falha e reenvio reaproveitando o
  `file`; eco do aparelho que leva o `file`; modelo (lista, janela fechada, variáveis, pendente, outro WABA, mídia no
  cabeçalho, Evolution, reenvio). Unitários: `templates.test.ts`, `media.test.ts` (`classifyOutbound`) e
  `media-out.test.ts` (token). `inbox-contacts.test.ts`: telefone corrigido em "salvar como cliente".
- C6: `tests/db/inbox-platform.test.ts` (Postgres real, provedor e armazenamento simulados): acesso (anônimo 401; dono de tenant e membro
  403 em toda rota; `claim`, `assign`, `assignees`, `candidates` e `customer` 404), suporte e proprietário respondem (texto, anexo, modelo,
  situação, iniciar conversa, vincular, renomear) e o suporte recebe 403 em canal, etiqueta e campo; isolamento (nenhuma conversa de tenant
  na plataforma, por lista, id, mensagens, mídia, envio, contato e SSE, e nenhuma da plataforma no tenant); `customerId` é 400; cliente
  de tenant com o mesmo telefone não aparece (nem na busca) e a consulta da lista não menciona `customer`; SSE só do escopo (carga só de
  ids, limite de 3); sessão personificada 403. Unitário: `src/lib/inbox/platform.test.ts` (capacidades, schemas, varredura que impede
  `withPlatformScope` e `customer` nos arquivos da plataforma).
- C4: `tests/db/inbox-realtime.test.ts` (Postgres real): sessão, tenant e `inbox:read`; o membro A não recebe
  evento de conversa do membro B, e entrar e sair da fila chega a quem deve; status de entrega com o dono
  completado no servidor; ingestão num **processo à parte** (`fixtures/inbox-realtime-worker.ts`, o papel do
  `--worker`) chegando ao SSE deste, com a carga crua sem texto, telefone nem nome; batimento; limite de 3;
  reautenticação (fluxo encerrado e reconexão com sessão revogada → 401); queda do `LISTEN` → fluxo
  encerrado, 503 e volta. Unitários: `src/lib/inbox/realtime.test.ts` (carga, `parseInboxNotice`,
  `noticeVisibleTo`) e `src/components/inbox/use-inbox-events.test.ts` (modo, backoff, releitura, toast).
- C7: `tests/db/inbox-lgpd.test.ts` (Postgres real, armazenamento em memória): excluir o cliente pela API apaga contato,
  conversa, mensagens, `file` e objeto, e o contato sem vínculo e o mesmo número em outro tenant ficam; um tenant não
  exclui cliente de outro (404, nada muda); anonimizar a pessoa do portal; anonimizar `user` (mensagem sem autor,
  `closed_by` e `file.created_by` nulos, vínculo desfeito no tenant e na plataforma, nenhuma conversa apagada); excluir a organização (contatos,
  conversas, mensagens, `file`, anexo de saída, `channel_event` e a mídia `inbound/` de aviso pendente; outro tenant
  intacto); exportação do portal (só as conversas dos cadastros dele, anexo por nome, sem id nem e-mail de quem atendeu,
  nada do outro tenant com o mesmo número; cadastro ligado só pelo e-mail entra) e a da equipe sem conversas (o telefone
  declarado de outra pessoa não exporta a conversa dela); editar papel tirando `inbox:reply`
  devolve à fila. `channels-events.test.ts`: prazo de `CHANNEL_EVENT_RETENTION_DAYS`. `lgpd-export.test.ts`: o zip
  ganhou `conversas-whatsapp.json`.

## Limites conhecidos (todas as fases)

Reunidos aqui; o detalhe de cada um está na seção da fase.

| Fase | Limite |
|---|---|
| C1 | Se enfileirar `inbox.media` falhar depois do commit, a mensagem fica `pending` até "Tentar de novo" (sem varredura de mídia `pending`) |
| C2 | Provedor que responde depois de 2 min, com o atendente já tendo usado "Reenviar" na `UNKNOWN_RESULT`: o contato recebe duas vezes |
| C2 | Status de entrega que chega antes de gravarmos o `provider_message_id` fica `ignored` (a mensagem para em `sent`) |
| C3 | A releitura de lista e mensagens (`useInfiniteQuery`) relê todas as páginas já carregadas |
| C4 | Sessão revogada, papel trocado ou membro removido seguem recebendo **ids** no SSE por até 15 min (a releitura já barra); teto de 3 fluxos é por processo; evento perdido na queda só volta pela releitura; aviso sem `a` custa um `SELECT` |
| C5 | Imagem de 5 a 16 MB passa no nosso limite e a Meta recusa (`failed` com o motivo); o token de `media-out` não é de uso único (5 min) e fica na URL/log da Evolution; B0 simulada (nada contra Meta ou Evolution reais) |
| C6 | Não há papel de plataforma só de leitura (a distinção `read`/`reply` está pronta em `platformCapabilities`) |
| C7 | Editar papel devolve à fila **depois** da gravação do Better Auth (fora da transação): falha aqui vai ao log e deixa o dono até a próxima mudança |
| C7 | Excluir a organização não remove os **canais** (credenciais cifradas e a instância Evolution ou o número na Meta continuam; os avisos novos são `ignored` e saem pela retenção). Desconectar no provedor é ação do owner antes de excluir |
| C7 | Depois de excluído o cliente, o `channel_event` que trouxe as mensagens dele ainda guarda o `raw` (telefone e texto) até o fim da retenção (padrão 30 dias). O `/admin` só reprocessa aviso `failed` ou `ignored`, então o que já foi gravado não volta; um aviso falho do mesmo número reprocessado depois recria o contato, como uma mensagem nova |
| C7 | Exportação limitada às 20.000 mensagens mais recentes; o zip é montado em memória |
| C7 | **Fechado na pré-produção (T1):** o vínculo automático só usa telefone confirmado. Texto original: O vínculo com `customer` (e o com `user`) nasce do telefone, que não é verificado: a pessoa do portal que troca o próprio telefone para o de alguém que ainda não escreveu ao tenant recebe na exportação (e apaga na exclusão da conta) a conversa dessa pessoa. A conversa de usuário excluído fica na plataforma, sem vínculo |
| C7 | Backup anterior à exclusão ainda contém as conversas: restaurar exige reaplicar as exclusões (`tech/14-deploy.md`) |

## Desvios da SPEC (C7)

- A exclusão de `user` desfaz o vínculo em **todos** os escopos (como a SPEC), e o zip da equipe não traz conversas. A primeira
  versão da C7 apagava o contato da plataforma e exportava as conversas pelo vínculo com `user`; o `/security-review` mostrou que
  esse vínculo vem de telefone declarado, sem verificação (seção "Por que o vínculo com `user` não decide nada"). Consequência:
  a conversa da plataforma com um usuário excluído fica, sem vínculo (o telefone e as mensagens continuam, como dado da
  plataforma). **Decisão pendente do proprietário:** prazo de retenção ou exclusão manual dessas conversas.
- `file.created_by` dos anexos enviados pela pessoa excluída também é zerado (a SPEC só falava das mensagens).
- A exclusão da organização apaga também os `channel_event` do tenant e a mídia `inbound/` deles (a SPEC só falava das
  conversas e dos objetos). Os canais ficam (limite acima).
- A retenção de `channel_event` (30 dias) já existia desde os canais; a C7 só a tornou configurável
  (`CHANNEL_EVENT_RETENTION_DAYS`). Conversas encerradas não têm prazo: a SPEC e o PRD não definem (decisão pendente do
  proprietário).
- `deleteCustomer` passou a travar o cliente (`FOR UPDATE`) antes de apagar as conversas, na mesma transação.

## Desvios da SPEC (C6)

- `GET /api/admin/inbox/conversations` não tem `tab` (a SPEC dizia "só existe a lista", mas o serviço do tenant pedia `supervise` para
  `tab = all`): a rota fixa `tab = all` e `listConversations` só pede `supervise` no tenant.
- `GET /api/admin/inbox/unread` devolve o mesmo `{ queue, mine }` do tenant (`mine` sempre 0): a tela soma os dois para o ponto.
- `selectConversationRows` passou a receber o escopo e deixa de juntar `customer` na plataforma (a SPEC pedia só "nenhuma consulta a
  `customer`"; a junção era uma consulta, vazia pelo RLS, e agora nem existe).
- `marcar como lida` na plataforma exige papel que responde (`canReply`), como no tenant (zera o contador de todos).
- Vínculo manual na plataforma escolhe o usuário na busca de `/api/admin/users` (não há `candidates`); aceita qualquer usuário não banido,
  não só quem tem o mesmo telefone.
- `GET /api/admin/users` ganhou `phoneKind` por usuário (só o tipo, como `/api/team`), para o "Conversar".
- Não existe papel de plataforma "só de leitura" hoje (`PLATFORM_ROLES` = `user`, `platform_owner`, `platform_support`): a distinção
  `read` × `reply` está em `platformCapabilities` e no teste unitário, pronta para um papel futuro.

## Desvios da SPEC (C5)

- `GET /api/inbox/conversations/:id/templates` (nova, `inbox:reply`): a SPEC pede o `template-dialog` com a lista de
  aprovados, mas não a rota; a de canais (`/api/channels/:id/templates`) exige permissão de canal, que o atendente não tem.
- `variables` do modelo é uma **lista na ordem dos slots** (cabeçalho, depois corpo), não um objeto; o servidor devolve os
  `slots` e confere a contagem.
- O texto preenchido do modelo fica em `message.text` (e na prévia da conversa), não duplicado em `payload`; o `payload`
  guarda `id`, nome, idioma, variáveis e os `components` do envio (usados no reenvio).
- Rota `media-out` criada: a B0 (simulada) não mediu base64 no `/send/media`. Registrado em "Anexo de saída".
- Modelos com cabeçalho de mídia, botão com variável e demais recursos aparecem **desabilitados** (a SPEC só diz
  "variáveis validadas contra `components`").
- Anexo tem limite próprio de 20/min por pessoa, além dos 60/min de envio, e respeita a cota `storage_mb` do plano.
- Teto de 16 MB único para imagem, vídeo, áudio e documento; a Meta limita a imagem a 5 MB: acima disso o provedor recusa e
  a mensagem fica `failed` com o motivo dele.
- "Conversar" no detalhe do cliente deixou de esconder fixo e celular de 8 dígitos: mostra o botão com a explicação, e o
  servidor decide (a exceção do contato que já escreveu).

## Desvios da SPEC (C4)

- A carga ganhou `u` (quem fez a mudança, só id): sem ele, quem assume a própria conversa (`a = eu`,
  `p = null`) receberia o toast "atribuída a você", que a SPEC reserva à atribuição feita por outra pessoa.
- `a` vira obrigatório na prática: quem grava sem saber o dono (status, varredura, mídia) tem o dono lido na
  mesma transação; aviso sem dono conhecido só chega a quem supervisiona (a SPEC não dizia).
- O SSE recusa a 4ª conexão (429) em vez de derrubar uma antiga, e o teto é por processo.
- O `useInboxEvents` é montado no layout do `/app` (não só na tela do atendimento), para o ponto de não lidas
  do menu andar pelos eventos em qualquer tela; uma conexão por aba.
- `docker/caddy/Caddyfile`: o caminho do SSE sai do `encode` (a SPEC só pedia "sem buffer").

## Desvios da SPEC (C3)

- Polling de 20 s no lugar de SSE (entregue na C4).
- Sem "Enviar modelo", anexo nem citação (entregues na C5).
- "Conversar" esconde fixo e celular de 8 dígitos com a explicação; a exceção da SPEC (cliente salvo a partir
  de um contato que já escreveu) não aparece no botão, porque o cliente não diz se o contato existe. O servidor
  continua decidindo: pelo diálogo "Nova conversa" com telefone, o número que já escreveu vale.
- `GET /api/team` ganhou `phoneKind` (única mudança de API da C3, fora de `src/lib/inbox/`).
- `INVALID_PHONE` em "Salvar como cliente" aparece como erro do formulário, sem campo de telefone para corrigir:
  `saveContactAsCustomerSchema` não tinha `phone` (**resolvido na C5**: `phone` opcional e campo no formulário).

## Desvios da SPEC (C2)

- Personificação responde `IMPERSONATION_BLOCKED` (código do projeto), não `IMPERSONATION_READ_ONLY`.
- E-mail repetido no "salvar como cliente" é `CUSTOMER_EMAIL_TAKEN` (o código de `crm-cadastro`), não
  `CUSTOMER_EMAIL_IN_USE`.
- O envio aceita só `type: "text"`; modelo e anexo (`multipart`) entram na C5 com o contrato da SPEC.
- `POST /conversations/:id/assign` usa `inbox:read` na rota e decide `reply`/`assign` no serviço.
- Iniciar conversa dá o dono a quem iniciou (a SPEC não dizia; sem isso a conversa iria para a fila).
- Contato vinculado a cliente aparece sem nome, etiquetas nem campos para quem não tem `customer:read`.
