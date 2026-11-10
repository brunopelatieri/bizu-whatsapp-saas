import type { MetaFunction } from "react-router";
import { SettingsNav } from "@/components/app/settings-nav";
import { Can, useCan } from "@/components/auth/can";
import { ChannelManager } from "@/components/channels/channel-manager";

export const meta: MetaFunction = () => [
  { title: "Canais — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/** Números de WhatsApp do tenant. Ler pede `channel:read`; mudar, `channel:manage` (a API decide). */
export default function SettingsChannels() {
  const can = useCan();

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight text-foreground">Configurações</h1>
      <SettingsNav />
      <Can
        resource="channel"
        action="read"
        fallback={
          <p className="text-sm text-muted-foreground">
            Você não tem permissão para ver os números de WhatsApp.
          </p>
        }
      >
        <ChannelManager canManage={can("channel", "manage")} />
      </Can>
    </div>
  );
}
