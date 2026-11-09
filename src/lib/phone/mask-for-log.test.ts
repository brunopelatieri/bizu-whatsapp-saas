import { describe, expect, it } from "vitest";
import { maskPhoneForLog } from "./mask-for-log";

describe("maskPhoneForLog", () => {
  it("mantém 5 dígitos no início e 4 no fim, com a pontuação", () => {
    expect(maskPhoneForLog("55 11 98765-4321")).toBe("55 11 9****-4321");
    expect(maskPhoneForLog("5511987654321")).toBe("55119****4321");
    expect(maskPhoneForLog("+55 (11) 98765-4321")).toBe("+55 (11) 9****-4321");
  });

  it("mascara tudo em número curto", () => {
    expect(maskPhoneForLog("1234-5678")).toBe("****-****");
  });

  it("vazio devolve traço", () => {
    expect(maskPhoneForLog(null)).toBe("—");
    expect(maskPhoneForLog(undefined)).toBe("—");
    expect(maskPhoneForLog("")).toBe("—");
  });
});
