/** Tetos e padrões do cadastro CRM (`docs/specs/crm-cadastro/spec.md`, "Modelo de dados"). */

/** Etiquetas por escopo (tenant ou plataforma). */
export const TAG_LIMIT = 100;

/** Etiquetas por cliente. */
export const CUSTOMER_TAG_LIMIT = 20;

export const TAG_NAME_MAX = 40;

/** Cor padrão de etiqueta (`#rrggbb`). */
export const DEFAULT_TAG_COLOR = "#3b82f6";

/** Os 8 presets do seletor de cor. */
export const TAG_COLOR_PRESETS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
] as const;
