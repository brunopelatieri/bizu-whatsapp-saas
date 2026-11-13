import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type CustomerStatus,
  customerStatuses,
} from "../../lib/tenant/customer-constants";
import { phoneVerifiedVia } from "../../lib/phone/verification";
import { phoneRequired, phoneVerifiedConsistent } from "../phone-check";
import { tenantPolicy } from "../tenant-policy";
import { user } from "./auth";
import { portalUser } from "./portal-auth";
import { organization } from "./tenant";

export type { CustomerStatus };

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Cliente ou lead de um tenant. `status` é o portão do portal: só `active` entra. A mesma
 * pessoa (`portal_user`) pode ser cliente de vários tenants, com uma linha em cada.
 */
export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    portalUserId: uuid("portal_user_id").references(() => portalUser.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    // Opcional: o cliente que chega pelo WhatsApp raramente tem e-mail. Sem e-mail não há
    // convite, magic link nem conta acessível. Vários nulos convivem no índice único.
    email: text("email"),
    phone: text("phone"),
    phoneNormalized: text("phone_normalized"),
    phoneKey: text("phone_key"),
    // Quando e como o número atual foi confirmado; nulos = só declarado (`phone/verification.ts`).
    phoneVerifiedAt: timestamptz("phone_verified_at"),
    phoneVerifiedVia: text("phone_verified_via", { enum: phoneVerifiedVia }),
    /**
     * A pessoa da equipe desta organização que também é cliente dela: dois cadastros
     * separados, ligados por id (`src/lib/tenant/team-customer.ts`). O papel mostrado na
     * ficha é lido de `member`, não gravado aqui.
     */
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    document: text("document"),
    status: text("status", { enum: customerStatuses })
      .notNull()
      .default("lead"),
    notes: text("notes"),
    /** `{ "<id do campo>": valor }`: valores dos campos adicionais (`custom_field`). */
    customFields: jsonb("custom_fields")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    invitedAt: timestamptz("invited_at"),
    lastLoginAt: timestamptz("last_login_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("customer_tenant_email_idx").on(table.tenantId, table.email),
    index("customer_portal_user_id_idx").on(table.portalUserId),
    // Telefone único por tenant, também na variante com ou sem o 9º dígito (`phone_key`).
    uniqueIndex("customer_tenant_phone_key_idx")
      .on(table.tenantId, table.phoneKey)
      .where(sql`${table.phoneKey} IS NOT NULL`),
    // Uma ficha de cliente por pessoa da equipe, por organização.
    uniqueIndex("customer_tenant_user_idx")
      .on(table.tenantId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    check("customer_phone_required", phoneRequired),
    check("customer_phone_verified_consistent", phoneVerifiedConsistent),
    check("customer_custom_fields_object", sql`jsonb_typeof(${table.customFields}) = 'object'`),
    tenantPolicy(),
  ],
).enableRLS();
