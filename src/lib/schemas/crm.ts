import { z } from "zod";
import { normalizeHexColor } from "@/lib/crm/colors";
import {
  CUSTOM_FIELD_LABEL_MAX,
  CUSTOM_FIELD_OPTION_LIMIT,
  CUSTOMER_TAG_LIMIT,
  customFieldEntities,
  customFieldTypes,
  listFieldTypes,
  TAG_NAME_MAX,
} from "@/lib/crm/constants";

/** Contratos de `/api/tags`, `/api/admin/crm/tags` e dos formulários de etiqueta. */

export const tagNameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Informe o nome da etiqueta.")
      .max(TAG_NAME_MAX, `Use até ${TAG_NAME_MAX} caracteres.`),
  );

/** Aceita `#abc`, `abc` e `AABBCC`; grava `#aabbcc`. */
export const tagColorSchema = z
  .string()
  .transform((value, ctx) => {
    const color = normalizeHexColor(value);
    if (!color) {
      ctx.addIssue({ code: "custom", message: "Cor inválida. Use o formato #rrggbb." });
      return z.NEVER;
    }
    return color;
  });

export const tagSchema = z.object({
  name: tagNameSchema,
  color: tagColorSchema.optional(),
});
export type TagInput = z.infer<typeof tagSchema>;
export type TagFormValues = z.input<typeof tagSchema>;

export const updateTagSchema = tagSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nada para alterar." });
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

/** Conjunto de etiquetas de um cliente (substitui o atual). */
export const tagIdsSchema = z
  .array(z.uuid("Etiqueta inválida."))
  .max(CUSTOMER_TAG_LIMIT, "Muitas etiquetas.")
  .transform((ids) => [...new Set(ids)]);

/** `tags=<id>,<id>` na listagem de clientes: qualquer uma delas. */
export const tagFilterSchema = z
  .string()
  .transform((value) => value.split(",").map((id) => id.trim()).filter(Boolean))
  .pipe(z.array(z.uuid("Etiqueta inválida.")).max(CUSTOMER_TAG_LIMIT));

/* ---------- Campos adicionais ---------- */

const customFieldLabelSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Informe o nome.")
      .max(CUSTOM_FIELD_LABEL_MAX, `Use até ${CUSTOM_FIELD_LABEL_MAX} caracteres.`),
  );

/** Opção de lista: `value` ausente quer dizer opção nova (o servidor gera). */
export const customFieldOptionSchema = z.object({
  value: z
    .string()
    .regex(/^[a-z0-9_]{1,40}$/, "Valor de opção inválido.")
    .optional(),
  label: customFieldLabelSchema,
});

const customFieldOptionsSchema = z
  .array(customFieldOptionSchema)
  .max(CUSTOM_FIELD_OPTION_LIMIT, `Use até ${CUSTOM_FIELD_OPTION_LIMIT} opções.`)
  .refine(
    (options) => new Set(options.map(({ label }) => label.toLowerCase())).size === options.length,
    "Há opções com o mesmo nome.",
  );

export const customFieldKeySchema = z
  .string()
  .regex(/^[a-z0-9_]{1,40}$/, "Use letras minúsculas, números e _ (até 40).");

export const customFieldSchema = z
  .object({
    entity: z.enum(customFieldEntities),
    label: customFieldLabelSchema,
    /** Gerada do rótulo se não vier; nunca muda depois. */
    key: customFieldKeySchema.optional(),
    type: z.enum(customFieldTypes),
    options: customFieldOptionsSchema.optional(),
    required: z.boolean().optional(),
  })
  .superRefine((field, ctx) => {
    const isList = listFieldTypes.includes(field.type);
    if (isList && (field.options?.length ?? 0) === 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Informe ao menos uma opção." });
    }
    if (!isList && (field.options?.length ?? 0) > 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Só campos de lista têm opções." });
    }
  });
export type CustomFieldInput = z.infer<typeof customFieldSchema>;
export type CustomFieldFormValues = z.input<typeof customFieldSchema>;

/** `type` e `key` não mudam depois de criado. */
export const updateCustomFieldSchema = z
  .object({
    label: customFieldLabelSchema.optional(),
    options: customFieldOptionsSchema.optional(),
    required: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nada para alterar." });
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

export const customFieldsQuerySchema = z.object({
  entity: z.enum(customFieldEntities).default("customer"),
  /** Padrão: só os ativos; `true`, só os arquivados; `all`, todos. */
  archived: z.enum(["true", "false", "all"]).default("false"),
  /** Soma `usage` (quantos cadastros têm valor): custa uma varredura por campo, só o gestor pede. */
  usage: z.enum(["true", "false"]).default("false"),
});

export const customFieldOrderSchema = z.object({
  entity: z.enum(customFieldEntities),
  ids: z
    .array(z.uuid("Campo inválido."))
    .max(200)
    .refine((ids) => new Set(ids).size === ids.length, "Há campos repetidos."),
});

export const deleteCustomFieldSchema = z.object({ confirm: z.string().max(100) });

/**
 * `customFields` em `POST` e `PATCH /api/customers`: `{ "<id do campo>": valor | null }`. Aqui
 * só o formato do envelope; o tipo de cada valor é conferido contra as definições ativas por
 * `buildCustomFieldsSchema`.
 */
export const customFieldValuesSchema = z
  .record(z.uuid("Campo inválido."), z.unknown())
  .refine((values) => Object.keys(values).length <= 100, "Campos demais.");
