import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { PhoneChange } from "@/components/phone/phone-change-api";
import { PhoneChangeSection } from "@/components/phone/phone-change-section";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";

/**
 * A troca do telefone do próprio cliente (`POST` e `DELETE /api/portal/me/phone-change`, ficha da
 * organização ativa), lida de `GET /api/portal/me/phone-verification` (`change` de cada ficha).
 * Serve a `/portal/conta` e à tela "Confirme seu WhatsApp" do portal, onde a conta pendente corrige
 * o número. Sem `activeTenantId` (a tela de confirmação não lê `/api/portal/me`), vale a primeira
 * ficha que tem troca aberta.
 */

type PortalPhoneOverview = {
  responsibles: Array<{ tenantId: string | null; change?: PhoneChange | null }>;
};

export const PORTAL_PHONE_KEY = ["phone-verification", "portal"] as const;

export function PortalPhoneChange({
  current,
  activeTenantId,
  onChanged,
}: {
  /** O número atual, como o portal o mostra. */
  current: string;
  activeTenantId?: string | null;
  onChanged?: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const overview = useQuery({
    queryKey: PORTAL_PHONE_KEY,
    queryFn: () => apiFetch<PortalPhoneOverview>("/api/portal/me/phone-verification"),
    retry: false,
  });

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: PORTAL_PHONE_KEY });
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

  const rows = overview.data.responsibles;
  const row = activeTenantId
    ? rows.find((item) => item.tenantId === activeTenantId)
    : rows.find((item) => item.change);
  const change = row?.change ?? null;

  return (
    <PhoneChangeSection
      audience="portal"
      current={current}
      change={change}
      onRequest={async (phone) => {
        await apiFetch("/api/portal/me/phone-change", {
          method: "POST",
          body: JSON.stringify({ phone }),
        });
        await reload();
      }}
      onCancel={async () => {
        await apiFetch("/api/portal/me/phone-change", { method: "DELETE" });
        await reload();
      }}
      onResend={async () => {
        await apiFetch("/api/portal/me/phone-verification/resend", {
          method: "POST",
          body: JSON.stringify({ tenantId: change?.tenantId ?? undefined, purpose: "change" }),
        });
        await reload();
      }}
    />
  );
}
