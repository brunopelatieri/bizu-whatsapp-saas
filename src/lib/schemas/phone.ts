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

/** O token do link de verificação: 32 bytes em base64url (43 caracteres). */
const verificationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Link inválido ou expirado.");

export const phoneVerificationTokenSchema = z.object({ token: verificationToken });

export const phoneVerificationPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
