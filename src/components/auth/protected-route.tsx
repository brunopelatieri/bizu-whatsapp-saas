import { Navigate, Outlet, useLocation } from "react-router";
import { TeamPhoneGate } from "@/components/phone/phone-verification-panel";
import { useAuth } from "@/providers/auth-provider";

export function ProtectedRoute() {
  const { user, loading, phoneBlocked } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
          <p className="text-sm text-muted-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname)}`}
        replace
      />
    );
  }

  // A API já recusa tudo (403 `PHONE_UNVERIFIED`); a tela só acompanha, em `/app`, `/admin` e
  // no onboarding.
  if (phoneBlocked) return <TeamPhoneGate />;

  return <Outlet />;
}

export default ProtectedRoute;
