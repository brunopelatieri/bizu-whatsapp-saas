import type { MetaFunction } from "react-router";
import { CustomFieldManager } from "@/components/app/crm/custom-field-manager";
import { SettingsNav } from "@/components/app/settings-nav";
import { Can } from "@/components/auth/can";

export const meta: MetaFunction = () => [
  { title: "Campos adicionais — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/** Catálogo de campos adicionais dos clientes. A API só deixa mexer quem tem `custom_field:manage`. */
export default function SettingsFields() {
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">Configurações</h1>
      <SettingsNav />
      <Can
        resource="custom_field"
        action="manage"
        fallback={
          <p className="text-sm text-muted-foreground">
            Você não tem permissão para gerir campos adicionais.
          </p>
        }
      >
        <CustomFieldManager />
      </Can>
    </div>
  );
}
