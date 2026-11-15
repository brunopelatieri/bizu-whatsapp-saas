import type { MetaFunction } from "react-router";
import { PortalVerifyPhonePage } from "@/pages/verify-phone-page";

export const meta: MetaFunction = () => [
  { title: "Confirmar WhatsApp — Bizu SaaS" },
  { name: "robots", content: "noindex" },
  // O token está na URL: nenhum recurso de fora recebe a página como origem.
  { name: "referrer", content: "no-referrer" },
];

// Sem `loader` nem `action`: abrir o link nunca consome o token. O botão faz o POST.
export default function Route() {
  return <PortalVerifyPhonePage />;
}
