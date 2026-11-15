import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  evaluatePassword,
  isPasswordValid,
  normalizePassword,
  PASSWORD_POLICY_CODE,
  PASSWORD_POLICY_MESSAGE,
} from "@/lib/auth/password-policy";

/**
 * Rotas que gravam senha nova e o campo em que ela chega. `auth.api.setPassword` não entra: é
 * só de servidor, sem `path`, e o hook não a reconhece. Ninguém a chama hoje; quem passar a
 * chamar valida antes, como `setPortalPassword`.
 */
const NEW_PASSWORD_FIELD: Record<string, "password" | "newPassword"> = {
  "/sign-up/email": "password",
  "/reset-password": "newPassword",
  "/change-password": "newPassword",
  "/admin/set-user-password": "newPassword",
  "/admin/create-user": "password",
};

const PASSWORD_FIELDS = ["password", "newPassword", "currentPassword"] as const;

/**
 * Hook `before` das duas instâncias do Better Auth. Roda em toda chamada, por HTTP ou por
 * `auth.api.*`, então a rota chamada direto não escapa do que o Zod das rotas próprias cobra.
 *
 * - Normaliza (`normalizePassword`) todo campo de senha do corpo, em qualquer rota: a que
 *   grava e a que confere (login, senha atual, confirmação de 2FA) veem a mesma forma.
 * - Onde nasce senha nova, aplica a política. O login não é avaliado.
 */
export const passwordPolicyHook = createAuthMiddleware(async (ctx) => {
  const body: unknown = ctx.body;
  if (!body || typeof body !== "object") return;

  const source = body as Record<string, unknown>;
  const normalized: Record<string, string> = {};

  for (const field of PASSWORD_FIELDS) {
    const value = source[field];
    if (typeof value === "string") normalized[field] = normalizePassword(value);
  }

  // Ausente ou de outro tipo: o próprio endpoint recusa.
  const created = normalized[NEW_PASSWORD_FIELD[ctx.path ?? ""] ?? ""];

  if (created !== undefined && !isPasswordValid(evaluatePassword(created))) {
    throw new APIError("BAD_REQUEST", {
      message: PASSWORD_POLICY_MESSAGE,
      code: PASSWORD_POLICY_CODE,
    });
  }

  if (Object.keys(normalized).length === 0) return;

  return { context: { body: { ...source, ...normalized } } };
});
