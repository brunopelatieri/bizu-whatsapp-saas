import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cloudDedupeKey,
  verifyChallenge,
  verifyCloudWebhook,
  verifyMetaSignature,
} from "@/lib/channels/providers/whatsapp_cloud/webhook";
import { fixtureText } from "@/lib/channels/test-fixtures";
import type { WebhookContext } from "@/lib/channels/types";

const SECRET = "app-secret-de-teste-do-canal-a";
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyMetaSignature", () => {
  const body = fixtureText("cloud/message-text");

  it("aceita a assinatura do corpo cru com o segredo do canal", () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("recusa corpo adulterado (um byte basta)", () => {
    expect(verifyMetaSignature(`${body} `, sign(body), SECRET)).toBe(false);
  });

  it("recusa assinatura feita com o segredo de outro canal", () => {
    expect(verifyMetaSignature(body, sign(body, "segredo-do-canal-b"), SECRET)).toBe(false);
  });

  it("falha fechada sem segredo, sem cabeçalho ou sem o prefixo sha256=", () => {
    expect(verifyMetaSignature(body, sign(body), undefined)).toBe(false);
    expect(verifyMetaSignature(body, sign(body), "")).toBe(false);
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, sign(body).slice("sha256=".length), SECRET)).toBe(false);
    expect(verifyMetaSignature(body, "sha1=abc", SECRET)).toBe(false);
  });

  it("assinatura de tamanho diferente não lança", () => {
    expect(verifyMetaSignature(body, "sha256=abc", SECRET)).toBe(false);
  });
});

describe("verifyChallenge", () => {
  const ok = { mode: "subscribe", token: "token-do-canal", challenge: "1158201444" };

  it("devolve o desafio com o token certo", () => {
    expect(verifyChallenge(ok, "token-do-canal")).toBe("1158201444");
  });

  it("recusa token errado, modo errado e desafio ausente", () => {
    expect(verifyChallenge({ ...ok, token: "outro" }, "token-do-canal")).toBeNull();
    expect(verifyChallenge({ ...ok, mode: "unsubscribe" }, "token-do-canal")).toBeNull();
    expect(verifyChallenge({ ...ok, challenge: null }, "token-do-canal")).toBeNull();
  });

  it("canal desconhecido (sem token esperado) responde igual a token errado", () => {
    expect(verifyChallenge(ok, undefined)).toBeNull();
    expect(verifyChallenge({ ...ok, token: "" }, "")).toBeNull();
    expect(verifyChallenge({ ...ok, token: null }, undefined)).toBeNull();
  });
});

describe("verifyCloudWebhook", () => {
  const rawBody = fixtureText("cloud/message-text");
  const ctx = (
    headers: Record<string, string | undefined>,
    appSecret?: string,
  ): WebhookContext => ({
    rawBody,
    headers,
    credentials: appSecret ? { appSecret } : ({} as Record<string, string>),
    config: {},
  });

  it("assinatura válida: ok e dedupeKey = sha256 do corpo", async () => {
    const result = await verifyCloudWebhook(ctx({ "x-hub-signature-256": sign(rawBody) }, SECRET));

    expect(result).toEqual({ ok: true, dedupeKey: cloudDedupeKey(rawBody) });
    expect(cloudDedupeKey(rawBody)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("assinatura adulterada ou ausente: não ok e nunca lança", async () => {
    await expect(
      verifyCloudWebhook(ctx({ "x-hub-signature-256": sign(`${rawBody}x`) }, SECRET)),
    ).resolves.toMatchObject({ ok: false });
    await expect(verifyCloudWebhook(ctx({}, SECRET))).resolves.toMatchObject({ ok: false });
  });

  it("canal sem app_secret: falha fechada, mesmo com assinatura de segredo vazio", async () => {
    const forged = `sha256=${createHmac("sha256", "").update(rawBody).digest("hex")}`;

    await expect(
      verifyCloudWebhook(ctx({ "x-hub-signature-256": forged })),
    ).resolves.toMatchObject({ ok: false });
  });

  it("mesmo corpo, mesmo dedupeKey (a Meta reentrega o mesmo corpo)", () => {
    expect(cloudDedupeKey(rawBody)).toBe(cloudDedupeKey(rawBody));
    expect(cloudDedupeKey(rawBody)).not.toBe(cloudDedupeKey(`${rawBody}\n`));
  });
});
