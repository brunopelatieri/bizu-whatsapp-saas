# SPEC: Canais WhatsApp (Cloud API e Evolution Go)

- **Status:** rascunho
- **PRD:** `docs/specs/whatsapp-canais/prd.md`
- **Programa:** `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T3, T8 a T10, T12, T14)
- **Contexto carregado:** `core.md`, `tech/06-hono-api.md`, `tech/07-banco-drizzle.md`,
  `tech/20-jobs.md`, `tech/23-billing-planos.md`, `tech/24-billing-cobranca.md` (caixa de
  entrada de webhooks), `tech/26-seguranca.md`, `src/api/webhooks-payments.ts`,
  `src/lib/payments/registry.ts`, `src/lib/crypto/secrets.ts`, `src/lib/tenant/credentials.ts`
- **Origem conferida:** tabelas `channels`, `whatsapp_config`, `evolution_instances`,
  `evolution_instance_secrets` e `message_templates` do banco do `zap-crm-br-client`;
  `src/lib/channels/`, `src/lib/whatsapp/`, `src/lib/evolution/` e as SPECs 048, 049 e 064 de lá.

## Onde entra

- [x] API Hono: `src/api/channels.ts`, `src/api/webhooks-channels.ts`, `src/api/admin.ts`
- [x] Jobs: `src/jobs/channels.ts` (filas `channel.inbound` e `channel.health`)
- [x] Área client-only: `/app/configuracoes/canais`, `/admin/configuracoes/canais`,
  `/admin/webhooks` (aba nova)
- [ ] Pública com SSR: nada

## O que muda em relação à origem

| Na origem | Aqui | Motivo |
|---|---|---|
| Um endereço de webhook da Meta para todas as contas; a verificação varre todos os tokens | Endereço por canal, com chave aleatória no caminho | Cada owner tem o próprio aplicativo da Meta. A rota sabe de quem é o aviso antes de ler o corpo |
| Segredo do aplicativo opcional, com reserva em variável de ambiente | Segredo do aplicativo **obrigatório** por canal | Em multi-tenant, um segredo comum deixaria um tenant forjar aviso de outro. Sem segredo, a falha é fechada |
| Aviso processado em `after()`, depois do 200 | Gravado em `channel_event` e aplicado por job, com retry e fila morta | Reinício do processo perdia mensagem |
| Sem deduplicação na Cloud API | Única `(channel_id, dedupe_key)` no aviso e `(channel_id, provider_message_id)` na mensagem | A Meta reentrega |
| Tradução do aviso dentro da rota | `normalizeEvents()` no módulo do provedor | A rota não conhece formato de provedor |
| Criação em duas escritas com compensação manual | Uma transação; a chamada externa vem antes ou é desfeita | Drizzle tem transação |
| Envio por QR Code não confere o estado do canal | 409 `CHANNEL_NOT_CONNECTED` antes de chamar o provedor | Erro claro em vez de falha do provedor |
| Token, segredo e canais lidos por RLS de qualquer membro | Colunas cifradas nunca saem do servidor | Regra do projeto |

## Modelo de dados (Drizzle)

Arquivo `src/db/schema/channels.ts`. Todas com `scopedPolicy()` + `FORCE` (plano, T1 e T2).

| Tabela | Colunas principais | Observações |
|---|---|---|
| `channel` | `id`, `tenant_id` (nulo = plataforma), `type` (`whatsapp_cloud` \| `whatsapp_qr`), `name` (1 a 60), `identifier` (telefone exibido), `status` (`disconnected` \| `connecting` \| `connected` \| `error` \| `disabled`), `status_detail`, `is_default`, `connected_at`, `last_seen_at`, `created_by` → `user` `set null`, `created_at`, `updated_at` | Um padrão por escopo e tipo: único parcial `(tenant_id, type) WHERE is_default` e o par para `tenant_id IS NULL`. Índice `(tenant_id, type)` |
| `channel_whatsapp_cloud` | `channel_id` PK → `channel` `cascade`, `tenant_id`, `phone_number_id` (**único global**), `waba_id`, `app_id`, `access_token_enc`, `app_secret_enc`, `verify_token_enc`, `key_version`, `webhook_key` (única, 32 hex), `webhook_verified_at`, `display_phone`, `verified_name`, `quality_rating`, `registered_at`, `subscribed_at`, `last_error`, `updated_at` | 1:1 com o canal. Os três `_enc` ficam `NULL` quando o canal é desativado |
| `channel_evolution` | `channel_id` PK → `channel` `cascade`, `tenant_id`, `remote_instance_id`, `remote_instance_name` (**único global**), `instance_token_enc`, `webhook_secret_enc`, `webhook_secret_hash` (único, sha256), `key_version`, `connected_phone`, `connected_jid`, `advanced_settings` jsonb, `last_qr_at`, `last_error`, `updated_at` | 1:1 com o canal. O QR nunca é gravado |
| `channel_event` | `id`, `tenant_id`, `channel_id` → `channel` `cascade`, `provider`, `dedupe_key`, `kind` (`message` \| `status` \| `connection` \| `template` \| `other`), `status` (`pending` \| `processed` \| `ignored` \| `failed`), `raw` jsonb, `attempts`, `error`, `received_at`, `processed_at` | Único `(channel_id, dedupe_key)`. Índice parcial em `status = 'pending'`. Sai no `maintenance.prune` depois de 30 dias |
| `message_template` | `id`, `tenant_id`, `waba_id`, `name`, `language`, `category`, `status` (valor da Meta), `components` jsonb, `provider_template_id`, `synced_at` | Único por escopo em `(waba_id, name, language)`. Só leitura: a fonte é a Meta |

- **Aviso recusado não vira linha.** Assinatura inválida só incrementa o limite por IP e gera
  log, como hoje nos pagamentos depois do limite.
- **`raw` nunca guarda mídia em base64.** Na Evolution, o conteúdo sai para o `StorageProvider`
  antes da gravação e o `raw` fica com a referência (seção "Mídia no aviso da Evolution").
- **Migration:** `src/db/schema/channels.ts` + `npm run db:generate`, mais a customizada com
  `FORCE`. Aditiva; sem backfill.
- **Limites do plano:** `plan.limits` ganha `channels_whatsapp_cloud` e `channels_whatsapp_qr`.
  A convenção não muda (ausente ou `null` = ilimitado), então o seed e a tela `/admin/planos`
  passam a preencher os dois: `free` 0 e 1, `basic` 1 e 1, `pro` 3 e 3 (PRD, pergunta aberta).
  Canal `disabled` não conta.

## Módulos de canal

```text
src/lib/channels/
|-- types.ts            ChannelProvider, capacidades, eventos normalizados
|-- registry.ts         lê CHANNEL_PROVIDERS; mesma descoberta de payments/registry.ts
|-- capabilities.ts     can(type, capacidade)
|-- service.ts          CRUD comum, padrão por tipo, remoção, limites (recebe Scope)
|-- credentials.ts      cifra e leitura dos segredos; maskSecret
|-- events.ts           receiveEvent, enqueue, reprocess
|-- errors.ts           ChannelNotConfiguredError, ChannelCapabilityError, ProviderError
`-- providers/
    |-- whatsapp_cloud/ index.ts, graph.ts, webhook.ts, normalize.ts, templates.ts, README.md
    `-- whatsapp_qr/    index.ts, client.ts, instances.ts, webhook.ts, normalize.ts, README.md
```

```ts
export interface ChannelProvider {
  type: ChannelType;
  capabilities: ChannelCapabilities;
  /** Confere quem mandou, sobre o corpo cru. Nunca lança por assinatura errada. */
  verifyWebhook(ctx: WebhookContext): Promise<{ ok: true; dedupeKey: string } | { ok: false; reason: string }>;
  /** Formato do provedor → eventos comuns. Função pura, testada com fixtures reais. */
  normalizeEvents(raw: unknown): NormalizedEvent[];
  sendText(ctx: ChannelContext, input: SendText): Promise<SendResult>;
  sendMedia(ctx: ChannelContext, input: SendMedia): Promise<SendResult>;
  sendTemplate?(ctx: ChannelContext, input: SendTemplate): Promise<SendResult>;
  fetchMedia?(ctx: ChannelContext, providerMediaId: string): Promise<{ body: Buffer; mime: string }>;
  /** Estado real no provedor; a camada comum grava em `channel.status`. */
  probe(ctx: ChannelContext): Promise<ProbeResult>;
}
```

| Capacidade | `whatsapp_cloud` | `whatsapp_qr` |
|---|---|---|
| `templates` | sim | não |
| `sessionWindow24h` | sim | não |
| `deliveryFailure` (status `failed` por aviso) | sim | não |
| `deviceEcho` (mensagem enviada pelo celular) | não | sim |
| `pairing` (QR e código) | não | sim |

O código pergunta à capacidade, nunca ao tipo. `NormalizedEvent` é
`message | status | connection | template`; a mensagem normalizada leva `fromPhone`,
`fromExternalId` (LID), `pushName`, `providerMessageId`, `fromMe`, `type`, `text`, `media`,
`replyToProviderMessageId` e `occurredAt` (hora do provedor). Quem os aplica é a caixa de
entrada (`docs/specs/caixa-de-entrada/spec.md`); até ela existir, `message` e `status` ficam
`ignored`.

### WhatsApp Cloud (`providers/whatsapp_cloud/`)

- `graph.ts`: `GRAPH_VERSION` em um lugar só (a origem usa `v21.0`; **conferir a vigente na
  fase B0**), base `https://graph.facebook.com`, timeout de 15 s, `MetaApiError(status, code)`
  com o texto `(#code) título: mensagem`.
- Chamadas: `verifyPhoneNumber` (`id`, `display_phone_number`, `verified_name`,
  `quality_rating`), `registerPhoneNumber` (só com PIN; "já registrado" é sucesso),
  `subscribeWabaToApp`, `getSubscribedApps`, `sendText`, `sendMedia`, `sendTemplate`,
  `uploadMedia` (`POST /{phone_number_id}/media`, para anexos de saída), `getMediaUrl` e
  `downloadMedia`, `listTemplates`.
- **Salvar um número:** valida o formato → `verifyPhoneNumber` (falha 4xx da Meta vira 400
  `META_REJECTED` com a mensagem dela; nada é gravado) → `subscribeWabaToApp` → transação:
  `channel` + `channel_whatsapp_cloud`, com `webhook_key` e token de verificação gerados no
  servidor. `phone_number_id` já usado, em qualquer escopo, é 409 `PHONE_NUMBER_IN_USE`, sem
  dizer por quem.
- **Editar:** `access_token`, `app_secret` e `pin` ausentes ou vazios **mantêm** o que está
  gravado. O token de verificação e a `webhook_key` não mudam (há "Gerar novo endereço", que
  troca os dois e avisa que a Meta precisa ser reconfigurada).
- **Diagnóstico** (`POST .../test`): `credentials_readable`, `token_valid`, `phone_reachable`,
  `waba_subscribed`, `webhook_verified` (se `webhook_verified_at` existe) e `last_event_at`.
  Erro 4xx da Meta marca o canal `error`; 5xx, 429 e timeout não mudam o estado.
- **Modelos:** `POST .../templates/sync` lê `listTemplates` do WABA e faz upsert; o que sumiu
  na Meta é apagado aqui. Modelo é do WABA, não do canal: dois números do mesmo WABA veem os
  mesmos.

### Evolution Go (`providers/whatsapp_qr/`)

Tudo o que segue foi medido na origem contra um servidor real e **diverge da documentação do
Evolution Go**. A fase B0 mede de novo e guarda as respostas como fixtures.

- `client.ts`: `evolutionRequest(path, { method, key, body, timeoutMs })`, header `apikey`.
  Chave global só em `/instance/create`, `/instance/delete` e `/instance/all`; o resto usa o
  token da instância (mapa explícito por endpoint). Erro pode vir como texto plano. Resposta
  embrulhada em `data` ou não: `unwrap`.
- **Criar:** confere limites (teto do servidor antes do limite do plano) → nome
  `<prefixo>_<8 hex do escopo>_<slug até 24>_<4 hex>` → token = `randomUUID()` (obrigatório
  no `create`) → `POST /instance/create { name, token }` → transação com `channel`
  (`connecting`) e `channel_evolution` (token e segredo de webhook cifrados; hash do segredo).
  Falha na transação apaga a instância no servidor.
- **Conectar:** `POST /instance/connect { immediate: true, subscribe: [MESSAGE, SEND_MESSAGE,
  READ_RECEIPT, CONNECTION, QRCODE], webhookUrl }`; `GET /instance/qr` devolve `qrcode` (data
  URI) e `code`. O QR custa cerca de 3 s e vale 60 s: a tela não o busca em laço curto.
  "Já conectado" não é erro.
- **Código de pareamento:** `POST /instance/pair { phone }` → `pairingCode`.
- **Ciclo de vida:** `GET /instance/status`, `POST /instance/disconnect`,
  `DELETE /instance/logout`, reconectar, `DELETE` da instância.
- **Mesmo número, canal novo:** se o telefone que conectou já teve um canal por QR Code no
  escopo, o canal antigo é readotado, para o histórico não se partir.
- **Envio:** `POST /send/text { number, text, quoted? }`, `POST /send/media { number, url, type,
  caption?, filename? }`. O id da mensagem vem em `Info.ID`. 401 ou 403 marca o canal `error`.
- **Aviso:** nome do evento normalizado (sem `_`, sem espaço, maiúsculas); `Info.ID`;
  `Info.Chat` como JID, sem o sufixo `:NN`; `state` do recibo no envelope; mídia em base64
  como irmã do proto; URL `*.whatsapp.net` é cifrada e não serve.

## Webhooks

Rotas em `src/api/webhooks-channels.ts`, fora de `sameOrigin` e do CSRF, como
`/api/webhooks/payments/*`. Sempre o corpo cru.

| Método e rota | Verificação | Resposta |
|---|---|---|
| `GET /api/webhooks/whatsapp/cloud/:webhookKey` | `hub.mode = subscribe` e `hub.verify_token` igual ao do canal, em tempo constante | 200 com `hub.challenge` em `text/plain`, e grava `webhook_verified_at`; senão 403. Chave desconhecida e token errado respondem igual |
| `POST /api/webhooks/whatsapp/cloud/:webhookKey` | `X-Hub-Signature-256` = HMAC-SHA256 do corpo cru com o `app_secret` **daquele canal** | 200 `{ received: true }`; 401 sem assinatura válida; 413 acima de 3 MB |
| `POST /api/webhooks/whatsapp/evolution/:secret` | Cadeia: sha256 do `secret` acha a instância; `instanceId` do corpo = `remote_instance_id`; `instanceToken` do corpo = token decifrado, em tempo constante | 200; 401 sem detalhe em qualquer falha; 413 acima de 25 MB |

Fluxo comum, o mesmo de `webhooks-payments.ts`:

1. Acha o canal pela chave do caminho (`withPlatformScope("webhook de canal")`, só a linha de
   configuração). Canal `disabled` responde 200 e descarta.
2. `provider.verifyWebhook`. Falha → 401, conta no limite por IP (20 por minuto) e para.
3. `receiveEvent`: insere `channel_event` `pending`; conflito na única = repetido, responde 200
   sem enfileirar de novo o que já foi tratado.
4. Enfileira `channel.inbound` com o id do evento e responde 200.

**Roteamento na Cloud API:** um aplicativo da Meta tem um endereço para todos os números
assinados nele. O aviso que chega na chave do canal A pode trazer mudança do número B. O job
resolve cada `change` por `metadata.phone_number_id` **somente entre os canais do mesmo escopo
do canal A**, cuja assinatura acabou de ser conferida. Número de outro escopo é descartado com
log. `dedupe_key` = sha256 do corpo cru.

**Deduplicação na Evolution:** `dedupe_key` = tipo do evento + `Info.ID` (mensagem), ou + ids
do recibo + estado, ou sha256 do corpo (conexão).

**Mídia no aviso da Evolution:** antes do passo 3, o base64 é gravado no `StorageProvider` sob
`inbound/<chave aleatória>` e trocado no `raw` por `{ storageKey, mime, size }`. Evento que
termina `ignored` ou `failed` definitivo apaga o objeto.

## Jobs

| Fila | Gatilho | Retry | Observação |
|---|---|---|---|
| `channel.inbound` | webhooks | 5x, backoff de 30 s a 1 h | `exclusive`, `singletonKey = channel_event.id`; fila morta `channel.inbound.dead` (14 dias). Chama `provider.normalizeEvents` e entrega cada evento a `applyChannelEvent(scope, channel, event)` dentro de `withScope` |
| `channel.health` | cron a cada 15 min | 1x | `probe` de cada canal não `disabled`; grava `status`, `status_detail` e `last_seen_at`; avisa os owners por e-mail (`channel-disconnected`) na passagem de `connected` para `error` ou `disconnected`, uma vez por queda. Devolve à fila eventos `pending` há mais de 10 min |

`applyChannelEvent` trata aqui `connection` (estado do canal, telefone conectado, readoção) e
`template` (status do modelo). `message` e `status` são da caixa de entrada. Handlers
idempotentes; na última tentativa o evento vira `failed` com `sanitizeError`.
`maintenance.prune` apaga `channel_event` tratado há mais de 30 dias.

## Contratos

Schemas em `src/lib/schemas/channels.ts`. Rotas de tenant: `requireAuth` + `requireTenant` +
`requirePermission`. Toda escrita com `blockMutationsWhileImpersonating` e auditoria.

| Método e rota | Entrada | Saída | Autorização |
|---|---|---|---|
| `GET /api/channels` | – | `{ channels: [ChannelView], providers: { whatsapp_cloud, whatsapp_qr }, limits }` | `channel:read` |
| `POST /api/channels/whatsapp-cloud` | `{ name, phoneNumberId, wabaId, accessToken, appSecret, appId?, pin? }` | 201 `{ channel, webhook: { url, verifyToken } }`; 400 `META_REJECTED`; 403 `PLAN_LIMIT_REACHED`; 409 `PHONE_NUMBER_IN_USE` | `channel:manage` |
| `PATCH /api/channels/:id` | `{ name?, wabaId?, accessToken?, appSecret?, appId?, pin?, advancedSettings? }` conforme o tipo | `{ channel }` | `channel:manage` |
| `GET /api/channels/:id/webhook` | – | `{ url, verifyToken }` (só Cloud) | `channel:manage` |
| `POST /api/channels/:id/webhook/rotate` | – | `{ url, verifyToken }` novos | `channel:manage` |
| `POST /api/channels/:id/test` | – | `{ checks: [{ id, ok, detail? }], status }` | `channel:manage` |
| `POST /api/channels/:id/default` | – | `{ ok }`; 409 `CHANNEL_DISABLED` | `channel:manage` |
| `DELETE /api/channels/:id` | `{ confirm: name }` | `{ outcome: "deleted" \| "disabled" }`; 400 `CONFIRMATION_MISMATCH` | `channel:manage` |
| `POST /api/channels/whatsapp-qr` | `{ name }` | 201 `{ channel }`; 403 `PLAN_LIMIT_REACHED`; 409 `SERVER_LIMIT_REACHED`; 503 `PROVIDER_UNAVAILABLE` | `channel:manage` |
| `POST /api/channels/:id/qr` | – | `{ qrcode, expiresInSeconds }` ou `{ alreadyConnected: true }`; `Cache-Control: no-store`; 15 por minuto | `channel:manage` |
| `POST /api/channels/:id/pair` | `{ phone }` (normalizado) | `{ pairingCode }` | `channel:manage` |
| `GET /api/channels/:id/status` | – | `{ status, statusDetail, identifier, lastSeenAt }`; 30 por minuto | `channel:read` |
| `POST /api/channels/:id/disconnect`, `/logout`, `/reconnect` | – | `{ channel }` | `channel:manage` |
| `GET /api/channels/:id/templates` | `status?` | `{ templates, syncedAt }` | `channel:read` |
| `POST /api/channels/:id/templates/sync` | – | `{ synced, removed }`; 5 por minuto | `channel:manage` |

- `ChannelView`: `id`, `type`, `name`, `identifier`, `status`, `statusDetail`, `isDefault`,
  `connectedAt`, `lastSeenAt`, `hasConversations` e, por tipo, dados não secretos
  (`phoneNumberId`, `wabaId`, `appId`, `verifiedName`, `qualityRating`,
  `accessTokenHint`; ou `connectedPhone`). **Nenhuma coluna `_enc` sai.**
- `providers` diz quais módulos estão ativos; sem `EVOLUTION_API_URL`, `whatsapp_qr` vem
  `{ enabled: false }` e a tela esconde a opção.
- `POST .../default` e a eleição automática do padrão rodam em uma transação que trava os
  canais daquele escopo e tipo (`FOR UPDATE`). O primeiro canal ativo de um tipo vira padrão;
  desativar o padrão elege o conectado mais antigo.
- **Remoção:** sem conversas, apaga o canal (na Evolution, apaga antes a instância). Com
  conversas, `status = disabled`, colunas `_enc` nulas, `is_default = false`; a FK da conversa
  é `restrict`. Readicionar o mesmo `phone_number_id` no mesmo escopo readota o canal.
- **Limite:** `assertWithinLimit(tenantId, "channels_<tipo>")` na mesma transação da criação,
  com `pg_advisory_xact_lock` por escopo e tipo.
- Tenant em `read_only` não cria nem altera canal (regra geral de `requireTenant`); os webhooks
  continuam recebendo. Organização suspensa ou em exclusão: os eventos são `ignored`.

**Plataforma:** as mesmas rotas sob `/api/admin/channels/*`, com `Scope = platform`. Leitura
para a plataforma; escrita com `requirePlatform(["platform_owner"])`. Somam-se
`GET /api/admin/channel-events?status&page` (sem `raw`) e
`POST /api/admin/channel-events/:id/reprocess` (só `failed` ou `ignored`), de todos os escopos.

## Permissões

```ts
channel: ["read", "manage"],
```

owner e admin: as duas. member: `read`. `channel:manage` é atribuível a papel personalizado.

## Variáveis de ambiente

Em `src/lib/env.ts` e `.env.example`:

| Variável | Padrão | Uso |
|---|---|---|
| `CHANNEL_PROVIDERS` | vazio | Lista de módulos ativos: `whatsapp_cloud,whatsapp_qr` |
| `EVOLUTION_API_URL`, `EVOLUTION_GLOBAL_API_KEY` | – | Obrigatórias com `whatsapp_qr` na lista; a chave começa com `change-me` no exemplo |
| `EVOLUTION_WEBHOOK_PUBLIC_URL` | `APP_URL` | Endereço que o servidor Evolution alcança |
| `EVOLUTION_INSTANCE_PREFIX` | `bizu` | Prefixo do nome da instância |
| `EVOLUTION_MAX_INSTANCES_TOTAL` | `20` | Teto do servidor, somando todos os escopos |
| `EVOLUTION_REQUEST_TIMEOUT_MS`, `EVOLUTION_MEDIA_TIMEOUT_MS` | `15000`, `60000` | Timeouts |

A Cloud API não tem variável: as credenciais são de cada canal.

## Interface

| Rota | Arquivo | O que tem |
|---|---|---|
| `/app/configuracoes/canais` | `routes/app.settings.channels.tsx`, `components/channels/*` | Lista de números com estado, tipo e padrão; "Conectar número" abre a escolha do tipo |
| diálogo Cloud | `components/channels/cloud-channel-dialog.tsx` | Passo a passo em 4 etapas (criar o app, adicionar o produto WhatsApp, copiar as credenciais, configurar o webhook assinando `messages`); formulário; cartão com endereço e token para copiar; "Diagnosticar" |
| diálogo QR | `components/channels/qr-channel-dialog.tsx` | Aviso de risco permanente; nome; abas "QR Code" (imagem, contagem de 60 s, "Gerar outro") e "Código" (telefone → código); consulta o estado a cada 4 s e fecha ao conectar |
| `/admin/configuracoes/canais` | `routes/admin/channels.tsx` | Os mesmos componentes; sem Evolution configurada, mostra quais variáveis faltam |
| `/admin/webhooks` | `pages/admin/webhooks-page.tsx` | Aba "Canais": eventos com falha e "Reprocessar" |
| `/admin/planos/:id` | `plan-detail-page.tsx` | Dois campos de limite novos |

- `channel-badge.tsx` (ícone do tipo + nome) e `channel-status.tsx` ficam em
  `src/components/channels/`, reaproveitados pelo atendimento.
- O QR usa `qrcode.react`, já instalado, quando o servidor devolver o texto do código; se vier
  só a imagem em data URI, a CSP precisa de `img-src data:` nessa tela (conferir em B0).
- **Estados:** carregando, vazio ("Nenhum número conectado"), erro e sucesso por `QueryState`.
  No limite do plano, o botão fica desabilitado com o motivo.
- **Navegação:** títulos em `app-nav.ts` e `admin-nav.ts`; link dentro de Configurações.

## Segurança

- **Segredos:** `encryptSecret(valor, "channel:<id>:<campo>")`; `rotateCredentials()` passa a
  cobrir as duas tabelas. Decifrar só em `credentials.ts`, para uso do servidor.
- **Falha fechada:** sem `app_secret` não há canal Cloud; sem assinatura válida, 401. O corpo só
  é lido como JSON depois da verificação.
- **Isolamento do aviso:** a chave do caminho define o escopo; o roteamento por
  `phone_number_id` nunca sai dele. Teste: aviso assinado pelo tenant A citando número do
  tenant B não toca em B.
- **SSRF:** nenhuma URL vem do tenant. Graph API com host fixo; Evolution por variável.
- **Enumeração:** `PHONE_NUMBER_IN_USE` não diz de quem; chave de webhook desconhecida responde
  como token errado.
- **O token da instância que a Evolution devolve em `/instance/info` nunca é repassado.**
- **Log:** `logError` sem corpo de aviso, sem telefone, sem token. O redator do pino já cobre
  `token`, `secret` e `phone`.
- **Limites de taxa:** criar instância 10 por minuto, QR 15, demais ações 30, por usuário, no
  store configurado (`RATE_LIMIT_STORE`).
- **Auditoria:** `channel.created`, `channel.updated`, `channel.connected`,
  `channel.disconnected`, `channel.disabled`, `channel.deleted`, `channel.default_changed`,
  `channel.webhook_rotated`; `metadata` com `type` e `channelId`.
- `/security-review` obrigatório em B1 e B2.

## Plano de implementação

1. **B0, medição:** contra o servidor Evolution e uma conta de teste da Meta: criar, conectar,
   QR, parear, status, enviar texto e mídia, receber cada tipo de aviso. Saída:
   `tests/fixtures/channels/{cloud,evolution}/*.json` anonimizadas e as divergências anotadas
   nos `README.md` dos módulos → revisão humana das fixtures.
2. **B1, dados:** schema, migrations, limites no seed e em `/admin/planos` → `rls.test.ts`.
3. **B1, núcleo:** `types.ts`, `registry.ts`, `credentials.ts`, `service.ts`, `events.ts`, filas
   e `maintenance.prune` → testes de cifra (cópia entre linhas não decifra), do registro (id
   desconhecido é erro de configuração) e da fila (`billing-queue.test.ts` como modelo).
4. **B1, rotas comuns e permissões** (listar, renomear, padrão, remover) → matriz RBAC; id de
   outro tenant 404; resposta sem `_enc`.
5. **B2, Cloud (servidor):** `graph.ts` com `fetch` simulado, salvar, editar, diagnóstico,
   webhook GET e POST, normalização, modelos → testes com as fixtures: assinatura adulterada
   401; repetido não duplica; roteamento entre escopos; `app_secret` ausente no `PATCH` mantém.
6. **B2, Cloud (tela)** → smoke com conta de teste da Meta.
7. **B3, Evolution (servidor):** cliente, instâncias, webhook, normalização, saúde → testes com
   as fixtures: cadeia de verificação; evento de conexão muda o estado; base64 vai ao
   armazenamento; limite do servidor antes do plano.
8. **B3, Evolution (tela)** → smoke com o servidor real: QR, código, desconectar no celular.
9. **B4, plataforma:** rotas e telas em `/admin`; aba de eventos → suporte 403 nas escritas.
10. **Remoção de módulo:** `check-module-removal.mjs` aprende `whatsapp_cloud` e `whatsapp_qr`
    (pasta em `src/lib/channels/providers/`, variável `CHANNEL_PROVIDERS`) e o CI ganha as duas
    linhas na matriz.
11. **Contexto e revisão.**

## Verificação

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db`, `npm run build`
- [ ] `npm run jobs:install` cria as filas novas; `/api/ready` segue 200
- [ ] `npm run check:module-removal -- whatsapp_cloud` e `-- whatsapp_qr`
- [ ] Testes de cada etapa acima, com as fixtures de B0
- [ ] Smoke: número oficial de teste e número por QR Code no tenant `acme`; um de cada na
  plataforma; desligar o app com um aviso `pending` e ver o processamento na volta
- [ ] Cada critério de aceite do PRD marcado
- [ ] `/code-review` e `/security-review`

## Atualização de contexto

- [ ] `docs/context/tech/29-canais-whatsapp.md` (novo) e linha no `INDEX.md`
- [ ] `README.md` de cada módulo em `providers/`, com o que foi medido e como remover
- [ ] `tech/20-jobs.md`: filas `channel.inbound` e `channel.health`
- [ ] `tech/23-billing-planos.md`: limites novos e seed
- [ ] `tech/26-seguranca.md`: cifra dos segredos de canal e rotação
- [ ] `tech/22-admin.md`, `tech/06-hono-api.md`, `tech/14-deploy.md` e `infra-deploy.md`
  (variáveis, servidor Evolution, limite de corpo no Caddy)
- [ ] `lgpd.md`: retenção de `channel_event`
- [ ] `.env.example`, `docker/.env.prod.example`, `status.md`
- [ ] Rules novas `canais.md` com `paths: src/lib/channels/**`, em `.claude/rules/` e
  `.cursor/rules/`; skill `ctx-canais`

## Decisões

| Decisão | Motivo | Alternativa descartada |
|---|---|---|
| Endereço de webhook por canal, com chave no caminho | Isola tenants antes de ler o corpo; dispensa varrer tokens | Um endereço global, como na origem |
| `app_secret` obrigatório, sem reserva em variável | Falha fechada em multi-tenant | `META_APP_SECRET` comum |
| Roteamento por `phone_number_id` restrito ao escopo do canal verificado | Vários números no mesmo aplicativo da Meta chegam num endereço só | Um aplicativo por número |
| Aviso gravado e aplicado por job | Durável; reprocessável; mesma peça da cobrança | `after()` da origem |
| `raw` sem base64 | Linha de 16 MB no Postgres por mensagem de mídia | Guardar o corpo inteiro |
| Remover = desativar quando há conversas | O histórico aponta para o canal | Apagar em cascata |
| Modelos só sincronizados | Criar e submeter é um produto à parte, e o painel da Meta já faz | Portar o editor de modelos |
| Sem teto de envio frio | Só protege envio de motor (automação, disparo), que não existe aqui | Portar `channel_cold_sends` |
| Limites pela convenção atual (ausente = ilimitado) | Não cria exceção nova em `checkLimit`; o seed preenche | Ausente = 0 |
| QR gerado por `POST` | Gerar reconecta a instância: tem efeito | `GET`, como na origem |
