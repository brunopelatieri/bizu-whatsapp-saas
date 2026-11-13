import type { BillingSummary } from "@/lib/billing/summary";

export const PLATFORM_ROLES = [
  "user",
  "platform_owner",
  "platform_support",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Organização de que a pessoa faz parte. */
export type TenantSummary = {
  id: string;
  slug: string;
  name: string;
  role: string;
  status: string;
};

/** Resposta de `GET /api/me`. `billing`, `features` e `limits` são do tenant ativo. */
export type MeResponse = {
  user: AuthUser;
  tenants: TenantSummary[];
  permissions: string[];
  /** `null` sem tenant ativo. */
  billing: BillingSummary | null;
  features: string[];
  /** Só os limites definidos pelo plano; chave ausente = ilimitado. */
  limits: Record<string, number>;
  /** Falta 2FA para seguir: a API responde 403 até a pessoa configurar. */
  security: { tenantRequires2fa: boolean; platformRequires2fa: boolean };
  /** Documentos legais com versão nova a aceitar. Vazio: nada pendente (ou sessão de suporte). */
  consentRequired: Array<"terms" | "privacy">;
  /**
   * O telefone não vale na organização ativa (T3). Só chega `true` com
   * `PHONE_VERIFICATION_REQUIRED=false`: ligada, a API responde 403 `PHONE_UNVERIFIED` antes.
   */
  phonePending: boolean;
};

/** Usuário independente de provedor, usado pela interface e pela API. */
export type AuthUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  platformRole: PlatformRole;
  twoFactorEnabled: boolean;
  activeTenant: {
    id: string;
    slug: string;
    role: string;
    permissions: string[];
  } | null;
  impersonatedBy: string | null;
};

type SessionData = {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    role?: string | null;
    twoFactorEnabled?: boolean | null;
  };
  session: { impersonatedBy?: string | null };
};

function toPlatformRole(role: string | null | undefined): PlatformRole {
  return PLATFORM_ROLES.find((known) => known === role) ?? "user";
}

/**
 * Converte a sessão do Better Auth em `AuthUser`. Usada pela API e pelo cliente.
 * O tenant ativo vem de `GET /api/me`.
 */
export function toAuthUser({ user, session }: SessionData): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    platformRole: toPlatformRole(user.role),
    twoFactorEnabled: user.twoFactorEnabled ?? false,
    activeTenant: null,
    impersonatedBy: session.impersonatedBy ?? null,
  };
}
