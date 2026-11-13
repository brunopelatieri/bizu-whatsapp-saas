import { useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { AppNav } from "@/components/app/app-nav";
import {
  AppMobileNavFooter,
  AppMobileNavHeader,
  AppSidebar,
} from "@/components/app/app-sidebar";
import { AppTopbar } from "@/components/app/app-topbar";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  adminBottomNav,
  adminMainNav,
  adminTitleFromPath,
} from "@/lib/constants/admin-nav";
import { ConsentGate } from "@/components/app/consent-gate";
import { InboxEvents } from "@/components/inbox/use-inbox-events";
import { TeamPhonePendingBanner } from "@/components/phone/phone-verification-panel";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";

const NAV = { main: adminMainNav, bottom: adminBottomNav };
const TWO_FACTOR_PATH = "/admin/configuracoes/seguranca";

/**
 * Casca de `/admin`, a mesma de `/app` com outro menu. O gate é só o caminho da
 * interface: quem barra os dados é `requirePlatform`, em toda rota de `/api/admin/*`.
 */
export function AdminLayout() {
  const { user, loading, security } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { pathname } = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  if (!user || user.platformRole === "user") {
    return <Navigate to="/app" replace />;
  }

  // Só encurta o caminho: é `requirePlatform` quem responde 403 `PLATFORM_2FA_REQUIRED`.
  if (security.platformRequires2fa && pathname !== TWO_FACTOR_PATH) {
    return <Navigate to={TWO_FACTOR_PATH} replace />;
  }

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      <ConsentGate />
      {/* Tempo real do atendimento da plataforma: o ponto do menu anda em qualquer tela do /admin. */}
      <InboxEvents mode="platform" />
      <AppSidebar
        collapsed={collapsed}
        nav={NAV}
        header={
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {collapsed ? "Adm" : "Plataforma"}
          </p>
        }
      />

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[min(100vw-2rem,18rem)] p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Menu da plataforma</SheetTitle>
            <SheetDescription>Navegação da administração</SheetDescription>
          </SheetHeader>

          <AppMobileNavHeader />
          <AppNav
            main={NAV.main}
            bottom={NAV.bottom}
            onNavigate={() => setMobileNavOpen(false)}
            className="min-h-0"
          />
          <AppMobileNavFooter onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppTopbar
          sidebarCollapsed={collapsed}
          onToggleSidebar={() => setCollapsed((value) => !value)}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          title={adminTitleFromPath(pathname)}
          subtitle="Administração da plataforma"
        />
        <TeamPhonePendingBanner />
        {/* O atendimento ocupa a altura toda e rola por dentro; as demais telas rolam aqui. */}
        <main
          className={cn(
            "flex-1",
            pathname.startsWith("/admin/atendimento")
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

export default AdminLayout;
