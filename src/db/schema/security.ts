import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenantPolicy } from "../tenant-policy";
import { user } from "./auth";
import { organization } from "./tenant";

/** Personificação, rate limit compartilhado e credenciais cifradas (fase 9). */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Consentimento do owner para o suporte entrar no tenant. Vale até `expires_at` ou
 * `revoked_at`, para mais de uma entrada no período; `used_by` guarda quem usou por último,
 * e o histórico completo fica em `audit_log`.
 */
export const impersonationGrant = pgTable(
  "impersonation_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => user.id, {
      onDelete: "set null",
    }),
    scope: text("scope", { enum: ["tenant"] }).notNull().default("tenant"),
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    usedBy: uuid("used_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("impersonation_grant_tenant_expires_idx").on(
      table.tenantId,
      table.expiresAt,
    ),
    tenantPolicy(),
  ],
).enableRLS();

/**
 * Credencial de provedor por tenant, para o fluxo (b), ainda sem tela. `encrypted_secret`
 * guarda o texto de `encryptSecret` (`src/lib/crypto/secrets.ts`).
 */
export const tenantPaymentCredential = pgTable(
  "tenant_payment_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    encryptedSecret: bytea("encrypted_secret").notNull(),
    keyVersion: integer("key_version").notNull(),
    label: text("label").notNull(),
    sandbox: boolean("sandbox").notNull().default(false),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("tenant_payment_credential_tenant_idx").on(table.tenantId),
    tenantPolicy(),
  ],
).enableRLS();

export const loginThrottleRealms = ["team", "portal"] as const;
export type LoginThrottleRealm = (typeof loginThrottleRealms)[number];

/**
 * Falhas de login por e-mail (ou por e-mail e IP, `LOGIN_LOCKOUT_SCOPE`) e o bloqueio que
 * elas abrem (`src/lib/auth/login-throttle.ts`). Sem `tenant_id` nem RLS, como
 * `rate_limit_bucket`: o login acontece antes de existir tenant. O e-mail e o IP só entram
 * em HMAC com `AUDIT_SALT`; a linha existe também para e-mail sem conta.
 */
export const loginThrottle = pgTable(
  "login_throttle",
  {
    realm: text("realm", { enum: loginThrottleRealms }).notNull(),
    /** O que o contador bloqueia: o e-mail, ou o par e-mail e IP. */
    keyHash: text("key_hash").notNull(),
    /** Só o e-mail: zera todos os contadores dele quando a senha é redefinida. */
    subjectHash: text("subject_hash").notNull(),
    failures: integer("failures").notNull().default(0),
    windowStartedAt: timestamptz("window_started_at").notNull(),
    lockedUntil: timestamptz("locked_until"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.realm, table.keyHash] }),
    index("login_throttle_subject_idx").on(table.realm, table.subjectHash),
    index("login_throttle_updated_at_idx").on(table.updatedAt),
  ],
);

/** Contadores de `RATE_LIMIT_STORE=postgres`, com a janela alinhada ao relógio. */
export const rateLimitBucket = pgTable(
  "rate_limit_bucket",
  {
    key: text("key").notNull(),
    windowStart: timestamptz("window_start").notNull(),
    count: integer("count").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    index("rate_limit_bucket_window_start_idx").on(table.windowStart),
  ],
);
