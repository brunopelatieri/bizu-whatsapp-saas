import { useState } from "react";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { RoleSelect } from "@/components/app/team/role-select";
import {
  type RoleOption,
  type TeamMember,
  useTeamMutation,
} from "@/components/app/team/team-api";
import { Can, useCan } from "@/components/auth/can";
import { StartConversationButton } from "@/components/inbox/new-conversation-dialog";
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
import { isOwner, roleLabel } from "@/lib/auth/permissions";
import { conversationsLabel, deletedVerb } from "@/lib/format/conversations";
import { useAuth } from "@/providers/auth-provider";

type MembersTableProps = { members: TeamMember[]; roles: RoleOption[] };

export function MembersTable({ members, roles }: MembersTableProps) {
  const { user, tenant } = useAuth();
  const can = useCan();
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const changeRole = useTeamMutation("Papel alterado.");
  const remove = useTeamMutation("Membro removido.");

  // Só a primeira barreira, para a tela não oferecer o que a API vai recusar.
  const canManage = (member: TeamMember) =>
    member.userId !== user?.id &&
    (!isOwner(member.role) || isOwner(tenant?.role ?? ""));

  function confirmRemoval() {
    if (!removing) return;

    remove.mutate(
      { path: `/api/team/members/${removing.id}`, method: "DELETE" },
      { onSettled: () => setRemoving(null) },
    );
  }

  return (
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
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="font-medium">{member.name}</TableCell>
                <TableCell className="break-all">{member.email}</TableCell>
                <TableCell>
                  {can("member", "update") && canManage(member) ? (
                    <RoleSelect
                      roles={roles}
                      value={member.role}
                      disabled={changeRole.isPending}
                      className="w-44"
                      onChange={(role) =>
                        changeRole.mutate({
                          path: `/api/team/members/${member.id}`,
                          method: "PATCH",
                          body: { role },
                        })
                      }
                    />
                  ) : (
                    <Badge variant="secondary">{roleLabel(member.role)}</Badge>
                  )}
                </TableCell>
                <TableCell className="space-x-1 text-right">
                  {member.userId !== user?.id ? (
                    <StartConversationButton
                      target={{ userId: member.userId }}
                      name={member.name}
                      phoneKind={member.phoneKind}
                      size="sm"
                    />
                  ) : null}
                  {canManage(member) ? (
                    <Can resource="member" action="delete">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemoving(member)}
                      >
                        Remover
                      </Button>
                    </Can>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <ConfirmDialog
        open={Boolean(removing)}
        title="Remover membro"
        description={
          <>
            {removing?.name} perde o acesso a esta organização na hora.
            {removing?.customerRecord ? (
              <>
                {" "}
                <strong>
                  A pessoa também é cliente desta organização: a ficha de cliente ligada a ela
                  {removing.customerRecord.conversationCount > 0
                    ? ` e ${conversationsLabel(removing.customerRecord.conversationCount)} de WhatsApp do número dela`
                    : ""}{" "}
                  {deletedVerb(1, removing.customerRecord.conversationCount)}, sem volta.
                </strong>{" "}
                Para manter a ficha, desfaça antes a ligação com a equipe, na página do cliente.
              </>
            ) : null}
          </>
        }
        confirmLabel="Remover"
        pending={remove.isPending}
        onConfirm={confirmRemoval}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}
