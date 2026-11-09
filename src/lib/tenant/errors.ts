import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Regra de negócio recusada. A API responde `{ error, code }` com este status e, se houver,
 * os campos de `details` na raiz (ex.: `{ tenants: [{ id, name }] }` em `LAST_OWNER`).
 */
export class TenantRuleError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TenantRuleError";
  }
}

export const ROLE_IN_USE = new TenantRuleError(
  409,
  "ROLE_IN_USE",
  "Este papel está em uso por membros ou convites pendentes.",
);

export const notFound = (message: string) =>
  new TenantRuleError(404, "NOT_FOUND", message);

/** Telefone já usado por outro cliente do tenant (inclui a variante com ou sem o 9º dígito). */
export const phoneInUse = (details?: { customerId: string; name?: string }) =>
  new TenantRuleError(409, "PHONE_IN_USE", "Já existe um cliente com este telefone.", details);
