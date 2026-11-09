# Canais WhatsApp (Cloud API e Evolution Go)

- **Escopo:** números de WhatsApp do tenant e da plataforma: módulos de canal, estado, caixa de avisos dos provedores, jobs de aplicação e de saúde, limites do plano. A caixa de entrada (chat) é de `docs/specs/caixa-de-entrada/`.
- **Specs relacionadas:** `docs/specs/whatsapp-canais/spec.md` e `prd.md`; programa em `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T3, T8 a T10, T12, T14)
- **Paths do código:** `src/lib/channels/` (`types.ts`, `capabilities.ts`, `errors.ts`, `payload.ts`, `registry.ts`, `credentials.ts`, `service.ts`, `events.ts`, `health.ts`, `log.ts`, `pairing.ts`, `connection.ts`, `inbound-pairing.ts`, `media.ts`, `send.ts`, `providers/whatsapp_cloud/`, `providers/whatsapp_qr/`), `src/db/schema/channels.ts`, `src/api/channels.ts`, `src/api/webhooks-channels-evolution.ts`, `src/components/channels/qr-channel-dialog.tsx`, `src/jobs/channels.ts`, `src/lib/schemas/channels.ts`, `src/lib/email/templates/channel-disconnected.ts`, `drizzle/0022_canais_whatsapp.sql`, `drizzle/0023_rls_canais.sql`, `tests/db/channels-*.test.ts`, `tests/fixtures/channels/`

## Estado

| Etapa | Estado |
|---|---|
| B0 medição | **Pendente.** Fixtures simuladas a partir da origem (`tests/fixtures/channels/README.md`); falta capturar da Meta e da Evolution reais |
| B1 dados e núcleo | Feito: tabelas, RLS, serviço, avisos, filas, saúde, retenção, rotas comuns (listar, renomear, padrão, remover) |
| B2 Cloud (rotas, webhook, tela) | Módulo puro pronto (`graph`, `webhook`, `normalize`); faltam rotas de criar/editar/testar, o webhook HTTP, modelos e a tela |
| B3 Evolution | **Feito no servidor e no diálogo:** webhook, mídia no `StorageProvider`, rotas de criar/parear/estado/ciclo de vida, readoção, `qr-channel-dialog.tsx`. **Pendente:** smoke com o servidor Evolution real (B0), e a página da lista (B2) chamar o diálogo |
| B4 plataforma | Pendente (`/api/admin/channels/*`, telas e aba de avisos) |

## Modelo

Cinco tabelas, todas com `tenant_id` anulável (`NULL` = plataforma), `scopedPolicy()` e `FORCE`
(`tech/07-banco-drizzle.md`): `channel` (comum), `channel_whatsapp_cloud` e `channel_evolution`
(1:1, com os segredos cifrados), `channel_event` (caixa de avisos) e `message_template`.

- `phone_number_id` e `remote_instance_name` são **únicos em todos os escopos**; o aviso e a mensagem
  têm unicidade própria (`channel_event(channel_id, dedupe_key)`).
- Um padrão por escopo e tipo (índice único parcial; a plataforma tem o próprio, porque dois nulos
  não são iguais). Eleição em `electDefault`: o conectado mais antigo.
- Remover = apagar sem conversas, **desativar** com conversas (`status = disabled`, `_enc` nulos,
  sem padrão). Até a caixa de entrada (C1), `channelHasConversations` devolve `false`;
  `setConversationCheck` troca o corpo.

## Módulos e registro

`src/lib/channels/providers/<id>/` com `index.ts` que exporta `default: ChannelModule`; liga-se por
`CHANNEL_PROVIDERS` (`whatsapp_cloud`, `whatsapp_qr`). O núcleo **nunca** importa a pasta de um
módulo (`registry.test.ts` reprova) e pergunta à capacidade, não ao tipo (`can(type, "pairing")`).
Teste com banco de um módulo mora na pasta dele (`*.db.test.ts`, roda em `test:db`) para sumir com
ela. `npm run check:module-removal -- whatsapp_cloud|whatsapp_qr` prova.

Contrato `ChannelProvider`: `verifyWebhook` (nunca lança por assinatura errada), `normalizeEvents`
(pura, testada com fixtures), `sendText`, `sendMedia`, `sendTemplate?`, `fetchMedia?`, `probe`,
`destroy?`. READMEs dos módulos: o que foi medido, o que não foi e como remover.

## Avisos (`channel_event`) e jobs

O webhook **grava e enfileira**; quem aplica é `channel.inbound`:

1. `receiveChannelEvent` insere `pending` sob o escopo do canal; conflito na única = repetido.
2. `enqueueChannelEvent` manda `{ channelEventId }` (`exclusive`, `singletonKey` = id).
3. `processChannelEvent` trava a linha, normaliza com o módulo e aplica dentro de `withScope`:
   `connection` (estado, telefone, JID) e `template` (status de modelo já existente); `message` e
   `status` vão a `setInboxHandlers` (C1) e, sem ele, ficam `ignored`.
4. Falha soma `attempts` e guarda o erro **sem telefone nem e-mail** (`sanitizeChannelError`); na
   última tentativa vira `failed` e o job vai para `channel.inbound.dead`.

**Roteamento da Cloud:** o aviso que chega na chave do canal A pode trazer outro número do mesmo
aplicativo. `resolveTarget` procura o `phone_number_id` **só entre os canais do mesmo escopo** do canal
A; número de outro tenant ou da plataforma é descartado (RLS + filtro de escopo).

Canal `disabled` e organização que não está `active` respondem 200 no webhook e o evento fica
`ignored`. Tenant em `read_only` continua recebendo.

`channel.health` (cron de 15 min): `probe` de cada canal não desativado; grava `status`,
`status_detail`, `last_seen_at`; e-mail `channel-disconnected` aos owners **só** na passagem de
`connected` para `error`/`disconnected` (uma vez por queda); falha transitória (5xx, 429, timeout)
não muda o estado; devolve à fila avisos `pending` há mais de 10 min. `maintenance.prune` apaga
`channel_event` tratado há mais de 30 dias.

## Canal por QR Code (Evolution Go, B3)

O núcleo não conhece a Evolution: fala com `provider.pairing` (`PairingOperations` em `types.ts`), que
só o módulo com a capacidade `pairing` implementa. Sem o módulo em `CHANNEL_PROVIDERS`, toda rota
abaixo responde 503 `PROVIDER_UNAVAILABLE`.

- **Criar** (`pairing.ts`, `createPairingChannel`): teto do servidor (`EVOLUTION_MAX_INSTANCES_TOTAL`,
  o maior entre o que o servidor lista e os canais locais de todos os escopos) → limite do plano →
  instância no servidor (token nosso, `randomUUID`) → transação (`lockScopeType`, limite de novo,
  `channel` em `connecting`, `channel_evolution` com token e segredo cifrados). Transação que falha
  apaga a instância.
- **Parear:** `POST /:id/qr` registra o webhook (`connect`, reexecutável) e pede o QR; devolve
  `qrcode` (data URI), `code` (texto, desenhado com `qrcode.react`) e `expiresInSeconds` (60). O QR
  nunca é gravado, só `last_qr_at`. Canal já conectado responde `{ alreadyConnected: true }` sem chamar
  o servidor. `POST /:id/pair` devolve o código de 8 caracteres.
- **Estado:** `GET /:id/status` devolve o gravado; em `connecting`, pergunta também ao provedor
  (`probe`), para a tela fechar mesmo se o aviso de conexão não chegar. É um `GET` que grava (estado
  e, se for o caso, a readoção) com `channel:read`: o que grava vem do provedor, nunca de quem chama.
- **Conexão e readoção** (`connection.ts`, `applyConnectionState`): o aviso `connection` (ou o `probe`)
  grava estado, telefone e JID e audita `channel.connected`/`channel.disconnected` só na passagem. Se o
  telefone que conectou já tem um canal por QR **não conectado no mesmo escopo** (desativado ou caído),
  a instância nova passa para o canal antigo (segredos recifrados: o `aad` leva o id), os avisos
  pendentes seguem junto e o canal novo é apagado. Para quem consulta o canal novo, `status` responde
  404 (ou `readoptedInto`): a tela trata como conectado.
- **Envio** (`send.ts`): canal que não está `connected` responde 409 `CHANNEL_NOT_CONNECTED` antes de
  chamar o provedor; 401/403 do provedor marca o canal `error`.
- **Ajustes avançados:** `PATCH /:id/advanced-settings` (lista fechada em `qrAdvancedSettingsSchema`).
  Rota própria, e não o `PATCH /:id` da SPEC, para não disputar o handler com os campos da Cloud.

### Webhook (`POST /api/webhooks/whatsapp/evolution/:secret`)

`src/api/webhooks-channels-evolution.ts` exporta `evolutionWebhooks`, montado em `app.ts` antes do
CSRF. Cadeia em `inbound-pairing.ts`: sha256 do segredo acha a instância (o corpo nem é lido antes
disso) → `instanceId` = `remote_instance_id` → `instanceToken` = token decifrado, em tempo constante.
Qualquer falha é 401 **igual e sem detalhe**; 20 falhas por IP por minuto, depois 429; 413 acima de
25 MB; canal `disabled` responde 200 e descarta; módulo desligado, 503. O `instanceToken` sai do corpo
antes de gravar (em qualquer nível): `channel_event.raw` não guarda segredo.

### Mídia (`media.ts` e `providers/whatsapp_qr/media.ts`)

- **base64:** no webhook, antes do `channel_event`, vai ao `StorageProvider` sob `inbound/<chave
  aleatória>` e o `raw` fica com `{ storageKey, mime, size }`. Reentrega não sobe de novo.
- **`mediaUrl`:** o job baixa só de origem em `EVOLUTION_MEDIA_ORIGINS` (exata), sem seguir
  redirecionamento, com timeout e teto de 25 MB. Fora da lista → `ignored`; 403/404 → `failed` na hora
  (`PermanentEventError`, sem retry). URL cifrada do CDN do WhatsApp nunca é baixada.
- O `Content-Type` do objeto vem de quem mandou a mensagem: `safeMime` troca HTML, SVG, XML e script
  por `application/octet-stream`. **Quem servir esses objetos (C1) deve mandar `Content-Disposition:
  attachment` ou restringir os tipos**, e validar a referência com `isStoredMedia`.
- Aviso `ignored` ou `failed` definitivo apaga o objeto. Reprocessar um aviso assim não recupera a
  mídia. O objeto de aviso `processed` é da caixa de entrada (C1), que ainda não o referencia.

### Tela

`QrChannelDialog` (`src/components/channels/qr-channel-dialog.tsx`) é autocontido: aviso de risco
permanente, nome, abas "QR Code" (contagem de 60 s, "Gerar outro", um QR por abertura) e "Código",
consulta `status` a cada 4 s e fecha ao conectar. Props: `trigger` ou `open`/`onOpenChange`, `channel`
(parear de novo), `onChanged` (recarregar a lista) e `basePath` (`/api/admin/channels` na B4). **A
página da lista (B2) ainda não o chama.**

## Rotas

`/api/channels` (`src/api/channels.ts`): `GET` (`channel:read`; devolve `channels`, `providers` e
`limits`), `PATCH /:id` (renomear), `POST /:id/default`, `DELETE /:id` com `{ confirm: nome }`
(`channel:manage`). Todas com `requireAuth` + `requireTenant`, `blockMutationsWhileImpersonating`,
30 escritas por minuto e 404 para canal de outro tenant. A resposta é `ChannelView`: **nenhuma coluna
`_enc`**, só a dica dos 4 últimos caracteres do token. Falar com o provedor (apagar a instância) vem
antes da transação; falha dele é 503 `PROVIDER_UNAVAILABLE` e o canal fica como estava.

QR Code (B3), no mesmo arquivo: `POST /whatsapp-qr` (10 por minuto), `POST /:id/qr` e `/:id/pair` (15,
`Cache-Control: no-store`), `GET /:id/status` (`channel:read`, 30), `POST /:id/disconnect`, `/logout`,
`/reconnect` e `PATCH /:id/advanced-settings` (30). Limites por usuário. Códigos: 403
`PLAN_LIMIT_REACHED`, 409 `SERVER_LIMIT_REACHED`, 503 `PROVIDER_UNAVAILABLE`, 409 `CHANNEL_DISABLED`,
409 `CHANNEL_ALREADY_CONNECTED`, 400 `UNSUPPORTED_FOR_CHANNEL` (canal sem pareamento).

## Segurança

- Segredos cifrados por `sealSecret` com `aad = channel:<id>:<campo>`; só `credentials.ts` decifra, e
  `rotateChannelSecrets` entra em `rotateCredentials()` (`tech/26-seguranca.md`). Cifra copiada para
  outro canal ou campo não decifra.
- Falha fechada: sem `app_secret`, 401; módulo ligado sem variáveis da Evolution recusa (`ChannelNotConfiguredError`).
- Log só por `logChannelError`: de `ProviderError` ficam tipo, status e código (a mensagem do provedor
  pode citar telefone ou o endereço interno do servidor).
- A chave global da Evolution nunca vai a endpoint de instância e vice-versa (`keyScopeOf`).
- URL de mídia só de hosts da Meta (Cloud) ou de `EVOLUTION_MEDIA_ORIGINS` (Evolution): SSRF.

## Limites do plano

`plan.limits.channels_whatsapp_cloud` e `channels_whatsapp_qr` (`free` 1/1, `basic` 2/2, `pro` 3/3;
ausente = ilimitado). `databaseLimitSource.used` conta canais não desativados do tipo;
`assertChannelWithinLimit` roda com `lockScopeType` (`pg_advisory_xact_lock`) na transação de criação.
A plataforma não tem limite de plano.

## Testes

`src/lib/channels/**` (unitários, `fetch` simulado, fixtures), `tests/db/channels-schema.test.ts`
(três modos de escopo, unicidades, cascata), `channels-service`, `channels-events`, `channels-queue`
(pg-boss real), `channels-http` e a matriz de `rbac.test.ts`. Da B3, na pasta do módulo (`test:db`):
`webhook.db.test.ts` (cadeia, dedupe, mídia, conexão, readoção) e `routes.db.test.ts` (limites, RBAC,
404 entre tenants, resposta sem segredo), com servidor Evolution simulado (`db-test-support.ts`).
