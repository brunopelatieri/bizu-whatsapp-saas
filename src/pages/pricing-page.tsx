import { Check } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PageHero } from "@/components/layout/page-hero";
import { Button } from "@/components/ui/button";
import {
  formatMoney,
  LIMIT_LABELS,
  type LimitMetric,
  limitMetrics,
  type PriceInterval,
} from "@/lib/billing/constants";
import type { PublicPlan } from "@/lib/billing/public-plans.server";
import { cn } from "@/lib/utils";

const FEATURE_LABELS: Record<string, string> = {
  audit_export: "Exportação da auditoria",
  custom_roles: "Papéis personalizados",
};

/** Canais de WhatsApp só aparecem com valor no plano (e módulo ativo: o loader filtra). */
const OPTIONAL_METRICS = new Set<LimitMetric>(["channels_whatsapp_cloud", "channels_whatsapp_qr"]);

function limitLines(plan: PublicPlan) {
  const metrics = limitMetrics.filter(
    (metric) => !OPTIONAL_METRICS.has(metric) || plan.limits[metric] !== undefined,
  );

  return metrics.map((metric: LimitMetric) => {
    const value = plan.limits[metric];
    const label = LIMIT_LABELS[metric];

    // Organizações sem valor no plano valem 1 (`src/lib/billing/organizations.ts`).
    if (metric === "organizations" && (value === undefined || value === 1)) {
      return "1 organização";
    }

    return value === undefined
      ? `${label[0]?.toUpperCase()}${label.slice(1)} ilimitados`
      : `Até ${value.toLocaleString("pt-BR")} ${label}`;
  });
}

function PriceLine({ plan, interval }: { plan: PublicPlan; interval: PriceInterval }) {
  if (plan.isFree) {
    return <p className="text-3xl font-semibold">Grátis</p>;
  }

  const price = plan.prices[interval];

  if (!price) {
    return <p className="text-sm text-muted-foreground">Preço em breve</p>;
  }

  return (
    <p className="text-3xl font-semibold">
      {formatMoney(price.amountCents, price.currency)}
      <span className="text-sm font-normal text-muted-foreground">
        /{interval === "month" ? "mês" : "ano"}
      </span>
    </p>
  );
}

export function PricingPage({ plans }: { plans: PublicPlan[] }) {
  const [interval, setInterval] = useState<PriceInterval>("month");
  const hasYearly = plans.some((plan) => plan.prices.year);

  return (
    <>
      <PageHero
        eyebrow="Preços"
        title="Escolha o plano da sua equipe"
        description="Comece sem compromisso. Mude de plano quando precisar, sem trocar de conta."
      />

      <section className="px-6 py-12">
        <div className="mx-auto max-w-5xl">
          {hasYearly ? (
            <fieldset className="mb-8 inline-flex rounded-lg border border-border p-1 text-sm">
              <legend className="sr-only">Intervalo de cobrança</legend>
              {(["month", "year"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={interval === value}
                  onClick={() => setInterval(value)}
                  className={cn(
                    "rounded-md px-4 py-1.5 transition",
                    interval === value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "month" ? "Mensal" : "Anual"}
                </button>
              ))}
            </fieldset>
          ) : null}

          {plans.length === 0 ? (
            <p className="text-muted-foreground">
              Os planos ainda não foram publicados.
            </p>
          ) : (
            <div className="grid gap-6 md:grid-cols-3">
              {plans.map((plan) => (
                <article
                  key={plan.slug}
                  className="flex flex-col rounded-xl border border-border/60 bg-card p-6 shadow-sm"
                >
                  <h2 className="text-lg font-semibold">{plan.name}</h2>
                  {plan.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {plan.description}
                    </p>
                  ) : null}
                  <div className="my-5">
                    <PriceLine plan={plan} interval={interval} />
                  </div>
                  <ul className="mb-6 flex-1 space-y-2 text-sm">
                    {[
                      ...limitLines(plan),
                      ...plan.features.map((feature) => FEATURE_LABELS[feature] ?? feature),
                    ].map((line) => (
                      <li key={line} className="flex gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                        {line}
                      </li>
                    ))}
                  </ul>
                  <Button render={<Link to="/cadastro" />}>Começar</Button>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
