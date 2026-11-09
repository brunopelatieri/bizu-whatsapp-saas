import type { MetaFunction } from "react-router";
import { TagManager } from "@/components/app/crm/tag-manager";
import { SettingsNav } from "@/components/app/settings-nav";
import { Can } from "@/components/auth/can";

export const meta: MetaFunction = () => [
  { title: "Etiquetas — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/** Catálogo de etiquetas dos clientes. A API só deixa mexer quem tem `tag:manage`. */
export default function SettingsTags() {
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">Configurações</h1>
      <SettingsNav />
      <Can
        resource="tag"
        action="manage"
        fallback={
          <p className="text-sm text-muted-foreground">
            Você não tem permissão para gerir etiquetas.
          </p>
        }
      >
        <TagManager />
      </Can>
    </div>
  );
}
