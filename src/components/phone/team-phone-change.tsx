import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { PhoneChange } from "@/components/phone/phone-change-api";
import { PhoneChangeSection } from "@/components/phone/phone-change-section";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/providers/auth-provider";

/**
 * A troca do telefone da própria conta da equipe (`POST` e `DELETE /api/me/phone-change`), lida
 * de `GET /api/me/phone-verification` (`change`). Serve ao perfil (`/app/perfil`, `/admin/perfil`)
 * e à tela "Confirme seu WhatsApp": a rota passa pelo bloqueio de telefone, então a conta
 * pendente corrige o número por aqui. Na personificação a API recusa; a tela só não oferece.
 */

export const TEAM_PHONE_KEY = ["phone-verification", "team"] as const;

type TeamPhoneOverview = {
  /** Os 4 últimos dígitos do número atual da conta. */
  phoneHint?: string | null;
  /** O pedido de confirmação do número atual, se há um aberto. */
  pending?: { status: "sent" | "awaiting_manual"; phoneHint: string | null } | null;
  change?: PhoneChange | null;
};

export function useTeamPhoneOverview() {
  return useQuery({
    queryKey: TEAM_PHONE_KEY,
    queryFn: () => apiFetch<TeamPhoneOverview>("/api/me/phone-verification"),
    retry: false,
  });
}

export function TeamPhoneChange({ onChanged }: { onChanged?: () => Promise<void> }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const overview = useTeamPhoneOverview();

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: TEAM_PHONE_KEY });
    await onChanged?.();
  };

  if (overview.isPending) {
    return (
      <div className="flex justify-center py-4">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (overview.error) {
    return (
      <div className="grid gap-2 text-sm">
        <p className="text-destructive">{overview.error.message}</p>
        <Button type="button" variant="outline" className="w-fit" onClick={() => void overview.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const data = overview.data;
  const hint = data.phoneHint;

  return (
    <PhoneChangeSection
      audience="team"
      current={
        hint ? `WhatsApp terminado em ${hint}${data.pending ? " (ainda não confirmado)" : ""}` : "não informado"
      }
      change={data.change ?? null}
      disabled={Boolean(user?.impersonatedBy)}
      disabledReason="Durante o acesso de suporte não é possível trocar o telefone."
      onRequest={async (phone) => {
        await apiFetch("/api/me/phone-change", { method: "POST", body: JSON.stringify({ phone }) });
        await reload();
      }}
      onCancel={async () => {
        await apiFetch("/api/me/phone-change", { method: "DELETE" });
        await reload();
      }}
      onResend={async () => {
        await apiFetch("/api/me/phone-verification/resend", {
          method: "POST",
          body: JSON.stringify({ purpose: "change" }),
        });
        await reload();
      }}
    />
  );
}
