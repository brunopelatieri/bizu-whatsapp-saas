import { NavLink } from "react-router";
import { useCan } from "@/components/auth/can";
import { cn } from "@/lib/utils";

/** Abas de `/app/configuracoes`. Suporte é do owner: a API recusa os demais. */
export function SettingsNav() {
  const can = useCan();

  const items = [
    { to: "/app/configuracoes", label: "Geral", end: true, show: true },
    { to: "/app/configuracoes/seguranca", label: "Segurança", show: true },
    { to: "/app/configuracoes/sessoes", label: "Sessões", show: true },
    { to: "/app/configuracoes/etiquetas", label: "Etiquetas", show: can("tag", "manage") },
    { to: "/app/configuracoes/privacidade", label: "Privacidade", show: true },
    {
      to: "/app/configuracoes/suporte",
      label: "Suporte",
      show: can("support", "grant"),
    },
  ];

  return (
    <nav aria-label="Configurações" className="flex flex-wrap gap-1 border-b border-border">
      {items
        .filter(({ show }) => show)
        .map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "-mb-px border-b-2 px-3 py-2 text-sm",
                isActive
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )
            }
          >
            {label}
          </NavLink>
        ))}
    </nav>
  );
}
