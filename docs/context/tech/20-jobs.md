# Jobs em segundo plano (pg-boss)

- **Escopo:** Fila no Postgres com pg-boss 12: instalação, modos de execução, filas, retry, dead letter, manutenção e prontidão.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-email-jobs.md`
- **Paths do código:** `src/jobs/` (`boss.ts`, `consumers.ts`, `queues.ts`, `index.ts`, `email.ts`, `billing.ts`, `webhooks.ts`, `maintenance.ts`, `install.ts`), `src/server.ts`, `src/api/ready.ts`, `drizzle/0005_email_jobs.sql`

## Instalação

1. `npm run db:migrate` cria o schema `pgboss` (migration `0005_email_jobs`) e dá
   `USAGE` + privilégios padrão ao `bizu_app` sobre tudo que `bizu_owner` criar nele.
2. `npm run jobs:install` roda o primeiro `start()` do pg-boss com `DIRECT_URL`
   (`bizu_owner`): cria as tabelas do schema `pgboss`, as filas e os crons. É
   idempotente; rode de novo ao atualizar o pg-boss ou ao acrescentar uma fila.
3. O runtime (`bizu_app`) nunca migra nem cria tabelas: `migrate: false`,
   `createSchema: false` em `boss.ts`.

Sem o passo 2, `sendEmail` falha (fila inexistente), o `email_message` fica `failed` e
`/api/ready` devolve 503 com `jobs: false`. Em produção, o `--worker` e o app em `inline` encerram
se a fila não subir, e o restart tenta de novo: de pé, o app ficaria sem consumidor e sem nova
tentativa, com `/api/ready` em 200 assim que as filas existissem. Em dev, o site continua e só loga.

## Modos (`JOBS_MODE`)

| Modo | O que o processo faz |
|---|---|
| `inline` (padrão) | `src/server.ts` sobe os workers no mesmo processo do HTTP |
| `worker` | `node build/server/index.js --worker`: só workers e crons, sem HTTP (serviço à parte) |
| `off` | só enfileira (processo web quando há worker separado, scripts, testes) |

- Com `worker`, o processo web roda com `JOBS_MODE=off` (ou `worker`, que no HTTP
  equivale a `off`): ele enfileira, o serviço `--worker` entrega.
- Em dev: `npx tsx --tsconfig tsconfig.app.json src/server.ts --worker` também funciona.
- Papéis do `boss.ts`: `installer` (DIRECT_URL, migra), `worker` (DATABASE_URL, supervisiona
  e agenda crons), `producer` (DATABASE_URL, só `send`). A instância fica em `globalThis`
  (HMR do dev não duplica).
- Scripts que usam `sendEmail` fora do servidor devem chamar `stopBoss()` e encerrar o
  cliente do Drizzle antes de sair, senão o processo não termina.
- Aviso de `inline` com worker ao mesmo tempo: seção "Consumidores concorrentes" abaixo.
- PgBouncer em modo transaction quebra o LISTEN/NOTIFY do pg-boss; aponte a conexão da
  fila para o Postgres direto ou use pooler em modo session.

## Consumidores concorrentes

Réplicas do `app` em `inline` ou do `worker` são normais. A combinação errada é `inline` no app
**e** o serviço `--worker`: o compose não consegue impedi-la, porque o modo do app vem de uma
variável e o worker de um perfil. Ela não corrompe nada: o pg-boss entrega cada job a um só
consumidor e os handlers são idempotentes. O dano é operacional: os jobs seguem no processo web
que o worker deveria aliviar, e a concorrência soma as duas configurações. Por isso avisa, sem
recusar a subida.

- `startJobs` recebe `consumer` e vira `instanceName` no registro nativo do pg-boss
  (`bizu-jobs-inline`, `bizu-jobs-worker`). Cada instância se anuncia no `start()`, renova a
  linha a cada 30 s (`pgboss.instance`) e sai dela no `stop()`; depois de uma queda, fica como
  viva por até 90 s. Sem tabela nem timer nossos. Por isso o aviso pode sair uma vez, sem
  motivo real, na troca de modo; `/admin` mostra o estado atual.
- Ao subir, depois de entrar no registro, `warnIfMixedConsumers` loga em `warn` com a correção.
  Quem sobe por último enxerga o outro, em qualquer ordem; o aviso sai no log desse processo.
- `/admin` mostra "Consumidores da fila" ao vivo (`getJobConsumers`), inclusive o caso oposto:
  ninguém consumindo. `/api/ready` não muda: a combinação não torna o app indisponível.
- Falha nessa leitura só gera log; nunca impede os jobs de rodar.

## Filas (`queues.ts`)

| Fila | Gatilho | Retry | Observação |
|---|---|---|---|
| `email.send` | `sendEmail` | 5x, backoff exponencial (30 s a 1 h) | `singletonKey = email_message.id`; dead letter `email.send.dead` (7 dias) |
| `maintenance.prune` | cron diário 04:30 UTC | 1x | apaga `email_message` > 180 dias e buckets de rate limit > 24 h (`pruneOldData`) |
| `billing.trial` | cron diário 03:00 UTC | 3x, 5 min com backoff | avisos T-3, T-1 e T0, expira o trial vencido para `read_only` após a carência; idempotente (`runBillingTrial`, `tech/23-billing-planos.md`); dead letter `billing.trial.dead` (14 dias) |
| `webhook.process` | `POST /api/webhooks/payments/:provider` | 5x, backoff de 30 s a 1 h | política `exclusive`, `singletonKey = payment_event.id`: no máximo um job vivo por evento; dead letter `webhook.process.dead` (14 dias) |
| `billing.dunning` | cron diário 03:10 UTC | 3x, 5 min com backoff | avisos T-3 e T0 da carência, `past_due` → `unpaid` + `read_only`; idempotente (`runBillingDunning`) |
| `billing.period_end` | cron de hora em hora | 3x, 5 min com backoff | encerra cancelamentos e aplica downgrades vencidos (`runBillingPeriodEnd`) |
| `billing.reconcile` | cron diário 04:00 UTC | 3x, 5 min com backoff | compara com o provedor, corrige e alerta; devolve à fila eventos `pending` há mais de 10 min (`runBillingReconcile`) |

| `channel.inbound` | webhooks de canal | 5x, backoff de 30 s a 1 h | `exclusive`, `singletonKey = channel_event.id`; aplica o aviso gravado (`processChannelEvent`); na última tentativa o aviso vira `failed`; dead letter `channel.inbound.dead` (14 dias) |
| `channel.health` | cron a cada 15 min | 1x | `probe` de cada canal não desativado, grava o estado, avisa os owners na queda e devolve à fila avisos `pending` há mais de 10 min (`tech/29-canais-whatsapp.md`) |

Detalhes das filas de cobrança em `tech/24-billing-cobranca.md`. As de LGPD entram na fase 10: acrescente em `queueDefinitions` (a
dead letter `<fila>.dead` antes da fila), em `scheduleDefinitions` se tiver cron, e o
handler em `registerWorkers` (`index.ts`); depois `npm run jobs:install`.

### Regras dos handlers

- Idempotentes: recarregam o estado do banco e agem só se faltar fazer
  (`deliverEmail` só envia `email_message` `queued`).
- Falha → relança o erro (o pg-boss agenda o retry). Na última tentativa
  (`retryCount === retryLimit`) o handler grava o estado final (`failed`) antes de relançar;
  o job vai para a dead letter.
- Erro gravado em coluna passa por `sanitizeError` (sem e-mails, 500 caracteres).
- Payload de job: ids sempre que possível. `email.send` é a exceção documentada
  (mensagem renderizada, retenção curta).

## Prontidão

`GET /api/ready` → `{ db, jobs, schema }`, 200 se todos `true`, 503 caso contrário; cada checagem
tem timeout de 2 s (`src/api/ready.ts`). `db` é `SELECT 1`; `jobs` confirma que o
pg-boss conecta e a fila `email.send` existe; `schema` confere as migrations do build
(`src/db/schema-status.ts`, `tech/14-deploy.md`). `/api/health` continua liveness simples: não toca no
banco, então um app com a fila ou o schema quebrados segue `healthy` para o Docker.

## Testes

`tests/db/email-queue.test.ts` (`npm run test:db`, exige `db:migrate` + `jobs:install`):
enfileirar → worker → `sent`, supressão, retries esgotados → `failed` + `email.send.dead`,
`maintenance.prune` e `checkReady`. `tests/db/job-consumers.test.ts` sobe instâncias reais do pg-boss
como `bizu_app` e confere contagem e aviso. `tests/db/billing.test.ts` chama `runBillingTrial(now, { tenantIds })`
diretamente, com relógio e tenants controlados, como `billing-lifecycle.test.ts` nos outros jobs de
cobrança; `billing-queue.test.ts` confere filas, crons e a política `exclusive` no pg-boss real. Unitários sem banco: `src/jobs/email.test.ts`,
`src/jobs/consumers.test.ts`, `src/api/ready.test.ts`.

## Filas da fase 10

| Fila | Gatilho | Retry | Observação |
|---|---|---|---|
| `lgpd.export` | `POST /api/me/export`, `/api/portal/me/export` | 3x, backoff | `exclusive`, `singletonKey` = `data_export.id`; na última tentativa o pedido vira `failed`; dead letter `lgpd.export.dead` |
| `lgpd.delete` | cron diário 05:00 UTC | 3x | executa `deletion_request` vencidas, cada uma em transação; dead letter `lgpd.delete.dead` |

`maintenance.prune` (cron diário 04:30) agora cobre `payment_event` tratado (90 dias), `channel_event` tratado (30 dias), sessões e verificações vencidas das duas instâncias, exportações vencidas, `audit_log` além de `audit_retention_days`, `email_message` (180 dias) e buckets de rate limit. Tabela em `docs/context/lgpd.md`.

Quem só **enfileira** (`JOBS_MODE=off|worker` no web) precisa que as filas já existam: o worker as cria ao subir (`registerQueues`).
