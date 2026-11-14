import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Customer, useCustomerMutation } from "@/components/app/customers/customers-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api/client";
import { roleLabel } from "@/lib/auth/permissions";
import { useAuth } from "@/providers/auth-provider";

/**
 * Ligar a ficha de cliente a uma pessoa da equipe, à mão (SPEC `pre-producao`, "Equipe que também é
 * cliente", D-9): `PUT /api/customers/:id/team-link`, com a lista de
 * `GET /api/customers/:id/team-candidates` (só quem pode ser ligado, isto é, quem tem o WhatsApp
 * confirmado; id, nome, papel e se já tem ficha; nada de e-mail ou telefone). O diálogo diz, antes de confirmar, o que a ligação muda (D-11). Quem decide é a API:
 * ela recusa ligar a si mesmo, a pessoa que já tem ficha e a ficha já ligada.
 */

type Candidate = { userId: string; name: string; role: string; hasCustomer: boolean };

function useTeamCandidates(customerId: string, enabled: boolean) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: ["customers", tenant?.id, "team-candidates", customerId],
    queryFn: () =>
      apiFetch<{ candidates: Candidate[] }>(`/api/customers/${customerId}/team-candidates`),
    enabled: enabled && Boolean(tenant),
    retry: false,
  });
}

export function TeamLinkDialog({
  customer,
  open,
  onClose,
}: {
  customer: Customer;
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const candidates = useTeamCandidates(customer.id, open);
  const [chosen, setChosen] = useState<string | null>(null);
  const link = useCustomerMutation("Ficha ligada à pessoa da equipe.");
  const picked = candidates.data?.candidates.find(({ userId }) => userId === chosen) ?? null;

  function close() {
    setChosen(null);
    onClose();
  }

  function confirm() {
    if (!chosen) return;
    link.mutate(
      { path: `/api/customers/${customer.id}/team-link`, method: "PUT", body: { userId: chosen } },
      {
        onSuccess: () => {
          // O aviso da remoção de membros (`/app/equipe`) vem da lista da equipe.
          void queryClient.invalidateQueries({ queryKey: ["team"] });
          close();
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ligar a uma pessoa da equipe</DialogTitle>
          <DialogDescription>
            Use quando {customer.name} é alguém da equipe desta organização (por exemplo, com o mesmo
            e-mail). A ficha passa a mostrar o papel da pessoa.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <strong>
              Se a pessoa for removida da equipe ou excluir a própria conta, esta ficha é apagada, sem
              volta, com as conversas de WhatsApp do telefone confirmado dela.
            </strong>{" "}
            Conversas de outros números ligadas à ficha só perdem o vínculo e ficam com a organização.
            Para manter a ficha nesse caso, desfaça a ligação antes de remover a pessoa.
          </p>

          {candidates.isPending ? (
            <p className="text-muted-foreground">Carregando a equipe…</p>
          ) : candidates.isError ? (
            <p className="text-destructive">Não foi possível carregar a equipe.</p>
          ) : (
            <fieldset className="space-y-1">
              <legend className="mb-2 font-medium">Pessoa da equipe</legend>
              {candidates.data.candidates.length === 0 ? (
                <p className="text-muted-foreground">
                  Ninguém da equipe pode ser ligado agora: só aparece quem já confirmou o WhatsApp.
                </p>
              ) : null}
              {candidates.data.candidates.map((person) => {
                const self = person.userId === user?.id;
                const disabled = self || person.hasCustomer;
                return (
                  <label
                    key={person.userId}
                    className={`flex items-center gap-3 rounded-md border p-2 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-muted"}`}
                  >
                    <input
                      type="radio"
                      name="team-link-person"
                      value={person.userId}
                      disabled={disabled}
                      checked={chosen === person.userId}
                      onChange={() => setChosen(person.userId)}
                    />
                    <span className="min-w-0 flex-1 truncate">{person.name}</span>
                    <Badge variant="secondary">{roleLabel(person.role)}</Badge>
                    {self ? (
                      <span className="text-xs text-muted-foreground">você</span>
                    ) : person.hasCustomer ? (
                      <span className="text-xs text-muted-foreground">já tem ficha</span>
                    ) : null}
                  </label>
                );
              })}
              <p className="pt-1 text-xs text-muted-foreground">
                Só aparece quem já confirmou o WhatsApp. Ninguém liga a ficha à própria conta: peça
                a outra pessoa da equipe.
              </p>
            </fieldset>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancelar
          </Button>
          <Button disabled={!picked || link.isPending} onClick={confirm}>
            {picked ? `Ligar a ${picked.name}` : "Ligar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
