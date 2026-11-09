/**
 * Constantes de cobrança sem dependência de servidor: o schema do Drizzle, os schemas
 * Zod e a interface importam daqui. Importe por caminho relativo no schema, porque o
 * Drizzle Kit carrega `src/db/schema.ts` sem o alias `@/`.
 */

export const paymentProviderIds = [
  "stripe",
  "asaas",
  "mercadopago",
  "pagarme",
  "pagbank",
] as const;
export type PaymentProviderId = (typeof paymentProviderIds)[number];

/**
 * Cobrança sem módulo: o proprietário da plataforma marca o pagamento em `/admin`. Não é um
 * módulo de `src/lib/payments/providers/` (`getProvider("manual")` é `null`); só aparece em
 * `plan_price.provider` (preço manual) e `invoice.provider` (fatura manual).
 */
export const MANUAL_PROVIDER = "manual" as const;
export const billingProviderIds = [MANUAL_PROVIDER, ...paymentProviderIds] as const;
export type BillingProviderId = (typeof billingProviderIds)[number];

export const priceIntervals = ["month", "year"] as const;
export type PriceInterval = (typeof priceIntervals)[number];

/** Mesma lista de `subscription.status`, sem depender do schema no navegador. */
export const subscriptionStatusList = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "canceled",
  "expired",
] as const;

export const SUBSCRIPTION_STATUS_LABELS: Record<
  (typeof subscriptionStatusList)[number],
  string
> = {
  trialing: "Em teste",
  active: "Ativa",
  past_due: "Pagamento pendente",
  unpaid: "Inadimplente",
  paused: "Pausada",
  canceled: "Cancelada",
  expired: "Teste encerrado",
};

export const paymentMethods = ["pix", "boleto", "card"] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  pix: "Pix",
  boleto: "Boleto",
  card: "Cartão",
};

export const invoiceStatuses = [
  "open",
  "paid",
  "failed",
  "refunded",
  "void",
] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  open: "Em aberto",
  paid: "Paga",
  failed: "Falhou",
  refunded: "Reembolsada",
  void: "Cancelada",
};

export const paymentEventStatuses = [
  "pending",
  "processed",
  "ignored",
  "failed",
  "duplicate",
] as const;

export const PROVIDER_LABELS: Record<BillingProviderId, string> = {
  manual: "Manual",
  stripe: "Stripe",
  asaas: "Asaas",
  mercadopago: "Mercado Pago",
  pagarme: "Pagar.me",
  pagbank: "PagBank",
};

export const INTERVAL_LABELS: Record<PriceInterval, string> = {
  month: "mês",
  year: "ano",
};

/** Limites que um plano pode fixar (`plan.limits`). */
export const limitMetrics = [
  "members",
  "customers",
  "storage_mb",
  "custom_roles",
  "organizations",
  // Números de WhatsApp por tipo de canal (`docs/specs/whatsapp-canais/spec.md`).
  "channels_whatsapp_cloud",
  "channels_whatsapp_qr",
] as const;
export type LimitMetric = (typeof limitMetrics)[number];

export const LIMIT_LABELS: Record<LimitMetric, string> = {
  members: "membros",
  customers: "clientes",
  storage_mb: "armazenamento (MB)",
  custom_roles: "papéis personalizados",
  organizations: "organizações",
  channels_whatsapp_cloud: "números oficiais de WhatsApp",
  channels_whatsapp_qr: "números de WhatsApp por QR Code",
};

export function formatMoney(cents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(
    cents / 100,
  );
}

/** `consent`: o suporte só entra com autorização. Fica aqui porque o formulário também usa. */
export const impersonationPolicies = ["consent", "allow_without_consent"] as const;
export type ImpersonationPolicy = (typeof impersonationPolicies)[number];
