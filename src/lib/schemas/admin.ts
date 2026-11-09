import { z } from "zod";
import {
  billingProviderIds,
  impersonationPolicies,
  MANUAL_PROVIDER,
  paymentEventStatuses,
  paymentMethods,
  priceIntervals,
  subscriptionStatusList,
} from "@/lib/billing/constants";
import { billingStates } from "@/lib/billing/state";
import { tagFilterSchema } from "@/lib/schemas/crm";
import { phoneSchema } from "@/lib/schemas/phone";
import {
  slugSchema,
  updateTenantSchema as ownerUpdateTenantSchema,
} from "@/lib/schemas/tenant";

/** Contratos de `/api/admin/*` e dos formulários de `/admin`. */

export const PAGE_SIZE = 20;

const optionalLimit = z
  .number("Informe um número.")
  .int("Use um número inteiro.")
  .min(0, "Não pode ser negativo.")
  .max(1_000_000_000, "Valor muito alto.")
  .nullable()
  .optional();

/** Chave ausente ou `null` = ilimitado. */
export const planLimitsSchema = z.strictObject({
  members: optionalLimit,
  customers: optionalLimit,
  storage_mb: optionalLimit,
  custom_roles: optionalLimit,
  organizations: optionalLimit,
  channels_whatsapp_cloud: optionalLimit,
  channels_whatsapp_qr: optionalLimit,
});

const featureSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "Use letras minúsculas, números e _.");

const featuresSchema = z
  .array(featureSchema)
  .max(30, "Muitas features.")
  .transform((list) => [...new Set(list)]);

// Sem `.default()` aqui: o `partial()` das atualizações o aplicaria a campos ausentes e um
// PATCH de `name` zeraria limites, features e `active`.
const planFields = {
  name: z.string().trim().min(2, "Informe o nome.").max(60, "Nome muito longo."),
  description: z.string().trim().max(280, "Descrição muito longa.").nullable(),
  limits: planLimitsSchema,
  features: featuresSchema,
  isFree: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};

export const planSchema = z.object({
  slug: slugSchema,
  name: planFields.name,
  description: planFields.description.optional(),
  limits: planFields.limits.default({}),
  features: planFields.features.default([]),
  isFree: planFields.isFree.default(false),
  active: planFields.active.default(true),
  sortOrder: planFields.sortOrder.default(0),
});
export type PlanInput = z.infer<typeof planSchema>;

/** O `slug` identifica o plano em seeds e integrações: não muda depois de criado. */
export const updatePlanSchema = z
  .object(planFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nada para alterar.");
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

const priceFields = {
  amountCents: z
    .number("Informe o valor.")
    .int("Use centavos inteiros.")
    .min(1, "O valor precisa ser maior que zero.")
    .max(100_000_000, "Valor muito alto."),
  providerPriceRef: z.string().trim().max(200).nullable(),
  active: z.boolean(),
};

/** `manual`: preço da cobrança manual, sem referência no provedor. */
export const planPriceSchema = z
  .object({
    provider: z.enum(billingProviderIds),
    interval: z.enum(priceIntervals),
    amountCents: priceFields.amountCents,
    providerPriceRef: priceFields.providerPriceRef.optional(),
    active: priceFields.active.default(true),
  })
  .refine(
    (value) => value.provider !== MANUAL_PROVIDER || !value.providerPriceRef,
    { message: "Preço manual não tem referência no provedor.", path: ["providerPriceRef"] },
  );
export type PlanPriceInput = z.infer<typeof planPriceSchema>;

export const updatePlanPriceSchema = z
  .object(priceFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nada para alterar.");

export const platformSettingsSchema = z
  .object({
    trialPlanId: z.uuid("Plano inválido.").nullable(),
    trialDays: z
      .number("Informe os dias.")
      .int("Use um número inteiro.")
      .min(0, "Use 0 ou mais.")
      .max(365, "No máximo 365 dias."),
    graceDays: z
      .number("Informe os dias.")
      .int("Use um número inteiro.")
      .min(0, "Use 0 ou mais.")
      .max(60, "No máximo 60 dias."),
    impersonationPolicy: z.enum(impersonationPolicies),
    dpoEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, "E-mail muito longo.")
      .email("Informe um e-mail válido.")
      .nullable(),
    auditRetentionDays: z
      .number("Informe os dias.")
      .int("Use um número inteiro.")
      .min(30, "Mantenha a auditoria por pelo menos 30 dias.")
      .max(3650, "No máximo 3650 dias."),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nada para alterar.");
export type PlatformSettingsInput = z.infer<typeof platformSettingsSchema>;

export const reasonSchema = z.object({
  reason: z.string().trim().max(200, "Motivo muito longo.").optional(),
});

export const impersonateSchema = z.object({
  userId: z.uuid(),
  tenantId: z.uuid(),
  reason: z.string().trim().min(1).max(200).optional(),
});

export const changeTenantPlanSchema = z.object({ planId: z.uuid("Plano inválido.") });

/**
 * Cobrança manual (`src/lib/billing/manual.ts`). Sem `invoiceId`, vale a fatura em aberto (ou
 * uma nova); sem `planPriceId`, o preço manual do plano.
 */
export const manualPaymentSchema = z.object({
  invoiceId: z.uuid("Fatura inválida.").optional(),
  planPriceId: z.uuid("Preço inválido.").optional(),
  method: z.enum(paymentMethods).optional(),
});
export type ManualPaymentInput = z.infer<typeof manualPaymentSchema>;

/** `immediate`: sem carência, direto a `unpaid` + `read_only`. */
export const manualUnpaidSchema = z.object({
  invoiceId: z.uuid("Fatura inválida.").optional(),
  immediate: z.boolean().default(false),
});
export type ManualUnpaidInput = z.infer<typeof manualUnpaidSchema>;

const page = z.coerce.number().int().min(1).max(10_000).default(1);
const search = z.string().trim().max(100).optional();

export const tenantsQuerySchema = z.object({
  q: search,
  status: z.enum(billingStates).optional(),
  // admin-crud A: organizações de um plano.
  plan: z.uuid("Plano inválido.").optional(),
  // crm-cadastro A4: etiquetas da plataforma, qualquer uma (`tags=<id>,<id>`).
  tags: tagFilterSchema.optional(),
  page,
});

export const usersQuerySchema = z.object({
  q: search,
  page,
  // `team`: equipe e plataforma. `portal`: clientes e leads, outra identidade.
  scope: z.enum(["team", "portal"]).default("team"),
});

export const webhooksQuerySchema = z.object({
  status: z.enum(paymentEventStatuses).optional(),
  page,
});

export const subscriptionsQuerySchema = z.object({
  status: z.enum(subscriptionStatusList).optional(),
  q: search,
  page,
});

// admin-crud A ----------------------------------------------------------------------------

/** Edição da organização pela plataforma: mesmas regras de nome e de slug do owner. */
export const updateTenantSchema = z
  .object({
    name: ownerUpdateTenantSchema.shape.name,
    slug: slugSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nada para alterar.");
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

// admin-crud B: edição de datas e status da assinatura (`src/lib/billing/admin-edit.ts`).
const isoDate = z.iso
  .datetime({ offset: true, message: "Data inválida." })
  .transform((value) => new Date(value));

/**
 * `PATCH /api/admin/subscriptions/:id`. Datas ISO 8601. O que cada status aceita e os efeitos
 * de cada mudança estão em `admin-edit-rules.ts`; o motivo vai para o histórico da assinatura.
 */
export const updateSubscriptionSchema = z
  .object({
    status: z.enum(subscriptionStatusList).optional(),
    currentPeriodEnd: isoDate.optional(),
    trialEndsAt: isoDate.optional(),
    graceUntil: isoDate.optional(),
    reason: z
      .string("Informe o motivo.")
      .trim()
      .min(3, "Informe o motivo.")
      .max(200, "Motivo muito longo."),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.currentPeriodEnd !== undefined ||
      value.trialEndsAt !== undefined ||
      value.graceUntil !== undefined,
    "Nada para alterar.",
  );
export type UpdateSubscriptionInput = z.output<typeof updateSubscriptionSchema>;

// admin-crud C: exclusão (agendada ou imediata) e edição de pessoas pelo `/admin`.

export const deletionModes = ["scheduled", "now"] as const;
export type DeletionMode = (typeof deletionModes)[number];

/**
 * `scheduled`: 30 dias de carência, reversível. `now`: executa na hora, sem volta. `confirm`
 * é o slug da organização ou o e-mail da pessoa, conferido no servidor.
 */
export const deleteSchema = z.object({
  mode: z.enum(deletionModes, "Escolha agendar ou excluir agora."),
  confirm: z.string().trim().min(1, "Digite a confirmação.").max(254, "Texto muito longo."),
  reason: z.string().trim().max(200, "Motivo muito longo.").optional(),
});
export type DeleteInput = z.infer<typeof deleteSchema>;

/** Organizações de que a pessoa é a única owner só caem junto com a flag explícita. */
export const deleteUserSchema = deleteSchema.extend({
  deleteSoleOrganizations: z.boolean().default(false),
});
export type DeleteUserInput = z.infer<typeof deleteUserSchema>;

const personFields = {
  name: z.string().trim().min(2, "Informe o nome.").max(120, "Nome muito longo."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "E-mail muito longo.")
    .email("Informe um e-mail válido."),
  phone: phoneSchema,
};

/** Papéis não se editam por aqui. O telefone se troca, mas nunca se apaga. */
export const updateUserSchema = z
  .object(personFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nada para alterar.");
export type UpdatePersonInput = z.infer<typeof updateUserSchema>;

export const updatePortalUserSchema = updateUserSchema;
