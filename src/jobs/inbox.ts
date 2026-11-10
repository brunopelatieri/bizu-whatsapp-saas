import type { JobWithMetadata } from "pg-boss";
import type { InboxMediaJob } from "@/jobs/queues";
import { processInboxMedia } from "@/lib/inbox/media";

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
