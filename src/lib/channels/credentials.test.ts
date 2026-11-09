import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  aadOf,
  generateInstanceToken,
  generateVerifyToken,
  generateWebhookKey,
  generateWebhookSecret,
  openSecret,
  sealSecret,
} from "@/lib/channels/credentials";
import { SecretDecryptError, type SecretKeyRing } from "@/lib/crypto/secrets";

const ring: SecretKeyRing = { version: 1, key: randomBytes(32) };

describe("segredos de canal", () => {
  const channelId = randomUUID();

  it("cifra e decifra, e o texto cifrado não contém o segredo", () => {
    const token = sealSecret(channelId, "accessToken", "EAAB-token-secreto", ring);

    expect(token).not.toContain("EAAB");
    expect(openSecret(channelId, "accessToken", token, ring)).toBe("EAAB-token-secreto");
  });

  it("aad = channel:<id>:<campo>", () => {
    expect(aadOf("abc", "appSecret")).toBe("channel:abc:appSecret");
  });

  it("a cifra copiada para outro canal não decifra", () => {
    const token = sealSecret(channelId, "accessToken", "segredo", ring);

    expect(() => openSecret(randomUUID(), "accessToken", token, ring)).toThrow(SecretDecryptError);
  });

  it("a cifra copiada para outro campo do mesmo canal não decifra", () => {
    const token = sealSecret(channelId, "accessToken", "segredo", ring);

    expect(() => openSecret(channelId, "appSecret", token, ring)).toThrow(SecretDecryptError);
  });

  it("cada cifra tem nonce próprio", () => {
    expect(sealSecret(channelId, "appSecret", "x", ring)).not.toBe(
      sealSecret(channelId, "appSecret", "x", ring),
    );
  });

  it("chave errada não decifra", () => {
    const token = sealSecret(channelId, "accessToken", "segredo", ring);

    expect(() =>
      openSecret(channelId, "accessToken", token, { version: 1, key: randomBytes(32) }),
    ).toThrow(SecretDecryptError);
  });
});

describe("geradores", () => {
  it("chave do webhook: 32 hex; token de verificação: 48 hex; segredo da Evolution: 43 base64url", () => {
    expect(generateWebhookKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateVerifyToken()).toMatch(/^[0-9a-f]{48}$/);
    expect(generateWebhookSecret()).toMatch(/^[\w-]{43}$/);
    expect(generateInstanceToken()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("não repetem", () => {
    expect(new Set(Array.from({ length: 50 }, generateWebhookKey)).size).toBe(50);
    expect(new Set(Array.from({ length: 50 }, generateWebhookSecret)).size).toBe(50);
  });
});
