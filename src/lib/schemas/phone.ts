import { z } from "zod";
import { canWhatsApp, normalizePhone, PHONE_MAX_INPUT, phoneErrorMessage } from "@/lib/phone/br";

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

export const WHATSAPP_PHONE_REQUIRED = "Informe um celular com WhatsApp.";

/**
 * Telefone de quem tem conta na equipe (owner, admins, membros e a equipe da plataforma): só
 * número que recebe WhatsApp, porque é por ele que a conta é verificada. Fixo e celular antigo de
 * 8 dígitos, aceitos no cliente, são recusados aqui.
 */
export const whatsappPhoneSchema = phoneSchema.superRefine((value, ctx) => {
  const result = normalizePhone(value);
  if (result.ok && !canWhatsApp(result.kind)) {
    ctx.addIssue({ code: "custom", message: WHATSAPP_PHONE_REQUIRED });
  }
});
