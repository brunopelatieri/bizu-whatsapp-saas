import type { Job } from "pg-boss";
import type { PhoneVerifyJob } from "@/jobs/queues";
import { deliverPhoneVerification } from "@/lib/phone/delivery";

/**
 * `phone.verify`: uma passada da cascata de envio do link de verificação de telefone
 * (`src/lib/phone/delivery.ts`). O payload só tem o id do pedido e o motivo: o token é gerado
 * dentro do job, a cada tentativa, e nunca é gravado na fila.
 */
export async function handlePhoneVerify(jobs: Job<PhoneVerifyJob>[]) {
  for (const job of jobs) {
    await deliverPhoneVerification(job.data);
  }
}
