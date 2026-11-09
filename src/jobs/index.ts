import type { PgBoss } from "pg-boss";
import { startBoss, stopBoss } from "@/jobs/boss";
import { type JobConsumer, warnIfMixedConsumers } from "@/jobs/consumers";
import {
  handleBillingDunning,
  handleBillingPeriodEnd,
  handleBillingReconcile,
  handleBillingTrial,
} from "@/jobs/billing";
import { handleChannelHealth, handleChannelInbound } from "@/jobs/channels";
import { handleEmailSend } from "@/jobs/email";
import { handleLgpdDelete, handleLgpdExport } from "@/jobs/lgpd";
import { handleMaintenancePrune } from "@/jobs/maintenance";
import { handleWebhookProcess } from "@/jobs/webhooks";
import {
  queueDefinitions,
  QUEUE,
  scheduleDefinitions,
} from "@/jobs/queues";

/**
 * Registro das filas. Uma fila nova entra em três lugares: `queueDefinitions` e
 * `scheduleDefinitions` (`queues.ts`) e o handler em `registerWorkers`.
 */

/** Cria as filas (idempotente). As dead letters vêm primeiro em `queueDefinitions`. */
export async function registerQueues(boss: PgBoss) {
  for (const { name, options } of queueDefinitions) {
    await boss.createQueue(name, options);
  }
}

export async function registerSchedules(boss: PgBoss) {
  for (const { queue, cron } of scheduleDefinitions) {
    await boss.schedule(queue, cron);
  }
}

export async function registerWorkers(
  boss: PgBoss,
  options: { pollingIntervalSeconds?: number } = {},
) {
  // `offWork` antes: recarga de módulo em dev não duplica workers.
  await boss.offWork(QUEUE.emailSend);
  await boss.offWork(QUEUE.maintenancePrune);
  await boss.offWork(QUEUE.billingTrial);
  await boss.offWork(QUEUE.webhookProcess);
  await boss.offWork(QUEUE.billingDunning);
  await boss.offWork(QUEUE.billingPeriodEnd);
  await boss.offWork(QUEUE.billingReconcile);
  await boss.offWork(QUEUE.lgpdExport);
  await boss.offWork(QUEUE.lgpdDelete);
  await boss.offWork(QUEUE.channelInbound);
  await boss.offWork(QUEUE.channelHealth);
  await boss.work(
    QUEUE.emailSend,
    { includeMetadata: true, batchSize: 1, localConcurrency: 4, ...options },
    handleEmailSend,
  );
  await boss.work(QUEUE.maintenancePrune, options, handleMaintenancePrune);
  await boss.work(QUEUE.billingTrial, options, handleBillingTrial);
  await boss.work(
    QUEUE.webhookProcess,
    { batchSize: 1, localConcurrency: 4, ...options },
    handleWebhookProcess,
  );
  await boss.work(QUEUE.billingDunning, options, handleBillingDunning);
  await boss.work(QUEUE.billingPeriodEnd, options, handleBillingPeriodEnd);
  await boss.work(QUEUE.billingReconcile, options, handleBillingReconcile);
  await boss.work(
    QUEUE.lgpdExport,
    { includeMetadata: true, batchSize: 1, localConcurrency: 2, ...options },
    handleLgpdExport,
  );
  await boss.work(QUEUE.lgpdDelete, options, handleLgpdDelete);
  await boss.work(
    QUEUE.channelInbound,
    { includeMetadata: true, batchSize: 1, localConcurrency: 4, ...options },
    handleChannelInbound,
  );
  await boss.work(QUEUE.channelHealth, options, handleChannelHealth);

}

/**
 * Sobe os workers neste processo: `JOBS_MODE=inline` (dentro do servidor HTTP) ou
 * `--worker` (`JOBS_MODE=worker`, sem HTTP). Devolve a função que para tudo.
 */
export async function startJobs({
  consumer = "inline",
  ...options
}: { consumer?: JobConsumer; pollingIntervalSeconds?: number } = {}) {
  const boss = await startBoss("worker", consumer);
  await registerQueues(boss);
  await registerSchedules(boss);
  await registerWorkers(boss, options);
  await warnIfMixedConsumers(boss);

  return { boss, stop: stopBoss };
}
