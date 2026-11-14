import { describe, expect, it } from "vitest";
import { phoneChangeErrorMessage, responsibleText } from "@/components/phone/phone-change-api";
import { ApiError } from "@/lib/api/client";

describe("troca de telefone: textos das telas", () => {
  it("diz quem responde pela troca", () => {
    expect(responsibleText({ responsible: "platform", tenantName: null })).toBe(
      "do proprietário da plataforma",
    );
    expect(responsibleText({ responsible: "organization", tenantName: "Clínica Acme" })).toBe(
      "de quem administra Clínica Acme",
    );
    expect(responsibleText({ responsible: "organization", tenantName: null })).toBe(
      "de quem administra a organização",
    );
  });

  it("uma mensagem para cada recusa conhecida do pedido", () => {
    expect(phoneChangeErrorMessage(new ApiError("x", 400, "PHONE_UNCHANGED"))).toMatch(
      /já é o número do cadastro/,
    );
    expect(phoneChangeErrorMessage(new ApiError("x", 429, "PHONE_VERIFICATION_LIMIT"))).toMatch(
      /máximo de links/,
    );
    expect(phoneChangeErrorMessage(new ApiError("x", 429))).toMatch(/Muitos pedidos/);
    expect(phoneChangeErrorMessage(new ApiError("x", 403, "IMPERSONATION_BLOCKED"))).toMatch(
      /acesso de suporte/,
    );
  });

  it("o resto vem da API ou do texto padrão", () => {
    expect(phoneChangeErrorMessage(new ApiError("Número inválido.", 400, "OUTRO"))).toBe(
      "Número inválido.",
    );
    expect(phoneChangeErrorMessage(new Error("falhou"))).toBe("falhou");
    expect(phoneChangeErrorMessage("texto")).toBe("Não foi possível pedir a troca.");
  });
});
