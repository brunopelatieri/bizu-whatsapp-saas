import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { toast } from "sonner";
import { AuthShell, AuthSpinner } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { usePortalAuth } from "@/providers/portal-auth-provider";

/** Cliente de mais de um tenant escolhe onde entrar. O tenant fica só na sessão. */
export function PortalChoosePage() {
  const navigate = useNavigate();
  const { user, tenants, loading, switchTenant, phoneBlocked } = usePortalAuth();
  const [pending, setPending] = useState<string | null>(null);

  if (loading) return <AuthSpinner />;
  // A tela de confirmação, em `/portal`, também troca a organização em uso.
  if (phoneBlocked) return <Navigate to="/portal" replace />;
  if (!user) return <Navigate to="/portal/login" replace />;

  const available = tenants.filter((tenant) => tenant.available);

  // Sem o que escolher, `PortalLayout` decide: entra no único ou mostra o aviso.
  if (available.length < 2) return <Navigate to="/portal" replace />;

  async function choose(tenantId: string) {
    setPending(tenantId);

    try {
      await switchTenant(tenantId);
      navigate("/portal", { replace: true });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Não foi possível entrar.",
      );
      setPending(null);
    }
  }

  return (
    <AuthShell title="Portal do cliente" subtitle="Escolha onde entrar">
      <div className="grid gap-3">
        {available.map((tenant) => (
          <Button
            key={tenant.id}
            type="button"
            variant="outline"
            size="lg"
            className="h-11 w-full"
            disabled={pending !== null}
            onClick={() => void choose(tenant.id)}
          >
            {tenant.name}
          </Button>
        ))}
      </div>
    </AuthShell>
  );
}
