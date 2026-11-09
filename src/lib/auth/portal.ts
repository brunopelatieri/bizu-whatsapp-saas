import { createHash, createHmac } from "node:crypto";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink, twoFactor } from "better-auth/plugins";
import { getDb } from "@/db";
import {
  portalAccount,
  portalRateLimit,
  portalSession,
  portalTwoFactor,
  portalUser,
  portalVerification,
} from "@/db/schema";
import { runInBackground } from "@/lib/auth/background";
import {
  CLIENT_IP_HEADER,
  PORTAL_AUTH_BASE_PATH,
  PORTAL_COOKIE_PREFIX,
  PORTAL_INVITE_TTL_SECONDS,
  PORTAL_MAGIC_LINK_TTL_SECONDS,
  TRUST_DEVICE_SECONDS,
} from "@/lib/auth/constants";
import {
  type PortalLinkContext,
  sendPortalExistingUserNotice,
  sendPortalLink,
  sendPortalVerificationLink,
} from "@/lib/auth/portal-emails";
import { logError } from "@/api/log";
import { getEnv } from "@/lib/env";
import { recordSignupConsent, signupPhoneValues } from "@/lib/lgpd/consent";
import { portalAccessBarred } from "@/lib/lgpd/deletion";
import { recordPortalLogin, soleTenantId } from "@/lib/portal/access";

/**
 * Segredo só desta instância. Com o da `auth`, um JWT de verificação ou um cookie assinado
 * por uma valeria na outra: `session_data`, renomeado, passaria pelo `getSession` com cache.
 */
export function derivePortalSecret(secret: string) {
  return createHmac("sha256", secret).update("bizu-portal-auth").digest("base64");
}

/**
 * 2FA do portal: desligado por padrão, sem tela. O plugin e a tabela ficam prontos, mas
 * ninguém ativa por HTTP; quem o ligar por tenant abre estas rotas (`spec-auth.md`).
 */
const PORTAL_TWO_FACTOR_PATHS = [
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
  "/two-factor/generate-backup-codes",
];

/** O plugin grava `sha256(token)` em base64url, sem preenchimento. */
function magicLinkIdentifier(token: string) {
  return `magic-link:${createHash("sha256").update(token).digest("base64url")}`;
}

function createPortalAuth() {
  const env = getEnv();

  return betterAuth({
    appName: "Bizu SaaS Portal",
    baseURL: env.APP_URL,
    basePath: PORTAL_AUTH_BASE_PATH,
    secret: derivePortalSecret(env.BETTER_AUTH_SECRET),
    trustedOrigins: [new URL(env.APP_URL).origin],
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        portal_user: portalUser,
        portal_session: portalSession,
        portal_account: portalAccount,
        portal_verification: portalVerification,
        portal_rate_limit: portalRateLimit,
        portal_two_factor: portalTwoFactor,
      },
    }),

    disabledPaths: PORTAL_TWO_FACTOR_PATHS,

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      onExistingUserSignUp: ({ user }) => sendPortalExistingUserNotice(user),
    },

    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      expiresIn: 3600,
      // O link só confirma o e-mail. Sem sessão, repeti-lo não abre nada.
      autoSignInAfterVerification: false,
      sendVerificationEmail: ({ user, token, url }) =>
        sendPortalVerificationLink(user, token, url),
    },

    user: {
      modelName: "portal_user",
      additionalFields: {
        phone: { type: "string", required: false, input: false },
        phoneNormalized: { type: "string", required: false, input: false },
        phoneKey: { type: "string", required: false, input: false },
        locale: { type: "string", required: false, input: false },
      },
    },

    session: {
      modelName: "portal_session",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 300 },
      additionalFields: {
        activeTenantId: { type: "string", required: false, input: false },
      },
    },

    account: { modelName: "portal_account" },

    // Guarda o magic link. Com isto, nem o hash do token fica legível no banco.
    verification: {
      modelName: "portal_verification",
      storeIdentifier: "hashed",
    },

    databaseHooks: {
      user: {
        create: {
          // Autocadastro do portal: o telefone vem do contexto (`requestPortalSignup`). O
          // convite cria o `portal_user` por `INSERT` direto (`ensurePortalUser`) e não passa aqui.
          before: async (user) => ({
            data: { ...user, ...signupPhoneValues("portal_user") },
          }),
          after: async (user) => {
            await recordSignupConsent({ type: "portal_user", id: user.id }).catch(
              (error) => logError("Falha ao registrar o consentimento", error),
            );
          },
        },
      },
      session: {
        create: {
          // Na carência de uma exclusão pedida pela plataforma, nenhuma sessão nasce: nem por
          // link enviado antes, nem por qualquer outro caminho (`portalAccessBarred`).
          before: async (session) => {
            if (await portalAccessBarred(session.userId)) return false;

            return {
              data: {
                ...session,
                activeTenantId: await soleTenantId(session.userId),
              },
            };
          },
          after: async (session) => {
            const { activeTenantId, userId } = session as typeof session & {
              activeTenantId?: string | null;
            };

            if (activeTenantId) {
              runInBackground(recordPortalLogin(userId, activeTenantId));
            }
          },
        },
      },
    },

    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "portal_rate_limit",
      customRules: {
        "/sign-in/email": { window: 10, max: 3 },
        "/get-session": false,
      },
    },

    plugins: [
      twoFactor({
        issuer: "Bizu SaaS Portal",
        twoFactorTable: "portal_two_factor",
        trustDeviceMaxAge: TRUST_DEVICE_SECONDS,
      }),
      // Sem `organization` nem `admin`: nada de equipe ou plataforma passa por aqui.
      magicLink({
        storeToken: "hashed",
        disableSignUp: true,
        expiresIn: PORTAL_MAGIC_LINK_TTL_SECONDS,
        sendMagicLink: async ({ email, token, metadata }, ctx) => {
          const link = metadata as PortalLinkContext;

          // `expiresIn` é um só no plugin, e o convite vale mais que o login.
          if (link.kind === "invite") {
            await ctx?.context.internalAdapter.updateVerificationByIdentifier(
              magicLinkIdentifier(token),
              { expiresAt: new Date(Date.now() + PORTAL_INVITE_TTL_SECONDS * 1000) },
            );
          }

          await sendPortalLink(email, token, link);
        },
      }),
    ],

    advanced: {
      cookiePrefix: PORTAL_COOKIE_PREFIX,
      useSecureCookies: env.NODE_ENV === "production",
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      backgroundTasks: { handler: runInBackground },
    },
  });
}

export type PortalAuth = ReturnType<typeof createPortalAuth>;

let instance: PortalAuth | undefined;

/** Instância `portalAuth` (clientes e leads). Criada na primeira chamada, como `getAuth`. */
export function getPortalAuth(): PortalAuth {
  if (!instance) instance = createPortalAuth();
  return instance;
}
