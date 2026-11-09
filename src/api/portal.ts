import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  createRateLimitByEmail,
  forwardedHeaders,
  hideUnverified,
} from "@/api/auth-ext";
import {
  authRateLimit,
  jsonBodyLimit,
  MINUTE,
  sameOrigin,
  validationError,
} from "@/api/guards";
import {
  type PortalTenantEnv,
  requirePortalAuth,
  requirePortalTenant,
} from "@/api/portal-auth";
import { clientKey, rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { INVALID_LINK_MESSAGE } from "@/api/verification-guard";
import { runInBackground } from "@/lib/auth/background";
import { PORTAL_AUTH_BASE_PATH } from "@/lib/auth/constants";
import { getPortalAuth } from "@/lib/auth/portal";
import { readVerificationClaims } from "@/lib/auth/verification-issue";
import {
  enterPortalTenant,
  enterRequestedTenant,
  listPortalTenants,
} from "@/lib/portal/access";
import {
  confirmPortalSignup,
  publicTenantInfo,
  requestPortalLogin,
  requestPortalSignup,
} from "@/lib/portal/login";
import {
  hasPortalPassword,
  setPortalPassword,
  updatePortalProfile,
} from "@/lib/portal/profile";
import {
  magicLinkRequestSchema,
  portalProfileSchema,
  portalSignupSchema,
  portalTokenSchema,
  setPasswordSchema,
} from "@/lib/schemas/portal";
import { activeTenantSchema, slugSchema } from "@/lib/schemas/tenant";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { acceptCurrentVersions, pendingConsents } from "@/lib/lgpd/consent";
import { portalEmailBarred } from "@/lib/lgpd/deletion";
import { acceptConsentSchema } from "@/lib/schemas/lgpd";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * O que o portal expõe do Better Auth. Lista fechada: magic link, cadastro e reset passam
 * pelas rotas abaixo, com resposta uniforme, e `verify` não pode consumir token em GET.
 */
const PORTAL_AUTH_PATHS = new Set([
  "POST /sign-in/email",
  "POST /sign-out",
  "GET /get-session",
  "GET /list-sessions",
  "POST /revoke-session",
  "POST /revoke-other-sessions",
]);

/**
 * Na carência de uma exclusão pedida pela plataforma, a senha certa não entra. Em vez de uma
 * resposta própria, a senha vai trocada por uma aleatória: o Better Auth responde o mesmo 401
 * de senha errada, com o mesmo corpo, cabeçalhos e tempo (o hash ainda é conferido).
 */
async function barredSignIn(body: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  const email = (parsed as { email?: unknown } | null)?.email;
  if (typeof email !== "string" || !(await portalEmailBarred(email))) return body;

  return JSON.stringify({
    ...(parsed as object),
    password: randomBytes(24).toString("base64url"),
  });
}

/** Só para quem chega depois de um GET: a página renderiza e o botão faz o POST. */
const GET_NOT_ALLOWED = { error: "Use o botão da página do link." };

const verifyRateLimit = rateLimit({ name: "portal-verify", limit: 10, windowMs: MINUTE });

/**
 * `/api/portal/*`, a API de quem é cliente de um tenant. O tenant vem da sessão do portal:
 * nada aqui recebe `tenantId` para ler dados, e toda leitura parte do `portal_user` da
 * sessão. Cookie de equipe não abre estas rotas, e o de portal não abre as de equipe.
 */
export const portalRoutes = new Hono<PortalTenantEnv>();

portalRoutes.onError(handleTenantError);
portalRoutes.use("/api/portal/*", sameOrigin, jsonBodyLimit);

/** Remonta o GET do Better Auth atrás do POST do botão. */
function verifyRequest(url: string, token: string, headers: Headers) {
  const target = new URL(url);
  target.search = new URLSearchParams({ token }).toString();
  headers.delete("Content-Type");

  return getPortalAuth().handler(
    new Request(target, { method: "GET", headers }),
  );
}

portalRoutes.get(`${PORTAL_AUTH_BASE_PATH}/magic-link/verify`, (c) =>
  c.json(GET_NOT_ALLOWED, 405),
);

portalRoutes.post(
  `${PORTAL_AUTH_BASE_PATH}/magic-link/verify`,
  verifyRateLimit,
  zValidator("json", portalTokenSchema, validationError),
  async (c) => {
    const { token, org } = c.req.valid("json");
    const response = await verifyRequest(
      c.req.url,
      token,
      forwardedHeaders(c),
    );

    // Expirado, usado ou inventado: o plugin redireciona, e aqui é tudo a mesma resposta.
    if (!response.ok) return c.json({ error: INVALID_LINK_MESSAGE }, 400);

    for (const cookie of response.headers.getSetCookie()) {
      c.header("Set-Cookie", cookie, { append: true });
    }

    const { user, session } = (await response.json()) as {
      user: { id: string };
      session: { id: string };
    };

    await enterRequestedTenant(session.id, user.id, org);

    return c.json({ ok: true });
  },
);

portalRoutes.get(`${PORTAL_AUTH_BASE_PATH}/verify-email`, (c) =>
  c.json(GET_NOT_ALLOWED, 405),
);

portalRoutes.post(
  `${PORTAL_AUTH_BASE_PATH}/verify-email`,
  verifyRateLimit,
  zValidator("json", portalTokenSchema, validationError),
  async (c) => {
    const { token, org } = c.req.valid("json");
    const response = await verifyRequest(
      c.req.url,
      token,
      forwardedHeaders(c),
    );

    if (!response.ok) return c.json({ error: INVALID_LINK_MESSAGE }, 400);

    const { email } = readVerificationClaims(token);

    if (email && org) await confirmPortalSignup(email, org);

    return c.json({ ok: true });
  },
);

portalRoutes.on(["GET", "POST"], `${PORTAL_AUTH_BASE_PATH}/*`, async (c) => {
  const { method, url, path } = c.req;

  if (!PORTAL_AUTH_PATHS.has(`${method} ${path.slice(PORTAL_AUTH_BASE_PATH.length)}`)) {
    return c.json({ error: "Não encontrado." }, 404);
  }

  let body = method === "POST" ? await c.req.text() : undefined;
  if (body && path === `${PORTAL_AUTH_BASE_PATH}/sign-in/email`) {
    body = await barredSignIn(body);
  }
  const response = await getPortalAuth().handler(
    new Request(url, { method, headers: forwardedHeaders(c), body }),
  );

  return hideUnverified(response);
});

/** Só o que a tela de login mostra. Slug malformado é só algo que não existe. */
portalRoutes.get(
  "/api/portal/auth-ext/org/:slug",
  rateLimit({ name: "portal-org", limit: 30, windowMs: MINUTE }),
  async (c) => {
    const slug = slugSchema.safeParse(c.req.param("slug"));
    const tenant = slug.success ? await publicTenantInfo(slug.data) : null;

    if (!tenant) throw notFound("Não encontrado.");

    return c.json({ tenant });
  },
);

portalRoutes.post(
  "/api/portal/auth-ext/magic-link",
  rateLimit({ name: "portal-magic-link", limit: 3, windowMs: 15 * MINUTE }),
  zValidator("json", magicLinkRequestSchema, validationError),
  createRateLimitByEmail("portal-magic-link-by-email"),
  (c) => {
    const { email, org } = c.req.valid("json");

    runInBackground(requestPortalLogin(email, org));

    return c.json({ ok: true });
  },
);

portalRoutes.post(
  "/api/portal/auth-ext/sign-up",
  rateLimit({ name: "portal-sign-up", limit: 3, windowMs: 15 * MINUTE }),
  zValidator("json", portalSignupSchema, validationError),
  createRateLimitByEmail("portal-sign-up-by-email"),
  (c) => {
    runInBackground(
      requestPortalSignup(c.req.valid("json"), {
        ip: clientKey(c),
        userAgent: c.req.header("User-Agent"),
      }),
    );

    return c.json({ ok: true });
  },
);

portalRoutes.post(
  "/api/portal/auth-ext/set-password",
  rateLimit({ name: "portal-set-password", limit: 5, windowMs: 15 * MINUTE }),
  requirePortalAuth,
  zValidator("json", setPasswordSchema, validationError),
  async (c) => {
    await setPortalPassword(
      {
        user: c.get("portalUser"),
        session: c.get("portalSession"),
        ip: clientKey(c),
      },
      c.req.valid("json"),
    );

    return c.json({ ok: true });
  },
);

portalRoutes.get("/api/portal/me", authRateLimit, requirePortalAuth, async (c) => {
  const { id, name, email, phone, phoneNormalized } = c.get("portalUser");
  const session = c.get("portalSession");
  const tenants = await listPortalTenants(id);
  const available = tenants.filter((tenant) => tenant.available);

  let active =
    available.find((tenant) => tenant.id === session.activeTenantId) ?? null;

  // Sem tenant ativo e sem o que escolher: entrou ou saiu um vínculo depois do login.
  if (!active && available.length === 1) {
    active = available[0] ?? null;
    if (active) await enterPortalTenant(session.id, id, active.id);
  }

  return c.json({
    consentRequired: await pendingConsents({ type: "portal_user", id }),
    user: { id, name, email, phone, phoneNormalized, hasPassword: await hasPortalPassword(id) },
    tenants: tenants.map(({ id, slug, name, status, available }) => ({
      id,
      slug,
      name,
      status,
      available,
    })),
    active: active && { id: active.id, slug: active.slug, name: active.name },
  });
});

/** Re-aceite dos textos legais (modal do `PortalLayout`). */
portalRoutes.post(
  "/api/portal/me/consent",
  authRateLimit,
  requirePortalAuth,
  zValidator("json", acceptConsentSchema, validationError),
  async (c) => {
    if (c.req.valid("json").version !== LEGAL_VERSIONS.terms) {
      throw new TenantRuleError(
        409,
        "STALE_LEGAL_VERSION",
        "Os textos foram atualizados. Recarregue a página e leia a versão nova.",
      );
    }

    await acceptCurrentVersions(
      { type: "portal_user", id: c.get("portalUser").id },
      { ip: clientKey(c), userAgent: c.req.header("User-Agent") },
    );

    return c.json({ ok: true });
  },
);

portalRoutes.post(
  "/api/portal/active-tenant",
  authRateLimit,
  requirePortalAuth,
  zValidator("json", activeTenantSchema, validationError),
  async (c) => {
    const { tenantId } = c.req.valid("json");
    const { id } = c.get("portalUser");
    const tenants = await listPortalTenants(id);

    if (!tenants.some((tenant) => tenant.available && tenant.id === tenantId)) {
      throw notFound("Organização não encontrada.");
    }

    await enterPortalTenant(c.get("portalSession").id, id, tenantId);

    return c.json({ ok: true });
  },
);

portalRoutes.patch(
  "/api/portal/me",
  authRateLimit,
  requirePortalAuth,
  requirePortalTenant,
  zValidator("json", portalProfileSchema, validationError),
  async (c) => {
    const user = await updatePortalProfile(
      c.get("portalUser").id,
      c.get("customer"),
      c.req.valid("json"),
      clientKey(c),
    );

    return c.json({ user });
  },
);

portalRoutes.get(
  "/api/portal/customer",
  authRateLimit,
  requirePortalAuth,
  requirePortalTenant,
  (c) => {
    const { tenant, name, email, phone, document, status } = c.get("customer");

    return c.json({ tenant, customer: { name, email, phone, document, status } });
  },
);
