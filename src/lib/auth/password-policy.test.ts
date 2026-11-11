import { describe, expect, it } from "vitest";
import {
  evaluatePassword,
  isPasswordValid,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHARS,
  type PasswordRule,
} from "@/lib/auth/password-policy";

const VALID = "Senha-forte-123";

/** As regras que a senha deixa de cumprir. */
function failed(password: string) {
  return Object.entries(evaluatePassword(password))
    .filter(([, ok]) => !ok)
    .map(([rule]) => rule as PasswordRule);
}

const valid = (password: string) => isPasswordValid(evaluatePassword(password));

describe("evaluatePassword", () => {
  it("aceita a senha que cumpre tudo", () => {
    expect(failed(VALID)).toEqual([]);
    expect(valid(VALID)).toBe(true);
  });

  it.each<[string, string, PasswordRule]>([
    ["tamanho mínimo", "Senha-1ab", "minLength"],
    ["maiúscula", "senha-forte-123", "uppercase"],
    ["minúscula", "SENHA-FORTE-123", "lowercase"],
    ["número", "Senha-forte-abc", "number"],
    ["caractere especial", "SenhaForte123", "special"],
    ["caractere de controle", "Senha-for\u0007te-123", "noControl"],
  ])("aponta só a regra de %s", (_name, password, rule) => {
    expect(failed(password)).toEqual([rule]);
    expect(valid(password)).toBe(false);
  });

  it("aponta só o tamanho máximo", () => {
    const password = `${VALID}${"a".repeat(PASSWORD_MAX_LENGTH)}`;
    expect(failed(password)).toEqual(["maxLength"]);
  });

  it("string vazia: só o máximo e a ausência de controle passam", () => {
    expect(evaluatePassword("")).toEqual({
      minLength: false,
      maxLength: true,
      uppercase: false,
      lowercase: false,
      number: false,
      special: false,
      noControl: true,
    });
    expect(valid("")).toBe(false);
  });

  it("respeita os limites exatos de tamanho", () => {
    const base = "Aa1!";
    const withLength = (length: number) => base + "x".repeat(length - base.length);

    expect(valid(withLength(PASSWORD_MIN_LENGTH - 1))).toBe(false);
    expect(valid(withLength(PASSWORD_MIN_LENGTH))).toBe(true);
    expect(valid(withLength(PASSWORD_MAX_LENGTH))).toBe(true);
    expect(valid(withLength(PASSWORD_MAX_LENGTH + 1))).toBe(false);
  });

  it("aceita cada caractere especial do conjunto e só eles", () => {
    for (const char of PASSWORD_SPECIAL_CHARS) {
      expect(evaluatePassword(`SenhaForte123${char}`).special).toBe(true);
    }
    for (const char of ["|", "\\", "'", '"', "<", ">", "`", " ", "ç"]) {
      expect(evaluatePassword(`SenhaForte123${char}x`).special).toBe(false);
    }
  });

  it("recusa controle no meio: U+0000 a U+001F e U+007F", () => {
    for (const code of [0x00, 0x09, 0x0a, 0x1f, 0x7f]) {
      const password = `Senha-${String.fromCharCode(code)}forte-123`;
      expect(evaluatePassword(password).noControl).toBe(false);
    }
    expect(evaluatePassword("Senha- forte-123").noControl).toBe(true);
    expect(evaluatePassword("Senha-\u0080forte-123").noControl).toBe(true);
  });

  it("permite espaço no meio", () => {
    expect(valid("Senha forte 123!")).toBe(true);
  });

  it("avalia a forma normalizada: as pontas não contam no tamanho", () => {
    expect(evaluatePassword("  Aa1!xxxxx  ").minLength).toBe(false);
    expect(valid("\tSenha-forte-123\n")).toBe(true);
  });
});

describe("normalizePassword", () => {
  it("tira espaço das pontas e mantém o do meio", () => {
    expect(normalizePassword("  Senha forte 1!  ")).toBe("Senha forte 1!");
  });

  it("compõe em NFC", () => {
    const decomposed = "Señha-forte-123";
    expect(normalizePassword(decomposed)).toBe("Señha-forte-123");
    expect(normalizePassword(decomposed)).toBe(normalizePassword("Señha-forte-123"));
  });

  it("é idempotente", () => {
    for (const password of ["  Señha forte 1! ", VALID, "", "   "]) {
      const once = normalizePassword(password);
      expect(normalizePassword(once)).toBe(once);
    }
  });
});
