import { getSessionCookie } from "better-auth/cookies";
import { createMiddleware } from "hono/factory";
import { logError } from "@/api/log";
import { refusal } from "@/api/permissions";
import { PORTAL_COOKIE_PREFIX } from "@/lib/auth/constants";
import { getPortalAuth } from "@/lib/auth/portal";
import { portalAccessBarred } from "@/lib/lgpd/deletion";
import { findPortalCustomer, type PortalCustomer } from "@/lib/portal/access";

export type PortalUserContext = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  phone: string | null;
  phoneNormalized: string | null;
};

export type PortalSessionContext = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  activeTenantId: string | null;
};

export type PortalAuthEnv = {
  Variables: {
    portalUser: PortalUserContext;
    portalSession: PortalSessionContext;
  };
};

export type PortalTenantEnv = {
  Variables: PortalAuthEnv["Variables"] & { customer: PortalCustomer };
};

export type ResolvedPortalSession = {
  user: PortalUserContext;
  session: PortalSessionContext;
};

/** A plataforma agendou a exclusão desta pessoa (`portalAccessBarred`). */
export type PortalBarrier = (portalUserId: string) => Promise<boolean>;

export type ResolvePortalSession = (
  headers: Headers,
) => Promise<ResolvedPortalSession | null>;

/** Lê a sessão no banco: revogada ou com o tenant trocado, vale na hora. */
const resolvePortalSession: ResolvePortalSession = async (headers) => {
  const result = await getPortalAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });

  if (!result) return null;

  const { user, session } = result;

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      phone: user.phone ?? null,
      phoneNormalized: user.phoneNormalized ?? null,
    },
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      activeTenantId: session.activeTenantId ?? null,
    },
  };
};

/**
 * `requireAuth` do portal. Olha só o cookie `bizu_portal`, assinado com outro segredo:
 * um nunca vale pelo outro. Falha fechada: Auth indisponível não abre a rota. Na carência de
 * uma exclusão pedida pela plataforma (`barred`), a sessão vale como inexistente (401).
 */
export function createRequirePortalAuth(
  resolve: ResolvePortalSession,
  barred: PortalBarrier = async () => false,
) {
  return createMiddleware<PortalAuthEnv>(async (c, next) => {
    const { headers } = c.req.raw;

    if (!getSessionCookie(headers, { cookiePrefix: PORTAL_COOKIE_PREFIX })) {
      return c.json({ error: "Autenticação necessária." }, 401);
    }

    let resolved: ResolvedPortalSession | null;

    try {
      resolved = await resolve(headers);
      if (resolved && (await barred(resolved.user.id))) resolved = null;
    } catch (error) {
      logError("Falha ao validar sessão do portal", error);
      return c.json({ error: "Autenticação indisponível." }, 503);
    }

    if (!resolved) {
      return c.json({ error: "Sessão inválida ou expirada." }, 401);
    }

    if (!resolved.user.emailVerified) {
      return c.json(
        { error: "Confirme seu e-mail para entrar.", code: "EMAIL_NOT_VERIFIED" },
        403,
      );
    }

    c.set("portalUser", resolved.user);
    c.set("portalSession", resolved.session);
    await next();
  });
}

export const requirePortalAuth = createRequirePortalAuth(
  resolvePortalSession,
  portalAccessBarred,
);

/**
 * Vem depois de `requirePortalAuth`. O tenant é o da sessão, nunca o da requisição, e o
 * vínculo é lido a cada chamada dentro de `withTenant`: cliente bloqueado cai na hora.
 */
export const requirePortalTenant = createMiddleware<PortalTenantEnv>(
  async (c, next) => {
    const tenantId = c.get("portalSession").activeTenantId;
    let current: PortalCustomer | null = null;

    try {
      if (tenantId) {
        current = await findPortalCustomer(c.get("portalUser").id, tenantId);
      }
    } catch (error) {
      logError("Falha ao carregar o cliente do portal", error);
      return c.json({ error: "Portal indisponível." }, 503);
    }

    if (current?.status !== "active") {
      return c.json(
        { error: "Escolha uma organização.", code: "PORTAL_TENANT_REQUIRED" },
        403,
      );
    }

    const refused = refusal(c, {
      status: current.tenantStatus,
      accessMode: current.accessMode,
    });
    if (refused) return refused;

    c.set("customer", current);
    await next();
  },
);
