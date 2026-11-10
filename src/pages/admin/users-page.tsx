import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  type Page,
  useAdminMutation,
  useAdminQuery,
  useIsPlatformOwner,
} from "@/components/admin/admin-api";
import { OrgList, type OrgRef } from "@/components/admin/org-list";
import { Pager } from "@/components/admin/pager";
import { PortalUsersCard } from "@/components/admin/portal-users-card";
import { InboxModeProvider } from "@/components/inbox/inbox-scope";
import { StartConversationButton } from "@/components/inbox/new-conversation-dialog";
import type { PhoneKind } from "@/lib/phone/br";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { ReasonDialog } from "@/components/admin/reason-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleLabel } from "@/lib/auth/permissions";
import { useAuth } from "@/providers/auth-provider";

type AdminUser = {
  id: string;
  name: string;
  email: string;
  platformRole: string;
  emailVerified: boolean;
  banned: boolean;
  banReason: string | null;
  /** Tipo do telefone (`null` sem telefone); o número não sai da API. */
  phoneKind: PhoneKind | null;
  organizations: OrgRef[];
  more: number;
};

const ROLE_LABELS: Record<string, string> = {
  platform_owner: "Proprietário",
  platform_support: "Suporte",
};

export function AdminUsersPage() {
  const owner = useIsPlatformOwner();
  const { user: me } = useAuth();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [banning, setBanning] = useState<AdminUser | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = searchParams.get("scope") === "portal" ? "portal" : "team";
  const query = useAdminQuery<Page<AdminUser>>(
    "/api/admin/users",
    { q, page, scope: "team" },
    scope === "team",
  );
  const ban = useAdminMutation("Usuário banido.");
  const unban = useAdminMutation("Usuário desbanido.");

  return (
    <div className="max-w-5xl space-y-6">
      <PageTitle
        title="Usuários"
        description="Equipe e plataforma de um lado, clientes do portal do outro: são identidades separadas."
      />

      <Tabs
        value={scope}
        onValueChange={(next) => {
          setSearchParams(next === "portal" ? { scope: "portal" } : {});
          setPage(1);
        }}
      >
        <TabsList>
          <TabsTrigger value="team">Equipe e plataforma</TabsTrigger>
          <TabsTrigger value="portal">Portal</TabsTrigger>
        </TabsList>
      </Tabs>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setQ(search.trim());
          setPage(1);
        }}
      >
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar por nome ou e-mail"
          aria-label="Buscar usuário"
          maxLength={100}
        />
      </form>

      {scope === "portal" ? (
        <PortalUsersCard q={q} page={page} onPage={setPage} />
      ) : (
      <QueryState {...query}>
        {query.data ? (
          <Card>
            <CardContent className="pt-6">
              {query.data.items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum usuário encontrado.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>E-mail</TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead>Organizações</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.items.map((user) => (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium">
                          <Link to={`/admin/usuarios/${user.id}`} className="hover:underline">
                            {user.name}
                          </Link>
                        </TableCell>
                        <TableCell className="break-all">{user.email}</TableCell>
                        <TableCell className="space-x-1">
                          {ROLE_LABELS[user.platformRole] ? (
                            <Badge variant="secondary">
                              {ROLE_LABELS[user.platformRole]}
                            </Badge>
                          ) : null}
                          {user.banned ? (
                            <Badge variant="destructive">Banido</Badge>
                          ) : null}
                          {!user.emailVerified ? (
                            <Badge variant="outline">Sem verificação</Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <OrgList
                            organizations={user.organizations}
                            more={user.more}
                            label={(org) =>
                              org.role
                                ? org.role
                                    .split(",")
                                    .map((role) => roleLabel(role))
                                    .join(", ")
                                : null
                            }
                          />
                        </TableCell>
                        <TableCell className="space-x-2 text-right">
                          {/* "Conversar": papel que responde e telefone preenchido (o servidor confere). */}
                          {user.banned || user.id === me?.id ? null : (
                            <InboxModeProvider value="platform">
                              <StartConversationButton
                                target={{ userId: user.id }}
                                name={user.name}
                                phoneKind={user.phoneKind}
                                size="sm"
                              />
                            </InboxModeProvider>
                          )}
                          {owner && user.platformRole === "user" && user.id !== me?.id ? (
                            user.banned ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={unban.isPending}
                                onClick={() =>
                                  unban.mutate({
                                    path: `/api/admin/users/${user.id}/unban`,
                                    method: "POST",
                                  })
                                }
                              >
                                Desbanir
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setBanning(user)}
                              >
                                Banir
                              </Button>
                            )
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <Pager
                page={page}
                total={query.data.total}
                pageSize={query.data.pageSize}
                onPage={setPage}
              />
            </CardContent>
          </Card>
        ) : null}
      </QueryState>
      )}

      <ReasonDialog
        open={banning !== null}
        title="Banir usuário"
        description={`${banning?.email ?? ""} perde o acesso e as sessões abertas são encerradas.`}
        confirmLabel="Banir"
        pending={ban.isPending}
        onCancel={() => setBanning(null)}
        onConfirm={(reason) => {
          if (!banning) return;

          ban.mutate(
            {
              path: `/api/admin/users/${banning.id}/ban`,
              method: "POST",
              body: { reason },
            },
            { onSettled: () => setBanning(null) },
          );
        }}
      />
    </div>
  );
}
