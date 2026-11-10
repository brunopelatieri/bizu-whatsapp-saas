import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { scopedPolicy } from "../tenant-policy";
import { user } from "./auth";
import { organization } from "./tenant";

/**
 * Metadados dos arquivos do módulo de arquivos. O conteúdo fica no `StorageProvider`, sob `key`
 * (aleatória; o nome original só existe aqui). `owner_type`/`owner_id` dizem a quem o arquivo
 * pertence no domínio do projeto (ex.: `customer`, `message`); o núcleo não confere que o dono
 * existe.
 *
 * `tenant_id` nulo é arquivo da plataforma (mídia do atendimento em `/admin`, `scopedPolicy()`):
 * `withTenant` nunca o lê, e só `withPlatformData` o grava.
 */
export const file = pgTable(
  "file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => organization.id, { onDelete: "cascade" }),
    ownerType: text("owner_type").notNull().default("tenant"),
    ownerId: uuid("owner_id"),
    key: text("key").notNull(),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mime: text("mime").notNull(),
    provider: text("provider").notNull(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("file_key_idx").on(table.key),
    index("file_tenant_owner_idx").on(
      table.tenantId,
      table.ownerType,
      table.ownerId,
    ),
    scopedPolicy(),
  ],
).enableRLS();
