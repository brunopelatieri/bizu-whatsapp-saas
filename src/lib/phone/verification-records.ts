import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { phoneVerification } from "@/db/schema";
import type { PhoneVerificationSubject } from "@/lib/phone/verification";

/**
 * Limpeza dos pedidos de verificação de um cadastro apagado, sem regra nenhuma: fica fora de
 * `requests.ts` para que a exclusão de ficha (`src/lib/tenant/customer-deletion.ts`), que o `claim`
 * usa de dentro de `requests.ts`, não feche um ciclo de importação. `requests.ts` a reexporta.
 */
/** Cadastro apagado ou anonimizado: os pedidos dele saem junto (`subject_id` não tem FK). */
export async function deleteVerificationsOf(
  tx: Tx,
  type: PhoneVerificationSubject,
  ids: string[],
) {
  if (ids.length === 0) return;

  await tx
    .delete(phoneVerification)
    .where(
      and(eq(phoneVerification.subjectType, type), inArray(phoneVerification.subjectId, ids)),
    );
}
