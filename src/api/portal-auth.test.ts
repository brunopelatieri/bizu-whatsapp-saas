import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requireAuth } from "@/api/auth";
import {
  createRequirePortalAuth,
  type PortalAuthEnv,
  type PortalBarrier,
  type PortalPhoneGate,
  type ResolvedPortalSession,
  type ResolvePortalSession,
} from "@/api/portal-auth";

const PORTAL_COOKIE = "bizu_portal.session_token=token.assinatura";
const APP_COOKIE = "bizu.session_token=token.assinatura";

function resolved(emailVerified = true): ResolvedPortalSession {
  return {
    user: {
      id: "11111111-1111-1111-1111-111111111111",
      email: "julia@example.com",
      name: "Júlia",
      emailVerified,
      phone: null,
      phoneNormalized: null,
    },
    session: {
      id: "sessao",
      createdAt: new Date(0),
      expiresAt: new Date(0),
      activeTenantId: null,
    },
  };
}

function get(resolve: ResolvePortalSession, cookie?: string, barred?: PortalBarrier) {
  const app = new Hono<PortalAuthEnv>();

  app.get("/private", createRequirePortalAuth(resolve, barred, async () => true), (c) =>
    c.json({ id: c.get("portalUser").id }),
  );

  return app.request("/private", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

describe("requirePortalAuth", () => {
  it("recusa sem cookie, sem consultar o Auth", async () => {
    const resolve = vi.fn<ResolvePortalSession>();

    expect((await get(resolve)).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("cookie de equipe não conta como cookie do portal", async () => {
    const resolve = vi.fn<ResolvePortalSession>();

    expect((await get(resolve, APP_COOKIE)).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("falha fechada: Auth indisponível responde 503", async () => {
    const resolve = vi.fn<ResolvePortalSession>(async () => {
      throw new Error("banco fora do ar");
    });

    expect((await get(resolve, PORTAL_COOKIE)).status).toBe(503);
  });

  it("sessão inválida responde 401", async () => {
    const resolve = vi.fn<ResolvePortalSession>(async () => null);

    expect((await get(resolve, PORTAL_COOKIE)).status).toBe(401);
  });

  it("e-mail sem verificação responde 403", async () => {
    const resolve = vi.fn<ResolvePortalSession>(async () => resolved(false));
    const response = await get(resolve, PORTAL_COOKIE);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("sessão válida passa o cliente adiante", async () => {
    const resolve = vi.fn<ResolvePortalSession>(async () => resolved());
    const response = await get(resolve, PORTAL_COOKIE);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: resolved().user.id });
  });
});

describe("requirePortalAuth: exclusão pela plataforma", () => {
  it("na carência, a sessão válida vale como inexistente (401)", async () => {
    const resolve = vi.fn<ResolvePortalSession>(async () => resolved());
    const barred = vi.fn<PortalBarrier>(async () => true);

    expect((await get(resolve, PORTAL_COOKIE, barred)).status).toBe(401);
    expect(barred).toHaveBeenCalledWith(resolved().user.id);
  });

  it("falha ao conferir a barreira é fechada (503)", async () => {
    const resolve = vi.fn<ResolvePortalSession>(async () => resolved());
    const barred = vi.fn<PortalBarrier>(async () => {
      throw new Error("banco fora do ar");
    });

    expect((await get(resolve, PORTAL_COOKIE, barred)).status).toBe(503);
  });
});

describe("requirePortalAuth: telefone pendente (T3)", () => {
  function app(gate: PortalPhoneGate, emailVerified = true) {
    const routes = new Hono<PortalAuthEnv>();
    const guard = createRequirePortalAuth(async () => resolved(emailVerified), undefined, gate);
    routes.get("/api/portal/customer", guard, (c) => c.json({ ok: true }));
    routes.get("/api/portal/me/phone-verification", guard, (c) => c.json({ ok: true }));
    routes.patch("/api/portal/me", guard, (c) => c.json({ ok: true }));
    routes.post("/api/portal/me/phone-change", guard, (c) => c.json({ ok: true }));
    return routes;
  }

  const call = (routes: Hono<PortalAuthEnv>, path: string, method = "GET") =>
    routes.request(path, { method, headers: { Cookie: PORTAL_COOKIE } });

  it("ficha pendente: 403 PHONE_UNVERIFIED, menos no que confirma ou corrige o número", async () => {
    const gate = vi.fn<PortalPhoneGate>(async () => false);
    const routes = app(gate);
    const blocked = await call(routes, "/api/portal/customer");

    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "PHONE_UNVERIFIED" });
    expect((await call(routes, "/api/portal/me/phone-verification")).status).toBe(200);
    // Corrigir o número é pela troca; editar o perfil (`PATCH`) não passa mais.
    expect((await call(routes, "/api/portal/me/phone-change", "POST")).status).toBe(200);
    expect((await call(routes, "/api/portal/me", "PATCH")).status).toBe(403);
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it("o e-mail vem antes do telefone", async () => {
    const gate = vi.fn<PortalPhoneGate>(async () => false);
    const response = await call(app(gate, false), "/api/portal/customer");

    expect(await response.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(gate).not.toHaveBeenCalled();
  });

  it("falha ao conferir o telefone é fechada (503)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const routes = app(async () => {
      throw new Error("banco fora do ar");
    });

    expect((await call(routes, "/api/portal/customer")).status).toBe(503);
    spy.mockRestore();
  });
});

describe("requireAuth", () => {
  it("cookie do portal não conta como cookie de equipe", async () => {
    const app = new Hono();
    app.get("/private", requireAuth, (c) => c.json({ ok: true }));

    const response = await app.request("/private", {
      headers: { Cookie: PORTAL_COOKIE },
    });

    expect(response.status).toBe(401);
  });
});
