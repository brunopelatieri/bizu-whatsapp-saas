import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import {
  PASSWORD_POLICY_CODE,
  PASSWORD_POLICY_MESSAGE,
} from "@/lib/auth/password-policy";

/** Cliente do Better Auth no navegador. Mesma origem da API; nada aqui é segredo. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [adminClient(), twoFactorClient()],
});

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  // Fixa: o login responde igual para senha errada e conta não confirmada.
  INVALID_EMAIL_OR_PASSWORD:
    "E-mail ou senha incorretos. Se a conta é nova, confirme o e-mail pelo link mais recente.",
  INVALID_EMAIL: "Informe um e-mail válido.",
  INVALID_PASSWORD: "E-mail ou senha incorretos.",
  PASSWORD_TOO_SHORT: "A senha é curta demais.",
  PASSWORD_TOO_LONG: "A senha é longa demais.",
  // Só a regra: a resposta não diz nada sobre a conta.
  [PASSWORD_POLICY_CODE]: PASSWORD_POLICY_MESSAGE,
  INVALID_TOKEN: "Link inválido ou expirado.",
  BANNED_USER: "Esta conta está suspensa. Fale com o suporte.",
  INVALID_CODE: "Código incorreto. Tente de novo.",
  INVALID_BACKUP_CODE: "Código de backup incorreto ou já usado.",
  INVALID_TWO_FACTOR_COOKIE: "A verificação expirou. Entre de novo.",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Muitas tentativas. Entre de novo.",
  ACCOUNT_TEMPORARILY_LOCKED:
    "Muitas tentativas erradas. A conta fica bloqueada por 15 minutos.",
  TOTP_ALREADY_ENABLED: "A verificação em duas etapas já está ativa.",
};

type AuthErrorBody = {
  status?: number;
  code?: string;
  /** Rotas próprias da API respondem `{ error }`, já em português. */
  error?: string;
};

export class AuthActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AuthActionError";
  }
}

/** O Better Auth responde em inglês: a interface mostra sempre o texto daqui. */
export function toAuthActionError({ status, code, error }: AuthErrorBody) {
  if (status === 429) {
    return new AuthActionError("Muitas tentativas. Tente mais tarde.", code, status);
  }

  const known = code ? AUTH_ERROR_MESSAGES[code] : undefined;

  return new AuthActionError(
    known ?? error ?? "Não foi possível concluir. Tente novamente.",
    code,
    status,
  );
}
