import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { useIsPlatformOwner } from "@/components/admin/admin-api";
import { PageTitle } from "@/components/admin/query-state";
import { TagManager } from "@/components/app/crm/tag-manager";
import { platformTagsApi } from "@/components/crm/tags-api";

export const meta: MetaFunction = () => [
  { title: "Etiquetas das organizações — Administração — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/**
 * Catálogo de etiquetas da plataforma (`/api/admin/crm/tags`). Só `platform_owner` escreve; o
 * suporte lê. O proprietário da organização nunca vê estas etiquetas.
 */
export default function AdminCrmTags() {
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
        title="Etiquetas das organizações"
        description="Servem para classificar organizações em /admin. Só a plataforma as vê."
      />
      <TagManager api={platformTagsApi} readOnly={!owner} />
    </div>
  );
}
