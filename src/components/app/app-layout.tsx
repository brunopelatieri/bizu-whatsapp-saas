import { useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import {
  AppMobileNavFooter,
  AppMobileNavHeader,
  AppSidebar,
} from "@/components/app/app-sidebar";
import { AppNav } from "@/components/app/app-nav";
import { AppTopbar } from "@/components/app/app-topbar";
import { BillingBanner } from "@/components/app/billing-banner";
import { ConsentGate } from "@/components/app/consent-gate";
import { ImpersonationBanner } from "@/components/app/impersonation-banner";
import { TenantSwitcher } from "@/components/app/tenant-switcher";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { appTitleFromPath } from "@/lib/constants/app-nav";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";

const TWO_FACTOR_PATH = "/app/configuracoes/seguranca";

/**
 * Sem tenant, a pessoa vai ao onboarding. É só o caminho da interface: quem barra os
 * dados é `requireTenant`, na API.
 */
export function AppLayout() {
  const { tenant, security, accountLoading, accountError, reloadAccount } =
    useAuth();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { pathname } = useLocation();
  const title = appTitleFromPath(pathname);

  function closeMobileNav() {
    setMobileNavOpen(false);
  }

  if (accountLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  if (accountError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-2 bg-background text-sm">
        <p className="text-destructive">{accountError.message}</p>
        <button
          type="button"
          onClick={() => void reloadAccount()}
          className="font-medium text-primary hover:underline"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (!tenant) return <Navigate to="/app/onboarding" replace />;

  // Só encurta o caminho: é `requireTenant` quem responde 403 `TENANT_2FA_REQUIRED`.
  if (security.tenantRequires2fa && pathname !== TWO_FACTOR_PATH) {
    return <Navigate to={TWO_FACTOR_PATH} replace />;
  }

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <ConsentGate />
      <AppSidebar collapsed={collapsed} />

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[min(100vw-2rem,18rem)] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Menu do dashboard</SheetTitle>
            <SheetDescription>Navegação da área autenticada</SheetDescription>
          </SheetHeader>

          <AppMobileNavHeader />
          <div className="border-b border-border p-3">
            <TenantSwitcher />
          </div>
          <AppNav onNavigate={closeMobileNav} className="min-h-0" />
          <AppMobileNavFooter onNavigate={closeMobileNav} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ImpersonationBanner />
        <AppTopbar
          sidebarCollapsed={collapsed}
          onToggleSidebar={() => setCollapsed((value) => !value)}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          title={title}
        />
        <BillingBanner />
        {/* O atendimento ocupa a altura toda e rola por dentro; as demais telas rolam aqui. */}
        <main
          className={cn(
            "flex-1",
            pathname.startsWith("/app/atendimento")
              ? "min-h-0 overflow-hidden"
              : "overflow-y-auto p-4 sm:p-6",
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default AppLayout;
