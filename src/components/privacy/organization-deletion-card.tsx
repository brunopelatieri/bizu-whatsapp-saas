import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "react-router";
import { Can } from "@/components/auth/can";
import { CHANNEL_KINDS } from "@/components/channels/channel-kinds";
import { useChannels } from "@/components/channels/channels-api";
import { type IdentityValues, IdentityDialog } from "@/components/privacy/identity-dialog";
import { useDeletionStatus } from "@/components/privacy/account-deletion-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/providers/auth-provider";

const formatDate = (iso: string) => new Date(iso).toLocaleDateString("pt-BR");

/**
 * P6: excluir a organização **não** desconecta os números de WhatsApp (as credenciais cifradas e a
 * instância ou o número no provedor continuam). O cartão lista os que ainda estão ativos e pede a
 * remoção antes; o pedido não é bloqueado.
 */
function ActiveChannelsNotice() {
  const channels = useChannels();
  const all = channels.data?.channels ?? [];
  const active = all.filter(({ status }) => status !== "disabled");
  const disabled = all.length - active.length;

  // Sem `channel:read` (papel personalizado com `organization:delete`) a lista não vem: o aviso
  // genérico segue, só sem os números, para a exclusão nunca parecer livre de números conectados.
  if (channels.isError) {
    return (
      <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-foreground">
        <strong>Remova os números de WhatsApp antes de excluir.</strong> A exclusão da organização não
        desconecta os números: as credenciais ficam guardadas e a conexão continua no provedor.
      </p>
    );
  }

  if (all.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-foreground">
      <p>
        <strong>Remova os números de WhatsApp antes de excluir.</strong> A exclusão da organização não
        desconecta os números: as credenciais ficam guardadas, cifradas, e a conexão continua no
        provedor até você removê-los.
      </p>
      {active.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5">
          {active.map((item) => (
            <li key={item.id}>
              {item.name}
              <span className="text-muted-foreground">
                {" "}
                · {CHANNEL_KINDS[item.type].label}
                {item.identifier ? ` · ${item.identifier}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {disabled > 0 ? (
        <p className="text-muted-foreground">
          {disabled === 1 ? "Há também 1 número desativado" : `Há também ${disabled} números desativados`},
          que também continua cadastrado.
        </p>
      ) : null}
      <Link to="/app/configuracoes/canais" className="inline-block underline underline-offset-4">
        Abrir os canais de WhatsApp
      </Link>
    </div>
  );
}

/**
 * Excluir a organização inteira (só o proprietário). Encerra a cobrança, bloqueia o acesso da
 * equipe e anonimiza tudo em 30 dias. Quem está agendado aparece com o botão de desistir, fora do
 * `<Can>`: organização em exclusão não tem permissões, e quem decide é a API.
 */
export function OrganizationDeletionCard() {
  const { user, tenant, tenants, reloadAccount } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const status = useDeletionStatus("/api/me/deletion");

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["privacy", "deletion"] });
    await reloadAccount();
  };

  const remove = useMutation({
    mutationFn: (values: IdentityValues) =>
      apiFetch("/api/tenant", { method: "DELETE", body: JSON.stringify(values) }),
    onSuccess: async () => {
      setOpen(false);
      toast.success("Exclusão da organização agendada.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const cancel = useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch("/api/tenant/deletion/cancel", {
        method: "POST",
        body: JSON.stringify({ tenantId }),
      }),
    onSuccess: async () => {
      toast.success("Exclusão da organização cancelada.");
      await refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const pending = status.data?.tenants ?? [];

  if (!tenant && pending.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Excluir a organização</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {pending.map(({ tenantId, scheduledFor, origin }) => (
          <div
            key={tenantId}
            className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3"
          >
            <p className="text-foreground">
              <strong>{tenants.find(({ id }) => id === tenantId)?.name ?? "A organização"}</strong>{" "}
              será excluída em <strong>{formatDate(scheduledFor)}</strong>. O acesso da equipe já
              está bloqueado.
            </p>
            {origin === "platform" ? (
              <p className="text-muted-foreground">
                A exclusão foi pedida pela administração da plataforma: fale com ela para desistir.
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(tenantId)}
              >
                Cancelar exclusão
              </Button>
            )}
          </div>
        ))}

        <Can resource="organization" action="delete">
          <p className="text-muted-foreground">
            Encerra a assinatura, bloqueia a equipe e anonimiza clientes, dados de cobrança e
            arquivos depois de 30 dias. Faturas e auditoria ficam, sem identificar ninguém.
          </p>
          <ActiveChannelsNotice />
          <Button variant="destructive" onClick={() => setOpen(true)}>
            Excluir {tenant?.name ?? "a organização"}
          </Button>

          <IdentityDialog
            open={open}
            title={`Excluir ${tenant?.name ?? "a organização"}?`}
            description="Toda a equipe perde o acesso agora. Confirme com a sua senha; você tem 30 dias para desistir."
            confirmLabel="Excluir organização"
            needsTotp={user?.twoFactorEnabled ?? false}
            pending={remove.isPending}
            onConfirm={(values) => remove.mutate(values)}
            onCancel={() => setOpen(false)}
          />
        </Can>
      </CardContent>
    </Card>
  );
}
