import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthEnv,
  createRequireAuth,
  type PhoneGate,
  requireAuth,
  requirePlatform,
  type ResolvedSession,
  type ResolveSession,
} from "@/api/auth";
import type { AuthUser, PlatformRole } from "@/lib/auth/types";

const user: AuthUser = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "ana@example.com",
  name: "Ana",
  emailVerified: true,
  platformRole: "user",
  twoFactorEnabled: false,
  activeTenant: null,
  impersonatedBy: null,
};

/** Sem banco aqui: o portão de telefone é injetado (o de verdade está em `tests/db/phone-gate.test.ts`). */
const open: PhoneGate = async () => true;

const SESSION_COOKIE = "bizu.session_token=token.assinatura";

function resolved(overrides: Partial<AuthUser> = {}): ResolvedSession {
  return {
    user: { ...user, ...overrides },
    session: { id: "sessao", expiresAt: new Date(0) },
  };
}

function buildApp(guard: ReturnType<typeof createRequireAuth>) {
  const app = new Hono<AuthEnv>();
  app.get("/private", guard, (c) => c.json({ id: c.get("user").id }));
  return app;
}

function get(app: Hono<AuthEnv>, cookie?: string) {
  return app.request("/private", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

describe("requireAuth", () => {
  it("recusa requisição sem cookie de sessão, sem consultar o Auth", async () => {
    const resolve = vi.fn<ResolveSession>();
    const response = await get(buildApp(createRequireAuth(resolve, undefined, open)));

    expect(response.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("ignora Authorization: Bearer e cookies de outro prefixo", async () => {
    const resolve = vi.fn<ResolveSession>();
    const app = buildApp(createRequireAuth(resolve, undefined, open));

    const bearer = await app.request("/private", {
      headers: { Authorization: "Bearer abc" },
    });
    const portal = await get(app, "bizu_portal.session_token=abc");

    expect(bearer.status).toBe(401);
    expect(portal.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("recusa sessão inválida", async () => {
    const guard = createRequireAuth(async () => null, undefined, open);
    const response = await get(buildApp(guard), SESSION_COOKIE);

    expect(response.status).toBe(401);
  });

  it("falha fechada quando o Auth está indisponível", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const guard = createRequireAuth(
      async () => {
        throw new Error("indisponível");
      },
      undefined,
      open,
    );
    const response = await get(buildApp(guard), SESSION_COOKIE);

    expect(response.status).toBe(503);
    spy.mockRestore();
  });

  it("com verificação exigida, bloqueia e-mail não verificado mesmo com sessão", async () => {
    const guard = createRequireAuth(
      async () => resolved({ emailVerified: false }),
      () => true,
    );
    const response = await get(buildApp(guard), SESSION_COOKIE);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("sem verificação exigida (padrão do template), aceita e-mail não verificado", async () => {
    const guard = createRequireAuth(
      async () => resolved({ emailVerified: false }),
      () => false,
      open,
    );
    const response = await get(buildApp(guard), SESSION_COOKIE);

    expect(response.status).toBe(200);
  });

  it("libera a rota e expõe o usuário quando a sessão é válida", async () => {
    const resolve = vi.fn<ResolveSession>(async () => resolved());
    const response = await get(
      buildApp(createRequireAuth(resolve, undefined, open)),
      SESSION_COOKIE,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: user.id });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("aceita o cookie com prefixo __Secure- de produção", async () => {
    const guard = createRequireAuth(async () => resolved(), undefined, open);
    const response = await get(buildApp(guard), `__Secure-${SESSION_COOKIE}`);

    expect(response.status).toBe(200);
  });

  it("a instância padrão responde 401 sem cookie, sem tocar no banco", async () => {
    const response = await get(buildApp(requireAuth));

    expect(response.status).toBe(401);
  });
});

describe("requireAuth: telefone pendente (T3)", () => {
  function app(guard: ReturnType<typeof createRequireAuth>) {
    const routes = new Hono<AuthEnv>();
    routes.get("/private", guard, (c) => c.json({ id: c.get("user").id }));
    routes.get("/api/me/phone-verification", guard, (c) => c.json({ ok: true }));
    routes.get("/api/me/phone-verification/", guard, (c) => c.json({ ok: true }));
    routes.post("/api/me/phone-verification/confirm", guard, (c) => c.json({ ok: true }));
    return routes;
  }

  const call = (routes: Hono<AuthEnv>, path: string, method = "GET") =>
    routes.request(path, { method, headers: { Cookie: SESSION_COOKIE } });

  it("o predicado recusa: 403 PHONE_UNVERIFIED, com a organização ativa da sessão", async () => {
    const gate = vi.fn<PhoneGate>(async () => false);
    const guard = createRequireAuth(
      async () => ({ ...resolved(), activeOrganizationId: "org-a" }),
      () => false,
      gate,
    );
    const response = await call(app(guard), "/private");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PHONE_UNVERIFIED" });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ id: user.id }), "org-a");
  });

  it("o predicado aceita: segue", async () => {
    const guard = createRequireAuth(async () => resolved(), () => false, async () => true);

    expect((await call(app(guard), "/private")).status).toBe(200);
  });

  it("a lista do que passa não consulta o predicado; caminho parecido não entra nela", async () => {
    const gate = vi.fn<PhoneGate>(async () => false);
    const routes = app(createRequireAuth(async () => resolved(), () => false, gate));

    expect((await call(routes, "/api/me/phone-verification")).status).toBe(200);
    expect((await call(routes, "/api/me/phone-verification/confirm", "POST")).status).toBe(200);
    expect(gate).not.toHaveBeenCalled();

    expect((await call(routes, "/api/me/phone-verification/")).status).toBe(403);
  });

  it("o e-mail vem antes: sem e-mail verificado, nem o telefone é consultado", async () => {
    const gate = vi.fn<PhoneGate>(async () => false);
    const routes = app(
      createRequireAuth(async () => resolved({ emailVerified: false }), () => true, gate),
    );

    for (const path of ["/private", "/api/me/phone-verification"]) {
      const response = await call(routes, path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    }
    expect(gate).not.toHaveBeenCalled();
  });

  it("falha ao conferir o telefone é fechada (503)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const guard = createRequireAuth(async () => resolved(), () => false, async () => {
      throw new Error("banco fora do ar");
    });

    expect((await call(app(guard), "/private")).status).toBe(503);
    spy.mockRestore();
  });
});

describe("requirePlatform", () => {
  function request(platformRole: PlatformRole, roles?: PlatformRole[]) {
    const app = new Hono<AuthEnv>();
    const guard = createRequireAuth(async () => resolved({ platformRole }), undefined, open);
    app.get("/admin", guard, requirePlatform(roles), (c) => c.text("ok"));
    return app.request("/admin", { headers: { Cookie: SESSION_COOKIE } });
  }

  it("recusa usuário comum", async () => {
    const response = await request("user");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PLATFORM_FORBIDDEN" });
  });

  it("libera proprietário e suporte", async () => {
    expect((await request("platform_owner")).status).toBe(200);
    expect((await request("platform_support")).status).toBe(200);
  });

  it("restringe a papéis específicos", async () => {
    const owners: PlatformRole[] = ["platform_owner"];

    expect((await request("platform_support", owners)).status).toBe(403);
    expect((await request("platform_owner", owners)).status).toBe(200);
  });
});
