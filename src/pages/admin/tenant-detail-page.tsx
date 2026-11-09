import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import {
  type AdminPlan,
  useAdminMutation,
  useAdminQuery,
  useIsPlatformOwner,
} from "@/components/admin/admin-api";
import { BillingStateBadge } from "@/components/admin/billing-state-badge";
import { EditTenantDialog } from "@/components/admin/edit-tenant-dialog";
import {
  ManualBillingCard,
  type ManualInvoice,
  type ManualPrice,
  type ManualSubscription,
} from "@/components/admin/manual-billing-card";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { ReasonDialog } from "@/components/admin/reason-dialog";
import {
  type OrganizationAnnotation,
  TenantAnnotationCard,
} from "@/components/admin/tenant-annotation-card";
import { TenantDeletionCard } from "@/components/admin/tenant-deletion-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { BillingState } from "@/lib/billing/state";
import { roleLabel } from "@/lib/auth/permissions";

type TenantDetail = {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    accessMode: string;
    state: BillingState;
    createdAt: string;
  };
  /** Anotação da plataforma (etiquetas e campos): só `/admin` a recebe. */
  tags: OrganizationAnnotation["tags"];
  customFields: OrganizationAnnotation["customFields"];
  subscription: ManualSubscription | null;
  plan: { id: string; name: string; isFree: boolean } | null;
  invoices: ManualInvoice[];
  manualPrices: ManualPrice[];
  impersonation: {
    allowed: boolean;
    policy: string;
    grantExpiresAt: string | null;
  };
  members: Array<{
    id: string;
    userId: string;
    name: string;
    email: string;
    role: string;
    banned: boolean;
  }>;
  events: Array<{
    id: string;
    from: string | null;
    to: string;
    reason: string;
    source: string;
    createdAt: string;
  }>;
  audit: Array<{ id: string; action: string; actorType: string; createdAt: string }>;
};

const formatDateTime = (iso: string) => new Date(iso).toLocaleString("pt-BR");

function PlanChanger({ detail, plans }: { detail: TenantDetail; plans: AdminPlan[] }) {
  const [planId, setPlanId] = useState(detail.plan?.id ?? "");
  const change = useAdminMutation("Plano alterado.");
  const items = plans
    .filter(({ active, id }) => active || id === detail.plan?.id)
    .map(({ id, name }) => ({ value: id, label: name }));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        items={items}
        value={planId}
        onValueChange={(next) => next && setPlanId(next)}
      >
        <SelectTrigger aria-label="Plano" className="w-52">
          <SelectValue placeholder="Escolha o plano" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={!planId || planId === detail.plan?.id || change.isPending}
        onClick={() =>
          change.mutate({
            path: `/api/admin/tenants/${detail.tenant.id}/plan`,
            method: "PUT",
            body: { planId },
          })
        }
      >
        Trocar plano
      </Button>
    </div>
  );
}

/**
 * Sem consentimento, o mesmo POST vira o pedido ao owner, por isso o botão muda de nome. Dá
 * certo: recarrega em `/app`, já na sessão da pessoa.
 */
function ImpersonateButton({
  tenantId,
  userId,
  allowed,
}: {
  tenantId: string;
  userId: string;
  allowed: boolean;
}) {
  const impersonate = useMutation({
    mutationFn: () =>
      apiFetch("/api/admin/impersonate", {
        method: "POST",
        body: JSON.stringify({ userId, tenantId }),
      }),
    onSuccess: () => window.location.assign("/app"),
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === "IMPERSONATION_CONSENT_REQUIRED"
      ) {
        toast.info(error.message);
        return;
      }

      toast.error(error.message);
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={impersonate.isPending}
      onClick={() => impersonate.mutate()}
    >
      {allowed ? "Personificar" : "Pedir acesso"}
    </Button>
  );
}

export function AdminTenantDetailPage() {
  const { id = "" } = useParams();
  const owner = useIsPlatformOwner();
  const query = useAdminQuery<TenantDetail>(`/api/admin/tenants/${id}`);
  const plans = useAdminQuery<{ plans: AdminPlan[] }>("/api/admin/plans");
  const [suspending, setSuspending] = useState(false);
  const [editing, setEditing] = useState(false); // admin-crud A
  const suspend = useAdminMutation("Organização suspensa.");
  const unsuspend = useAdminMutation("Organização reativada.");
  const detail = query.data;

  return (
    <div className="max-w-4xl space-y-6">
      <Link
        to="/admin/tenants"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Organizações
      </Link>

      <QueryState {...query}>
        {detail ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <PageTitle title={detail.tenant.name} description={detail.tenant.slug} />
                <div className="mt-2">
                  <BillingStateBadge state={detail.tenant.state} />
                </div>
              </div>
              {owner ? (
                <div className="flex flex-wrap gap-2">
                  {/* admin-crud A: edição de nome e slug (não em exclusão) */}
                  {detail.tenant.status === "deleting" || detail.tenant.status === "deleted" ? null : (
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Editar
                    </Button>
                  )}
                {detail.tenant.status === "suspended" ? (
                  <Button
                    variant="outline"
                    disabled={unsuspend.isPending}
                    onClick={() =>
                      unsuspend.mutate({
                        path: `/api/admin/tenants/${id}/unsuspend`,
                        method: "POST",
                      })
                    }
                  >
                    Reativar
                  </Button>
                ) : (
                  <Button variant="destructive" onClick={() => setSuspending(true)}>
                    Suspender
                  </Button>
                )}
                </div>
              ) : null}
            </div>

            {/* admin-crud C: excluir e cancelar a exclusão */}
            <TenantDeletionCard tenant={detail.tenant} />

            <TenantAnnotationCard
              tenantId={id}
              annotation={{ tags: detail.tags, customFields: detail.customFields }}
              canWrite={owner && detail.tenant.status !== "deleting" && detail.tenant.status !== "deleted"}
            />

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Assinatura</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {detail.subscription ? (
                  <>
                    <p>
                      Plano <strong>{detail.plan?.name}</strong>
                    </p>
                    <ManualBillingCard
                      key={`${detail.subscription.id}:${detail.subscription.planId}`}
                      subscription={detail.subscription}
                      planIsFree={detail.plan?.isFree ?? false}
                      invoices={detail.invoices}
                      prices={detail.manualPrices}
                      canWrite={owner}
                    />
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    Sem assinatura: o tenant não tem limites.
                  </p>
                )}
                {owner && plans.data ? (
                  <PlanChanger
                    key={detail.plan?.id ?? "none"}
                    detail={detail}
                    plans={plans.data.plans}
                  />
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Membros</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>E-mail</TableHead>
                      <TableHead>Papel</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className="font-medium">{member.name}</TableCell>
                        <TableCell className="break-all">{member.email}</TableCell>
                        <TableCell>
                          {member.role
                            .split(",")
                            .map((role) => roleLabel(role))
                            .join(", ")}
                          {member.banned ? " (banido)" : ""}
                        </TableCell>
                        <TableCell className="text-right">
                          <ImpersonateButton
                            tenantId={id}
                            userId={member.userId}
                            allowed={detail.impersonation.allowed}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Histórico da assinatura</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {detail.events.length === 0 ? (
                    <p className="text-muted-foreground">Nada registrado.</p>
                  ) : (
                    detail.events.map((event) => (
                      <p key={event.id}>
                        <span className="text-muted-foreground">
                          {formatDateTime(event.createdAt)}
                        </span>{" "}
                        {event.from ?? "–"} → {event.to} ({event.source})
                      </p>
                    ))
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Auditoria recente</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {detail.audit.length === 0 ? (
                    <p className="text-muted-foreground">Nada registrado.</p>
                  ) : (
                    detail.audit.map((entry) => (
                      <p key={entry.id}>
                        <span className="text-muted-foreground">
                          {formatDateTime(entry.createdAt)}
                        </span>{" "}
                        {entry.action}
                      </p>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>

            {editing ? (
              <EditTenantDialog
                open
                tenant={detail.tenant}
                onClose={() => setEditing(false)}
              />
            ) : null}

            <ReasonDialog
              open={suspending}
              title="Suspender organização"
              description="Todos os membros perdem o acesso na hora e os proprietários recebem um e-mail. Os dados continuam guardados."
              confirmLabel="Suspender"
              pending={suspend.isPending}
              onCancel={() => setSuspending(false)}
              onConfirm={(reason) =>
                suspend.mutate(
                  {
                    path: `/api/admin/tenants/${id}/suspend`,
                    method: "POST",
                    body: { reason },
                  },
                  { onSettled: () => setSuspending(false) },
                )
              }
            />
          </>
        ) : null}
      </QueryState>
    </div>
  );
}
