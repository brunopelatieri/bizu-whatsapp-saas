import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type ChannelEventKind,
  type ChannelEventStatus,
  type ChannelStatus,
  type ChannelType,
  channelEventKinds,
  channelEventStatuses,
  channelStatuses,
  channelTypes,
} from "../../lib/channels/types";
import { scopedPolicy } from "../tenant-policy";
import { user } from "./auth";
import { organization } from "./tenant";

export type { ChannelEventKind, ChannelEventStatus, ChannelStatus, ChannelType };

/**
 * Canais de mensagem (`docs/specs/whatsapp-canais/spec.md`). Todas as tabelas têm `tenant_id`
 * anulável: `NULL` é dado da plataforma (`scopedPolicy()`, plano T1 e T2). Tabela filha
 * repete o `tenant_id` do pai e quem grava o preenche a partir do `Scope`, nunca do corpo.
 *
 * As colunas `*_enc` guardam `encryptSecret(valor, "channel:<id>:<campo>")` e nunca saem do
 * servidor (`src/lib/channels/credentials.ts`).
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

const tenantRef = () =>
  uuid("tenant_id").references(() => organization.id, { onDelete: "cascade" });

export const channel = pgTable(
  "channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    type: text("type", { enum: channelTypes }).notNull(),
    name: text("name").notNull(),
    /** Telefone exibido. Nulo enquanto não pareado. */
    identifier: text("identifier"),
    status: text("status", { enum: channelStatuses }).notNull().default("disconnected"),
    statusDetail: text("status_detail"),
    isDefault: boolean("is_default").notNull().default(false),
    connectedAt: timestamptz("connected_at"),
    lastSeenAt: timestamptz("last_seen_at"),
    createdBy: uuid("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("channel_tenant_type_idx").on(table.tenantId, table.type),
    // Um padrão por escopo e tipo. Com `tenant_id` nulo o Postgres não vê dois nulos como
    // iguais, então a plataforma tem o próprio índice.
    uniqueIndex("channel_default_tenant_idx")
      .on(table.tenantId, table.type)
      .where(sql`${table.isDefault} and ${table.tenantId} is not null`),
    uniqueIndex("channel_default_platform_idx")
      .on(table.type)
      .where(sql`${table.isDefault} and ${table.tenantId} is null`),
    check("channel_name_length", sql`char_length(${table.name}) between 1 and 60`),
    scopedPolicy(),
  ],
).enableRLS();

/** 1:1 com `channel` do tipo `whatsapp_cloud`. Os três `_enc` ficam nulos quando desativado. */
export const channelWhatsappCloud = pgTable(
  "channel_whatsapp_cloud",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channel.id, { onDelete: "cascade" }),
    tenantId: tenantRef(),
    /** Único em todos os escopos: um número oficial só pode estar em uma conta (RF-11). */
    phoneNumberId: text("phone_number_id").notNull().unique(),
    wabaId: text("waba_id").notNull(),
    appId: text("app_id"),
    accessTokenEnc: text("access_token_enc"),
    appSecretEnc: text("app_secret_enc"),
    verifyTokenEnc: text("verify_token_enc"),
    keyVersion: integer("key_version").notNull().default(1),
    /** 32 hex aleatórios no caminho do webhook; define o escopo antes de ler o corpo. */
    webhookKey: text("webhook_key").notNull().unique(),
    webhookVerifiedAt: timestamptz("webhook_verified_at"),
    displayPhone: text("display_phone"),
    verifiedName: text("verified_name"),
    qualityRating: text("quality_rating"),
    registeredAt: timestamptz("registered_at"),
    subscribedAt: timestamptz("subscribed_at"),
    lastError: text("last_error"),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("channel_whatsapp_cloud_tenant_idx").on(table.tenantId),
    index("channel_whatsapp_cloud_waba_idx").on(table.wabaId),
    scopedPolicy(),
  ],
).enableRLS();

/** 1:1 com `channel` do tipo `whatsapp_qr`. O QR nunca é gravado. */
export const channelEvolution = pgTable(
  "channel_evolution",
  {
    channelId: uuid("channel_id")
      .primaryKey()
      .references(() => channel.id, { onDelete: "cascade" }),
    tenantId: tenantRef(),
    remoteInstanceId: text("remote_instance_id"),
    /** Global no servidor Evolution: `<prefixo>_<8 hex do escopo>_<slug>_<4 hex>`. */
    remoteInstanceName: text("remote_instance_name").notNull().unique(),
    instanceTokenEnc: text("instance_token_enc"),
    webhookSecretEnc: text("webhook_secret_enc"),
    /** sha256 do segredo do caminho: acha a instância sem varrer nem decifrar. */
    webhookSecretHash: text("webhook_secret_hash").notNull().unique(),
    keyVersion: integer("key_version").notNull().default(1),
    connectedPhone: text("connected_phone"),
    connectedJid: text("connected_jid"),
    advancedSettings: jsonb("advanced_settings").$type<Record<string, unknown>>(),
    lastQrAt: timestamptz("last_qr_at"),
    lastError: text("last_error"),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("channel_evolution_tenant_idx").on(table.tenantId), scopedPolicy()],
).enableRLS();

/**
 * Caixa de entrada dos avisos de provedor: o webhook grava `pending` e responde; o job
 * `channel.inbound` aplica. `raw` nunca guarda mídia em base64 (referência ao
 * `StorageProvider`). Sai no `maintenance.prune` depois de 30 dias.
 */
export const channelEvent = pgTable(
  "channel_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: channelTypes }).notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind", { enum: channelEventKinds }).notNull(),
    status: text("status", { enum: channelEventStatuses }).notNull().default("pending"),
    raw: jsonb("raw").notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
    processedAt: timestamptz("processed_at"),
  },
  (table) => [
    // A Meta e a Evolution reentregam: o mesmo aviso não vira dois eventos.
    uniqueIndex("channel_event_dedupe_idx").on(table.channelId, table.dedupeKey),
    index("channel_event_pending_idx")
      .on(table.receivedAt)
      .where(sql`${table.status} = 'pending'`),
    index("channel_event_status_idx").on(table.status, table.receivedAt),
    index("channel_event_received_idx").on(table.receivedAt),
    scopedPolicy(),
  ],
).enableRLS();

/**
 * Modelos de mensagem aprovados na Meta. Só leitura: a fonte é a Meta. É do WABA, não do
 * canal: dois números do mesmo WABA veem os mesmos.
 */
export const messageTemplate = pgTable(
  "message_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    wabaId: text("waba_id").notNull(),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category"),
    /** Valor da Meta (`APPROVED`, `REJECTED`, ...). */
    status: text("status").notNull(),
    components: jsonb("components").$type<unknown[]>().notNull().default([]),
    providerTemplateId: text("provider_template_id"),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_template_tenant_idx")
      .on(table.tenantId, table.wabaId, table.name, table.language)
      .where(sql`${table.tenantId} is not null`),
    uniqueIndex("message_template_platform_idx")
      .on(table.wabaId, table.name, table.language)
      .where(sql`${table.tenantId} is null`),
    index("message_template_waba_idx").on(table.wabaId),
    scopedPolicy(),
  ],
).enableRLS();
