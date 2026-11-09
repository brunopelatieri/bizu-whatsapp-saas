import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { phoneRequired } from "../phone-check";
import { organization } from "./tenant";

/**
 * Tabelas do Better Auth (instância `auth`, equipe e plataforma). Nomes e tipos
 * seguem `getAuthTables`, com `uuid` (`advanced.database.generateId: "uuid"`) e
 * `timestamptz`. As chaves deste módulo são os nomes de modelo que o adapter procura.
 * As do plugin `organization` ficam em `tenant.ts`.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

const timestamps = {
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // `user`, `platform_owner` ou `platform_support` (src/lib/auth/permissions.ts).
  role: text("role").notNull().default("user"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamptz("ban_expires"),
  // Só o plugin `twoFactor` escreve: vira `true` depois do primeiro código válido.
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  // O que a pessoa digitou. `phone_normalized` (canônico) e `phone_key` (comparação, sem o 9º
  // dígito) são calculados no servidor por `phoneColumns`; o `CHECK` exige os dois.
  phone: text("phone"),
  phoneNormalized: text("phone_normalized"),
  phoneKey: text("phone_key"),
  locale: text("locale"),
  // Sessão nova abre neste tenant, se a pessoa ainda for membro. Não passa pelo Better Auth.
  lastTenantId: uuid("last_tenant_id").references(() => organization.id, {
    onDelete: "set null",
  }),
  ...timestamps,
}, (table) => [
  // Não único: dois membros podem dividir o número da empresa.
  index("user_phone_key_idx").on(table.phoneKey),
  check("user_phone_required", phoneRequired),
]);

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    // Teto da personificação, que o Better Auth não renova (`impersonationExpired`).
    impersonationExpiresAt: timestamptz("impersonation_expires_at"),
    activeOrganizationId: uuid("active_organization_id").references(
      () => organization.id,
      { onDelete: "set null" },
    ),
    ...timestamps,
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // `credential` para senha; demais valores só com login social (fase futura).
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    ...timestamps,
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_idx").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

/** Plugin `twoFactor`. Segredo TOTP e códigos de backup ficam cifrados pelo próprio plugin. */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    // `false` até o primeiro código: ativar pela metade não vale no login.
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count")
      .notNull()
      .default(0),
    lockedUntil: timestamptz("locked_until"),
  },
  (table) => [uniqueIndex("two_factor_user_id_idx").on(table.userId)],
);

/** Reset de senha, em hash (`verification.storeIdentifier: "hashed"`). */
export const verification = pgTable(
  "verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/** Contadores de `rateLimit.storage: "database"`. */
export const rateLimit = pgTable("rate_limit", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/**
 * Emissão vigente do link de e-mail de cada usuário. O token do Better Auth é um
 * JWT sem estado: guardar só o hash do último emitido dá uso único e invalida os
 * anteriores (`src/api/verification-guard.ts`).
 */
export const emailVerificationIssue = pgTable("email_verification_issue", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
  // `verify`: cadastro. `change`: etapas da troca de e-mail.
  kind: text("kind", { enum: ["verify", "change"] }).notNull(),
  issuedAt: timestamptz("issued_at").notNull().defaultNow(),
});

export type EmailVerificationKind =
  (typeof emailVerificationIssue.$inferInsert)["kind"];
