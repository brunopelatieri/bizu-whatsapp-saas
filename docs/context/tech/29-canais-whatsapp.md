# Canais WhatsApp (Cloud API e Evolution Go)

- **Escopo:** números de WhatsApp do tenant e da plataforma: módulos de canal, estado, caixa de avisos dos provedores, jobs de aplicação e de saúde, limites do plano. A caixa de entrada (chat) é de `docs/specs/caixa-de-entrada/`.
- **Specs relacionadas:** `docs/specs/whatsapp-canais/spec.md` e `prd.md`; programa em `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T3, T8 a T10, T12, T14)
- **Paths do código:** `src/lib/channels/` (`types.ts`, `capabilities.ts`, `errors.ts`, `payload.ts`, `registry.ts`, `credentials.ts`, `service.ts`, `events.ts`, `health.ts`, `log.ts`, `providers/whatsapp_cloud/`, `providers/whatsapp_qr/`), `src/db/schema/channels.ts`, `src/api/channels.ts`, `src/api/webhooks-channels.ts`, `src/components/channels/`, `src/routes/app.settings.channels.tsx`, `src/jobs/channels.ts`, `src/lib/schemas/channels.ts`, `src/lib/email/templates/channel-disconnected.ts`, `drizzle/0022_canais_whatsapp.sql`, `drizzle/0023_rls_canais.sql`, `tests/db/channels-*.test.ts`, `tests/fixtures/channels/`

## Estado

| Etapa | Estado |
|---|---|
| B0 medição | **Pendente.** Fixtures simuladas a partir da origem (`tests/fixtures/channels/README.md`); falta capturar da Meta e da Evolution reais |
| B1 dados e núcleo | Feito: tabelas, RLS, serviço, avisos, filas, saúde, retenção, rotas comuns (listar, renomear, padrão, remover) |
| B2 Cloud (rotas, webhook, tela) | Feito: webhook HTTP comum, salvar/editar/endereço/diagnóstico/modelos e a tela `/app/configuracoes/canais`. **Pendente:** smoke com conta de teste da Meta e conferência da `GRAPH_VERSION` contra a conta real |
| B3 Evolution | Módulo puro pronto (`client`, `instances`, `webhook`, `normalize`); faltam rotas, mídia no `StorageProvider`, readoção e a tela |
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

Além do provedor, o `index.ts` do módulo declara em `ChannelModule` o que é só dele, e os arquivos
comuns apenas iteram `getModules()` (um provedor novo não os edita):

| Campo | Quem usa | O que é |
|---|---|---|
| `webhook` (`segment`, `maxBodyBytes`, `findTarget`, `handshake?`, `prepareRaw?`) | `src/api/webhooks-channels.ts` | Porta de entrada dos avisos: `/api/webhooks/whatsapp/<segment>/:key` |
| `routes(kit)` | `src/api/channels.ts` | Rotas do tipo (criar, diagnosticar, modelos, QR); recebem escopo e autorização pelo `ChannelRouteKit` e respondem 404 com o módulo fora de `CHANNEL_PROVIDERS` |
| `update(scope, id, input, actor)` | `updateChannel` (serviço comum) | Campos do `PATCH /:id` além do nome |

`registry.ts` não tem `await` no topo: no app o `import.meta.glob` é estático; script `tsx` que
precise dos módulos chama `await loadChannelModules()` (o módulo importa o serviço comum, que
importa o registro: com `await` no topo o import dinâmico esperaria por ele mesmo).

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

## Webhook (`src/api/webhooks-channels.ts`)

Montado em `app.ts` antes do `csrfGuard`, fora de `sameOrigin`. Um fluxo para todos os provedores:

1. `findTarget(key)` acha o canal pela chave do caminho (`withPlatformScope("webhook de canal")`,
   só a linha de configuração). Canal `disabled`: 200 e descarta. Módulo desligado: 503.
2. `provider.verifyWebhook` sobre o corpo cru. Falha **ou chave desconhecida**: 401 com o mesmo
   corpo, e conta no limite por IP (20 falhas por minuto → 429; quem acerta não é contado).
3. Só então o JSON é lido (400 se inválido), `receiveChannelEvent` grava e `enqueueChannelEvent`
   enfileira; repetido não duplica e só volta à fila se ainda está `pending`. 413 acima do teto do
   módulo (Cloud: 3 MB).

`GET` (só módulo com `handshake`; Meta): `hub.mode = subscribe` e `hub.verify_token` igual ao do
canal, em tempo constante → 200 `text/plain` com o desafio e `webhook_verified_at` gravado; senão
403, igual para chave desconhecida e token errado.

## Rotas

`/api/channels` (`src/api/channels.ts`): `GET` (`channel:read`; devolve `channels`, `providers` e
`limits`), `PATCH /:id` (`updateChannelSchema`: só o nome renomeia; os outros campos vão ao
`update` do módulo), `POST /:id/default`, `DELETE /:id` com `{ confirm: nome }`
(`channel:manage`). Todas com `requireAuth` + `requireTenant`, `blockMutationsWhileImpersonating`,
30 escritas por minuto **por usuário** e 404 para canal de outro tenant. A resposta é `ChannelView`: **nenhuma coluna
`_enc`**, só a dica dos 4 últimos caracteres do token. Falar com o provedor (apagar a instância) vem
antes da transação; falha dele é 503 `PROVIDER_UNAVAILABLE` e o canal fica como estava.

**WhatsApp Cloud** (`providers/whatsapp_cloud/routes.ts`, `service.ts`, `templates.ts`):

| Rota | Permissão | O que faz |
|---|---|---|
| `POST /api/channels/whatsapp-cloud` | `channel:manage`, 10/min | `verifyPhoneNumber` → (PIN) `registerPhoneNumber` → `subscribeWabaToApp` → uma transação. 201 `{ channel, webhook: { url, verifyToken } }`; 400 `META_REJECTED` (mensagem da Meta), 403 `PLAN_LIMIT_REACHED`, 409 `PHONE_NUMBER_IN_USE`, 503 `PROVIDER_UNAVAILABLE` |
| `PATCH /api/channels/:id` | `channel:manage` | Token, segredo e PIN ausentes ou vazios **mantêm** o gravado; token, PIN ou WABA novos são conferidos na Meta antes de gravar |
| `GET /:id/webhook`, `POST /:id/webhook/rotate` | `channel:manage` | Endereço e token de verificação (`Cache-Control: no-store`); gerar novo troca os dois e zera `webhook_verified_at` |
| `POST /:id/test` | `channel:manage` | `checks`: `credentials_readable`, `token_valid`, `phone_reachable`, `waba_subscribed`, `webhook_verified`, `last_event_at`. 4xx da Meta marca `error`; 5xx, 429 e timeout não mudam o estado |
| `GET /:id/templates?status=` | `channel:read` | Modelos do WABA do canal, no escopo |
| `POST /:id/templates/sync` | `channel:manage`, 5/min | Lê a Meta, cria/atualiza e **apaga** o que sumiu lá |

- A conferência de número em uso vem **depois** de a Meta aceitar o token: só quem tem credencial
  válida daquele número descobre que ele já está em uso. Canal `disabled` do mesmo número no mesmo
  escopo é **readotado** (mesmo id, endereço novo).
- As recusas de permissão vêm antes da checagem de módulo ativo; a matriz RBAC destas rotas está
  em `providers/whatsapp_cloud/http.db.test.ts` (`tests/db/rbac.test.ts` não conhece módulo).

## Tela

`/app/configuracoes/canais` (`routes/app.settings.channels.tsx`, aba "Canais" de `SettingsNav` para
quem tem `channel:read`). `src/components/channels/`: `channel-manager.tsx` (lista com estado, tipo
e padrão; "Conectar número" desabilitado com o motivo no limite do plano; remover com o nome
digitado), `channel-badge.tsx` e `channel-status.tsx` (reaproveitados pelo atendimento),
`channel-kinds.tsx` (rótulo, ícone e texto de cada tipo) e `channel-dialogs.tsx` (**uma linha por
tipo** liga o diálogo de conectar/gerenciar; sem diálogo, o tipo não aparece na escolha),
`cloud-channel-dialog.tsx` (4 etapas, formulário com o schema da API, cartão com endereço e token
para copiar, "Gerar novo endereço", "Diagnosticar"). Segredo só sobe: os campos nascem vazios.

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

`src/lib/channels/**` (unitários, `fetch` simulado, fixtures), `providers/whatsapp_cloud/http.db.test.ts`
(webhook e rotas da Cloud pela API: assinatura adulterada 401, repetido não duplica, isolamento entre
tenants, `app_secret` mantido no `PATCH`, RBAC, 404 de outro tenant, resposta sem segredo), `tests/db/channels-schema.test.ts`
(três modos de escopo, unicidades, cascata), `channels-service`, `channels-events`, `channels-queue`
(pg-boss real), `channels-http` e a matriz de `rbac.test.ts`.
