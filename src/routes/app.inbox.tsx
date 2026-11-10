import type { MetaFunction } from "react-router";
import { InboxPage } from "@/pages/inbox-page";

export const meta: MetaFunction = () => [
  { title: "Atendimento — Bizu SaaS" },
  { name: "robots", content: "noindex" },
];

/** `/app/atendimento` e `/app/atendimento/:conversationId`: client-only, sem loader. */
export default function Route() {
  return <InboxPage />;
}
