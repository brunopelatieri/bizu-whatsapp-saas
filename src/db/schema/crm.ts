import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type CustomFieldEntity,
  type CustomFieldType,
  customFieldEntities,
  customFieldTypes,
  DEFAULT_TAG_COLOR,
} from "../../lib/crm/constants";
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

/** Opção de um campo de lista: `value` é estável (guardado no cliente); `label` é editável. */
export type CustomFieldOption = { value: string; label: string };

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * Definição de campo adicional. `tenant_id` nulo é campo da plataforma (`entity =
 * 'organization'`, fase A4); o tenant só tem `entity = 'customer'`. O valor fica no
 * `customer.custom_fields` (jsonb chaveado pelo **id** do campo): `key` e `type` não mudam.
 */
export const customField = pgTable(
  "custom_field",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => organization.id, { onDelete: "cascade" }),
    entity: text("entity", { enum: customFieldEntities }).notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type", { enum: customFieldTypes }).notNull(),
    options: jsonb("options").$type<CustomFieldOption[]>().notNull().default([]),
    required: boolean("required").notNull().default(false),
    position: integer("position").notNull().default(0),
    archivedAt: timestamptz("archived_at"),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // `key` única por escopo e entidade; com `tenant_id` nulo a plataforma tem o próprio índice.
    uniqueIndex("custom_field_tenant_key_idx")
      .on(table.tenantId, table.entity, table.key)
      .where(sql`${table.tenantId} is not null`),
    uniqueIndex("custom_field_platform_key_idx")
      .on(table.entity, table.key)
      .where(sql`${table.tenantId} is null`),
    index("custom_field_scope_idx").on(table.tenantId, table.entity, table.position),
    check("custom_field_key_format", sql`${table.key} ~ '^[a-z0-9_]{1,40}$'`),
    check("custom_field_label_length", sql`char_length(${table.label}) between 1 and 60`),
    check("custom_field_type_known", sql`${table.type} in (${inList(customFieldTypes)})`),
    check("custom_field_options_array", sql`jsonb_typeof(${table.options}) = 'array'`),
    check(
      "custom_field_entity_scope",
      sql`(${table.entity} = 'organization' and ${table.tenantId} is null) or (${table.entity} = 'customer' and ${table.tenantId} is not null)`,
    ),
    scopedPolicy(),
  ],
).enableRLS();

export type CustomFieldRow = typeof customField.$inferSelect;
export type { CustomFieldEntity, CustomFieldType };
