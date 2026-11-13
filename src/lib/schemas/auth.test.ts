import { describe, expect, it } from "vitest";
import {
  loginSchema,
  resetPasswordSchema,
  signupSchema,
} from "@/lib/schemas/auth";

const signup = {
  name: "Ana",
  email: "Ana@Example.com ",
  phone: "(11) 98765-4321",
  password: "Senha-com-10",
  acceptTerms: true,
  termsVersion: "2026-11",
};

describe("signupSchema", () => {
  it("normaliza o e-mail", () => {
    expect(signupSchema.parse(signup).email).toBe("ana@example.com");
  });

  it("exige senha de 10 caracteres", () => {
    expect(signupSchema.safeParse({ ...signup, password: "123456789" }).success).toBe(
      false,
    );
  });

  it.each([
    ["maiúscula", "senha-forte-123"],
    ["minúscula", "SENHA-FORTE-123"],
    ["número", "Senha-forte-abc"],
    ["caractere especial", "SenhaForte123"],
    ["ausência de caractere de controle", "Senha-forte-123"],
    ["no máximo 128 caracteres", `Aa1!${"x".repeat(125)}`],
  ])("exige %s", (_rule, password) => {
    expect(signupSchema.safeParse({ ...signup, password }).success).toBe(false);
  });

  it("grava a senha normalizada: sem as pontas, em NFC, com o espaço do meio", () => {
    const parsed = signupSchema.parse({ ...signup, password: "  Señha forte 1!  " });
    expect(parsed.password).toBe("Señha forte 1!");
  });

  it("exige o aceite dos termos", () => {
    expect(signupSchema.safeParse({ ...signup, acceptTerms: false }).success).toBe(
      false,
    );
  });

  it("exige telefone válido, com a mensagem do motivo", () => {
    const { phone: _phone, ...withoutPhone } = signup;
    expect(signupSchema.safeParse(withoutPhone).success).toBe(false);

    const message = (phone: string) => {
      const result = signupSchema.safeParse({ ...signup, phone });
      return result.success ? null : result.error.issues[0]?.message;
    };
    expect(message("")).toBe("Informe o telefone.");
    expect(message("(10) 98765-4321")).toBe("DDD inexistente.");
    expect(message("(11) 88765-4321")).toBe("Celular precisa começar com 9 depois do DDD.");
    expect(message("(11) 98765-43")).toBe("Número incompleto ou com dígitos a mais.");
    expect(message("(11) 98765-4321 ramal 2")).toBe("Use só números e + ( ) - .");
  });

  it("aceita celular com WhatsApp: nacional, +55 e estrangeiro", () => {
    for (const phone of ["(11) 98765-4321", "+55 (11) 98765-4321", "+1 415 555 2671"]) {
      expect(signupSchema.safeParse({ ...signup, phone }).success).toBe(true);
    }
  });

  it("a conta da equipe recusa fixo e celular antigo: é por WhatsApp que ela é verificada", () => {
    for (const phone of ["(11) 3456-7890", "(11) 9876-5432"]) {
      const result = signupSchema.safeParse({ ...signup, phone });

      expect(result.success).toBe(false);
      expect(result.error?.issues.map(({ message }) => message)).toEqual([
        "Informe um celular com WhatsApp.",
      ]);
    }
  });
});

describe("loginSchema", () => {
  it("não aplica regra de tamanho a senha antiga", () => {
    expect(
      loginSchema.safeParse({ email: "ana@example.com", password: "123" }).success,
    ).toBe(true);
  });
});

describe("resetPasswordSchema", () => {
  it("recusa confirmação diferente", () => {
    const result = resetPasswordSchema.safeParse({
      password: "Senha-com-10",
      confirmPassword: "Senha-com-11",
    });

    expect(result.success).toBe(false);
  });

  it("recusa senha fora da política", () => {
    const result = resetPasswordSchema.safeParse({
      password: "senha-com-10",
      confirmPassword: "senha-com-10",
    });

    expect(result.success).toBe(false);
  });

  it("compara as duas já normalizadas", () => {
    const result = resetPasswordSchema.safeParse({
      password: "Senha-com-10 ",
      confirmPassword: " Senha-com-10",
    });

    expect(result.success).toBe(true);
  });
});
