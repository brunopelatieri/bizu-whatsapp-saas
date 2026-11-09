import type { LucideIcon } from "lucide-react";
import {
  CreditCard,
  LayoutDashboard,
  ScrollText,
  Settings,
  UserCog,
  Users,
} from "lucide-react";
import type { Permission } from "@/lib/auth/permissions";

export type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Sem permissão, o item some do menu. A rota da API recusa por conta própria. */
  permission?: Permission;
};

/** Navegação da área do tenant (`/app/**`). */
export const appMainNav: AppNavItem[] = [
  { href: "/app", label: "Visão geral", icon: LayoutDashboard, end: true },
  {
    href: "/app/clientes",
    label: "Clientes",
    icon: Users,
    permission: "customer:read",
  },
  { href: "/app/equipe", label: "Equipe", icon: UserCog },
  {
    href: "/app/assinatura",
    label: "Assinatura",
    icon: CreditCard,
    permission: "billing:read",
  },
  {
    href: "/app/auditoria",
    label: "Auditoria",
    icon: ScrollText,
    permission: "audit:read",
  },
];

export const appBottomNav: AppNavItem[] = [
  { href: "/app/configuracoes", label: "Configurações", icon: Settings },
];

export const appTitles: Record<string, string> = {
  "/app": "Visão geral",
  "/app/clientes": "Clientes",
  "/app/equipe": "Equipe",
  "/app/assinatura": "Assinatura",
  "/app/assinatura/faturas": "Faturas",
  "/app/assinatura/retorno": "Pagamento",
  "/app/auditoria": "Auditoria",
  "/app/configuracoes": "Configurações",
  "/app/configuracoes/seguranca": "Segurança",
  "/app/configuracoes/sessoes": "Sessões",
  "/app/configuracoes/etiquetas": "Etiquetas",
  "/app/configuracoes/campos": "Campos adicionais",
  "/app/configuracoes/canais": "Canais",
  "/app/configuracoes/suporte": "Acesso do suporte",
};

export function appTitleFromPath(pathname: string): string {
  if (pathname.startsWith("/app/clientes/")) return "Cliente";

  return appTitles[pathname] ?? "Visão geral";
}
