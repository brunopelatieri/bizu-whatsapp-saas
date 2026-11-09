import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DEFAULT_TAG_COLOR } from "../../lib/crm/constants";
import { scopedPolicy, tenantPolicy } from "../tenant-policy";
import { user } from "./auth";
import { customer } from "./customer";
import { organization } from "./tenant";

/**
 * Cadastro CRM (`docs/specs/crm-cadastro/spec.md`). `tag` serve o tenant e a plataforma:
 * `tenant_id` nulo é dado da plataforma (`scopedPolicy()`, plano T1 e T2). Quem grava
 * preenche `tenant_id` a partir do `Scope`, nunca do corpo.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const tag = pgTable(
  "tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `#rrggbb` em minúsculas: cor inválida quebrava o chip na origem. */
    color: text("color").notNull().default(DEFAULT_TAG_COLOR),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Nome único por escopo, sem diferenciar maiúsculas. Com `tenant_id` nulo o Postgres não
    // vê dois nulos como iguais, então a plataforma tem o próprio índice.
    uniqueIndex("tag_tenant_name_idx")
      .on(table.tenantId, sql`lower(${table.name})`)
      .where(sql`${table.tenantId} is not null`),
    uniqueIndex("tag_platform_name_idx")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.tenantId} is null`),
    check("tag_name_length", sql`char_length(${table.name}) between 1 and 40`),
    check("tag_color_hex", sql`${table.color} ~ '^#[0-9a-f]{6}$'`),
    scopedPolicy(),
  ],
).enableRLS();

/** Etiqueta aplicada a um cliente (só tenant: `tenant_id` não nulo, repetido do cliente). */
export const customerTag = pgTable(
  "customer_tag",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tag.id, { onDelete: "cascade" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.customerId, table.tagId] }),
    index("customer_tag_tenant_tag_idx").on(table.tenantId, table.tagId),
    tenantPolicy(),
  ],
).enableRLS();
