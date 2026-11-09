import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { scopedPolicy } from "../tenant-policy";
import { organization } from "./tenant";

export const auditActorTypes = [
  "user",
  "portal_user",
  "system",
  "platform",
] as const;
export type AuditActorType = (typeof auditActorTypes)[number];

/**
 * Trilha de auditoria. `tenant_id` nulo marca evento fora de tenant (autenticação),
 * visível só com `withPlatformScope`. `metadata` guarda ids e enums, nunca dado pessoal.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    actorType: text("actor_type", { enum: auditActorTypes }).notNull(),
    actorId: uuid("actor_id"),
    impersonatorId: uuid("impersonator_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("audit_log_actor_id_idx").on(table.actorId),
    // Evento da plataforma (`tenant_id` nulo) grava e lê dentro de `withPlatformData`.
    scopedPolicy(),
  ],
).enableRLS();
