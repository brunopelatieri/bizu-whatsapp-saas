import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { QueryState } from "@/components/admin/query-state";
import { type IdentityValues, IdentityDialog } from "@/components/privacy/identity-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api/client";
import { accountRecordsWarning } from "@/lib/format/conversations";

export type DeletionStatus = {
  account: string | null;
  tenants: Array<{ tenantId: string; scheduledFor: string; origin?: "self" | "platform" }>;
  /** Portal: a conta tem senha (senão o pedido é confirmado por e-mail). Ausente na equipe. */
  needsPassword?: boolean;
  /**
   * Equipe (D-11): fichas de cliente ligadas à pessoa, em todas as organizações, que a exclusão da
   * conta apaga com as `conversationCount` conversas de WhatsApp do número dela.
   */
  customerRecords?: { customers: number; conversationCount: number };
};

const formatDate = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

export function useDeletionStatus(statusUrl: string) {
  return useQuery({
    queryKey: ["privacy", "deletion", statusUrl],
    queryFn: () => apiFetch<DeletionStatus>(statusUrl),
    retry: false,
  });
}

/**
 * Excluir a própria conta, com carência de 30 dias para desistir. A senha (e o código do 2FA)
 * são conferidos pelo servidor, que também recusa o último proprietário de uma organização.
 * `deleteUrl` é `/api/me` na equipe e `/api/portal/me` no portal; no portal, quem não tem
 * senha recebe um link de confirmação por e-mail (`202`).
 */
export function AccountDeletionCard({
  statusUrl,
  deleteUrl,
  cancelUrl,
  needsTotp = false,
  needsPassword = true,
}: {
  statusUrl: string;
  deleteUrl: string;
  cancelUrl: string;
  needsTotp?: boolean;
  needsPassword?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const query = useDeletionStatus(statusUrl);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["privacy", "deletion"] });

  const remove = useMutation({
    mutationFn: (values: IdentityValues) =>
      apiFetch<{ scheduledFor?: string; confirmationSent?: boolean }>(deleteUrl, {
        method: "DELETE",
        body: JSON.stringify(values),
      }),
    onSuccess: async (result) => {
      setOpen(false);
      toast.success(
        result.confirmationSent
          ? "Enviamos um e-mail com o link para confirmar a exclusão."
          : "Exclusão agendada. Você pode desistir até a data prevista.",
      );
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const cancel = useMutation({
    mutationFn: () => apiFetch(cancelUrl, { method: "POST" }),
    onSuccess: async () => {
      toast.success("Exclusão cancelada.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const scheduled = query.data?.account ?? null;
  // O servidor sabe se a conta tem senha; a prop é o que a tela já sabia (`/api/portal/me`).
  const askPassword = query.data?.needsPassword ?? needsPassword;
  const recordsWarning = accountRecordsWarning(query.data?.customerRecords);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Excluir minha conta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <QueryState {...query}>
          {scheduled ? (
            <>
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-foreground">
                Sua conta será excluída em <strong>{formatDate(scheduled)}</strong>. Até lá você
                pode desistir.
              </p>
              <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancelar exclusão
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                Seus dados pessoais são anonimizados depois de 30 dias, e você pode desistir nesse
                prazo. Faturas e registros de auditoria são mantidos sem identificar você. Quem é o
                único proprietário de uma organização precisa transferi-la ou excluí-la antes.
              </p>
              {recordsWarning ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-foreground">
                  {recordsWarning}
                </p>
              ) : null}
              <Button variant="destructive" onClick={() => setOpen(true)}>
                Excluir minha conta
              </Button>
            </>
          )}
        </QueryState>

        <IdentityDialog
          open={open}
          title="Excluir sua conta?"
          description={
            <>
              {askPassword
                ? "Confirme com a sua senha. A exclusão acontece em 30 dias, e até lá você pode cancelar."
                : "Enviaremos um e-mail para confirmar que foi você. A exclusão acontece 30 dias depois da confirmação."}
              {recordsWarning ? <strong> {recordsWarning}</strong> : null}
            </>
          }
          confirmLabel="Excluir conta"
          needsTotp={needsTotp}
          needsPassword={askPassword}
          pending={remove.isPending}
          onConfirm={(values) => remove.mutate(values)}
          onCancel={() => setOpen(false)}
        />
      </CardContent>
    </Card>
  );
}
