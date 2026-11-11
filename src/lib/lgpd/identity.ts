import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { twoFactor } from "@/db/schema";
import { normalizePassword } from "@/lib/auth/password-policy";
import { getAuth } from "@/lib/auth/server";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * Prova de identidade para ações que não têm volta (excluir conta ou organização): a senha e,
 * com 2FA ativo, o código do aplicativo. A mesma mensagem serve para senha, código ausente ou
 * errado: quem erra não descobre qual dos dois falhou. O limite de tentativas é da rota
 * (por usuário), e o do Better Auth não vale aqui, porque a chamada não passa pelo handler HTTP.
 */

const REFUSED = new TenantRuleError(
  403,
  "INVALID_CREDENTIALS",
  "Senha ou código incorretos.",
);

async function verifyTotp(userId: string, code: string) {
  const context = await getAuth().$context;
  const [row] = await getDb()
    .select({ secret: twoFactor.secret })
    .from(twoFactor)
    .where(and(eq(twoFactor.userId, userId), eq(twoFactor.verified, true)));

  if (!row) return false;

  const secret = await symmetricDecrypt({ key: context.secretConfig, data: row.secret });

  return createOTP(secret, { digits: 6, period: 30 }).verify(code);
}

/** Lança `INVALID_CREDENTIALS` (403) se a senha ou o código não conferirem. */
export async function confirmIdentity(
  user: { id: string; twoFactorEnabled: boolean },
  { password, totp }: { password: string; totp?: string },
) {
  const context = await getAuth().$context;
  const accounts = await context.internalAdapter.findAccounts(user.id);
  const stored = accounts.find(({ providerId }) => providerId === "credential");

  const passwordOk =
    Boolean(stored?.password) &&
    (await context.password.verify({
      hash: stored?.password ?? "",
      // A mesma forma em que a senha foi gravada e em que o login a confere.
      password: normalizePassword(password),
    }));

  // Sempre confere o código quando há 2FA, mesmo com a senha errada: o tempo de resposta
  // não diz qual falhou.
  const totpOk = user.twoFactorEnabled
    ? totp !== undefined && (await verifyTotp(user.id, totp))
    : true;

  if (!passwordOk || !totpOk) throw REFUSED;
}
