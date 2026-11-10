import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: "segredo-de-teste-com-mais-de-32-caracteres-ok",
  APP_URL: "https://app.exemplo.com",
  EVOLUTION_WEBHOOK_PUBLIC_URL: undefined as string | undefined,
}));
vi.mock("@/lib/env", () => ({ getEnv: () => env }));

import {
  MEDIA_OUT_TTL_SECONDS,
  mediaOutUrl,
  signMediaOutToken,
  verifyMediaOutToken,
} from "@/lib/inbox/media-out";

describe("token do anexo de saída", () => {
  const fileId = randomUUID();
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);

  afterEach(() => {
    env.BETTER_AUTH_SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
    env.EVOLUTION_WEBHOOK_PUBLIC_URL = undefined;
  });

  it("vale para o arquivo assinado, dentro dos 5 minutos", () => {
    const token = signMediaOutToken(fileId, now);

    expect(verifyMediaOutToken(token, now)).toBe(fileId);
    expect(verifyMediaOutToken(token, now + (MEDIA_OUT_TTL_SECONDS - 1) * 1000)).toBe(fileId);
  });

  it("vencido não vale", () => {
    const token = signMediaOutToken(fileId, now);

    expect(verifyMediaOutToken(token, now + MEDIA_OUT_TTL_SECONDS * 1000)).toBeNull();
    expect(verifyMediaOutToken(token, now + 3600_000)).toBeNull();
  });

  it("trocar o id do arquivo invalida a assinatura (token de outro arquivo)", () => {
    const [, expires, signature] = signMediaOutToken(fileId, now).split(".");

    expect(verifyMediaOutToken(`${randomUUID()}.${expires}.${signature}`, now)).toBeNull();
  });

  it("adiar o prazo à mão invalida a assinatura", () => {
    const [id, expires, signature] = signMediaOutToken(fileId, now).split(".");
    const later = Number(expires) + 3600;

    expect(verifyMediaOutToken(`${id}.${later}.${signature}`, now)).toBeNull();
    // Mesmo com o prazo dentro da janela, a assinatura é do prazo original.
    expect(verifyMediaOutToken(`${id}.${Number(expires) - 10}.${signature}`, now)).toBeNull();
  });

  it("assinatura adulterada, truncada ou vazia não vale", () => {
    const token = signMediaOutToken(fileId, now);

    expect(verifyMediaOutToken(`${token}x`, now)).toBeNull();
    expect(verifyMediaOutToken(token.slice(0, -2), now)).toBeNull();
    expect(verifyMediaOutToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, now)).toBeNull();
    expect(verifyMediaOutToken(`${fileId}.${Math.floor(now / 1000) + 60}.`, now)).toBeNull();
  });

  it("lixo e formatos estranhos não valem", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", `nao-uuid.${Math.floor(now / 1000) + 60}.x`, `${fileId}.-1.x`]) {
      expect(verifyMediaOutToken(bad, now)).toBeNull();
    }
  });

  it("token assinado com outro segredo não vale", () => {
    const token = signMediaOutToken(fileId, now);
    env.BETTER_AUTH_SECRET = "outro-segredo-de-teste-com-mais-de-32-caracteres";

    expect(verifyMediaOutToken(token, now)).toBeNull();
  });

  it("a URL usa o endereço que a Evolution alcança (padrão APP_URL)", () => {
    expect(mediaOutUrl(fileId)).toMatch(
      new RegExp(`^https://app\\.exemplo\\.com/api/inbox/media-out/${fileId}\\.\\d+\\.[\\w-]+$`),
    );

    env.EVOLUTION_WEBHOOK_PUBLIC_URL = "http://bizu.interno:3000/";
    expect(mediaOutUrl(fileId)).toMatch(/^http:\/\/bizu\.interno:3000\/api\/inbox\/media-out\//);
  });
});
