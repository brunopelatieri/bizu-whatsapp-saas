import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
import { channelTypes } from "../../lib/channels/types";
import {
  chatContactOrigins,
  chatIdentityKinds,
  conversationStatuses,
  mediaStatuses,
  messageDirections,
  messageSenderTypes,
  messageStatuses,
  messageTypes,
  PREVIEW_MAX,
} from "../../lib/inbox/constants";
import { platformOnlyPolicy, scopedPolicy } from "../tenant-policy";
import { user } from "./auth";
import { channel } from "./channels";
import { customer } from "./customer";
import { file } from "./files";
import { organization } from "./tenant";

/**
 * Caixa de entrada (`docs/specs/caixa-de-entrada/spec.md`). Todas as tabelas têm `tenant_id`
 * anulável: `NULL` é dado da plataforma (`scopedPolicy()`, plano T1 e T2). Tabela filha repete o
 * `tenant_id` do pai, preenchido a partir do `Scope`, nunca do corpo.
 *
 * Unicidade com `tenant_id` nulo pede dois índices: o normal, com `tenant_id`, e um parcial
 * `WHERE tenant_id IS NULL` (o Postgres não considera dois nulos iguais).
 *
 * Só `src/lib/inbox/` consulta estas tabelas (regra de visibilidade, T13).
 */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

const tenantRef = () =>
  uuid("tenant_id").references(() => organization.id, { onDelete: "cascade" });

const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Quem escreve no WhatsApp (T4). Nasce sozinho na primeira mensagem e não conta no plano; pode
 * ser ligado a um `customer` (só no tenant) ou a um `user`. `phone_key` junta o celular com e sem
 * o 9º dígito: o mesmo aparelho é um contato só.
 */
export const chatContact = pgTable(
  "chat_contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    /** Canônico (T6): só dígitos, com DDI, como o provedor entregou. */
    phone: text("phone").notNull(),
    /** Chave de `crm-cadastro`: o celular sem o 9º dígito. */
    phoneKey: text("phone_key").notNull(),
    /** Nome do perfil do WhatsApp, atualizado a cada mensagem recebida. */
    waName: text("wa_name"),
    /** Nome dado pela equipe. */
    name: text("name"),
    customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    createdVia: text("created_via", { enum: chatContactOrigins }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("chat_contact_tenant_phone_key_idx").on(table.tenantId, table.phoneKey),
    uniqueIndex("chat_contact_platform_phone_key_idx")
      .on(table.phoneKey)
      .where(sql`${table.tenantId} is null`),
    index("chat_contact_customer_idx").on(table.customerId),
    index("chat_contact_user_idx").on(table.userId),
    // Um vínculo só: cliente ou membro, nunca os dois.
    check("chat_contact_single_link", sql`${table.customerId} is null or ${table.userId} is null`),
    // A plataforma não alcança cliente de tenant (decisão do proprietário).
    check(
      "chat_contact_platform_no_customer",
      sql`${table.tenantId} is not null or ${table.customerId} is null`,
    ),
    scopedPolicy(),
  ],
).enableRLS();

/** Liga o identificador oculto do WhatsApp (LID) ao contato de telefone conhecido. */
export const chatContactIdentity = pgTable(
  "chat_contact_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => chatContact.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: chatIdentityKinds }).notNull(),
    value: text("value").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_contact_identity_tenant_idx").on(table.tenantId, table.kind, table.value),
    uniqueIndex("chat_contact_identity_platform_idx")
      .on(table.kind, table.value)
      .where(sql`${table.tenantId} is null`),
    index("chat_contact_identity_contact_idx").on(table.contactId),
    scopedPolicy(),
  ],
).enableRLS();

/**
 * Uma conversa por contato e número, reaberta (histórico contínuo). `channel_id` é imutável
 * (gatilho na migration `0033`): trocar de número é outra conversa.
 */
export const conversation = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "restrict" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => chatContact.id, { onDelete: "cascade" }),
    status: text("status", { enum: conversationStatuses }).notNull().default("open"),
    /** Sem dono = na fila. Na plataforma, sempre nulo. */
    assignedUserId: uuid("assigned_user_id").references(() => user.id, { onDelete: "set null" }),
    assignedAt: timestamptz("assigned_at"),
    lastMessageAt: timestamptz("last_message_at"),
    lastMessagePreview: text("last_message_preview"),
    lastMessageDirection: text("last_message_direction", { enum: messageDirections }),
    /** Âncora da janela de 24 h: só avança, só com mensagem recebida. */
    lastInboundAt: timestamptz("last_inbound_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    closedAt: timestamptz("closed_at"),
    closedBy: uuid("closed_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("conversation_tenant_contact_channel_idx").on(
      table.tenantId,
      table.contactId,
      table.channelId,
    ),
    uniqueIndex("conversation_platform_contact_channel_idx")
      .on(table.contactId, table.channelId)
      .where(sql`${table.tenantId} is null`),
    index("conversation_tenant_status_idx").on(
      table.tenantId,
      table.status,
      table.lastMessageAt.desc(),
      table.id.desc(),
    ),
    // A fila: sem dono e não encerrada.
    index("conversation_queue_idx")
      .on(table.tenantId, table.lastMessageAt.desc())
      .where(sql`${table.assignedUserId} is null and ${table.status} <> 'closed'`),
    index("conversation_assigned_idx").on(
      table.tenantId,
      table.assignedUserId,
      table.lastMessageAt.desc(),
    ),
    // `restrict` em `channel_id` e `cascade` em `contact_id` consultam por estas colunas.
    index("conversation_channel_idx").on(table.channelId),
    index("conversation_contact_idx").on(table.contactId),
    check("conversation_unread_nonnegative", sql`${table.unreadCount} >= 0`),
    check(
      "conversation_preview_length",
      sql`char_length(${table.lastMessagePreview}) <= ${sql.raw(String(PREVIEW_MAX))}`,
    ),
    check(
      "conversation_platform_unassigned",
      sql`${table.tenantId} is not null or ${table.assignedUserId} is null`,
    ),
    scopedPolicy(),
  ],
).enableRLS();

/**
 * Mensagem de uma conversa. `payload` guarda o que não tem coluna (coordenadas, cartão de
 * contato, variáveis do modelo), nunca o corpo bruto do provedor. O conteúdo nunca vai a log,
 * auditoria nem Sentry.
 */
export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRef(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** Repete o da conversa: a unicidade do id do provedor é por número. */
    channelId: uuid("channel_id").notNull(),
    direction: text("direction", { enum: messageDirections }).notNull(),
    senderType: text("sender_type", { enum: messageSenderTypes }).notNull(),
    senderUserId: uuid("sender_user_id").references(() => user.id, { onDelete: "set null" }),
    type: text("type", { enum: messageTypes }).notNull(),
    text: text("text"),
    fileId: uuid("file_id").references(() => file.id, { onDelete: "set null" }),
    mediaStatus: text("media_status", { enum: mediaStatuses }),
    providerMediaId: text("provider_media_id"),
    providerMessageId: text("provider_message_id"),
    /** Id gerado pela tela no envio: repetir o envio devolve a mesma linha. */
    clientId: text("client_id"),
    replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => message.id, {
      onDelete: "set null",
    }),
    templateName: text("template_name"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Só nas enviadas; a recebida fica nula. */
    status: text("status", { enum: messageStatuses }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** Hora informada pelo provedor. */
    providerTimestamp: timestamptz("provider_timestamp"),
    /**
     * Favorita (bloco R): a limpeza por idade e por contagem não a leva. É da conversa, não de
     * quem marcou: `favorited_by` só diz quem marcou (auditoria) e vira nulo se a conta sair.
     */
    isFavorite: boolean("is_favorite").notNull().default(false),
    favoritedAt: timestamptz("favorited_at"),
    favoritedBy: uuid("favorited_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Reentrega do provedor não duplica.
    uniqueIndex("message_channel_provider_id_idx")
      .on(table.channelId, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    uniqueIndex("message_conversation_client_id_idx")
      .on(table.conversationId, table.clientId)
      .where(sql`${table.clientId} is not null`),
    index("message_conversation_created_idx").on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    // Só as favoritas: o tamanho é o do conjunto de favoritas, não o da tabela (limpeza, bloco R).
    index("message_favorite_idx")
      .on(table.conversationId, table.createdAt)
      .where(sql`${table.isFavorite}`),
    // `set null` da conta que favoritou consulta por esta coluna.
    index("message_favorited_by_idx")
      .on(table.favoritedBy)
      .where(sql`${table.favoritedBy} is not null`),
    // A limpeza varre por escopo (organização e tipo de canal) e por idade (bloco R).
    index("message_tenant_created_idx").on(table.tenantId, table.createdAt),
    // Favorita e seus carimbos andam juntos: ou tudo ou nada.
    check(
      "message_favorite_stamp",
      sql`${table.isFavorite} or (${table.favoritedAt} is null and ${table.favoritedBy} is null)`,
    ),
    // Varredura de `queued` sem resposta (`inbox.sweep`).
    index("message_queued_idx")
      .on(table.createdAt)
      .where(sql`${table.status} = 'queued'`),
    // `set null` de `file` e da citação consultam por estas colunas.
    index("message_file_idx")
      .on(table.fileId)
      .where(sql`${table.fileId} is not null`),
    index("message_reply_to_idx")
      .on(table.replyToMessageId)
      .where(sql`${table.replyToMessageId} is not null`),
    scopedPolicy(),
  ],
).enableRLS();

/**
 * Política de retenção de mensagens por organização e tipo de canal (bloco R, SPEC `pre-producao`).
 * Só o proprietário da plataforma lê e grava (`platformOnlyPolicy()`): `withTenant` e o `bizu_app`
 * cru leem vazio, e o owner nunca a alcança. Tem `tenant_id`, mas a política não é de tenant: é dado
 * da plataforma **sobre** o tenant (mesmo desenho de `organization_tag`).
 *
 * `NULL` herda o padrão do `.env`; `0` é "sem limite" explícito; ausência de linha herda tudo. A
 * precedência mora em `src/lib/inbox/retention-policy.ts`. `channel_type` é o tipo, não o canal:
 * a política não morre com a instância pareada.
 */
export const retentionPolicy = pgTable(
  "retention_policy",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    channelType: text("channel_type", { enum: channelTypes }).notNull(),
    /** Teto de mensagens do escopo (organização e tipo de canal). */
    maxMessages: integer("max_messages"),
    /** Idade máxima, em dias. */
    retentionDays: integer("retention_days"),
    /** Teto de favoritas do escopo; as mais antigas acima dele perdem a estrela. */
    maxFavorites: integer("max_favorites"),
    updatedBy: uuid("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.channelType] }),
    check(
      "retention_policy_max_messages_nonneg",
      sql`${table.maxMessages} is null or ${table.maxMessages} >= 0`,
    ),
    check(
      "retention_policy_retention_days_nonneg",
      sql`${table.retentionDays} is null or ${table.retentionDays} >= 0`,
    ),
    check(
      "retention_policy_max_favorites_nonneg",
      sql`${table.maxFavorites} is null or ${table.maxFavorites} >= 0`,
    ),
    platformOnlyPolicy(),
  ],
).enableRLS();

/**
 * Última execução da limpeza por escopo: só `last_run_at` e `last_result`, não um log nem um claim
 * (o `singletonKey` do job já impede duas execuções). `tenant_id` nulo é o escopo da plataforma
 * (conversas sem tenant), que usa só os padrões do `.env`. Mesmo isolamento de `retention_policy`.
 */
export const messageRetentionState = pgTable(
  "message_retention_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => organization.id, { onDelete: "cascade" }),
    channelType: text("channel_type", { enum: channelTypes }).notNull(),
    lastRunAt: timestamptz("last_run_at"),
    /** Contagens do último ciclo (nunca texto de mensagem): ver `RetentionRunResult` (R2). */
    lastResult: jsonb("last_result").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("message_retention_state_tenant_idx")
      .on(table.tenantId, table.channelType)
      .where(sql`${table.tenantId} is not null`),
    uniqueIndex("message_retention_state_platform_idx")
      .on(table.channelType)
      .where(sql`${table.tenantId} is null`),
    check("message_retention_state_result_object", sql`jsonb_typeof(${table.lastResult}) = 'object'`),
    platformOnlyPolicy(),
  ],
).enableRLS();
