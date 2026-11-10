import type { MetaFunction } from "react-router";
import { InboxPage } from "@/pages/inbox-page";

export const meta: MetaFunction = () => [
  { title: "Atendimento — Administração — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/**
 * `/admin/atendimento` e `/admin/atendimento/:conversationId`: o atendimento da plataforma, com os
 * mesmos componentes da tela do tenant em `mode="platform"` (sem fila nem abas). Client-only, sem
 * loader; o gate de papel é do `AdminLayout` e da API (`requirePlatform`).
 */
export default function AdminInbox() {
  return <InboxPage mode="platform" />;
}
