import { describe, expect, it } from "vitest";
import { releaseErrorMessage } from "@/components/phone/phone-release-api";
import { ApiError } from "@/lib/api/client";

describe("releaseErrorMessage", () => {
  it("dá uma mensagem própria para cada recusa da liberação", () => {
    const texts = [
      ["SELF_CONFIRMATION", 403],
      ["PHONE_IN_USE", 409],
      ["PLATFORM_ONLY", 409],
      ["VERIFICATION_STALE", 409],
    ].map(([code, status]) =>
      releaseErrorMessage(new ApiError("texto da API", status as number, code as string)),
    );

    expect(new Set(texts).size).toBe(4);
    expect(texts.every((text) => text !== "texto da API")).toBe(true);
  });

  it("explica o 404 e repassa a mensagem de outro erro", () => {
    expect(releaseErrorMessage(new ApiError("x", 404))).toMatch(/não encontrado/i);
    expect(releaseErrorMessage(new ApiError("falhou", 500))).toBe("falhou");
    expect(releaseErrorMessage("?")).toBe("Não foi possível liberar o telefone.");
  });
});
