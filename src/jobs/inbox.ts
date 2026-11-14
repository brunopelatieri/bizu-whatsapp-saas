import type { JobWithMetadata } from "pg-boss";
import { logError } from "@/api/log";
import type { InboxMediaJob } from "@/jobs/queues";
import { processInboxMedia } from "@/lib/inbox/media";
import { runRetentionCycle } from "@/lib/inbox/retention";
import { sweepQueuedMessages } from "@/lib/inbox/send";

/** `inbox.sweep`: cron de 5 em 5 minutos; envio sem resposta do provedor vira `failed`. */
export async function handleInboxSweep() {
  try {
    await sweepQueuedMessages();
  } catch (error) {
    logError("Falha na varredura de mensagens sem confirmação", error);
    throw error;
  }
}

/**
 * `inbox.retention` (bloco R): cron diário com `singletonKey`. Desligada
 * (`MESSAGE_RETENTION_ENABLED=false`), não faz nada. Cada escopo que falha já foi ao `logError`
 * dentro do ciclo, sem texto de mensagem; só a falha ao listar os escopos chega aqui.
 */
export async function handleInboxRetention() {
  try {
    return await runRetentionCycle();
  } catch (error) {
    logError("Falha na limpeza de mensagens", error);
    throw error;
  }
}

/**
 * `inbox.media`: baixa a mídia de uma mensagem recebida pela Cloud API. `includeMetadata` traz
 * `retryCount`; na última tentativa a mensagem fica `media_status = failed`.
 */
export async function handleInboxMedia(jobs: JobWithMetadata<InboxMediaJob>[]) {
  for (const job of jobs) {
    const lastAttempt = job.retryCount >= job.retryLimit;

    await processInboxMedia(job.data, { lastAttempt });
  }
}
