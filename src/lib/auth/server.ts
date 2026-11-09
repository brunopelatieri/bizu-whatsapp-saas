import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { eq } from "drizzle-orm";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { runInBackground } from "@/lib/auth/background";
import { type AuditAction, audit } from "@/lib/audit";
import {
  AUTH_COOKIE_PREFIX,
  CLIENT_IP_HEADER,
  INVITATION_TTL_SECONDS,
  MAX_CUSTOM_ROLES,
  TRUST_DEVICE_SECONDS,
} from "@/lib/auth/constants";
import {
  emailChangeCompleted,
  sendChangeEmailApproval,
  sendChangeEmailDone,
  sendExistingUserNotice,
  sendInvitationLink,
  sendPasswordChangedNotice,
  sendResetPasswordLink,
  sendVerificationLink,
} from "@/lib/auth/emails";
import {
  platformAccessControl,
  platformRoles,
  tenantAccessControl,
  tenantRoles,
} from "@/lib/auth/permissions";
import { logError } from "@/api/log";
import { getEnv } from "@/lib/env";

import { recordSignupConsent, signupPhoneValues } from "@/lib/lgpd/consent";
import { preferredTenantId } from "@/lib/tenant/membership";

/** Só o plugin grava `two_factor_enabled`, então a rota diz o que mudou. */
const TWO_FACTOR_AUDIT: Record<string, AuditAction> = {
  "/two-factor/verify-totp": "auth.2fa_enabled",
  "/two-factor/disable": "auth.2fa_disabled",
};

function createAuth() {
  const env = getEnv();
  // Desligada (padrão), o cadastro entra direto (`tech/08-auth.md`).
  const verify = env.EMAIL_VERIFICATION_REQUIRED;

  return betterAuth({
    appName: "Bizu SaaS",
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(env.APP_URL).origin],
    database: drizzleAdapter(getDb(), { provider: "pg", schema }),

    // Sem rota HTTP: reenvio e reset passam por /api/auth-ext (resposta uniforme e
    // limite por e-mail); personificação, pela política de consentimento (`impersonation.ts`);
    // escrita sobre usuários, por /api/admin/*, com as regras e a auditoria de lá (o plugin
    // não compara o papel do alvo); sessões, por /api/me/sessions, com auditoria e sem
    // expor tokens. `auth.api.*` continua disponível no servidor.
    disabledPaths: [
      "/send-verification-email",
      "/request-password-reset",
      "/list-sessions",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
      "/two-factor/send-otp",
      "/two-factor/verify-otp",
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
      "/admin/set-role",
      "/admin/create-user",
      "/admin/update-user",
      "/admin/ban-user",
      "/admin/unban-user",
      "/admin/revoke-user-session",
      "/admin/revoke-user-sessions",
      "/admin/remove-user",
      "/admin/set-user-password",
    ],

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: verify,
      // O cadastro nunca abre sessão: a resposta é a mesma para e-mail novo e existente, e
      // `onExistingUserSignUp` avisa o dono. Sem verificação, o cliente entra em seguida.
      autoSignIn: false,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }) =>
        sendResetPasswordLink(user, token),
      onPasswordReset: async ({ user }, request) => {
        // O link chegou ao endereço da conta: concluir o reset prova o e-mail (inclusive o
        // trocado pelo /admin, que volta como não verificado).
        if (!user.emailVerified) {
          await getDb()
            .update(schema.user)
            .set({ emailVerified: true })
            .where(eq(schema.user.id, user.id));
        }
        runInBackground(sendPasswordChangedNotice(user));
        runInBackground(
          audit("auth.password_reset", {
            actor: { id: user.id },
            ip: request?.headers.get(CLIENT_IP_HEADER),
          }),
        );
      },
      onExistingUserSignUp: ({ user }) => sendExistingUserNotice(user),
    },

    emailVerification: {
      sendOnSignUp: verify,
      sendOnSignIn: verify,
      expiresIn: 3600,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, token }) =>
        sendVerificationLink(user, token),
      afterEmailVerification: async (user, request) => {
        const ip = request?.headers.get(CLIENT_IP_HEADER);

        runInBackground(sendChangeEmailDone(user, request));
        runInBackground(audit("auth.email_verified", { actor: { id: user.id }, ip }));

        if (emailChangeCompleted(request)) {
          runInBackground(audit("auth.email_changed", { actor: { id: user.id }, ip }));
        }
      },
    },

    user: {
      additionalFields: {
        // O telefone só entra pelo contexto do cadastro (`signupPhoneValues`), nunca pelo
        // corpo: `input: false` nas três colunas.
        phone: { type: "string", required: false, input: false },
        phoneNormalized: { type: "string", required: false, input: false },
        phoneKey: { type: "string", required: false, input: false },
        locale: { type: "string", required: false, input: false },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: ({ user, newEmail, token }) =>
          sendChangeEmailApproval(user, newEmail, token),
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 300 },
    },

    // Sessão nova abre no último tenant usado, se a pessoa ainda for membro.
    databaseHooks: {
      user: {
        create: {
          // Toda conta nasce com telefone (`CHECK` no banco). Sem o contexto do cadastro, a
          // criação falha aqui, antes do `INSERT`.
          before: async (user) => ({ data: { ...user, ...signupPhoneValues("user") } }),
          after: async (user, context) => {
            // Só grava se a rota de cadastro abriu o contexto de aceite (`withSignupConsent`).
            await recordSignupConsent({ type: "user", id: user.id }).catch((error) =>
              logError("Falha ao registrar o consentimento", error),
            );
            runInBackground(
              audit("auth.signed_up", {
                actor: { id: user.id },
                ip: context?.request?.headers.get(CLIENT_IP_HEADER),
              }),
            );
          },
        },
        update: {
          after: async (user, context) => {
            const action = context?.path && TWO_FACTOR_AUDIT[context.path];
            if (!action) return;

            runInBackground(
              audit(action, {
                actor: { id: user.id },
                ip: context.request?.headers.get(CLIENT_IP_HEADER),
              }),
            );
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              activeOrganizationId: await preferredTenantId(session.userId),
            },
          }),
        },
      },
    },

    // Só o reset usa `verification`: o token não fica legível no banco.
    verification: { storeIdentifier: "hashed" },

    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 10, max: 3 },
        "/sign-up/email": { window: 10, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/change-email": { window: 60, max: 3 },
        // Toda página consulta a sessão: sem escrita no banco por leitura.
        "/get-session": false,
      },
    },

    plugins: [
      admin({
        ac: platformAccessControl,
        roles: platformRoles,
        defaultRole: "user",
        adminRoles: ["platform_owner", "platform_support"],
        impersonationSessionDuration: 3600,
      }),
      twoFactor({ issuer: "Bizu SaaS", trustDeviceMaxAge: TRUST_DEVICE_SECONDS }),
      // Só por `auth.api.*`: `/api/auth/organization/*` não responde (`auth-ext.ts`).
      // `status`, `access_mode` e `settings` do tenant não passam pelo plugin.
      organization({
        ac: tenantAccessControl,
        roles: tenantRoles,
        creatorRole: "owner",
        dynamicAccessControl: {
          enabled: true,
          maximumRolesPerOrganization: MAX_CUSTOM_ROLES,
        },
        allowUserToCreateOrganization: (user) => !verify || user.emailVerified,
        // Sem teto aqui: o limite é do plano (`plan.limits.organizations`) e só
        // `POST /api/tenant` cria organização, com lock por pessoa
        // (`createOrganizationWithinLimit`).
        invitationExpiresIn: INVITATION_TTL_SECONDS,
        // Sem verificação, aceitar exige o id do convite, que só chega pelo e-mail.
        requireEmailVerificationOnInvitation: verify,
        cancelPendingInvitationsOnReInvite: true,
        // Exclusão de tenant tem carência e fluxo próprio (fase 10).
        disableOrganizationDeletion: true,
        sendInvitationEmail: (data) => sendInvitationLink(data),
        schema: {
          organizationRole: {
            additionalFields: {
              description: { type: "string", required: false, input: true },
            },
          },
        },
      }),
    ],

    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: env.NODE_ENV === "production",
      database: { generateId: "uuid" },
      // Preenchido pela API a partir de TRUSTED_PROXY_HOPS (`src/api/auth-ext.ts`):
      // X-Forwarded-For vem do cliente e não serve para limitar tentativas.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      backgroundTasks: { handler: runInBackground },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

/**
 * Instância `auth` (equipe e plataforma). Criada na primeira chamada, como `getDb`:
 * `src/server.ts` só carrega `.env.local` depois de importar a API.
 */
export function getAuth(): Auth {
  if (!instance) instance = createAuth();
  return instance;
}

/** Descarta a instância (testes que trocam `EMAIL_VERIFICATION_REQUIRED`). */
export function resetAuthForTests() {
  instance = undefined;
}
