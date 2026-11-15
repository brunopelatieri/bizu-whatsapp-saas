import { ApiError } from "@/lib/api/client";

/**
 * Troca de telefone pelo pedido (SPEC `pre-producao`, "Troca de telefone pelo pedido"). A tela só
 * consome as rotas que existem: `…/phone-change` (POST pede, DELETE desiste) e a leitura `change`
 * de `GET …/phone-verification` e de `GET /api/customers/:id`. O cadastro mantém o número antigo
 * até o novo ser confirmado pelo link ou liberado pelo responsável.
 */

/** A troca aberta do cadastro, como o servidor a devolve (`changeView`). */
export type PhoneChange = {
  /** `sent`: o link saiu para o número novo. `awaiting_manual`: ninguém conseguiu enviar; espera a liberação. */
  status: "sent" | "awaiting_manual";
  /** Os 4 últimos dígitos do número NOVO. */
  phoneHint: string | null;
  responsible: "platform" | "organization";
  tenantId: string | null;
  tenantName: string | null;
  requestedAt: string;
};

/** Quem responde pela troca, em texto: "do proprietário da plataforma" ou "de quem administra X". */
export function responsibleText(change: Pick<PhoneChange, "responsible" | "tenantName">) {
  return change.responsible === "platform"
    ? "do proprietário da plataforma"
    : `de quem administra ${change.tenantName ?? "a organização"}`;
}

/** Uma mensagem para cada recusa do pedido; o resto vem da API. */
export function phoneChangeErrorMessage(error: unknown, fallback = "Não foi possível pedir a troca.") {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : fallback;
  }

  switch (error.code) {
    case "PHONE_UNCHANGED":
      return "Este já é o número do cadastro. Informe o número novo.";
    case "PHONE_VERIFICATION_LIMIT":
      return "Já pedimos o máximo de links nesta hora. Tente mais tarde.";
    case "IMPERSONATION_BLOCKED":
      return "Durante o acesso de suporte não é possível trocar o telefone.";
    default:
      if (error.status === 429) return "Muitos pedidos de troca nesta hora. Tente mais tarde.";
      return error.message;
  }
}

export function formatRequestedAt(value: string) {
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}
