import { NavLink } from "react-router";
import { useInboxUnread } from "@/components/inbox/inbox-api";
import {
  appBottomNav,
  appMainNav,
  type AppNavItem,
} from "@/lib/constants/app-nav";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";

type AppNavProps = {
  /** Itens do menu. Padrão: navegação de `/app`. `/admin` passa a sua. */
  main?: AppNavItem[];
  bottom?: AppNavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
  className?: string;
};

function NavItem({
  item,
  collapsed,
  onNavigate,
}: {
  item: AppNavItem;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  // O item de `/admin` lê a contagem da plataforma; o de `/app`, a do tenant.
  const unread = useInboxUnread(item.badge === "inbox", item.href.startsWith("/admin") ? "platform" : "tenant");
  // Ponto: há conversa com mensagem nova na fila ou nas minhas (por polling até a C4).
  const hasUnread = item.badge === "inbox" && (unread.data?.queue ?? 0) + (unread.data?.mine ?? 0) > 0;

  return (
    <NavLink
      to={item.href}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-primary/10 text-primary shadow-[inset_0_0_0_1px_oklch(var(--primary)/0.15)]"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className="size-4" />
        {hasUnread && collapsed ? (
          <span className="absolute -top-1 -right-1 size-2 rounded-full bg-primary" aria-hidden />
        ) : null}
      </span>
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
      {hasUnread ? (
        <>
          {collapsed ? null : <span className="ml-auto size-2 rounded-full bg-primary" aria-hidden />}
          <span className="sr-only">, há mensagens não lidas</span>
        </>
      ) : null}
    </NavLink>
  );
}

export function AppNav({
  main = appMainNav,
  bottom = appBottomNav,
  collapsed = false,
  onNavigate,
  className,
}: AppNavProps) {
  const { permissions } = useAuth();
  const allowed = (item: AppNavItem) =>
    !item.permission || permissions.includes(item.permission);

  return (
    <div className={cn("flex flex-1 flex-col", className)}>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {main.filter(allowed).map((item) => (
          <NavItem
            key={item.href}
            item={item}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="space-y-1 border-t border-border p-3">
        {bottom.filter(allowed).map((item) => (
          <NavItem
            key={item.href}
            item={item}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
}
