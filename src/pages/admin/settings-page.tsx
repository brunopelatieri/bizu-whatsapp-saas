import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  type AdminPlan,
  type AdminSettings,
  useAdminMutation,
  useAdminQuery,
  useIsPlatformOwner,
} from "@/components/admin/admin-api";
import { Field } from "@/components/admin/field";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ImpersonationPolicy } from "@/lib/billing/constants";
import { platformSettingsSchema } from "@/lib/schemas/admin";

const AUTO = "auto";

const POLICY_ITEMS: Array<{ value: ImpersonationPolicy; label: string }> = [
  { value: "consent", label: "Só com autorização do proprietário" },
  { value: "allow_without_consent", label: "Sem autorização (sempre auditado)" },
];

function SettingsForm({
  settings,
  plans,
  readOnly,
}: {
  settings: AdminSettings;
  plans: AdminPlan[];
  readOnly: boolean;
}) {
  const [planId, setPlanId] = useState(settings.trialPlanId ?? AUTO);
  const [trialDays, setTrialDays] = useState(String(settings.trialDays));
  const [graceDays, setGraceDays] = useState(String(settings.graceDays));
  const [policy, setPolicy] = useState(settings.impersonationPolicy);
  const [dpoEmail, setDpoEmail] = useState(settings.dpoEmail ?? "");
  const [retentionDays, setRetentionDays] = useState(
    String(settings.auditRetentionDays),
  );
  const save = useAdminMutation("Configurações salvas.");

  const items = [
    { value: AUTO, label: "Primeiro plano gratuito ativo" },
    ...plans
      .filter(({ active }) => active)
      .map(({ id, name, isFree }) => ({
        value: id,
        label: isFree ? `${name} (gratuito)` : name,
      })),
  ];

  function submit(event: React.FormEvent) {
    event.preventDefault();

    const parsed = platformSettingsSchema.safeParse({
      trialPlanId: planId === AUTO ? null : planId,
      trialDays: Number(trialDays),
      graceDays: Number(graceDays),
      impersonationPolicy: policy,
      dpoEmail: dpoEmail.trim() === "" ? null : dpoEmail,
      auditRetentionDays: Number(retentionDays),
    });

    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Dados inválidos.");
      return;
    }

    save.mutate({ path: "/api/admin/settings", method: "PATCH", body: parsed.data });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Plano padrão e período de teste</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid max-w-md gap-4">
          <div className="grid gap-1 text-sm">
            <span>Plano que as organizações novas recebem</span>
            <Select
              items={items}
              value={planId}
              disabled={readOnly}
              onValueChange={(next) => next && setPlanId(next)}
            >
              <SelectTrigger aria-label="Plano padrão">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1 text-sm">
            <span>Acesso do suporte às organizações</span>
            <Select
              items={POLICY_ITEMS}
              value={policy}
              disabled={readOnly}
              onValueChange={(next) => next && setPolicy(next)}
            >
              <SelectTrigger aria-label="Acesso do suporte">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POLICY_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Field
            label="Dias de teste"
            hint="0 = sem teste: o plano padrão precisa ser gratuito e a organização nasce ativa, sem prazo (gratuito sem fim). Mudar aqui não altera organizações já criadas."
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={365}
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                readOnly={readOnly}
              />
            )}
          </Field>

          <Field
            label="Dias de carência depois do teste"
            hint="Passado o teste, a organização segue com acesso total por estes dias e então passa a somente leitura."
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={60}
                value={graceDays}
                onChange={(e) => setGraceDays(e.target.value)}
                readOnly={readOnly}
              />
            )}
          </Field>

          <Field
            label="E-mail do encarregado (DPO)"
            hint="Aparece nas páginas /legal/termos e /legal/privacidade. Deixe vazio enquanto não houver um."
          >
            {(id) => (
              <Input
                id={id}
                type="email"
                value={dpoEmail}
                onChange={(e) => setDpoEmail(e.target.value)}
                readOnly={readOnly}
              />
            )}
          </Field>

          <Field
            label="Dias de retenção da auditoria"
            hint="O job de manutenção apaga eventos mais antigos que isto (mínimo 30, padrão 365)."
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                min={30}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                readOnly={readOnly}
              />
            )}
          </Field>

          {readOnly ? (
            <p className="text-xs text-muted-foreground">
              Só o proprietário da plataforma altera estas configurações.
            </p>
          ) : (
            <Button type="submit" className="justify-self-start" disabled={save.isPending}>
              Salvar
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function AdminSettingsPage() {
  const owner = useIsPlatformOwner();
  const settings = useAdminQuery<{ settings: AdminSettings }>("/api/admin/settings");
  const plans = useAdminQuery<{ plans: AdminPlan[] }>("/api/admin/plans");

  return (
    <div className="max-w-4xl space-y-6">
      <PageTitle
        title="Configurações da plataforma"
        description="Valem para as próximas organizações criadas."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organizações: etiquetas e campos</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Anotações da plataforma sobre cada organização. Só a plataforma vê; o
            proprietário e a equipe da organização nunca as recebem.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <Link
                to="/admin/configuracoes/etiquetas"
                className="font-medium text-primary hover:underline"
              >
                Etiquetas das organizações
              </Link>
            </li>
            <li>
              <Link
                to="/admin/configuracoes/campos"
                className="font-medium text-primary hover:underline"
              >
                Campos das organizações
              </Link>
            </li>
          </ul>
        </CardContent>
      </Card>

      <QueryState
        isPending={settings.isPending || plans.isPending}
        isError={settings.isError || plans.isError}
        error={settings.error ?? plans.error}
        refetch={() => {
          void settings.refetch();
          void plans.refetch();
        }}
      >
        {settings.data && plans.data ? (
          <SettingsForm
            key={JSON.stringify(settings.data.settings)}
            settings={settings.data.settings}
            plans={plans.data.plans}
            readOnly={!owner}
          />
        ) : null}
      </QueryState>
    </div>
  );
}
