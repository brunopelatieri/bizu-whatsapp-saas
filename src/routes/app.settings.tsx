import { Link, type MetaFunction } from "react-router";
import { OrganizationCard } from "@/components/app/organization-card";
import { RolesCard } from "@/components/app/roles-card";
import { SettingsNav } from "@/components/app/settings-nav";
import { Can } from "@/components/auth/can";

export const meta: MetaFunction = () => [
  { title: "Configurações — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

export default function Settings() {
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">
        Configurações
      </h1>
      <SettingsNav />
      <OrganizationCard />
      <Can resource="role" action="create">
        <RolesCard />
      </Can>
      <p className="text-sm text-muted-foreground">
        Foto, nome, e-mail, telefone e senha da sua conta ficam em{" "}
        <Link to="/app/perfil" className="font-medium text-primary hover:underline">
          Perfil
        </Link>
        .
      </p>
    </div>
  );
}
