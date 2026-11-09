# Canais WhatsApp (Cloud API e Evolution Go)

- **Escopo:** números de WhatsApp do tenant e da plataforma: módulos de canal, estado, caixa de avisos dos provedores, jobs de aplicação e de saúde, limites do plano. A caixa de entrada (chat) é de `docs/specs/caixa-de-entrada/`.
- **Specs relacionadas:** `docs/specs/whatsapp-canais/spec.md` e `prd.md`; programa em `docs/specs/whatsapp-crm/plano.md` (decisões T1 a T3, T8 a T10, T12, T14)
- **Paths do código:** `src/lib/channels/` (`types.ts`, `capabilities.ts`, `errors.ts`, `payload.ts`, `registry.ts`, `credentials.ts`, `service.ts`, `events.ts`, `health.ts`, `log.ts`, `providers/whatsapp_cloud/`, `providers/whatsapp_qr/`), `src/db/schema/channels.ts`, `src/api/channels.ts`, `src/jobs/channels.ts`, `src/lib/schemas/channels.ts`, `src/lib/email/templates/channel-disconnected.ts`, `drizzle/0022_canais_whatsapp.sql`, `drizzle/0023_rls_canais.sql`, `tests/db/channels-*.test.ts`, `tests/fixtures/channels/`

## Estado

| Etapa | Estado |
|---|---|
| B0 medição | **Pendente.** Fixtures simuladas a partir da origem (`tests/fixtures/channels/README.md`); falta capturar da Meta e da Evolution reais |
| B1 dados e núcleo | Feito: tabelas, RLS, serviço, avisos, filas, saúde, retenção, rotas comuns (listar, renomear, padrão, remover) |
| B2 Cloud (rotas, webhook, tela) | Módulo puro pronto (`graph`, `webhook`, `normalize`); faltam rotas de criar/editar/testar, o webhook HTTP, modelos e a tela |
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

## Rotas

`/api/channels` (`src/api/channels.ts`): `GET` (`channel:read`; devolve `channels`, `providers` e
`limits`), `PATCH /:id` (renomear), `POST /:id/default`, `DELETE /:id` com `{ confirm: nome }`
(`channel:manage`). Todas com `requireAuth` + `requireTenant`, `blockMutationsWhileImpersonating`,
30 escritas por minuto e 404 para canal de outro tenant. A resposta é `ChannelView`: **nenhuma coluna
`_enc`**, só a dica dos 4 últimos caracteres do token. Falar com o provedor (apagar a instância) vem
antes da transação; falha dele é 503 `PROVIDER_UNAVAILABLE` e o canal fica como estava.

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
(pg-boss real), `channels-http` e a matriz de `rbac.test.ts`.
