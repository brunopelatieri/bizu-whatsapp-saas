import { describe, expect, it } from "vitest";
import {
  evolutionDedupeKey,
  hashWebhookSecret,
  isAllowedMediaUrl,
  verifyEvolutionWebhook,
} from "@/lib/channels/providers/whatsapp_qr/webhook";
import { fixture, fixtureText } from "@/lib/channels/test-fixtures";

const INSTANCE_ID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "test-instance-token-0001";

const ctx = (rawBody: string, overrides: { instanceId?: string; token?: string } = {}) => ({
  rawBody,
  headers: {},
  credentials: { instanceToken: overrides.token ?? TOKEN },
  config: { remoteInstanceId: overrides.instanceId ?? INSTANCE_ID },
});

describe("verifyEvolutionWebhook (cadeia de verificação)", () => {
  const rawBody = fixtureText("evolution/message-text");

  it("instanceId e instanceToken do corpo batem com os da instância: ok", async () => {
    await expect(verifyEvolutionWebhook(ctx(rawBody))).resolves.toEqual({
      ok: true,
      dedupeKey: "MESSAGE:3EB0AAAA0001",
    });
  });

  it("instanceId de outra instância: recusado", async () => {
    await expect(
      verifyEvolutionWebhook(ctx(rawBody, { instanceId: "99999999-0000-0000-0000-000000000000" })),
    ).resolves.toMatchObject({ ok: false });
  });

  it("instanceToken errado: recusado", async () => {
    await expect(verifyEvolutionWebhook(ctx(rawBody, { token: "outro-token" }))).resolves.toMatchObject({
      ok: false,
    });
  });

  it("token de tamanho diferente não lança", async () => {
    await expect(verifyEvolutionWebhook(ctx(rawBody, { token: "x" }))).resolves.toMatchObject({ ok: false });
  });

  it("falta qualquer elo da cadeia: recusado, sem detalhe", async () => {
    const body = fixture<Record<string, unknown>>("evolution/message-text");
    const without = (key: string) => JSON.stringify({ ...body, [key]: undefined });

    for (const rawBody of [without("instanceId"), without("instanceToken"), "não é json", "[]", ""]) {
      await expect(verifyEvolutionWebhook(ctx(rawBody)), rawBody).resolves.toEqual({
        ok: false,
        reason: "unauthorized",
      });
    }
    // Instância sem token ou sem id gravado: falha fechada, não "sem verificação".
    await expect(
      verifyEvolutionWebhook({ rawBody, headers: {}, credentials: {}, config: {} }),
    ).resolves.toMatchObject({ ok: false });
    await expect(verifyEvolutionWebhook(ctx(rawBody, { instanceId: "", token: "" }))).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("evolutionDedupeKey", () => {
  const key = (name: string) => {
    const raw = fixtureText(`evolution/${name}`);
    return evolutionDedupeKey(JSON.parse(raw), raw);
  };

  it("mensagem: tipo do evento + Info.ID; o eco do mesmo id é outro evento", () => {
    expect(key("message-text")).toBe("MESSAGE:3EB0AAAA0001");
    expect(key("send-message-echo")).toBe("SENDMESSAGE:3EB0OUT00002");
  });

  it("recibo: evento + estado + ids ordenados", () => {
    expect(key("receipt-delivered")).toBe("RECEIPT:delivered:3EB0OUT00001,3EB0OUT00002");
    expect(key("receipt-read")).toBe("RECEIPT:read:3EB0OUT00001");
  });

  it("Delivered e Read do mesmo id não colidem", () => {
    expect(key("receipt-delivered")).not.toBe(key("receipt-read"));
  });

  it("conexão: o nome do evento + sha256 do corpo", () => {
    expect(key("connected")).toMatch(/^CONNECTED:[0-9a-f]{64}$/);
    expect(key("logged-out")).toMatch(/^LOGGEDOUT:[0-9a-f]{64}$/);
    expect(key("connected")).toBe(key("connected"));
  });

  it("a mesma reentrega gera a mesma chave, mesmo com ordem de campos diferente", () => {
    const original = fixture<Record<string, unknown>>("evolution/message-text");
    const reordered = { data: original.data, instanceToken: original.instanceToken, event: original.event };

    expect(evolutionDedupeKey(reordered, JSON.stringify(reordered))).toBe(key("message-text"));
  });
});

describe("hashWebhookSecret", () => {
  it("sha256 em hex, estável, e não devolve o segredo", () => {
    const hash = hashWebhookSecret("segredo-do-caminho");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashWebhookSecret("segredo-do-caminho"));
    expect(hash).not.toContain("segredo");
    expect(hash).not.toBe(hashWebhookSecret("outro"));
  });
});

describe("isAllowedMediaUrl (SSRF)", () => {
  const origins = ["https://s3.exemplo.com", "http://minio.interno:9000"];

  it.each([
    ["https://s3.exemplo.com/bucket/a.jpg?X-Amz-Signature=x", true],
    ["http://minio.interno:9000/bucket/a.jpg", true],
    // esquema, host ou porta diferentes da origem da lista
    ["http://s3.exemplo.com/a.jpg", false],
    ["https://minio.interno:9000/a.jpg", false],
    ["http://minio.interno:9001/a.jpg", false],
    ["http://minio.interno/a.jpg", false],
    ["https://s3.exemplo.com.evil.test/a.jpg", false],
    ["https://evil.test/https://s3.exemplo.com/a.jpg", false],
    ["https://user:pass@s3.exemplo.com/a.jpg", false],
    ["https://s3.exemplo.com@evil.test/a.jpg", false],
    ["file:///etc/passwd", false],
    ["http://169.254.169.254/latest/meta-data", false],
    ["http://localhost:5432", false],
    ["não é url", false],
  ])("%s = %s", (url, expected) => {
    expect(isAllowedMediaUrl(url, origins)).toBe(expected);
  });

  it("lista vazia: nada é permitido (só base64)", () => {
    expect(isAllowedMediaUrl("https://s3.exemplo.com/a.jpg", [])).toBe(false);
  });

  it("http: só vale se a própria entrada da lista for http:", () => {
    expect(isAllowedMediaUrl("http://s3.exemplo.com/a.jpg", ["https://s3.exemplo.com"])).toBe(false);
    expect(isAllowedMediaUrl("http://s3.exemplo.com/a.jpg", ["http://s3.exemplo.com"])).toBe(true);
  });
});
