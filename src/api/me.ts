import { Hono } from "hono";
import type { AuthEnv } from "@/api/auth";
import { missingPlatform2fa, requireAuth } from "@/api/auth";
import { authRateLimit } from "@/api/guards";
import { handleTenantError } from "@/api/tenant-errors";
import { zValidator } from "@hono/zod-validator";
import { jsonBodyLimit, sameOrigin, validationError } from "@/api/guards";
import { blockWhileImpersonating } from "@/api/impersonation";
import { clientKey } from "@/api/rate-limit";
import { audit } from "@/lib/audit";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import {
  acceptCurrentVersions,
  currentConsents,
  pendingConsents,
  setMarketingConsent,
} from "@/lib/lgpd/consent";
import { acceptConsentSchema, marketingConsentSchema } from "@/lib/schemas/lgpd";
import { TenantRuleError } from "@/lib/tenant/errors";
import { permissionsOf } from "@/lib/auth/permissions";
import { loadTenantBilling } from "@/lib/billing/summary";
import type { AuthUser, MeResponse } from "@/lib/auth/types";
import {
  activateTenant,
  listMemberships,
  type Membership,
  preferredTenantId,
} from "@/lib/tenant/membership";
import { loadRoleCatalog } from "@/lib/tenant/roles";
import { teamPhoneGatePasses } from "@/lib/phone/gate";
import { phoneVerificationRequired } from "@/api/phone-gate";
import { listInvitationsFor } from "@/lib/tenant/team";

/**
 * O tenant ativo da sessão, se a pessoa ainda for membro. Removida dele, a sessão passa
 * ao tenant preferido, ou a nenhum: a interface manda ao onboarding.
 */
async function resolveActiveTenant(
  user: AuthUser,
  sessionId: string,
  activeId: string | null,
  memberships: Membership[],
) {
  const current = memberships.find(({ id }) => id === activeId);
  if (current) return current;

  // A sessão de suporte vale para um tenant só: nunca escorrega para outro da mesma pessoa.
  if (user.impersonatedBy) return null;

  const preferredId = await preferredTenantId(user.id);
  const preferred = memberships.find(({ id }) => id === preferredId) ?? null;

  if (preferred || activeId) {
    await activateTenant(sessionId, user.id, preferred?.id ?? null);
  }

  return preferred;
}

async function activePermissions(tenant: Membership | null) {
  if (!tenant) return [];
  if (tenant.status !== "active" || tenant.accessMode === "locked") return [];

  return permissionsOf(await loadRoleCatalog(tenant.id), tenant.role);
}

export const meRoutes = new Hono<AuthEnv>();

meRoutes.onError(handleTenantError);

meRoutes.get("/api/me", authRateLimit, requireAuth, async (c) => {
  const user = c.get("user");
  const memberships = await listMemberships(user.id);
  const tenant = await resolveActiveTenant(
    user,
    c.get("session").id,
    c.get("activeOrganizationId"),
    memberships,
  );
  const permissions = await activePermissions(tenant);
  const billing = tenant ? await loadTenantBilling(tenant) : null;
  // O suporte não aceita termos em nome de ninguém: a sessão dele não pede re-aceite.
  const consentRequired = user.impersonatedBy
    ? []
    : await pendingConsents({ type: "user", id: user.id });
  // Com `PHONE_VERIFICATION_REQUIRED=true` quem não passa nem chega aqui (403 em `requireAuth`);
  // desligada, a interface mostra o aviso "Confirme seu WhatsApp".
  const phonePending =
    !phoneVerificationRequired() && !(await teamPhoneGatePasses(user.id, tenant?.id ?? null));

  return c.json<MeResponse>({
    user: {
      ...user,
      activeTenant: tenant && {
        id: tenant.id,
        slug: tenant.slug,
        role: tenant.role,
        permissions,
      },
    },
    // Quem personifica entra em um tenant: os outros da pessoa não são da conta dele.
    tenants: memberships
      .filter(({ id }) => !user.impersonatedBy || id === tenant?.id)
      .map(({ id, slug, name, role, status }) => ({
        id,
        slug,
        name,
        role,
        status,
      })),
    permissions,
    billing: billing?.billing ?? null,
    features: billing?.features ?? [],
    limits: billing?.limits ?? {},
    security: {
      tenantRequires2fa: Boolean(tenant?.require2fa && !user.twoFactorEnabled),
      platformRequires2fa: missingPlatform2fa(user),
    },
    consentRequired,
    phonePending,
  });
});

meRoutes.use("/api/me/consent/*", sameOrigin, jsonBodyLimit);

/** Estado do consentimento para a tela de privacidade: marketing e versões já aceitas. */
meRoutes.get(
  "/api/me/consent",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  async (c) => {
    const latest = await currentConsents({ type: "user", id: c.get("user").id });
    const accepted = (kind: "terms" | "privacy" | "marketing") => {
      const row = latest.get(kind);
      return row?.accepted ? row.version : null;
    };

    return c.json({
      marketing: accepted("marketing") !== null,
      accepted: { terms: accepted("terms"), privacy: accepted("privacy") },
      current: LEGAL_VERSIONS,
    });
  },
);

/** Re-aceite dos textos legais (modal do `AppLayout`). */
meRoutes.post(
  "/api/me/consent",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  zValidator("json", acceptConsentSchema, validationError),
  async (c) => {
    const user = c.get("user");

    if (c.req.valid("json").version !== LEGAL_VERSIONS.terms) {
      throw new TenantRuleError(
        409,
        "STALE_LEGAL_VERSION",
        "Os textos foram atualizados. Recarregue a página e leia a versão nova.",
      );
    }

    await acceptCurrentVersions(
      { type: "user", id: user.id },
      { ip: clientKey(c), userAgent: c.req.header("User-Agent") },
    );
    await audit("auth.consent_accepted", {
      actor: { id: user.id },
      metadata: { version: LEGAL_VERSIONS.terms },
      ip: clientKey(c),
    });

    return c.json({ ok: true });
  },
);

/** Marketing é opcional e revogável a qualquer momento. */
meRoutes.post(
  "/api/me/consent/marketing",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  zValidator("json", marketingConsentSchema, validationError),
  async (c) => {
    await setMarketingConsent(
      { type: "user", id: c.get("user").id },
      c.req.valid("json").accepted,
      { ip: clientKey(c), userAgent: c.req.header("User-Agent") },
    );

    return c.json({ ok: true });
  },
);

/**
 * Só com o e-mail verificado: com a verificação desligada, quem cadastrasse o e-mail de outra
 * pessoa veria (e aceitaria) os convites dela. Sem verificar, o convite entra pelo link.
 */
meRoutes.get("/api/me/invitations", authRateLimit, requireAuth, async (c) => {
  const { email, emailVerified } = c.get("user");

  return c.json({
    invitations: emailVerified ? await listInvitationsFor(email) : [],
  });
});
