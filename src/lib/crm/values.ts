import { z } from "zod";
import { slugify } from "@/lib/schemas/tenant";
import {
  CUSTOM_FIELD_KEY_MAX,
  CUSTOM_FIELD_MULTISELECT_MAX,
  CUSTOM_FIELD_TEXT_MAX,
  type CustomFieldType,
} from "@/lib/crm/constants";

/**
 * Valores dos campos adicionais (`docs/specs/crm-cadastro/spec.md`, "Modelo de dados"). Puro:
 * serve o formulário e a API. Os valores ficam em `{ "<id do campo>": valor }`; `null` (ou
 * vazio) remove o valor.
 */

export type CustomFieldOption = { value: string; label: string };

/** O que a validação precisa de uma definição ativa. */
export type CustomFieldDef = {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  options: CustomFieldOption[];
  required: boolean;
};

export type CustomFieldValue = string | number | boolean | string[];
/** Valores gravados: só campos preenchidos. */
export type CustomFieldValues = Record<string, CustomFieldValue>;
/** Entrada normalizada: `null` quer dizer "remova o valor". */
export type CustomFieldsPatch = Record<string, CustomFieldValue | null>;

const MAX_ABS_NUMBER = 1e15;

/** `Clínica São João` vira `clinica_sao_joao` (até 40, `_` como separador). */
export function slugifyKey(value: string, max = CUSTOM_FIELD_KEY_MAX) {
  // `slugify` (acentos, minúsculas, até 48) já limpa as pontas; aqui só troca o separador.
  return slugify(value).replaceAll("-", "_").slice(0, max).replace(/_+$/, "");
}

/** `AAAA-MM-DD` que existe no calendário (31/02 não passa). */
export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Texto vazio, lista vazia e `null` valem como "sem valor". */
const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

/** Schema do valor de um campo; devolve `null` quando o valor é vazio (remove). */
function valueSchema(def: CustomFieldDef): z.ZodType<CustomFieldValue | null> {
  const allowed = new Set(def.options.map(({ value }) => value));

  const base = (() => {
    switch (def.type) {
      case "text":
        return z
          .string("Informe um texto.")
          .trim()
          .max(CUSTOM_FIELD_TEXT_MAX, `Use até ${CUSTOM_FIELD_TEXT_MAX} caracteres.`);
      case "number":
        return z
          .number("Informe um número.")
          .refine(
            (n) => Number.isFinite(n) && Math.abs(n) <= MAX_ABS_NUMBER,
            "Número fora do limite.",
          );
      case "date":
        return z
          .string("Informe uma data.")
          .refine(isIsoDate, "Use uma data válida (AAAA-MM-DD).");
      case "boolean":
        return z.boolean("Informe sim ou não.");
      case "select":
        return z
          .string("Escolha uma opção.")
          .refine((value) => allowed.has(value), "Opção inválida.");
      case "multiselect":
        return z
          .array(
            z.string().refine((value) => allowed.has(value), "Opção inválida."),
            "Escolha as opções.",
          )
          .max(CUSTOM_FIELD_MULTISELECT_MAX, `Escolha até ${CUSTOM_FIELD_MULTISELECT_MAX} opções.`)
          .transform((list) => [...new Set(list)]);
    }
  })() as z.ZodType<CustomFieldValue>;

  return z.unknown().transform((raw, ctx): CustomFieldValue | null => {
    if (isEmpty(raw)) return null;

    const parsed = base.safeParse(raw);
    if (parsed.success) return parsed.data;

    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", message: issue.message });
    }
    return z.NEVER;
  });
}

/**
 * Zod do bloco `customFields` montado das definições **ativas**: o formulário e a API usam o
 * mesmo. Chave desconhecida (inclusive de campo arquivado) é recusada. Com `requireAll` (o
 * padrão, do formulário completo) o campo `required` precisa vir preenchido; a API valida
 * os obrigatórios sobre o estado final do cadastro (`missingRequired`), então passa `false`.
 */
export function buildCustomFieldsSchema(defs: CustomFieldDef[], { requireAll = true } = {}) {
  const shape: Record<string, z.ZodType<CustomFieldValue | null | undefined>> = {};

  for (const def of defs) {
    const value = valueSchema(def);
    shape[def.id] =
      requireAll && def.required
        ? value.refine((parsed) => parsed !== null, "Campo obrigatório.")
        : value.optional();
  }

  return z.strictObject(shape);
}

/** Rótulos dos campos obrigatórios ainda sem valor no estado final do cadastro. */
export function missingRequired(defs: CustomFieldDef[], values: CustomFieldValues) {
  return defs
    .filter(({ id, required }) => required && values[id] === undefined)
    .map(({ label }) => label);
}

/** Mescla por chave (o que o `UPDATE` faz no banco): `null` remove, ausente não muda. */
export function mergeCustomFields(current: CustomFieldValues, patch: CustomFieldsPatch) {
  const next: CustomFieldValues = { ...current };

  for (const [id, value] of Object.entries(patch)) {
    if (value === null) delete next[id];
    else next[id] = value;
  }

  return next;
}

/** Texto legível do valor (lista mostra o rótulo das opções); `null` se vazio. */
export function displayCustomFieldValue(def: CustomFieldDef, value: unknown): string | null {
  if (isEmpty(value)) return null;

  const labelOf = (raw: string) => def.options.find(({ value: v }) => v === raw)?.label ?? raw;

  switch (def.type) {
    case "boolean":
      return value === true ? "Sim" : "Não";
    case "date": {
      if (typeof value !== "string" || !isIsoDate(value)) return String(value);
      const [year, month, day] = value.split("-");
      return `${day}/${month}/${year}`;
    }
    case "select":
      return labelOf(String(value));
    case "multiselect":
      return Array.isArray(value) ? value.map((item) => labelOf(String(item))).join(", ") : null;
    default:
      return String(value);
  }
}
