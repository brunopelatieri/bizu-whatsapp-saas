import { describe, expect, it, vi } from "vitest";
import { PermanentEventError } from "@/lib/channels/errors";
import {
  externalizeEvolutionMedia,
  resolveEvolutionMedia,
} from "@/lib/channels/providers/whatsapp_qr/media";
import { normalizeEvolutionEvents } from "@/lib/channels/providers/whatsapp_qr/normalize";
import { fixture } from "@/lib/channels/test-fixtures";
import type { NormalizedMessage, StoreInboundMedia } from "@/lib/channels/types";

function memoryStore() {
  const objects = new Map<string, { body: Buffer; mime: string | null }>();
  const store: StoreInboundMedia = async (body, mime) => {
    const storageKey = `inbound/k${objects.size + 1}`;

    objects.set(storageKey, { body, mime });
    return { storageKey, mime, size: body.byteLength };
  };

  return { objects, store };
}

const message = (raw: unknown) => normalizeEvolutionEvents(raw)[0] as NormalizedMessage;

describe("base64 do aviso sai para o armazenamento", () => {
  it.each(["message-image-base64-caption", "message-audio-base64"])(
    "%s: o raw fica com a referência e sem o base64",
    async (name) => {
      const original = fixture<{ data: { Message: { base64: string } } }>(`evolution/${name}`);
      const base64 = original.data.Message.base64;
      const { objects, store } = memoryStore();

      const raw = await externalizeEvolutionMedia(structuredClone(original), store);

      expect(JSON.stringify(raw)).not.toContain(base64);
      expect(objects.size).toBe(1);
      expect([...objects.values()][0]?.body.equals(Buffer.from(base64, "base64"))).toBe(true);

      const media = message(raw).media;
      expect(media?.base64).toBeUndefined();
      expect(media?.storage).toEqual({
        storageKey: "inbound/k1",
        mime: media?.mime,
        size: Buffer.from(base64, "base64").byteLength,
      });
    },
  );

  it("base64 dentro do proto ou em data.base64 também sai", async () => {
    const { objects, store } = memoryStore();
    const raw = await externalizeEvolutionMedia(
      {
        event: "Message",
        data: {
          Info: { Chat: "5511988880001@s.whatsapp.net", ID: "X1" },
          base64: "b2k=",
          Message: { documentMessage: { mimetype: "application/pdf", BASE64: "b2k=" } },
        },
      },
      store,
    );

    expect(JSON.stringify(raw)).not.toContain("b2k=");
    expect(objects.size).toBe(2);
  });

  it("conteúdo que não decodifica é descartado, nunca gravado como texto", async () => {
    const { objects, store } = memoryStore();
    const raw = (await externalizeEvolutionMedia(
      { event: "Message", data: { Message: { imageMessage: {}, base64: "" } } },
      store,
    )) as { data: { Message: { base64: unknown } } };

    expect(raw.data.Message.base64).toBeNull();
    expect(objects.size).toBe(0);
  });

  it("aviso sem mídia passa intacto", async () => {
    const original = fixture("evolution/message-text");
    const { objects, store } = memoryStore();

    expect(await externalizeEvolutionMedia(structuredClone(original), store)).toEqual(original);
    expect(objects.size).toBe(0);
  });
});

describe("mediaUrl (SSRF)", () => {
  const raw = () => fixture("evolution/message-image-mediaurl");
  const config = (mediaOrigins: string[], respond: () => Response = () => new Response("jpeg")) => ({
    mediaOrigins,
    mediaTimeoutMs: 1000,
    fetchFn: vi.fn<typeof fetch>(async () => respond()),
  });

  it("origem fora da lista: ignorado, nada é baixado", async () => {
    const { objects, store } = memoryStore();
    const cfg = config(["https://outro.exemplo.test"]);

    await expect(resolveEvolutionMedia(cfg, raw(), store)).resolves.toEqual({
      outcome: "ignored",
      reason: expect.stringContaining("fora da lista"),
    });
    expect(cfg.fetchFn).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });

  it("lista vazia (só base64): ignorado", async () => {
    const cfg = config([]);

    expect((await resolveEvolutionMedia(cfg, raw(), memoryStore().store)).outcome).toBe("ignored");
    expect(cfg.fetchFn).not.toHaveBeenCalled();
  });

  it("origem na lista: baixa, grava e o raw passa a ter a referência", async () => {
    const { objects, store } = memoryStore();
    const original = raw();
    const result = await resolveEvolutionMedia(config(["https://s3.exemplo.test"]), original, store);

    expect(result.outcome).toBe("stored");
    expect(objects.get("inbound/k1")?.body.toString()).toBe("jpeg");
    // O aviso original não é alterado: o job grava o novo.
    expect(original).toEqual(raw());

    const media = message(result.outcome === "stored" ? result.raw : null).media;
    expect(media?.storage).toEqual({ storageKey: "inbound/k1", mime: "image/jpeg", size: 4 });
    expect(media?.mediaUrl).toBeUndefined();
  });

  it("já gravado: não baixa de novo (retry do job)", async () => {
    const cfg = config(["https://s3.exemplo.test"]);
    const first = await resolveEvolutionMedia(cfg, raw(), memoryStore().store);
    const again = await resolveEvolutionMedia(
      cfg,
      first.outcome === "stored" ? first.raw : null,
      memoryStore().store,
    );

    expect(again).toEqual({ outcome: "unchanged" });
    expect(cfg.fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])("resposta %i: falha definitiva", async (status) => {
    const cfg = config(["https://s3.exemplo.test"], () => new Response("", { status }));

    await expect(resolveEvolutionMedia(cfg, raw(), memoryStore().store)).rejects.toBeInstanceOf(
      PermanentEventError,
    );
  });

  it("URL cifrada do CDN do WhatsApp nunca é baixada", async () => {
    const cfg = config(["https://mmg.whatsapp.net"]);

    await expect(
      resolveEvolutionMedia(cfg, fixture("evolution/message-image-encrypted-only"), memoryStore().store),
    ).resolves.toEqual({ outcome: "unchanged" });
    expect(cfg.fetchFn).not.toHaveBeenCalled();
  });

  it.each(["message-text", "connected", "message-image-base64-caption"])(
    "%s não tem endereço a resolver",
    async (name) => {
      const cfg = config(["https://s3.exemplo.test"]);
      const result = await resolveEvolutionMedia(cfg, fixture(`evolution/${name}`), memoryStore().store);

      expect(result).toEqual({ outcome: "unchanged" });
      expect(cfg.fetchFn).not.toHaveBeenCalled();
    },
  );
});
