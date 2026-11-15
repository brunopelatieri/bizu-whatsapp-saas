/**
 * Sem dependência de servidor: o schema do Drizzle, os schemas Zod e a interface importam
 * daqui. No schema, importe por caminho relativo: o Drizzle Kit não conhece o alias `@/`.
 */
/** A resposta de ficha que não existe nesta organização (404). */
export const CUSTOMER_NOT_FOUND = "Cliente não encontrado.";

export const customerStatuses = ["lead", "active", "blocked"] as const;
export type CustomerStatus = (typeof customerStatuses)[number];

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = {
  lead: "Lead",
  active: "Ativo",
  blocked: "Bloqueado",
};
