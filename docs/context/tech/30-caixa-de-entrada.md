# Caixa de entrada (chat e fila de atendimento)

- **Escopo:** conversas de WhatsApp do tenant e da plataforma: contatos (`chat_contact`), conversas,
  mensagens, ingestão dos avisos de canal e mídia recebida. A configuração dos números é de
  `tech/29-canais-whatsapp.md`.
- **Specs relacionadas:** `docs/specs/caixa-de-entrada/spec.md` e `prd.md`; programa em
  `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T6, T10, T11, T13)
- **Paths do código:** `src/db/schema/inbox.ts`, `src/lib/inbox/` (`constants.ts`, `contacts.ts`,
  `ingest.ts`, `media.ts`, `notify.ts`, `channel-usage.ts`), `src/jobs/inbox.ts`,
  `drizzle/0032_caixa_de_entrada.sql`, `drizzle/0033_rls_caixa_de_entrada.sql`,
  `tests/db/inbox-ingest.test.ts`, `tests/db/rls.test.ts` (bloco da caixa de entrada),
  `src/lib/channels/providers/*/inbox.db.test.ts`

## Estado

| Fase | Entrega | Estado |
|---|---|---|
| C1 | Dados e ingestão (mensagens, status, eco, LID, mídia de entrada) | **Feita** |
| C2 | API: leitura paginada, fila, assumir, transferir, envio de texto, janela de 24 h, visibilidade | Pendente |
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
- Só `src/lib/inbox/` consulta estas tabelas (regra de visibilidade, T13). A C2 acrescenta
  `visibility.ts`, usado por toda leitura e escrita de rota.

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

**Pendente para quem servir a mídia (C2):** o `file.mime` da mídia da Evolution é o declarado pelo
remetente, filtrado por `safeMime` (sem HTML/SVG/script), mas não conferido pelo conteúdo. A rota
`GET /api/inbox/messages/:id/media` deve conferir os primeiros bytes antes de servir `inline`
(`nosniff` e `attachment` para o resto, como a SPEC manda).

## Segurança e privacidade

- Conteúdo de mensagem, telefone e nome nunca vão a `logError`, `audit_log` ou Sentry; o erro do
  `channel_event` continua passando por `sanitizeChannelError`.
- `tenant_id` sempre do `Scope`, nunca do aviso. O LID de um tenant não acha contato de outro.
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
