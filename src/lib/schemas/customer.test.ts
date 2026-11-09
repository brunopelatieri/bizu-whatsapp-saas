import { describe, expect, it } from "vitest";
import {
  customerSchema,
  customersQuerySchema,
  updateCustomerSchema,
} from "@/lib/schemas/customer";
import {
  magicLinkRequestSchema,
  portalProfileSchema,
  portalTokenSchema,
  setPasswordSchema,
} from "@/lib/schemas/portal";

describe("customerSchema", () => {
  const valid = {
    name: "Júlia Lima",
    email: "  JULIA@Example.com ",
    phone: "(11) 98765-4321",
  };

  it("normaliza o e-mail e não inventa campos", () => {
    expect(customerSchema.parse(valid)).toEqual({
      name: "Júlia Lima",
      email: "julia@example.com",
      phone: "(11) 98765-4321",
    });
  });

  it("e-mail é opcional: vazio ou ausente, o cliente existe sem acesso", () => {
    expect(customerSchema.parse({ ...valid, email: "" }).email).toBeNull();
    const { email: _email, ...withoutEmail } = valid;
    expect(customerSchema.parse(withoutEmail).email).toBeUndefined();
    expect(customerSchema.safeParse({ ...valid, email: "não é e-mail" }).success).toBe(false);
  });

  it("telefone é obrigatório e validado, mesmo sem e-mail", () => {
    const { phone: _phone, ...withoutPhone } = valid;
    expect(customerSchema.safeParse(withoutPhone).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, phone: "" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, email: "", phone: "(10) 98765-4321" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, email: "", phone: "+55 (11) 98765-4321" }).success).toBe(true);
  });

  it("texto opcional vazio vira null", () => {
    expect(
      customerSchema.parse({ ...valid, document: "", notes: "" }),
    ).toMatchObject({ document: null, notes: null });
  });

  it("etiquetas repetidas somem", () => {
    expect(customerSchema.parse({ ...valid, tags: ["a", "b", "a"] }).tags).toEqual([
      "a",
      "b",
    ]);
  });

  it("recusa status fora da lista e telefone com letras", () => {
    expect(customerSchema.safeParse({ ...valid, status: "vip" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, phone: "abc" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...valid, phone: "11 98765-4321 x" }).success).toBe(false);
  });
});

describe("updateCustomerSchema", () => {
  it("só traz o que veio: o PATCH não apaga o resto", () => {
    expect(updateCustomerSchema.parse({ name: "Novo nome" })).toEqual({
      name: "Novo nome",
    });
  });

  it("o PATCH pode omitir o telefone, mas nunca apagá-lo", () => {
    expect(updateCustomerSchema.safeParse({ phone: "" }).success).toBe(false);
    expect(updateCustomerSchema.safeParse({ phone: "(11) 98765-4321" }).success).toBe(true);
  });

  it("recusa corpo vazio", () => {
    expect(updateCustomerSchema.safeParse({}).success).toBe(false);
  });
});

describe("customersQuerySchema", () => {
  it("usa a primeira página e converte o número", () => {
    expect(customersQuerySchema.parse({})).toEqual({ page: 1 });
    expect(customersQuerySchema.parse({ page: "3" }).page).toBe(3);
  });

  it("recusa página inválida", () => {
    expect(customersQuerySchema.safeParse({ page: "0" }).success).toBe(false);
  });
});

describe("schemas do portal", () => {
  it("magic link exige `org` válido", () => {
    expect(
      magicLinkRequestSchema.safeParse({ email: "a@b.com", org: "acme" }).success,
    ).toBe(true);
    expect(
      magicLinkRequestSchema.safeParse({ email: "a@b.com", org: "ACME/../x" })
        .success,
    ).toBe(false);
  });

  it("token é obrigatório; `org` é opcional", () => {
    expect(portalTokenSchema.safeParse({ token: "abc" }).success).toBe(true);
    expect(portalTokenSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("telefone do perfil é obrigatório: vazio e ausente são recusados", () => {
    expect(portalProfileSchema.safeParse({ name: "Júlia", phone: "" }).success).toBe(false);
    expect(portalProfileSchema.safeParse({ name: "Júlia" }).success).toBe(false);
    expect(portalProfileSchema.safeParse({ name: "Júlia", phone: "(11) 98765-4321" }).success).toBe(true);
  });

  it("senha nova segue o mínimo de 10", () => {
    expect(setPasswordSchema.safeParse({ newPassword: "curta" }).success).toBe(false);
    expect(
      setPasswordSchema.safeParse({ newPassword: "senha-com-dez" }).success,
    ).toBe(true);
  });
});
