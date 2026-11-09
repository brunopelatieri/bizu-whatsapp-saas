import { describe, expect, it, vi } from "vitest";
import type { EvolutionConfig } from "@/lib/channels/providers/whatsapp_qr/client";
import {
  buildInstanceName,
  connectInstance,
  countRemoteInstances,
  createRemoteInstance,
  deleteRemoteInstance,
  fetchPairingCode,
  fetchQr,
  fetchStatus,
  slugifyLabel,
  SUBSCRIBED_EVENTS,
  webhookUrlFor,
} from "@/lib/channels/providers/whatsapp_qr/instances";
import { jsonResponse } from "@/lib/channels/test-fixtures";

const GLOBAL = "chave-global-de-teste";
const TOKEN = "token-da-instancia";

function setup(responses: Array<() => Response>) {
  const queue = [...responses];
  const fetchFn = vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fetch sem resposta simulada");
    return next();
  });
  const config: EvolutionConfig = {
    apiUrl: "https://evolution.test",
    globalApiKey: GLOBAL,
    requestTimeoutMs: 5000,
    mediaTimeoutMs: 60_000,
    webhookPublicUrl: "https://app.test",
    instancePrefix: "bizu",
    maxInstancesTotal: 20,
    mediaOrigins: [],
    fetchFn,
  };

  return { config, fetchFn };
}

const reply = (name: string, status = 200) => () => jsonResponse(name, status);

describe("buildInstanceName", () => {
  it("<prefixo>_<8 hex do escopo>_<slug>_<4 hex>", () => {
    expect(buildInstanceName("bizu", "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "Vendas SP")).toMatch(
      /^bizu_a1b2c3d4_vendas-sp_[0-9a-f]{4}$/,
    );
  });

  it("a plataforma usa uma chave estável, completada com zeros", () => {
    expect(buildInstanceName("bizu", "platform", "Suporte")).toMatch(/^bizu_platform_suporte_[0-9a-f]{4}$/);
    expect(buildInstanceName("bizu", "ab", "x")).toMatch(/^bizu_ab000000_x_[0-9a-f]{4}$/);
  });

  it("dois nomes para o mesmo rótulo não colidem (sufixo aleatório)", () => {
    const names = new Set(Array.from({ length: 40 }, () => buildInstanceName("bizu", "a1b2c3d4", "x")));

    expect(names.size).toBeGreaterThan(30);
  });
});

describe("slugifyLabel", () => {
  it.each([
    ["Vendas SP", "vendas-sp"],
    ["Atendimento Açaí & Café", "atendimento-acai-cafe"],
    ["  --Loja 1--  ", "loja-1"],
    ["x".repeat(60), "x".repeat(24)],
    ["😀😀", "instancia"],
    ["", "instancia"],
    [`${"a".repeat(23)} b`, "a".repeat(23)],
  ])("%j → %j", (label, slug) => {
    expect(slugifyLabel(label)).toBe(slug);
  });
});

describe("criar e excluir instância (chave global)", () => {
  it("createRemoteInstance manda nome e token, e guarda o id remoto", async () => {
    const { config, fetchFn } = setup([reply("evolution/api/create-ok")]);

    await expect(createRemoteInstance(config, { name: "bizu_x_y_0001", token: TOKEN })).resolves.toEqual({
      id: "11111111-2222-3333-4444-555555555555",
      name: "bizu_x_y_0001",
    });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://evolution.test/instance/create");
    expect(init?.headers).toMatchObject({ apikey: GLOBAL });
    expect(JSON.parse(String(init?.body))).toEqual({ name: "bizu_x_y_0001", token: TOKEN });
  });

  it("deleteRemoteInstance: 404 (já não existe) é sucesso; outro erro sobe", async () => {
    const gone = setup([() => new Response("404 page not found", { status: 404 })]);
    await expect(deleteRemoteInstance(gone.config, "abc")).resolves.toBeUndefined();
    expect(String(gone.fetchFn.mock.calls[0]?.[0])).toBe("https://evolution.test/instance/delete/abc");

    const broken = setup([() => new Response("boom", { status: 500 })]);
    await expect(deleteRemoteInstance(broken.config, "abc")).rejects.toMatchObject({ status: 500 });
  });

  it("o id remoto vai codificado no caminho (não muda o endereço)", async () => {
    const { config, fetchFn } = setup([() => new Response("{}", { status: 200 })]);

    await deleteRemoteInstance(config, "../all");

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://evolution.test/instance/delete/..%2Fall");
  });

  it("countRemoteInstances conta as de todos os escopos", async () => {
    const { config } = setup([reply("evolution/api/all-ok")]);

    await expect(countRemoteInstances(config)).resolves.toBe(2);
  });
});

describe("connectInstance", () => {
  it("registra webhook (segredo no caminho) e as cinco famílias, com o token da instância", async () => {
    const { config, fetchFn } = setup([reply("evolution/api/connect-ok")]);

    await expect(
      connectInstance(config, { instanceToken: TOKEN, webhookSecret: "segredo123" }),
    ).resolves.toEqual({ eventStringMismatch: false });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://evolution.test/instance/connect");
    expect(init?.headers).toMatchObject({ apikey: TOKEN });
    expect(JSON.parse(String(init?.body))).toEqual({
      immediate: true,
      subscribe: ["MESSAGE", "SEND_MESSAGE", "READ_RECEIPT", "CONNECTION", "QRCODE"],
      webhookUrl: "https://app.test/api/webhooks/whatsapp/evolution/segredo123",
    });
    expect(SUBSCRIBED_EVENTS).toHaveLength(5);
  });

  it("avisa quando o servidor aceitou menos eventos do que pedimos", async () => {
    const { config } = setup([reply("evolution/api/connect-partial-events")]);

    await expect(connectInstance(config, { instanceToken: TOKEN, webhookSecret: "s" })).resolves.toEqual({
      eventStringMismatch: true,
    });
  });

  it("webhookUrlFor usa o endereço público sem barra final", () => {
    const { config } = setup([]);

    expect(webhookUrlFor({ ...config, webhookPublicUrl: "https://app.test" }, "s")).toBe(
      "https://app.test/api/webhooks/whatsapp/evolution/s",
    );
  });
});

describe("QR e pareamento", () => {
  it("fetchQr devolve imagem e texto do código", async () => {
    const { config } = setup([reply("evolution/api/qr-ok")]);

    await expect(fetchQr(config, TOKEN)).resolves.toEqual({
      alreadyConnected: false,
      qrcode: "data:image/png;base64,iVBORw0KGgo=",
      code: "2@fakeqrcode,fake,fake",
    });
  });

  it('"session already logged in" não é erro: já conectado', async () => {
    const { config } = setup([reply("evolution/api/qr-already-logged-in", 400)]);

    await expect(fetchQr(config, TOKEN)).resolves.toEqual({ alreadyConnected: true });
  });

  it("outro erro do QR sobe", async () => {
    const { config } = setup([reply("evolution/api/error-unauthorized", 401)]);

    await expect(fetchQr(config, TOKEN)).rejects.toMatchObject({ status: 401 });
  });

  it("fetchPairingCode manda o telefone e devolve o código", async () => {
    const { config, fetchFn } = setup([reply("evolution/api/pair-ok")]);

    await expect(fetchPairingCode(config, { instanceToken: TOKEN, phone: "5511988880001" })).resolves.toEqual({
      pairingCode: "ABCD-1234",
    });
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).phone).toBe("5511988880001");
  });

  it("resposta sem código é erro", async () => {
    const { config } = setup([() => new Response('{"data":{}}', { status: 200, headers: { "content-type": "application/json" } })]);

    await expect(fetchPairingCode(config, { instanceToken: TOKEN, phone: "5511988880001" })).rejects.toMatchObject({
      kind: "bad_request",
    });
  });
});

describe("fetchStatus", () => {
  it.each([
    ["connected", "connected"],
    ["connecting", "connecting"],
    ["disconnected", "disconnected"],
  ])("%s", async (fixture, status) => {
    const { config } = setup([reply(`evolution/api/status-${fixture}`)]);

    await expect(fetchStatus(config, TOKEN)).resolves.toMatchObject({ status });
  });
});
