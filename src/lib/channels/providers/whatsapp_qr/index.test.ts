import { describe, expect, it, vi } from "vitest";
import { ChannelNotConfiguredError } from "@/lib/channels/errors";
import { createEvolutionProvider, extractProviderMessageId } from "@/lib/channels/providers/whatsapp_qr";
import type { EvolutionConfig } from "@/lib/channels/providers/whatsapp_qr/client";
import { fixture, jsonResponse } from "@/lib/channels/test-fixtures";
import type { ChannelContext } from "@/lib/channels/types";

const ctx: ChannelContext = {
  channelId: "c1",
  type: "whatsapp_qr",
  credentials: { instanceToken: "token-da-instancia", webhookSecret: "s" },
};

function setup(respond: () => Response) {
  const fetchFn = vi.fn<typeof fetch>(async () => respond());
  const config: EvolutionConfig = {
    apiUrl: "https://evolution.test",
    globalApiKey: "chave-global",
    requestTimeoutMs: 5000,
    mediaTimeoutMs: 60_000,
    webhookPublicUrl: "https://app.test",
    instancePrefix: "bizu",
    maxInstancesTotal: 20,
    mediaOrigins: [],
    fetchFn,
  };

  return { fetchFn, provider: createEvolutionProvider(config) };
}

describe("extractProviderMessageId", () => {
  it("lê Info.ID (maiúsculo e aninhado), o formato medido", () => {
    const { data } = fixture<{ data: Record<string, unknown> }>("evolution/api/send-text-ok");

    expect(extractProviderMessageId(data)).toBe("3EB0SENT0001");
  });

  it("alternativas e, no pior caso, vazio: nunca lança (a mensagem já saiu)", () => {
    expect(extractProviderMessageId({ key: { id: "K1" } })).toBe("K1");
    expect(extractProviderMessageId({ ID: "R1" })).toBe("R1");
    expect(extractProviderMessageId({ Message: {} })).toBe("");
    expect(extractProviderMessageId({})).toBe("");
  });
});

describe("provedor whatsapp_qr", () => {
  it("declara capacidades de canal por QR Code", () => {
    const { provider } = setup(() => jsonResponse("evolution/api/send-text-ok"));

    expect(provider.capabilities).toMatchObject({ pairing: true, deviceEcho: true, templates: false });
    expect(provider.sendTemplate).toBeUndefined();
  });

  it("sendText: só dígitos, token da instância, citação em `quoted`", async () => {
    const { provider, fetchFn } = setup(() => jsonResponse("evolution/api/send-text-ok"));

    await expect(
      provider.sendText(ctx, { to: "+55 (11) 98888-0001", text: "Olá", quotedProviderMessageId: "3EB0IN" }),
    ).resolves.toEqual({ providerMessageId: "3EB0SENT0001" });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://evolution.test/send/text");
    expect(init?.headers).toMatchObject({ apikey: "token-da-instancia" });
    expect(JSON.parse(String(init?.body))).toEqual({
      number: "5511988880001",
      text: "Olá",
      quoted: { messageId: "3EB0IN" },
    });
  });

  it("resposta 200 sem id não lança e devolve vazio", async () => {
    const { provider } = setup(() => jsonResponse("evolution/api/send-text-no-id"));

    await expect(provider.sendText(ctx, { to: "5511988880001", text: "oi" })).resolves.toEqual({
      providerMessageId: "",
    });
  });

  it("sendMedia: tipo e legenda; só envia por endereço", async () => {
    const { provider, fetchFn } = setup(() => jsonResponse("evolution/api/send-text-ok"));

    await provider.sendMedia(ctx, {
      to: "5511988880001",
      kind: "image",
      url: "https://s3.test/a.jpg?sig=1",
      caption: "foto",
    });

    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({
      number: "5511988880001",
      url: "https://s3.test/a.jpg?sig=1",
      type: "image",
      caption: "foto",
    });
    expect(() => provider.sendMedia(ctx, { to: "5511988880001", kind: "image", providerMediaId: "1" })).toThrow(
      /endereço/,
    );
  });

  it("sem token no contexto, recusa antes de chamar o servidor", async () => {
    const { provider, fetchFn } = setup(() => jsonResponse("evolution/api/send-text-ok"));

    await expect(
      provider.sendText({ ...ctx, credentials: {} }, { to: "5511988880001", text: "oi" }),
    ).rejects.toMatchObject({ kind: "channel_auth_failed" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probe: estado real; 401 marca error; 5xx não decide (lança)", async () => {
    await expect(
      setup(() => jsonResponse("evolution/api/status-connected")).provider.probe(ctx),
    ).resolves.toMatchObject({ status: "connected", detail: null });
    await expect(
      setup(() => jsonResponse("evolution/api/status-disconnected")).provider.probe(ctx),
    ).resolves.toMatchObject({ status: "disconnected", detail: "Desconectado." });
    await expect(
      setup(() => jsonResponse("evolution/api/error-unauthorized", 401)).provider.probe(ctx),
    ).resolves.toMatchObject({ status: "error" });
    await expect(
      setup(() => new Response("boom", { status: 502 })).provider.probe(ctx),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("sem configuração do servidor (módulo ligado sem variáveis), falha fechada", async () => {
    const provider = createEvolutionProvider(null);

    await expect(provider.sendText(ctx, { to: "5511988880001", text: "oi" })).rejects.toBeInstanceOf(
      ChannelNotConfiguredError,
    );
    await expect(provider.probe(ctx)).rejects.toBeInstanceOf(ChannelNotConfiguredError);
  });
});
