import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type PhoneDeliveryAttempt,
  phoneRequesterTypes,
  phoneVerificationPurposes,
  phoneVerificationStatuses,
  phoneVerificationSubjects,
} from "../../lib/phone/verification";
import { scopedPolicy, tenantPolicy } from "../tenant-policy";
import { user } from "./auth";
import { channel } from "./channels";
import { organization } from "./tenant";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/**
 * Pedido de confirmação do telefone de um cadastro (`docs/specs/pre-producao/spec.md`, bloco T).
 * Confirma o número que o cadastro tem **agora** (`phone_key`): se o cadastro trocar de número
 * antes, o pedido deixa de valer.
 *
 * `tenant_id` é o escopo **responsável** por confirmar, não o do cadastro: a organização, para os
 * clientes dela e para quem entrou na equipe por convite; nulo (plataforma) para quem se
 * cadastrou sem convite e para a equipe da plataforma. É quem envia o link e quem libera à mão.
 *
 * `subject_id` não tem FK (aponta para `user` ou `customer`): quem apaga ou anonimiza o cadastro
 * apaga os pedidos dele (`deleteVerificationsOf`, `src/lib/phone/requests.ts`).
 *
 * O token só existe no link; aqui fica o SHA-256, que some quando é usado.
 */
export const phoneVerification = pgTable(
  "phone_verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => organization.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", { enum: phoneVerificationSubjects }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    /**
     * `signup`: confirma o número que o cadastro tem. `change`: a troca; o número deste pedido é o
     * NOVO, e o cadastro guarda o antigo até a confirmação (`src/lib/phone/requests.ts`).
     */
    purpose: text("purpose", { enum: phoneVerificationPurposes }).notNull().default("signup"),
    /** O número como foi digitado, para gravar no cadastro na troca. Nulo nos pedidos de cadastro. */
    phone: text("phone"),
    phoneNormalized: text("phone_normalized").notNull(),
    phoneKey: text("phone_key").notNull(),
    status: text("status", { enum: phoneVerificationStatuses })
      .notNull()
      .default("awaiting_manual"),
    tokenHash: text("token_hash").unique(),
    expiresAt: timestamptz("expires_at"),
    confirmedAt: timestamptz("confirmed_at"),
    /** Quem liberou à mão (`user.id`); nulo na confirmação por link. */
    confirmedBy: uuid("confirmed_by"),
    /**
     * Envio do link (T2b): o canal e a mensagem da tentativa atual. Sempre um canal do mesmo
     * escopo do pedido (`src/lib/phone/delivery.ts`). O id da mensagem é o que o aviso de
     * status do provedor cita quando a entrega falha depois.
     */
    channelId: uuid("channel_id").references(() => channel.id, { onDelete: "set null" }),
    providerMessageId: text("provider_message_id"),
    /** Histórico das tentativas (canal, tipo, hora, resultado, código do erro). Sem telefone nem token. */
    attempts: jsonb("attempts").$type<PhoneDeliveryAttempt[]>().notNull().default([]),
    /** Quando o responsável foi avisado por e-mail de que o pedido espera a liberação à mão. */
    manualNotifiedAt: timestamptz("manual_notified_at"),
    /**
     * Quem pediu a troca (`change`): a conta da equipe (a própria, alguém da equipe pela ficha do
     * cliente, ou o proprietário pelo /admin) ou a pessoa do portal. Nulo nos pedidos de cadastro.
     * Sem FK: aponta para `user` ou `portal_user`, e só serve à auditoria e ao efeito no portal.
     */
    requestedByType: text("requested_by_type", { enum: phoneRequesterTypes }),
    requestedById: uuid("requested_by_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Um pedido aberto por cadastro, por responsável e por finalidade: quem é da equipe de duas
    // organizações pode estar na fila das duas (e na da plataforma), sem uma cancelar a outra, e
    // a troca convive com o pedido do número atual. Com `tenant_id` nulo o Postgres não vê dois
    // nulos como iguais: a plataforma tem o índice dela.
    uniqueIndex("phone_verification_open_tenant_idx")
      .on(table.subjectType, table.subjectId, table.tenantId, table.purpose)
      .where(sql`${table.status} in ('sent', 'awaiting_manual') and ${table.tenantId} is not null`),
    uniqueIndex("phone_verification_open_platform_idx")
      .on(table.subjectType, table.subjectId, table.purpose)
      .where(sql`${table.status} in ('sent', 'awaiting_manual') and ${table.tenantId} is null`),
    // Uma troca aberta por cadastro, qualquer que seja o responsável.
    uniqueIndex("phone_verification_open_change_idx")
      .on(table.subjectType, table.subjectId)
      .where(sql`${table.status} in ('sent', 'awaiting_manual') and ${table.purpose} = 'change'`),
    index("phone_verification_scope_status_idx").on(table.tenantId, table.status),
    index("phone_verification_updated_at_idx").on(table.updatedAt),
    index("phone_verification_message_idx")
      .on(table.channelId, table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    check(
      "phone_verification_token_with_expiry",
      sql`(${table.tokenHash} is null) = (${table.expiresAt} is null)`,
    ),
    check(
      "phone_verification_status_known",
      sql`${table.status} in ('sent', 'awaiting_manual', 'confirmed', 'canceled')`,
    ),
    check("phone_verification_subject_known", sql`${table.subjectType} in ('user', 'customer')`),
    check("phone_verification_purpose_known", sql`${table.purpose} in ('signup', 'change')`),
    check(
      "phone_verification_requester_known",
      sql`${table.requestedByType} is null or ${table.requestedByType} in ('user', 'portal_user')`,
    ),
    // A troca leva o número digitado e quem pediu; o pedido de cadastro, não.
    check(
      "phone_verification_change_complete",
      sql`${table.purpose} <> 'change' or (${table.phone} is not null and ${table.requestedByType} is not null)`,
    ),
    check(
      "phone_verification_requester_pair",
      sql`(${table.requestedByType} is null) = (${table.requestedById} is null)`,
    ),
    // A ficha de cliente é sempre de uma organização; só a conta pode estar com a plataforma.
    check(
      "phone_verification_customer_has_tenant",
      sql`${table.subjectType} <> 'customer' or ${table.tenantId} is not null`,
    ),
    scopedPolicy(),
  ],
).enableRLS();

/**
 * A liberação à mão que o owner de uma organização fez no telefone da conta de um membro: uma
 * linha por par (conta, organização). Vale **só naquela organização** e só para o número que a
 * conta tinha na hora (`phone_key`): trocou de número, a linha deixa de casar e não vale mais.
 *
 * Fica fora de `user` de propósito. A conta é global e qualquer pessoa cria uma organização: uma
 * coluna na conta faria a liberação de uma organização valer nas outras, ou a de uma apagar a
 * de outra. Aqui cada organização responde só pelo que ela atestou, e o RLS do tenant esconde as
 * linhas das demais. Sai sozinha com a conta ou com a organização (`cascade`).
 */
export const phoneTenantVouch = pgTable(
  "phone_tenant_vouch",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    phoneKey: text("phone_key").notNull(),
    vouchedBy: uuid("vouched_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.tenantId] }),
    index("phone_tenant_vouch_tenant_idx").on(table.tenantId),
    tenantPolicy(),
  ],
).enableRLS();
