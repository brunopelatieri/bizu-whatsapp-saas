import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requireAuth } from "@/api/auth";
import {
  createRequirePortalAuth,
  type PortalAuthEnv,
  type PortalBarrier,
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

  app.get("/private", createRequirePortalAuth(resolve, barred), (c) =>
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
