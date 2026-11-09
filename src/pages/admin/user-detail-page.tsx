import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  useAdminMutation,
  useAdminQuery,
  useIsPlatformOwner,
} from "@/components/admin/admin-api";
import { BillingStateBadge } from "@/components/admin/billing-state-badge";
import { DeleteDialog } from "@/components/admin/delete-dialog";
import { DeletionStatus, type PendingDeletion } from "@/components/admin/deletion-status";
import { PersonEditCard } from "@/components/admin/person-edit-card";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { ReasonDialog } from "@/components/admin/reason-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleLabel } from "@/lib/auth/permissions";
import type { BillingState } from "@/lib/billing/state";
import { useAuth } from "@/providers/auth-provider";

type UserDetail = {
  user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    phoneNormalized: string | null;
    platformRole: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    banned: boolean;
    banReason: string | null;
    sessions: number;
    createdAt: string;
  };
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    state: BillingState;
    planName: string | null;
  }>;
  deletion: PendingDeletion;
};

const ROLE_LABELS: Record<string, string> = {
  platform_owner: "Proprietário da plataforma",
  platform_support: "Suporte da plataforma",
  user: "Equipe",
};

const isOwnerRole = (role: string) => role.split(",").includes("owner");

/** `/admin/usuarios/:id`: dados, organizações, editar, sessões, banir e excluir. */
export function AdminUserDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const owner = useIsPlatformOwner();
  const query = useAdminQuery<UserDetail>(`/api/admin/users/${id}`);
  const [banning, setBanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [withOrganizations, setWithOrganizations] = useState(false);
  const revoke = useAdminMutation<{ revoked: number }>("Sessões encerradas.");
  const ban = useAdminMutation("Usuário banido.");
  const unban = useAdminMutation("Usuário desbanido.");
  const remove = useAdminMutation<{ mode: string }>("Exclusão registrada.");
  const cancel = useAdminMutation("Exclusão cancelada.");
  const detail = query.data;
  const target = detail?.user;
  // A API decide (`assertManageableUser`); aqui só não se oferece o que ela recusaria.
  const manageable =
    owner && target !== undefined && target.platformRole !== "platform_owner" && target.id !== me?.id;
  const owned = detail?.organizations.filter(({ role }) => isOwnerRole(role)) ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      <Link to="/admin/usuarios" className="text-sm text-muted-foreground hover:text-foreground">
        ← Usuários
      </Link>

      <QueryState {...query}>
        {detail && target ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <PageTitle title={target.name} description={target.email} />
                <div className="mt-2 flex flex-wrap gap-1">
                  <Badge variant="secondary">
                    {ROLE_LABELS[target.platformRole] ?? target.platformRole}
                  </Badge>
                  {target.banned ? <Badge variant="destructive">Banido</Badge> : null}
                  {target.emailVerified ? null : <Badge variant="outline">Sem verificação</Badge>}
                  {target.twoFactorEnabled ? <Badge variant="outline">2FA</Badge> : null}
                </div>
              </div>
              {manageable && !detail.deletion ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending || target.sessions === 0}
                    onClick={() =>
                      revoke.mutate({ path: `/api/admin/users/${id}/revoke-sessions`, method: "POST" })
                    }
                  >
                    Encerrar sessões ({target.sessions})
                  </Button>
                  {target.platformRole === "user" ? (
                    target.banned ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={unban.isPending}
                        onClick={() => unban.mutate({ path: `/api/admin/users/${id}/unban`, method: "POST" })}
                      >
                        Desbanir
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => setBanning(true)}>
                        Banir
                      </Button>
                    )
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setDeleting(true)}
                  >
                    Excluir
                  </Button>
                </div>
              ) : null}
            </div>

            {detail.deletion ? (
              <DeletionStatus
                deletion={detail.deletion}
                canWrite={manageable}
                pending={cancel.isPending}
                onCancel={() =>
                  cancel.mutate({ path: `/api/admin/users/${id}/deletion/cancel`, method: "POST" })
                }
              />
            ) : null}

            {target.banned && target.banReason ? (
              <p className="text-sm text-muted-foreground">Motivo do banimento: {target.banReason}</p>
            ) : null}

            {manageable && !detail.deletion ? (
              <PersonEditCard
                key={`${target.name}:${target.email}:${target.phoneNormalized}`}
                path={`/api/admin/users/${id}`}
                person={target}
                emailWarning="Trocar o e-mail desverifica a conta, encerra as sessões, avisa o endereço antigo e manda ao novo um link para definir a senha."
              />
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Organizações</CardTitle>
              </CardHeader>
              <CardContent>
                {detail.organizations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhuma organização.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organização</TableHead>
                        <TableHead>Papel</TableHead>
                        <TableHead>Plano</TableHead>
                        <TableHead>Situação</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.organizations.map((org) => (
                        <TableRow key={org.id}>
                          <TableCell className="font-medium">
                            <Link to={`/admin/tenants/${org.id}`} className="hover:underline">
                              {org.name}
                            </Link>
                          </TableCell>
                          <TableCell>
                            {org.role
                              .split(",")
                              .map((role) => roleLabel(role))
                              .join(", ")}
                          </TableCell>
                          <TableCell>{org.planName ?? "–"}</TableCell>
                          <TableCell>
                            <BillingStateBadge state={org.state} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <ReasonDialog
              open={banning}
              title="Banir usuário"
              description={`${target.email} perde o acesso e as sessões abertas são encerradas.`}
              confirmLabel="Banir"
              pending={ban.isPending}
              onCancel={() => setBanning(false)}
              onConfirm={(reason) =>
                ban.mutate(
                  { path: `/api/admin/users/${id}/ban`, method: "POST", body: { reason } },
                  { onSettled: () => setBanning(false) },
                )
              }
            />

            <DeleteDialog
              open={deleting}
              title={`Excluir ${target.name}`}
              description="Agendar bane a conta e encerra as sessões até a data. A exclusão anonimiza a conta, tira o papel de plataforma e remove vínculos, convites e exportações; a auditoria fica."
              confirmText={target.email}
              confirmLabel="o e-mail"
              pending={remove.isPending}
              onCancel={() => setDeleting(false)}
              onConfirm={(input) =>
                remove.mutate(
                  {
                    path: `/api/admin/users/${id}`,
                    method: "DELETE",
                    body: { ...input, deleteSoleOrganizations: withOrganizations },
                  },
                  {
                    onSuccess: (result) => {
                      setDeleting(false);
                      if (result.mode === "now") navigate("/admin/usuarios");
                    },
                  },
                )
              }
            >
              {owned.length > 0 ? (
                <label className="flex gap-2 rounded-md border p-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={withOrganizations}
                    onChange={(event) => setWithOrganizations(event.target.checked)}
                  />
                  <span>
                    Excluir também as organizações de que esta pessoa é a única proprietária (
                    {owned.map(({ name }) => name).join(", ")}), no mesmo modo. Sem isto, a API
                    recusa e lista quais são.
                  </span>
                </label>
              ) : null}
            </DeleteDialog>
          </>
        ) : null}
      </QueryState>
    </div>
  );
}
