import { describe, expect, it } from "vitest";
import {
  BR_AREA_CODES,
  canWhatsApp,
  formatPhoneForDisplay,
  normalizePhone,
  phoneErrorMessage,
  phonesMatch,
  phoneVariants,
  phoneWarning,
} from "./br";

const reason = (raw: string) => {
  const result = normalizePhone(raw);
  return result.ok ? null : result.reason;
};

describe("normalizePhone: celular do Brasil", () => {
  it.each([
    "+55 (11) 98765-4321",
    "5511987654321",
    "011 98765-4321",
    "(11) 98765-4321",
    "11 98765-4321",
    "11987654321",
  ])("normaliza %s", (raw) => {
    expect(normalizePhone(raw)).toMatchObject({
      ok: true,
      phone: "5511987654321",
      kind: "mobile",
      ddd: 11,
      legacy: false,
    });
  });

  it("DDD 55 sem DDI não se confunde com o DDI", () => {
    expect(normalizePhone("55987654321")).toMatchObject({ ok: true, phone: "5555987654321", ddd: 55 });
    expect(normalizePhone("5551987654321")).toMatchObject({ ok: true, phone: "5551987654321", ddd: 51 });
  });

  it("aceita os 67 DDDs e recusa os de fora da lista", () => {
    expect(BR_AREA_CODES.size).toBe(67);
    for (const ddd of BR_AREA_CODES) {
      expect(normalizePhone(`${ddd}987654321`)).toMatchObject({ ok: true, kind: "mobile" });
    }
    for (const ddd of [10, 20, 23, 25, 26, 29, 36, 39, 40, 50, 52, 56, 60, 70, 72, 76, 78, 80, 90]) {
      expect(reason(`${ddd}987654321`)).toBe("invalid_ddd");
    }
  });

  it.each(["10 98765-4321", "23 98765-4321", "90 98765-4321", "+55 10 98765-4321"])(
    "DDD inexistente em %s",
    (raw) => expect(reason(raw)).toBe("invalid_ddd"),
  );

  it("exige 9 depois do DDD no celular", () => {
    expect(reason("11 88765-4321")).toBe("mobile_invalid_ninth_digit");
  });
});

describe("normalizePhone: fixo e celular antigo (aceitos com aviso)", () => {
  it("fixo é válido como landline", () => {
    expect(normalizePhone("11 3456-7890")).toMatchObject({ ok: true, phone: "551134567890", kind: "landline" });
  });

  it("celular de 8 dígitos é mobile_legacy e nunca ganha o 9", () => {
    expect(normalizePhone("11 9876-5432")).toMatchObject({
      ok: true,
      phone: "551198765432",
      kind: "mobile_legacy",
      legacy: true,
    });
  });

  it("recusa local iniciado em 0 ou 1", () => {
    expect(reason("11 0456-7890")).toBe("invalid_local_prefix");
    expect(reason("11 1456-7890")).toBe("invalid_local_prefix");
  });

  it("recusa celular antigo com DDD inexistente ou tamanho errado", () => {
    expect(reason("10 9876-5432")).toBe("invalid_ddd");
    expect(reason("11 9876-543")).toBe("invalid_length");
    expect(reason("11 98765-43")).toBe("invalid_length");
  });
});

describe("normalizePhone: entradas inválidas", () => {
  it("vazio e lixo", () => {
    expect(reason("")).toBe("empty");
    expect(reason("   ")).toBe("empty");
    expect(reason("abc")).toBe("empty");
  });

  it("sem DDD", () => {
    expect(reason("9876-5432")).toBe("missing_area_code");
    expect(reason("98765-4321")).toBe("missing_area_code");
  });

  it("0800 é recusado", () => {
    expect(normalizePhone("0800 123 4567").ok).toBe(false);
  });

  it("entrada longa demais é cortada antes do parsing", () => {
    expect(reason("1".repeat(31))).toBe("invalid_length");
  });
});

describe("normalizePhone: estrangeiro (só DDI 55 usa a regra do Brasil)", () => {
  it.each(["+1 415 555 2671", "+44 20 7946 0958", "+1 115 555 2671", "+351 912 345 678"])(
    "%s é foreign",
    (raw) => {
      const result = normalizePhone(raw);
      expect(result).toMatchObject({ ok: true, kind: "foreign", ddd: null });
      if (result.ok) expect(result.key).toBe(result.phone);
    },
  );

  it("E.164 de 8 a 15 dígitos", () => {
    expect(reason("+999")).toBe("invalid_length");
    expect(reason("+1234567")).toBe("invalid_length");
    expect(normalizePhone("+12345678")).toMatchObject({ ok: true, kind: "foreign" });
    expect(reason("+1234567890123456")).toBe("invalid_length");
  });

  it("colado sem + com 12 a 15 dígitos que não começam em 55", () => {
    expect(normalizePhone("351912345678")).toMatchObject({ ok: true, kind: "foreign" });
  });
});

describe("phone_key", () => {
  const key = (raw: string) => {
    const result = normalizePhone(raw);
    return result.ok ? result.key : null;
  };

  it("é igual com e sem o 9º dígito", () => {
    expect(key("5511987654321")).toBe(key("551187654321"));
    expect(key("11 98765-4321")).toBe("551187654321");
    expect(key("11 9876-5432")).toBe(key("11 99876-5432"));
  });

  it("difere entre fixos e números distintos", () => {
    expect(key("11 3456-7890")).not.toBe(key("11 3456-7891"));
    expect(key("11 98765-4321")).not.toBe(key("21 98765-4321"));
  });
});

describe("canWhatsApp, mensagens e avisos", () => {
  it("só celular e estrangeiro iniciam conversa", () => {
    expect(canWhatsApp("mobile")).toBe(true);
    expect(canWhatsApp("foreign")).toBe(true);
    expect(canWhatsApp("landline")).toBe(false);
    expect(canWhatsApp("mobile_legacy")).toBe(false);
  });

  it("mensagens e avisos em português", () => {
    expect(phoneErrorMessage("empty")).toBe("Informe o telefone.");
    expect(phoneErrorMessage("invalid_ddd")).toBe("DDD inexistente.");
    expect(phoneWarning("landline")).toContain("não recebe WhatsApp");
    expect(phoneWarning("mobile_legacy")).toContain("confira se falta o 9");
    expect(phoneWarning("mobile")).toBeNull();
    expect(phoneWarning("foreign")).toBeNull();
  });
});

describe("formatPhoneForDisplay", () => {
  it("formata celular e fixo do Brasil", () => {
    expect(formatPhoneForDisplay("5519999249658")).toBe("+55 (19) 99924-9658");
    expect(formatPhoneForDisplay("551134567890")).toBe("+55 (11) 3456-7890");
  });

  it("cai no fallback para estrangeiro e nunca lança", () => {
    expect(formatPhoneForDisplay("351912345678")).toBe("+351912345678");
    expect(formatPhoneForDisplay("")).toBe("");
  });
});

describe("phoneVariants e phonesMatch", () => {
  it("devolve as duas formas do celular do Brasil", () => {
    expect(phoneVariants("5511987654321")).toEqual(["5511987654321", "551187654321"]);
    expect(phoneVariants("551187654321")).toEqual(["551187654321", "5511987654321"]);
  });

  it("não inventa variante para fixo nem para estrangeiro", () => {
    expect(phoneVariants("551134567890")).toEqual(["551134567890"]);
    expect(phoneVariants("14155552671")).toEqual(["14155552671"]);
  });

  it("casa com e sem o 9º dígito", () => {
    expect(phonesMatch("551198765432", "5511998765432")).toBe(true);
    expect(phonesMatch("5511987654321", "5511987654322")).toBe(false);
  });
});
