import { sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { type Tx, withPlatformScope } from "@/db/rls";
import { phoneVerification } from "@/db/schema";
import { getBoss } from "@/jobs/boss";
import { type PhoneVerifyJob, QUEUE } from "@/jobs/queues";
import type { PhoneVerificationSubject } from "@/lib/phone/verification";

/**
 * Pedido de envio do link de verificação de telefone: só enfileira `phone.verify`. Fica separado
 * de `delivery.ts` de propósito: quem abre pedido (o cadastro do Better Auth, o convite, o portal)
 * não carrega os módulos de canal, e o registro deles não entra no ciclo de imports da
 * autenticação.
 */

type Subject = { type: PhoneVerificationSubject; id: string };

/** Links de verificação por hora, por cadastro (contenção do envio frio; SPEC, "Segurança"). */
export const MAX_LINKS_PER_HOUR = 3;

/**
 * Links que saíram para o cadastro na última hora, em todos os pedidos dele (`attempts` com
 * `sent`). O job usa para segurar o quarto link; a rota de reenvio, para responder 429 em vez de
 * aceitar um pedido que o job não vai cumprir.
 */
export async function linksSentInLastHour(tx: Tx, subject: Subject, now: Date) {
  const since = new Date(now.getTime() - 3_600_000).toISOString();
  const [row] = await tx.execute<{ total: number }>(sql`
    select count(*)::int as total
    from ${phoneVerification} pv, jsonb_array_elements(pv.attempts) attempt
    where pv.subject_type = ${subject.type}
      and pv.subject_id = ${subject.id}
      and attempt->>'outcome' = 'sent'
      and (attempt->>'at')::timestamptz > ${since}::timestamptz
  `);

  return row?.total ?? 0;
}

/** O cadastro já recebeu o máximo de links desta hora. */
export function sendLimitReached(subject: Subject, now = new Date()) {
  return withPlatformScope("telefone: links da última hora", async (tx) =>
    (await linksSentInLastHour(tx, subject, now)) >= MAX_LINKS_PER_HOUR,
  );
}

type Enqueue = (job: PhoneVerifyJob, subjectKey: string) => Promise<void>;

const enqueueWithBoss: Enqueue = async (job, key) => {
  const boss = await getBoss();
  // `singleton` por cadastro: os jobs da mesma pessoa rodam um de cada vez (um link por número).
  await boss.send(QUEUE.phoneVerify, job, { singletonKey: key });
};

let enqueue: Enqueue = enqueueWithBoss;

export const subjectKey = (subject: Subject) => `${subject.type}:${subject.id}`;

export const enqueuePhoneVerify: Enqueue = (job, key) => enqueue(job, key);

/** Sem pg-boss nos testes: eles chamam o job direto, ou ignoram o envio. `undefined` restaura. */
export function setPhoneVerifyQueueForTests(next: Enqueue | undefined) {
  enqueue = next ?? enqueueWithBoss;
}

/**
 * Pede o envio do link de um pedido. `open`: o pedido acabou de abrir (cadastro, convite,
 * autocadastro, troca de telefone no portal) e o job decide se é a vez dele (D-12, um link por
 * número). `resend`: a pessoa pediu, e o job tenta o próximo canal da ordem. Falha ao enfileirar
 * vai ao log: o pedido continua na fila de liberação.
 */
export async function requestPhoneVerificationSend(
  requestId: string | null,
  subject: Subject,
  reason: "open" | "resend" = "open",
) {
  if (!requestId) return;

  await enqueue({ requestId, reason }, subjectKey(subject)).catch((error: unknown) =>
    logError("Falha ao enfileirar o envio do link de verificação", error),
  );
}
