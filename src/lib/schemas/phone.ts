import { z } from "zod";
import { normalizePhone, PHONE_MAX_INPUT, phoneErrorMessage } from "@/lib/phone/br";

/**
 * Telefone obrigatório de qualquer cadastro de pessoa. Valida o texto digitado e o devolve
 * aparado: o servidor grava esse texto em `phone` e calcula `phone_normalized` e `phone_key`
 * por `phoneColumns` (`src/lib/phone/columns.ts`), nunca a partir do corpo. A validação do
 * formulário é conforto; a regra é esta, rodada de novo na API.
 */
export const phoneSchema = z
  .string()
  .trim()
  .max(PHONE_MAX_INPUT, "Telefone muito longo.")
  .regex(/^[\d\s()+.-]*$/, "Use só números e + ( ) - .")
  .superRefine((value, ctx) => {
    const result = normalizePhone(value);
    if (!result.ok) ctx.addIssue({ code: "custom", message: phoneErrorMessage(result.reason) });
  });
