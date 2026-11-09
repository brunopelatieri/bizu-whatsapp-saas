import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  useAdminMutation,
  useAdminQuery,
  useIsPlatformOwner,
} from "@/components/admin/admin-api";
import { DeleteDialog } from "@/components/admin/delete-dialog";
import { DeletionStatus, type PendingDeletion } from "@/components/admin/deletion-status";
import { PersonEditCard } from "@/components/admin/person-edit-card";
import { PageTitle, QueryState } from "@/components/admin/query-state";
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

type PortalUserDetail = {
  person: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    phoneNormalized: string | null;
    emailVerified: boolean;
    hasPassword: boolean;
    sessions: number;
    createdAt: string;
  };
  links: Array<{
    tenant: { id: string; name: string };
    status: string;
    lastLoginAt: string | null;
  }>;
  deletion: PendingDeletion;
};

const STATUS_LABELS: Record<string, string> = {
  active: "Ativo",
  lead: "Lead",
  blocked: "Bloqueado",
};

/** `/admin/usuarios/portal/:id`: dados, vínculos, editar, sessões e excluir. */
export function AdminPortalUserDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const owner = useIsPlatformOwner();
  const query = useAdminQuery<PortalUserDetail>(`/api/admin/portal-users/${id}`);
  const [deleting, setDeleting] = useState(false);
  const revoke = useAdminMutation("Sessões do portal encerradas.");
  const remove = useAdminMutation<{ mode: string }>("Exclusão registrada.");
  const cancel = useAdminMutation("Exclusão cancelada.");
  const detail = query.data;
  const person = detail?.person;

  return (
    <div className="max-w-4xl space-y-6">
      <Link
        to="/admin/usuarios?scope=portal"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Clientes do portal
      </Link>

      <QueryState {...query}>
        {detail && person ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <PageTitle title={person.name} description={person.email} />
                <div className="mt-2 flex flex-wrap gap-1">
                  {person.emailVerified ? null : <Badge variant="outline">Sem verificação</Badge>}
                  <Badge variant="outline">
                    {person.hasPassword ? "Com senha" : "Só magic link"}
                  </Badge>
                </div>
              </div>
              {owner && !detail.deletion ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending || person.sessions === 0}
                    onClick={() =>
                      revoke.mutate({
                        path: `/api/admin/portal-users/${id}/revoke-sessions`,
                        method: "POST",
                      })
                    }
                  >
                    Encerrar sessões ({person.sessions})
                  </Button>
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
                canWrite={owner}
                pending={cancel.isPending}
                onCancel={() =>
                  cancel.mutate({
                    path: `/api/admin/portal-users/${id}/deletion/cancel`,
                    method: "POST",
                  })
                }
              />
            ) : null}

            {owner && !detail.deletion ? (
              <PersonEditCard
                key={`${person.name}:${person.email}:${person.phoneNormalized}`}
                path={`/api/admin/portal-users/${id}`}
                person={person}
                emailWarning="O e-mail muda em todas as organizações. A senha e as sessões saem: o endereço novo entra por magic link, que prova a posse. O endereço antigo é avisado."
              />
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Organizações</CardTitle>
              </CardHeader>
              <CardContent>
                {detail.links.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum vínculo.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Organização</TableHead>
                        <TableHead>Situação</TableHead>
                        <TableHead>Último acesso</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.links.map((link) => (
                        <TableRow key={link.tenant.id}>
                          <TableCell className="font-medium">
                            <Link to={`/admin/tenants/${link.tenant.id}`} className="hover:underline">
                              {link.tenant.name}
                            </Link>
                          </TableCell>
                          <TableCell>{STATUS_LABELS[link.status] ?? link.status}</TableCell>
                          <TableCell>
                            {link.lastLoginAt
                              ? new Date(link.lastLoginAt).toLocaleString("pt-BR")
                              : "–"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <DeleteDialog
              open={deleting}
              title={`Excluir ${person.name}`}
              description="Agendar encerra as sessões e barra o portal (sessão, magic link e senha) até a data; a situação nas organizações não muda. A exclusão anonimiza a pessoa e o cadastro dela em todas as organizações."
              confirmText={person.email}
              confirmLabel="o e-mail"
              pending={remove.isPending}
              onCancel={() => setDeleting(false)}
              onConfirm={(input) =>
                remove.mutate(
                  { path: `/api/admin/portal-users/${id}`, method: "DELETE", body: input },
                  {
                    onSuccess: (result) => {
                      setDeleting(false);
                      if (result.mode === "now") navigate("/admin/usuarios?scope=portal");
                    },
                  },
                )
              }
            />
          </>
        ) : null}
      </QueryState>
    </div>
  );
}
