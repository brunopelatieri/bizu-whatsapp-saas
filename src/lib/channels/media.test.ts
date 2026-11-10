import { describe, expect, it, vi } from "vitest";
import { PermanentEventError } from "@/lib/channels/errors";
import {
  collectStorageKeys,
  decodeBase64Media,
  downloadMedia,
  isStoredMedia,
  safeMime,
} from "@/lib/channels/media";

describe("referência de mídia no raw", () => {
  it("só reconhece chave sob inbound/ e com tamanho", () => {
    expect(isStoredMedia({ storageKey: "inbound/abc", mime: "image/jpeg", size: 10 })).toBe(true);
    expect(isStoredMedia({ storageKey: "tenants/x/abc", mime: null, size: 10 })).toBe(false);
    expect(isStoredMedia({ storageKey: "inbound/../etc", mime: null, size: 10 })).toBe(false);
    expect(isStoredMedia({ storageKey: "inbound/abc" })).toBe(false);
    expect(isStoredMedia("inbound/abc")).toBe(false);
  });

  it("acha as referências em qualquer profundidade, e só elas", () => {
    const raw = {
      event: "Message",
      data: {
        Message: {
          imageMessage: { mimetype: "image/jpeg" },
          base64: { storageKey: "inbound/um", mime: "image/jpeg", size: 3 },
        },
        extra: [
          { storageKey: "inbound/dois", mime: null, size: 1 },
          { storageKey: "outro/x", size: 1 },
        ],
      },
    };

    expect(collectStorageKeys(raw)).toEqual(["inbound/um", "inbound/dois"]);
    expect(collectStorageKeys(null)).toEqual([]);
  });
});

describe("decodeBase64Media", () => {
  it("decodifica com ou sem prefixo data:", () => {
    expect(decodeBase64Media("b2k=")?.toString()).toBe("oi");
    expect(decodeBase64Media("data:text/plain;base64,b2k=")?.toString()).toBe("oi");
  });

  it("vazio ou acima do teto é descartado", () => {
    expect(decodeBase64Media("")).toBeNull();
    expect(decodeBase64Media("AAAAAAAAAAAAAAAA", 4)).toBeNull();
  });
});

describe("safeMime", () => {
  it("fica só com tipo/subtipo", () => {
    expect(safeMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(safeMime("IMAGE/JPEG")).toBe("image/jpeg");
    expect(safeMime("text/html\r\nX-Injected: 1")).toBeNull();
    expect(safeMime(null)).toBeNull();
  });

  it("conteúdo ativo (HTML, SVG, XML, script) vira download genérico", () => {
    for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/javascript"]) {
      expect(safeMime(mime), mime).toBe("application/octet-stream");
    }
    expect(safeMime("application/pdf")).toBe("application/pdf");
  });
});

describe("downloadMedia", () => {
  const options = (response: Response) => ({
    timeoutMs: 1000,
    fetchFn: vi.fn<typeof fetch>(async () => response),
  });
  const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

  it("baixa sem seguir redirecionamento", async () => {
    const opts = options(new Response("abc", { headers: { "content-type": "image/png" } }));

    await expect(downloadMedia("https://s3.test/a", opts)).resolves.toEqual({
      body: Buffer.from("abc"),
      mime: "image/png",
    });
    expect(opts.fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it.each([403, 404])("%i é definitivo (endereço vencido ou sem acesso)", async (status) => {
    await expect(
      downloadMedia("https://s3.test/a", options(new Response("", { status }))),
    ).rejects.toBeInstanceOf(PermanentEventError);
  });

  it("redirecionamento não é seguido: definitivo", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/" },
    });

    await expect(downloadMedia("https://s3.test/a", options(redirect))).rejects.toBeInstanceOf(
      PermanentEventError,
    );
  });

  it("5xx é transitório: erro comum, o job tenta de novo", async () => {
    const error = await failure(
      downloadMedia("https://s3.test/a", options(new Response("", { status: 503 }))),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentEventError);
  });

  it("corta no teto de tamanho, pelo cabeçalho ou pelo conteúdo", async () => {
    const declared = new Response("abc", { headers: { "content-length": "999" } });

    await expect(
      downloadMedia("https://s3.test/a", { ...options(declared), maxBytes: 10 }),
    ).rejects.toBeInstanceOf(PermanentEventError);
    await expect(
      downloadMedia("https://s3.test/a", { ...options(new Response("abcdefghijkl")), maxBytes: 10 }),
    ).rejects.toBeInstanceOf(PermanentEventError);
  });

  it("a mensagem de erro de rede não leva o endereço (pode ter assinatura na query)", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("connect ECONNREFUSED https://s3.test/a?X-Amz-Signature=segredo");
    });
    const error = (await failure(
      downloadMedia("https://s3.test/a?X-Amz-Signature=segredo", { timeoutMs: 1000, fetchFn }),
    )) as Error;

    expect(error.message).not.toContain("segredo");
    expect(error.message).not.toContain("s3.test");
  });
});
