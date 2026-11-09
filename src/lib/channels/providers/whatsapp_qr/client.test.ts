import { describe, expect, it, vi } from "vitest";
import {
  type EvolutionConfig,
  EvolutionApiError,
  evolutionRequest,
  isAlreadyLoggedInError,
  keyScopeOf,
  readEvolutionConfig,
  unwrap,
} from "@/lib/channels/providers/whatsapp_qr/client";
import { jsonResponse } from "@/lib/channels/test-fixtures";
import { parseEnv } from "@/lib/env";

const GLOBAL = "chave-global-de-teste";
const INSTANCE = "token-da-instancia";

function config(fetchFn: typeof fetch): EvolutionConfig {
  return {
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
}

describe("unwrap", () => {
  it("lê os três formatos medidos: embrulhado, cru e array", () => {
    expect(unwrap({ data: { a: 1 }, message: "success" })).toEqual({ a: 1 });
    expect(unwrap({ a: 1 })).toEqual({ a: 1 });
    expect(unwrap([{ a: 1 }])).toEqual({});
    expect(unwrap("texto")).toEqual({});
    expect(unwrap(null)).toEqual({});
    expect(unwrap({ data: [1] })).toEqual({ data: [1] });
  });
});

describe("keyScopeOf", () => {
  it("global só em create, delete e all; o resto é da instância", () => {
    expect(keyScopeOf("/instance/create")).toBe("global");
    expect(keyScopeOf("/instance/all")).toBe("global");
    expect(keyScopeOf("/instance/delete/abc")).toBe("global");
    expect(keyScopeOf("/instance/connect")).toBe("instance");
    expect(keyScopeOf("/instance/qr")).toBe("instance");
    expect(keyScopeOf("/send/text")).toBe("instance");
    expect(keyScopeOf("/instance/abc/advanced-settings")).toBe("instance");
  });

  it("endereço fora do mapa e prefixo parecido não têm escopo", () => {
    expect(keyScopeOf("/instance/info")).toBeNull();
    expect(keyScopeOf("/instance/createx")).toBeNull();
    expect(keyScopeOf("/admin/tudo")).toBeNull();
  });
});

describe("evolutionRequest", () => {
  it("manda a chave no cabeçalho apikey e o corpo em JSON", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse("evolution/api/pair-ok"));

    await evolutionRequest(config(fetchFn), "/instance/pair", {
      method: "POST",
      key: INSTANCE,
      body: { phone: "5511988880001" },
    });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://evolution.test/instance/pair");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ apikey: INSTANCE, "Content-Type": "application/json" });
    expect(init?.body).toBe('{"phone":"5511988880001"}');
    expect(init?.redirect).toBe("error");
  });

  it("a chave global nunca vai a endpoint de instância, nem o contrário", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse("evolution/api/status-connected"));

    await expect(
      evolutionRequest(config(fetchFn), "/instance/status", { key: GLOBAL }),
    ).rejects.toThrow(/chave incompatível/);
    await expect(
      evolutionRequest(config(fetchFn), "/instance/create", { key: INSTANCE }),
    ).rejects.toThrow(/chave incompatível/);
    await expect(
      evolutionRequest(config(fetchFn), "/instance/desconhecido", { key: INSTANCE }),
    ).rejects.toThrow(/chave incompatível/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('erro em texto plano: {"error":"not authorized"} vira channel_auth_failed', async () => {
    const error = await evolutionRequest(
      config(vi.fn<typeof fetch>(async () => jsonResponse("evolution/api/error-unauthorized", 401))),
      "/instance/status",
      { key: INSTANCE },
    ).catch((e) => e);

    expect(error).toBeInstanceOf(EvolutionApiError);
    expect(error).toMatchObject({
      kind: "channel_auth_failed",
      status: 401,
      message: "not authorized",
      isAuthFailure: true,
    });
  });

  it("404 em text/plain cru", async () => {
    const error = await evolutionRequest(
      config(
        vi.fn<typeof fetch>(
          async () => new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain" } }),
        ),
      ),
      "/instance/status",
      { key: INSTANCE },
    ).catch((e) => e);

    expect(error).toMatchObject({ kind: "not_found", status: 404, message: "404 page not found" });
  });

  it("envelope {error:{message}} da documentação também é lido", async () => {
    const error = await evolutionRequest(
      config(
        vi.fn<typeof fetch>(
          async () =>
            new Response(JSON.stringify({ success: false, error: { code: "X", message: "nome em uso" } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            }),
        ),
      ),
      "/instance/create",
      { key: GLOBAL },
    ).catch((e) => e);

    expect(error).toMatchObject({ kind: "bad_request", message: "nome em uso" });
  });

  it("5xx é indisponibilidade; rede e timeout viram status 0 sem a mensagem original", async () => {
    const e500 = await evolutionRequest(
      config(vi.fn<typeof fetch>(async () => new Response("boom", { status: 502 }))),
      "/instance/status",
      { key: INSTANCE },
    ).catch((e) => e);
    const e0 = (await evolutionRequest(
      config(vi.fn<typeof fetch>(async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:4000")))),
      "/instance/status",
      { key: INSTANCE },
    ).catch((e) => e)) as EvolutionApiError;

    expect(e500).toMatchObject({ kind: "channel_unavailable", status: 502, isRejection: false });
    expect(e0).toMatchObject({ kind: "channel_unavailable", status: 0 });
    expect(e0.message).not.toContain("10.0.0.5");
  });

  it("corpo de sucesso que não é JSON volta como texto", async () => {
    await expect(
      evolutionRequest(
        config(vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }))),
        "/instance/status",
        { key: INSTANCE },
      ),
    ).resolves.toBe("ok");
  });
});

describe("isAlreadyLoggedInError", () => {
  it("400 com 'session already logged in' não é falha", () => {
    expect(isAlreadyLoggedInError(new EvolutionApiError("bad_request", 400, "session already logged in"))).toBe(true);
    expect(isAlreadyLoggedInError(new EvolutionApiError("bad_request", 400, "outra coisa"))).toBe(false);
    expect(isAlreadyLoggedInError(new EvolutionApiError("not_found", 404, "already logged in"))).toBe(false);
    expect(isAlreadyLoggedInError(new Error("already logged in"))).toBe(false);
  });
});

describe("readEvolutionConfig", () => {
  const base = {
    APP_URL: "https://app.exemplo.com",
    DATABASE_URL: "postgresql://bizu_app:bizu_app@localhost:15437/bizu",
    DIRECT_URL: "postgresql://bizu_owner:bizu_owner@localhost:15437/bizu",
    BETTER_AUTH_SECRET: "change-me-better-auth-secret-with-32-bytes",
    CREDENTIALS_ENCRYPTION_KEY: "Y2hhbmdlLW1lLWNyZWRlbnRpYWxzLWtleS0zMmJ5dGU=",
    AUDIT_SALT: "change-me-audit-salt",
    SMTP_HOST: "localhost",
  };

  it("sem URL ou sem chave: null (falha fechada)", () => {
    expect(readEvolutionConfig(parseEnv(base))).toBeNull();
    expect(readEvolutionConfig(parseEnv({ ...base, EVOLUTION_API_URL: "https://e.test" }))).toBeNull();
  });

  it("monta a configuração, tira a barra final e usa APP_URL como webhook padrão", () => {
    const result = readEvolutionConfig(
      parseEnv({
        ...base,
        EVOLUTION_API_URL: "https://evolution.exemplo.com/",
        EVOLUTION_GLOBAL_API_KEY: "k",
        EVOLUTION_MEDIA_ORIGINS: "https://s3.exemplo.com",
      }),
    );

    expect(result).toMatchObject({
      apiUrl: "https://evolution.exemplo.com",
      globalApiKey: "k",
      webhookPublicUrl: "https://app.exemplo.com",
      instancePrefix: "bizu",
      maxInstancesTotal: 20,
      requestTimeoutMs: 15_000,
      mediaTimeoutMs: 60_000,
      mediaOrigins: ["https://s3.exemplo.com"],
    });
  });
});
