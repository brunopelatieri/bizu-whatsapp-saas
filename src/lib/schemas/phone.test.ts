import { describe, expect, it } from "vitest";
import { updatePortalUserSchema, updateUserSchema } from "@/lib/schemas/admin";
import { phoneSchema, whatsappPhoneSchema } from "@/lib/schemas/phone";
import { portalSignupSchema } from "@/lib/schemas/portal";
import { phoneVerifiedVia } from "@/lib/phone/verification";
import { phoneVerifiedConsistent } from "@/db/phone-check";

const MOBILE = "(11) 98765-4321";
const LANDLINE = "(11) 3456-7890";
const LEGACY = "(11) 9876-5432";
const FOREIGN = "+1 415 555 2671";

describe("whatsappPhoneSchema", () => {
  it("aceita só número que recebe WhatsApp", () => {
    expect(whatsappPhoneSchema.safeParse(MOBILE).success).toBe(true);
    expect(whatsappPhoneSchema.safeParse(FOREIGN).success).toBe(true);
    expect(whatsappPhoneSchema.safeParse(LANDLINE).success).toBe(false);
    expect(whatsappPhoneSchema.safeParse(LEGACY).success).toBe(false);
  });

  it("mantém as recusas do telefone comum, com a mensagem dele", () => {
    const result = whatsappPhoneSchema.safeParse("(10) 98765-4321");

    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toEqual(["DDD inexistente."]);
  });

  it("o telefone do cliente continua aceitando fixo e celular antigo", () => {
    expect(phoneSchema.safeParse(LANDLINE).success).toBe(true);
    expect(phoneSchema.safeParse(LEGACY).success).toBe(true);
  });
});

describe("quem exige WhatsApp", () => {
  it("o autocadastro do portal aceita fixo: a regra é só da conta da equipe", () => {
    const signup = {
      name: "Júlia Lima",
      email: "julia@exemplo.com",
      password: "Senha-forte-123",
      acceptTerms: true,
      termsVersion: "2026-11",
      org: "acme",
    };

    expect(portalSignupSchema.safeParse({ ...signup, phone: LANDLINE }).success).toBe(true);
  });

  it("no /admin, a conta da equipe exige WhatsApp e a do portal não", () => {
    expect(updateUserSchema.safeParse({ phone: LANDLINE }).success).toBe(false);
    expect(updateUserSchema.safeParse({ phone: MOBILE }).success).toBe(true);
    expect(updatePortalUserSchema.safeParse({ phone: LANDLINE }).success).toBe(true);
  });
});

describe("estado de verificação", () => {
  it("o CHECK do banco lista as mesmas formas do código", () => {
    // O SQL do `CHECK` é texto: sem este teste, uma forma nova passaria no TypeScript e o
    // banco a recusaria só em produção.
    const text = JSON.stringify(phoneVerifiedConsistent.queryChunks);

    for (const via of phoneVerifiedVia) expect(text).toContain(`'${via}'`);
  });
});
