import type { JobWithMetadata } from "pg-boss";
import { logError } from "@/api/log";
import type { ChannelInboundJob } from "@/jobs/queues";
import { processChannelEvent } from "@/lib/channels/events";
import { checkChannelsHealth } from "@/lib/channels/health";

/**
 * `channel.inbound`: aplica um aviso gravado em `channel_event`. `includeMetadata` traz
 * `retryCount`; na última tentativa o aviso vira `failed` e o job vai para a fila morta.
 */
export async function handleChannelInbound(jobs: JobWithMetadata<ChannelInboundJob>[]) {
  for (const job of jobs) {
    const lastAttempt = job.retryCount >= job.retryLimit;

    await processChannelEvent(job.data.channelEventId, { lastAttempt });
  }
}

/** `channel.health`: cron de 15 em 15 minutos. */
export async function handleChannelHealth() {
  try {
    await checkChannelsHealth();
  } catch (error) {
    logError("Falha na conferência de saúde dos canais", error);
    throw error;
  }
}
