import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { useIsPlatformOwner } from "@/components/admin/admin-api";
import { PageTitle } from "@/components/admin/query-state";
import { CustomFieldManager } from "@/components/app/crm/custom-field-manager";
import { platformFieldsApi } from "@/components/crm/custom-fields-api";

export const meta: MetaFunction = () => [
  { title: "Campos das organizações — Administração — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/**
 * Catálogo de campos adicionais da plataforma (`/api/admin/crm/custom-fields`, entidade
 * `organization`). Só `platform_owner` escreve; o suporte lê. O proprietário da organização
 * nunca vê estes campos.
 */
export default function AdminCrmFields() {
  const owner = useIsPlatformOwner();

  return (
    <div className="max-w-2xl space-y-6">
      <Link
        to="/admin/configuracoes"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Configurações
      </Link>
      <PageTitle
        title="Campos das organizações"
        description="Campos que a plataforma preenche no cartão de cada organização. Só a plataforma os vê."
      />
      <CustomFieldManager api={platformFieldsApi} readOnly={!owner} />
    </div>
  );
}
