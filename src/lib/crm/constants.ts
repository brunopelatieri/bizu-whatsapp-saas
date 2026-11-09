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

/** Campos adicionais ativos por entidade e escopo; arquivado não conta. */
export const CUSTOM_FIELD_LIMIT = 12;

/** Opções de um campo de lista (`select` e `multiselect`). */
export const CUSTOM_FIELD_OPTION_LIMIT = 50;

export const CUSTOM_FIELD_LABEL_MAX = 60;
export const CUSTOM_FIELD_KEY_MAX = 40;

/** Tamanho máximo do valor de texto e de uma lista `multiselect`. */
export const CUSTOM_FIELD_TEXT_MAX = 500;
export const CUSTOM_FIELD_MULTISELECT_MAX = 20;

export const customFieldTypes = [
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "multiselect",
] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];

/** Tipos que carregam a lista de opções. */
export const listFieldTypes: readonly CustomFieldType[] = ["select", "multiselect"];

/** `customer` é do tenant; `organization` é da plataforma (fase A4). */
export const customFieldEntities = ["customer", "organization"] as const;
export type CustomFieldEntity = (typeof customFieldEntities)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Texto",
  number: "Número",
  date: "Data",
  boolean: "Sim ou não",
  select: "Lista (uma opção)",
  multiselect: "Lista (várias opções)",
};
