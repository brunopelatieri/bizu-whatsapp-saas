import { z } from "zod";
import { normalizeHexColor } from "@/lib/crm/colors";
import { CUSTOMER_TAG_LIMIT, TAG_NAME_MAX } from "@/lib/crm/constants";

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
