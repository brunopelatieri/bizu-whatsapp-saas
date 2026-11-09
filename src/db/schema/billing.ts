import { sql } from "drizzle-orm";
import {
  boolean,
  char,
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
  type BillingProviderId,
  billingProviderIds,
  type InvoiceStatus,
  invoiceStatuses,
  type PaymentMethod,
  type PaymentProviderId,
  paymentEventStatuses,
  paymentMethods,
  paymentProviderIds,
  type PriceInterval,
  priceIntervals,
  subscriptionStatusList,
} from "../../lib/billing/constants";
import { tenantPolicy } from "../tenant-policy";
import { user } from "./auth";
import { organization } from "./tenant";

/**
 * Planos e assinatura. `plan`, `plan_price` e `platform_setting` são da plataforma (sem
 * `tenant_id`, sem RLS): quem os edita é `/api/admin/*`, atrás de `requirePlatform`.
 * `subscription`, `subscription_event`, `invoice` e `billing_profile` são de tenant, com RLS.
 * `payment_event` é a caixa de entrada dos webhooks: nasce sem tenant e só se lê com
 * `withPlatformScope`. A máquina de estados está em `src/lib/billing/state-machine.ts`.
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

const timestamps = {
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export type {
  BillingProviderId,
  InvoiceStatus,
  PaymentMethod,
  PaymentProviderId,
  PriceInterval,
};

/** Limites do plano. Chave ausente ou `null` = ilimitado. */
export type PlanLimits = {
  members?: number | null;
  customers?: number | null;
  storage_mb?: number | null;
  custom_roles?: number | null;
  /** Organizações que o dono pode ter (`src/lib/billing/organizations.ts`). */
  organizations?: number | null;
  /** Números de WhatsApp por tipo de canal; desativado não conta (`src/lib/channels/`). */
  channels_whatsapp_cloud?: number | null;
  channels_whatsapp_qr?: number | null;
};

export const plan = pgTable(
  "plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    limits: jsonb("limits").$type<PlanLimits>().notNull().default({}),
    features: text("features").array().notNull().default([]),
    isFree: boolean("is_free").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [index("plan_active_sort_idx").on(table.active, table.sortOrder)],
);

export const planPrice = pgTable(
  "plan_price",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    // `manual`: preço da cobrança manual, sem referência no provedor.
    provider: text("provider", { enum: billingProviderIds }).notNull(),
    interval: text("interval", { enum: priceIntervals }).notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("BRL"),
    // Id do preço no provedor (Stripe `price_...`); preenchido à mão em /admin/planos.
    providerPriceRef: text("provider_price_ref"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    // Um preço por provedor e intervalo.
    uniqueIndex("plan_price_plan_provider_interval_idx").on(
      table.planId,
      table.provider,
      table.interval,
    ),
  ],
);

/** Configurações da plataforma, uma chave por linha (`src/lib/billing/settings.ts`). */
export const platformSetting = pgTable("platform_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const subscriptionStatuses = subscriptionStatusList;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

/** Algo que o proprietário da plataforma precisa olhar (`/admin/assinaturas`). */
export type SubscriptionAlert = {
  kind: "divergence" | "duplicate_subscription" | "chargeback";
  /** ISO 8601. */
  at: string;
  /** Só ids e enums: nunca dado pessoal nem resposta crua do provedor. */
  detail?: string;
};

/** Estado por controle interno: avisos já enviados etc. Nunca dado pessoal. */
export type SubscriptionMetadata = {
  trialNotices?: Partial<Record<string, string>>;
  dunningNotices?: Partial<Record<string, string>>;
  /** Maior `occurred_at` aplicado de um evento do provedor (ISO 8601). */
  lastProviderEventAt?: string;
  /** Preço do downgrade agendado em `pending_plan_id`. */
  pendingPlanPriceId?: string;
  /** Pausada: até quando já estava pago (ISO 8601). Depois disso, retomar cobra. */
  paidThrough?: string;
  alert?: SubscriptionAlert;
};

export const subscription = pgTable(
  "subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    planPriceId: uuid("plan_price_id").references(() => planPrice.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: subscriptionStatuses }).notNull(),
    provider: text("provider", { enum: paymentProviderIds }),
    providerCustomerRef: text("provider_customer_ref"),
    providerSubscriptionRef: text("provider_subscription_ref"),
    trialEndsAt: timestamptz("trial_ends_at"),
    currentPeriodStart: timestamptz("current_period_start"),
    currentPeriodEnd: timestamptz("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamptz("canceled_at"),
    graceUntil: timestamptz("grace_until"),
    pendingPlanId: uuid("pending_plan_id").references(() => plan.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata").$type<SubscriptionMetadata>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    // Uma assinatura por tenant.
    uniqueIndex("subscription_tenant_id_idx").on(table.tenantId),
    index("subscription_status_trial_idx").on(table.status, table.trialEndsAt),
    index("subscription_plan_id_idx").on(table.planId),
    // A mesma assinatura do provedor nunca aponta para dois tenants.
    uniqueIndex("subscription_provider_ref_idx")
      .on(table.provider, table.providerSubscriptionRef)
      .where(sql`${table.providerSubscriptionRef} is not null`),
    index("subscription_provider_customer_idx").on(
      table.provider,
      table.providerCustomerRef,
    ),
    index("subscription_status_period_idx").on(
      table.status,
      table.currentPeriodEnd,
    ),
    tenantPolicy(),
  ],
).enableRLS();

export const subscriptionEventSources = [
  "webhook",
  "admin",
  "job",
  "owner",
  "system",
] as const;
export type SubscriptionEventSource = (typeof subscriptionEventSources)[number];

/** Histórico de transições. Toda mudança de `subscription.status` grava uma linha. */
export const subscriptionEvent = pgTable(
  "subscription_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscription.id, { onDelete: "cascade" }),
    fromStatus: text("from_status", { enum: subscriptionStatuses }),
    toStatus: text("to_status", { enum: subscriptionStatuses }).notNull(),
    reason: text("reason").notNull(),
    source: text("source", { enum: subscriptionEventSources }).notNull(),
    paymentEventId: uuid("payment_event_id").references(() => paymentEvent.id, {
      onDelete: "set null",
    }),
    // Quando aconteceu no provedor; `created_at` é quando chegou aqui.
    occurredAt: timestamptz("occurred_at").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("subscription_event_subscription_idx").on(
      table.subscriptionId,
      table.createdAt,
    ),
    index("subscription_event_tenant_idx").on(table.tenantId),
    tenantPolicy(),
  ],
).enableRLS();

export const documentTypes = ["cpf", "cnpj"] as const;
export type DocumentType = (typeof documentTypes)[number];

export type BillingAddress = {
  line1?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  postalCode?: string;
};

/** Dados de faturamento do tenant. Só `billing:manage` altera. */
export const billingProfile = pgTable(
  "billing_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    legalName: text("legal_name").notNull(),
    document: text("document").notNull(),
    documentType: text("document_type", { enum: documentTypes }).notNull(),
    email: text("email").notNull(),
    address: jsonb("address").$type<BillingAddress>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("billing_profile_tenant_id_idx").on(table.tenantId),
    tenantPolicy(),
  ],
).enableRLS();

/** Espelho local da fatura do provedor, ou fatura manual (`provider = manual`). */
export const invoice = pgTable(
  "invoice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscription.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: billingProviderIds }).notNull(),
    // Nulo entre o checkout inline e o primeiro evento do provedor, e sempre na manual.
    providerRef: text("provider_ref"),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("BRL"),
    status: text("status", { enum: invoiceStatuses }).notNull().default("open"),
    paymentMethod: text("payment_method", { enum: paymentMethods }),
    dueAt: timestamptz("due_at"),
    paidAt: timestamptz("paid_at"),
    // Período que a fatura cobre. A manual sempre preenche; o provedor pode deixar nulo.
    periodStart: timestamptz("period_start"),
    periodEnd: timestamptz("period_end"),
    hostedUrl: text("hosted_url"),
    pixPayload: text("pix_payload"),
    boletoLine: text("boleto_line"),
    attempt: integer("attempt").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("invoice_provider_ref_idx").on(table.provider, table.providerRef),
    index("invoice_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("invoice_subscription_idx").on(table.subscriptionId),
    tenantPolicy(),
  ],
).enableRLS();

export type PaymentEventStatus = (typeof paymentEventStatuses)[number];

/**
 * Caixa de entrada dos webhooks de pagamento. `provider_event_id` é a idempotência; `raw`
 * guarda o evento verificado e nunca o corpo de quem falhou na assinatura. Com RLS, como
 * toda tabela com `tenant_id`: linha sem tenant só aparece com `withPlatformScope`.
 */
export const paymentEvent = pgTable(
  "payment_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider", { enum: paymentProviderIds }).notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type"),
    raw: jsonb("raw"),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
    verified: boolean("verified").notNull().default(false),
    status: text("status", { enum: paymentEventStatuses })
      .notNull()
      .default("pending"),
    processedAt: timestamptz("processed_at"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    tenantId: uuid("tenant_id").references(() => organization.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("payment_event_provider_event_idx").on(
      table.provider,
      table.providerEventId,
    ),
    index("payment_event_status_received_idx").on(table.status, table.receivedAt),
    index("payment_event_tenant_idx").on(table.tenantId),
    tenantPolicy(),
  ],
).enableRLS();
