import { TriangleAlert } from "lucide-react";
import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { useIsPlatformOwner } from "@/components/admin/admin-api";
import { PageTitle } from "@/components/admin/query-state";
import { CHANNEL_KINDS } from "@/components/channels/channel-kinds";
import { ChannelManager } from "@/components/channels/channel-manager";
import { PLATFORM_CHANNELS_PATH, useChannels } from "@/components/channels/channels-api";
import { channelTypes } from "@/lib/channels/types";

export const meta: MetaFunction = () => [
  { title: "Canais da plataforma — Administração — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/**
 * O que falta no `.env` do servidor para cada tipo de número funcionar. A API manda só o nome
 * das variáveis (`providers[tipo].missing`), nunca o valor.
 */
function MissingSetup() {
  const { data } = useChannels(PLATFORM_CHANNELS_PATH);
  const pending = channelTypes
    .map((type) => ({ type, missing: data?.providers[type]?.missing ?? [] }))
    .filter((item) => item.missing.length > 0);

  if (pending.length === 0) return null;

  return (
    <section
      aria-labelledby="channels-setup"
      className="space-y-2 rounded-lg border border-border bg-muted/40 p-4 text-sm"
    >
      <h2 id="channels-setup" className="flex items-center gap-2 font-medium text-foreground">
        <TriangleAlert className="size-4 text-muted-foreground" aria-hidden />
        Configuração pendente no servidor
      </h2>
      <ul className="space-y-1 text-muted-foreground">
        {pending.map(({ type, missing }) => (
          <li key={type}>
            <span className="text-foreground">{CHANNEL_KINDS[type].label}:</span> falta{" "}
            {missing.map((name, index) => (
              <span key={name}>
                {index > 0 ? ", " : ""}
                <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
                  {name === "CHANNEL_PROVIDERS" ? `CHANNEL_PROVIDERS (incluir ${type})` : name}
                </code>
              </span>
            ))}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        As variáveis ficam no <code>.env</code> do servidor; depois de mudar, reinicie a aplicação.
      </p>
    </section>
  );
}

/**
 * Números de WhatsApp da plataforma (`/api/admin/channels`), com os mesmos componentes da tela
 * do tenant. Só `platform_owner` conecta, altera e remove; o suporte lê. A API decide.
 */
export default function AdminChannels() {
  const owner = useIsPlatformOwner();

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/admin/configuracoes"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← Configurações
      </Link>
      <PageTitle
        title="Canais da plataforma"
        description="Números de WhatsApp da própria plataforma. Os números de cada organização ficam na área dela."
      />
      <MissingSetup />
      <ChannelManager basePath={PLATFORM_CHANNELS_PATH} canManage={owner} />
      {owner ? null : (
        <p className="text-sm text-muted-foreground">
          Seu papel é de suporte: você vê os números, mas só o proprietário da plataforma altera.
        </p>
      )}
    </div>
  );
}
