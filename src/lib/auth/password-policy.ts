/**
 * Política de senha: módulo puro, usado pelo Zod (`src/lib/schemas/auth.ts`), pelo hook das
 * duas instâncias do Better Auth (`password-hook.ts`), pelo seed e pelas telas.
 *
 * O login não avalia nada disto: só normaliza, para a senha gravada continuar entrando.
 */

export const PASSWORD_MIN_LENGTH = 10;
/** Em caracteres. O hasher é scrypt (Better Auth), sem o corte de 72 bytes do bcrypt. */
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_SPECIAL_CHARS = "!@#$%^&*()_+-=[]{}:;,.?/~";

/** Código do erro devolvido pelo Better Auth quando a senha nova não cumpre a regra. */
export const PASSWORD_POLICY_CODE = "PASSWORD_POLICY";

export const PASSWORD_POLICY_MESSAGE = `A senha precisa ter de ${PASSWORD_MIN_LENGTH} a ${PASSWORD_MAX_LENGTH} caracteres, com letra maiúscula, letra minúscula, número e um caractere especial (${PASSWORD_SPECIAL_CHARS}).`;

export type PasswordRule =
  | "minLength"
  | "maxLength"
  | "uppercase"
  | "lowercase"
  | "number"
  | "special"
  | "noControl";

/** `true` em cada regra cumprida. */
export type PasswordEvaluation = Record<PasswordRule, boolean>;

/**
 * A forma em que a senha é gravada e conferida: sem espaço nas pontas e em NFC. Espaço no
 * meio fica. Idempotente.
 */
export function normalizePassword(password: string) {
  return password.trim().normalize("NFC");
}

function isControl(char: string) {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

/**
 * Avalia a senha já normalizada (o que o servidor grava), uma regra por vez. O tamanho conta
 * unidades UTF-16, como o Better Auth.
 */
export function evaluatePassword(password: string): PasswordEvaluation {
  const value = normalizePassword(password);
  const chars = [...value];

  return {
    minLength: value.length >= PASSWORD_MIN_LENGTH,
    maxLength: value.length <= PASSWORD_MAX_LENGTH,
    uppercase: /[A-Z]/.test(value),
    lowercase: /[a-z]/.test(value),
    number: /[0-9]/.test(value),
    special: chars.some((char) => PASSWORD_SPECIAL_CHARS.includes(char)),
    noControl: !chars.some(isControl),
  };
}

export function isPasswordValid(result: PasswordEvaluation) {
  return Object.values(result).every(Boolean);
}
