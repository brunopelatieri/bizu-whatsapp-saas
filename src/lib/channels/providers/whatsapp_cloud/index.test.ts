import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudProvider } from "@/lib/channels/providers/whatsapp_cloud";
import { jsonResponse } from "@/lib/channels/test-fixtures";
import type { ChannelContext } from "@/lib/channels/types";

const provider = createCloudProvider();
const ctx: ChannelContext = {
  channelId: "c1",
  type: "whatsapp_cloud",
  credentials: { phoneNumberId: "200000000000001", wabaId: "100000000000001", accessToken: "tok" },
};

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (name: string, status = 200) =>
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(name, status)));

describe("provedor whatsapp_cloud", () => {
  it("declara capacidades de Cloud API", () => {
    expect(provider.type).toBe("whatsapp_cloud");
    expect(provider.capabilities.templates).toBe(true);
    expect(provider.capabilities.pairing).toBe(false);
  });

  it("sendText devolve o id da mensagem", async () => {
    stubFetch("cloud/api/send-ok");

    await expect(provider.sendText(ctx, { to: "5511988880001", text: "oi" })).resolves.toEqual({
      providerMessageId: "wamid.SENT0001",
    });
  });

  it("sem credencial no contexto, falha antes de chamar a Meta", async () => {
    stubFetch("cloud/api/send-ok");

    await expect(
      provider.sendText({ ...ctx, credentials: { phoneNumberId: "1" } }, { to: "5511988880001", text: "oi" }),
    ).rejects.toThrow(/accessToken/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("probe: número alcançável = connected, com o telefone exibido", async () => {
    stubFetch("cloud/api/phone-info");

    await expect(provider.probe(ctx)).resolves.toEqual({
      status: "connected",
      detail: null,
      identifier: "+55 11 99999-0001",
    });
  });

  it("probe: 4xx da Meta marca error; 5xx não decide o estado (lança para o job manter o atual)", async () => {
    stubFetch("cloud/api/error-invalid-token", 401);
    await expect(provider.probe(ctx)).resolves.toMatchObject({ status: "error" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(provider.probe(ctx)).rejects.toMatchObject({ status: 503 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429 })));
    await expect(provider.probe(ctx)).rejects.toMatchObject({ status: 429 });
  });

  it("fetchMedia baixa pelo id e respeita o host", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse("cloud/api/media-url"))
      .mockResolvedValueOnce(new Response("bytes", { status: 200, headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchFn);

    const media = await provider.fetchMedia?.(ctx, "300000000000001");

    expect(media?.body.toString()).toBe("bytes");
    expect(media?.mime).toBe("image/jpeg");
  });

  it("normalizeEvents e verifyWebhook estão ligados ao módulo", async () => {
    expect(provider.normalizeEvents({})).toEqual([]);
    await expect(
      provider.verifyWebhook({ rawBody: "{}", headers: {}, credentials: {}, config: {} }),
    ).resolves.toMatchObject({ ok: false });
  });
});
