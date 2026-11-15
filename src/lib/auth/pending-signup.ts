import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { account, user } from "@/db/schema";
import { deleteUserVerifications } from "@/lib/phone/requests";
import { removeAvatarsOfDeleted } from "@/lib/profile/avatar";

export const PENDING_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A senha é criada antes de o e-mail ser provado. Sem prazo, quem cadastra o e-mail de
 * outra pessoa deixa uma conta à espera: quando o dono clicar em um link, a senha do
 * atacante passa a valer. Por isso o cadastro pendente expira.
 */
export function isPendingSignupExpired(
  { emailVerified, createdAt }: { emailVerified: boolean; createdAt: Date },
  now = Date.now(),
) {
  return !emailVerified && now - createdAt.getTime() > PENDING_SIGNUP_TTL_MS;
}

/**
 * Libera o e-mail: o próximo cadastro cria a conta do zero, com a senha de quem pediu. Só o
 * cadastro pendente tem senha sem e-mail provado; a conta cujo e-mail o `/admin` trocou volta
 * não verificada, mas sem senha (`updateUserByAdmin`), e por isso nunca é expurgada aqui.
 */
export async function purgeExpiredPendingSignup(email: string) {
  const removed = await getDb()
    .delete(user)
    .where(
      and(
        eq(user.email, email),
        eq(user.emailVerified, false),
        lt(user.createdAt, new Date(Date.now() - PENDING_SIGNUP_TTL_MS)),
        sql`exists (select 1 from ${account} where ${account.userId} = "user"."id" and ${account.providerId} = 'credential')`,
      ),
    )
    .returning({ id: user.id });

  // `phone_verification.subject_id` não tem FK: sem isto o pedido ficaria na fila para sempre.
  await deleteUserVerifications(removed.map(({ id }) => id));
  // Nem `file.owner_id`: a foto de perfil (bloco F) sairia sem dono, no banco e no armazenamento.
  await removeAvatarsOfDeleted(removed.map(({ id }) => id));
}
