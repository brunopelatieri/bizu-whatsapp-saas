import { describe, expect, it, vi } from "vitest";
import {
  assertGraphId,
  downloadMedia,
  formatMetaError,
  GRAPH_BASE,
  GRAPH_VERSION,
  getMediaUrl,
  getSubscribedApps,
  isTrustedMediaUrl,
  listTemplates,
  MetaApiError,
  registerPhoneNumber,
  sendMedia,
  sendTemplate,
  sendText,
  subscribeWabaToApp,
  uploadMedia,
  verifyPhoneNumber,
} from "@/lib/channels/providers/whatsapp_cloud/graph";
import { fixture, jsonResponse } from "@/lib/channels/test-fixtures";

const TOKEN = "EAAB-token-de-teste";
const creds = { accessToken: TOKEN };
const PNID = "200000000000001";

function mockFetch(name: string, status = 200) {
  return vi.fn<typeof fetch>(async () => jsonResponse(name, status));
}

/** Última chamada: URL, método, cabeçalhos e corpo JSON. */
function lastCall(fetchFn: ReturnType<typeof mockFetch>) {
  const [url, init] = fetchFn.mock.calls.at(-1) ?? [];

  return {
    url: new URL(String(url)),
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
  };
}

describe("versão e host", () => {
  it("a versão vigente é conferida em um lugar só e o host é fixo", async () => {
    expect(GRAPH_VERSION).toBe("v26.0");

    const fetchFn = mockFetch("cloud/api/phone-info");
    await verifyPhoneNumber({ ...creds, phoneNumberId: PNID }, { fetchFn });

    const { url, headers } = lastCall(fetchFn);
    expect(url.origin).toBe(GRAPH_BASE);
    expect(url.pathname).toBe(`/${GRAPH_VERSION}/${PNID}`);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // O token vai no cabeçalho, nunca na URL (que acaba em log de proxy).
    expect(url.search).not.toContain(TOKEN);
  });

  it("recusa id que mude o caminho da URL", () => {
    for (const bad of ["../me", "123/messages", "12 3", "", "abc", "1".repeat(40)]) {
      expect(() => assertGraphId(bad, "x")).toThrow(MetaApiError);
    }
    expect(assertGraphId("123456", "x")).toBe("123456");
  });
});

describe("verifyPhoneNumber", () => {
  it("devolve telefone exibido, nome verificado e qualidade", async () => {
    const info = await verifyPhoneNumber(
      { ...creds, phoneNumberId: PNID },
      { fetchFn: mockFetch("cloud/api/phone-info") },
    );

    expect(info).toMatchObject({
      display_phone_number: "+55 11 99999-0001",
      verified_name: "Empresa Exemplo",
      quality_rating: "GREEN",
    });
  });

  it("token inválido: 401 com (#190) e o texto da Meta, sem o token", async () => {
    const error = await verifyPhoneNumber(
      { ...creds, phoneNumberId: PNID },
      { fetchFn: mockFetch("cloud/api/error-invalid-token", 401) },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({ status: 401, code: 190, isRejection: true, isAuthFailure: true });
    expect(error.message).toBe("(#190) Invalid OAuth access token - Cannot parse access token");
    expect(error.message).not.toContain(TOKEN);
  });

  it("5xx e 429 não são recusa de credencial", async () => {
    const e500 = await verifyPhoneNumber(
      { ...creds, phoneNumberId: PNID },
      { fetchFn: vi.fn<typeof fetch>(async () => new Response("bad gateway", { status: 502 })) },
    ).catch((e) => e);
    const e429 = await verifyPhoneNumber(
      { ...creds, phoneNumberId: PNID },
      { fetchFn: vi.fn<typeof fetch>(async () => new Response("{}", { status: 429 })) },
    ).catch((e) => e);

    expect(e500).toMatchObject({ status: 502, isRejection: false });
    expect(e500.message).toBe("Meta API error: 502");
    expect(e429).toMatchObject({ status: 429, isRejection: false });
  });

  it("rede e timeout viram status 0, sem a mensagem original (pode trazer a URL)", async () => {
    const error = await verifyPhoneNumber(
      { ...creds, phoneNumberId: PNID },
      { fetchFn: vi.fn<typeof fetch>(async () => Promise.reject(new Error(`ECONNRESET ${TOKEN}`))) },
    ).catch((e) => e);

    expect(error).toMatchObject({ status: 0, isRejection: false });
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("ECONNRESET");
  });
});

describe("formatMetaError", () => {
  it("título e texto do usuário, com o código na frente", () => {
    expect(
      formatMetaError(
        { code: 131030, message: "x", title: "Número fora da lista", userMessage: "Adicione o número." },
        "falha",
      ),
    ).toBe("(#131030) Número fora da lista: Adicione o número.");
  });

  it("não duplica o (#código) que a Meta já embute na mensagem", async () => {
    const error = await sendText(
      { ...creds, phoneNumberId: PNID, to: "5511988880001", text: "oi" },
      { fetchFn: mockFetch("cloud/api/error-user-msg", 400) },
    ).catch((e) => e);

    expect(error.message).toBe("(#131030) Número fora da lista: Adicione o número à lista de destinatários.");
  });

  it("sem erro estruturado usa o texto padrão", () => {
    expect(formatMetaError(undefined, "Meta API error: 500")).toBe("Meta API error: 500");
  });
});

describe("registerPhoneNumber", () => {
  it("envia o PIN no corpo", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"success":true}', { status: 200 }));

    await expect(
      registerPhoneNumber({ ...creds, phoneNumberId: PNID, pin: "123456" }, { fetchFn }),
    ).resolves.toEqual({ alreadyRegistered: false });
    expect(lastCall(fetchFn)).toMatchObject({
      method: "POST",
      body: { messaging_product: "whatsapp", pin: "123456" },
    });
    expect(lastCall(fetchFn).url.pathname).toBe(`/${GRAPH_VERSION}/${PNID}/register`);
  });

  it('"já registrado" (133005) é sucesso', async () => {
    await expect(
      registerPhoneNumber(
        { ...creds, phoneNumberId: PNID, pin: "123456" },
        { fetchFn: mockFetch("cloud/api/error-already-registered", 400) },
      ),
    ).resolves.toEqual({ alreadyRegistered: true });
  });

  it("outro erro sobe", async () => {
    await expect(
      registerPhoneNumber(
        { ...creds, phoneNumberId: PNID, pin: "000000" },
        { fetchFn: mockFetch("cloud/api/error-invalid-token", 401) },
      ),
    ).rejects.toMatchObject({ code: 190 });
  });
});

describe("assinatura do WABA", () => {
  it("subscribeWabaToApp faz POST em /subscribed_apps", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"success":true}', { status: 200 }));

    await subscribeWabaToApp({ ...creds, wabaId: "100000000000001" }, { fetchFn });

    expect(lastCall(fetchFn).method).toBe("POST");
    expect(lastCall(fetchFn).url.pathname).toBe(`/${GRAPH_VERSION}/100000000000001/subscribed_apps`);
  });

  it("getSubscribedApps lista os aplicativos", async () => {
    const apps = await getSubscribedApps(
      { ...creds, wabaId: "100000000000001" },
      { fetchFn: mockFetch("cloud/api/subscribed-apps") },
    );

    expect(apps[0]?.whatsapp_business_api_data?.name).toBe("App Exemplo");
  });
});

describe("envio", () => {
  const base = { ...creds, phoneNumberId: PNID, to: "5511988880001" };

  it("sendText: corpo da Cloud API e id da mensagem; citação vira context", async () => {
    const fetchFn = mockFetch("cloud/api/send-ok");

    await expect(
      sendText({ ...base, text: "Olá", contextMessageId: "wamid.IN1" }, { fetchFn }),
    ).resolves.toEqual({ messageId: "wamid.SENT0001" });
    expect(lastCall(fetchFn).body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5511988880001",
      type: "text",
      text: { body: "Olá" },
      context: { message_id: "wamid.IN1" },
    });
  });

  it("resposta de sucesso sem id é erro nosso, não da Meta", async () => {
    await expect(
      sendText(
        { ...base, text: "Olá" },
        { fetchFn: vi.fn<typeof fetch>(async () => new Response('{"messages":[]}', { status: 200 })) },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
  });

  it("sendMedia: áudio não leva legenda nem nome; documento leva nome; id vence o link", async () => {
    const fetchFn = mockFetch("cloud/api/send-ok");

    await sendMedia(
      { ...base, kind: "audio", link: "https://x.test/a.ogg", caption: "x", filename: "y" },
      { fetchFn },
    );
    expect(lastCall(fetchFn).body.audio).toEqual({ link: "https://x.test/a.ogg" });

    await sendMedia(
      { ...base, kind: "document", link: "https://x.test/a.pdf", caption: "c", filename: "a.pdf" },
      { fetchFn },
    );
    expect(lastCall(fetchFn).body.document).toEqual({
      link: "https://x.test/a.pdf",
      caption: "c",
      filename: "a.pdf",
    });

    await sendMedia({ ...base, kind: "image", mediaId: "999", caption: "foto" }, { fetchFn });
    expect(lastCall(fetchFn).body.image).toEqual({ id: "999", caption: "foto" });
  });

  it("sendMedia sem link nem id é recusado antes de chamar a Meta", () => {
    const fetchFn = mockFetch("cloud/api/send-ok");

    expect(() => sendMedia({ ...base, kind: "image" }, { fetchFn })).toThrow(MetaApiError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sendTemplate: nome, idioma e componentes (omitidos quando vazios)", async () => {
    const fetchFn = mockFetch("cloud/api/send-ok");

    await sendTemplate({ ...base, name: "boas_vindas", language: "pt_BR" }, { fetchFn });
    expect(lastCall(fetchFn).body.template).toEqual({
      name: "boas_vindas",
      language: { code: "pt_BR" },
    });

    await sendTemplate(
      { ...base, name: "boas_vindas", language: "pt_BR", components: [{ type: "body" }] },
      { fetchFn },
    );
    expect(lastCall(fetchFn).body.template.components).toEqual([{ type: "body" }]);
  });

  it("uploadMedia: multipart com o tipo e devolve o id", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"id":"777"}', { status: 200 }));

    await expect(
      uploadMedia(
        { ...base, body: Buffer.from("bytes"), mime: "image/png", filename: "a.png" },
        { fetchFn },
      ),
    ).resolves.toEqual({ mediaId: "777" });

    const { body, url } = lastCall(fetchFn);
    expect(url.pathname).toBe(`/${GRAPH_VERSION}/${PNID}/media`);
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("messaging_product")).toBe("whatsapp");
    expect((body as FormData).get("type")).toBe("image/png");
  });
});

describe("mídia recebida", () => {
  it("getMediaUrl devolve a URL da Meta e o tipo", async () => {
    await expect(
      getMediaUrl({ ...creds, mediaId: "300000000000001" }, { fetchFn: mockFetch("cloud/api/media-url") }),
    ).resolves.toMatchObject({
      url: expect.stringContaining("lookaside.fbsbx.com"),
      mime: "image/jpeg",
    });
  });

  it("URL fora dos hosts da Meta é recusada: o download leva o token", async () => {
    await expect(
      getMediaUrl(
        { ...creds, mediaId: "300000000000001" },
        { fetchFn: mockFetch("cloud/api/media-url-hostile") },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
  });

  it.each([
    ["https://lookaside.fbsbx.com/x?mid=1", true],
    ["https://scontent.xx.fbcdn.net/v/x", true],
    ["http://lookaside.fbsbx.com/x", false],
    ["https://fbsbx.com.evil.test/x", false],
    ["https://evilfbsbx.com/x", false],
    ["https://user:pass@lookaside.fbsbx.com/x", false],
    ["https://evil.example.com/x", false],
    ["não é url", false],
  ])("isTrustedMediaUrl(%s) = %s", (url, expected) => {
    expect(isTrustedMediaUrl(url)).toBe(expected);
  });

  it("downloadMedia: sem token para host estranho, com teto de tamanho", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response("bytes", { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    await expect(
      downloadMedia({ ...creds, url: "https://evil.example.com/x", maxBytes: 10 }, { fetchFn }),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchFn).not.toHaveBeenCalled();

    await expect(
      downloadMedia({ ...creds, url: "https://lookaside.fbsbx.com/x", maxBytes: 10 }, { fetchFn }),
    ).resolves.toMatchObject({ mime: "image/jpeg" });
    await expect(
      downloadMedia({ ...creds, url: "https://lookaside.fbsbx.com/x", maxBytes: 3 }, { fetchFn }),
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe("listTemplates", () => {
  it("lê todas as páginas pelo cursor, sem seguir a URL `next` da resposta", async () => {
    const pages = [fixture("cloud/api/templates-page1"), fixture("cloud/api/templates-page2")];
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(pages.shift()), { status: 200 }),
    );

    const templates = await listTemplates({ ...creds, wabaId: "100000000000001" }, { fetchFn });

    expect(templates.map((template) => [template.name, template.status])).toEqual([
      ["boas_vindas", "APPROVED"],
      ["promo", "REJECTED"],
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchFn.mock.calls[1]?.[0])).searchParams.get("after")).toBe("cursor-pagina-2");
    expect(new URL(String(fetchFn.mock.calls[1]?.[0])).origin).toBe(GRAPH_BASE);
  });
});
