import { getSessionCookie } from "better-auth/cookies";
import { createMiddleware } from "hono/factory";
import { logError } from "@/api/log";
import { withImpersonator } from "@/lib/audit";
import { AUTH_COOKIE_PREFIX } from "@/lib/auth/constants";
import { getAuth } from "@/lib/auth/server";
import { impersonationExpired } from "@/lib/auth/sessions";
import { getEnv } from "@/lib/env";
import { teamPhoneGatePasses } from "@/lib/phone/gate";
import {
  PHONE_UNVERIFIED,
  phoneVerificationRequired,
  teamPhonePendingAllowed,
} from "@/api/phone-gate";
import { type AuthUser, type PlatformRole, toAuthUser } from "@/lib/auth/types";

export type AuthSession = { id: string; expiresAt: Date };

export type AuthEnv = {
  Variables: {
    user: AuthUser;
    session: AuthSession;
    activeOrganizationId: string | null;
  };
};

export type ResolvedSession = {
  user: AuthUser;
  session: AuthSession;
  activeOrganizationId?: string | null;
};

/** Retorna a sessão dos cookies, `null` se não houver e lança se o Auth falhar. */
export type ResolveSession = (headers: Headers) => Promise<ResolvedSession | null>;

/**
 * Lê a sessão no banco, sem o cache do cookie: a sessão revogada cai na hora, não
 * em até 5 minutos.
 */
export const resolveSession: ResolveSession = async (headers) => {
  const result = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });

  if (!result) return null;

  if (
    result.session.impersonatedBy &&
    (await impersonationExpired(result.session.id))
  ) {
    return null;
  }

  return {
    user: toAuthUser(result),
    session: { id: result.session.id, expiresAt: result.session.expiresAt },
    activeOrganizationId: result.session.activeOrganizationId,
  };
};

/**
 * O telefone da conta vale para esta sessão? `true` segue. Só é chamado com
 * `PHONE_VERIFICATION_REQUIRED=true` e fora da lista do que passa (`src/api/phone-gate.ts`).
 */
export type PhoneGate = (user: AuthUser, activeOrganizationId: string | null) => Promise<boolean>;

/** O padrão: desligado pela variável, ou o predicado da T3 (`src/lib/phone/gate.ts`). */
export const defaultPhoneGate: PhoneGate = async (user, activeOrganizationId) =>
  !phoneVerificationRequired() || teamPhoneGatePasses(user.id, activeOrganizationId);

/**
 * Exige sessão válida e, com `EMAIL_VERIFICATION_REQUIRED`, e-mail verificado; depois, com
 * `PHONE_VERIFICATION_REQUIRED`, telefone que vale na organização ativa. O gate do `ProtectedRoute`
 * roda no cliente e não protege dados: toda rota privada da API deve usar este middleware.
 *
 * Ordem das recusas: 401 sem cookie; 503 com o Auth fora; 401 sessão inválida; 403
 * `EMAIL_NOT_VERIFIED`; 403 `PHONE_UNVERIFIED`. O e-mail vem antes: quem não provou o e-mail não
 * chega a saber nada do telefone, e nem as rotas que confirmam o telefone abrem sem ele.
 * Falha fechada: se o Auth ou o banco estiverem indisponíveis, a rota não abre.
 */
export function createRequireAuth(
  resolve: ResolveSession,
  /** `EMAIL_VERIFICATION_REQUIRED`, lido a cada requisição (os testes trocam). */
  verificationRequired: () => boolean = () => getEnv().EMAIL_VERIFICATION_REQUIRED,
  phoneGate: PhoneGate = defaultPhoneGate,
) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const { headers } = c.req.raw;

    // Sem cookie não há o que consultar: o Auth e o banco nem são chamados.
    if (!getSessionCookie(headers, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
      return c.json({ error: "Autenticação necessária." }, 401);
    }

    let resolved: ResolvedSession | null;

    try {
      resolved = await resolve(headers);
    } catch (error) {
      logError("Falha ao validar sessão", error);
      return c.json({ error: "Autenticação indisponível." }, 503);
    }

    if (!resolved) {
      return c.json({ error: "Sessão inválida ou expirada." }, 401);
    }

    if (!resolved.user.emailVerified && verificationRequired()) {
      return c.json(
        { error: "Confirme seu e-mail para entrar.", code: "EMAIL_NOT_VERIFIED" },
        403,
      );
    }

    const activeOrganizationId = resolved.activeOrganizationId ?? null;

    // A sessão personificada responde pelo telefone da conta personificada: o suporte vê a mesma
    // tela que ela, e não confirma nem reenvia nada (`blockWhileImpersonating`).
    if (!teamPhonePendingAllowed(c)) {
      let passes: boolean;

      try {
        passes = await phoneGate(resolved.user, activeOrganizationId);
      } catch (error) {
        logError("Falha ao conferir o telefone da conta", error);
        return c.json({ error: "Autenticação indisponível." }, 503);
      }

      if (!passes) return c.json(PHONE_UNVERIFIED, 403);
    }

    c.set("user", resolved.user);
    c.set("session", resolved.session);
    c.set("activeOrganizationId", activeOrganizationId);

    const { impersonatedBy } = resolved.user;

    if (impersonatedBy) await withImpersonator(impersonatedBy, next);
    else await next();
  });
}

export const requireAuth = createRequireAuth(resolveSession);

const PLATFORM_STAFF: PlatformRole[] = ["platform_owner", "platform_support"];

/** Em produção, papel de plataforma sem 2FA não entra: é a conta mais visada do sistema. */
export function missingPlatform2fa(user: AuthUser) {
  return (
    process.env.NODE_ENV === "production" &&
    PLATFORM_STAFF.includes(user.platformRole) &&
    !user.twoFactorEnabled
  );
}

/**
 * Vem depois de `requireAuth`. Restrinja a `platform_owner` nas rotas que o suporte
 * não pode usar. As rotas `/api/auth/two-factor/*` ficam de fora, e por elas se ativa o 2FA.
 */
export function requirePlatform(roles: PlatformRole[] = PLATFORM_STAFF) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (!roles.includes(c.get("user").platformRole)) {
      return c.json(
        { error: "Acesso restrito à plataforma.", code: "PLATFORM_FORBIDDEN" },
        403,
      );
    }

    if (missingPlatform2fa(c.get("user"))) {
      return c.json(
        {
          error: "Ative a verificação em duas etapas para usar a administração.",
          code: "PLATFORM_2FA_REQUIRED",
        },
        403,
      );
    }

    await next();
  });
}
