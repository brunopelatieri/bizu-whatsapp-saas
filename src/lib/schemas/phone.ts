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

/**
 * O token do link de verificação: o prefixo do cadastro (`u.` conta da equipe, `c.` ficha de
 * cliente) e 32 bytes em base64url (43 caracteres).
 */
export const VERIFICATION_TOKEN_PATTERN = /^[uc]\.[A-Za-z0-9_-]{43}$/;

const verificationToken = z.string().regex(VERIFICATION_TOKEN_PATTERN, "Link inválido ou expirado.");

export const phoneVerificationTokenSchema = z.object({ token: verificationToken });

/**
 * Reenvio do link pedido pela pessoa. `responsible` escolhe o pedido: `platform` (a confirmação
 * que vale em todo lugar, D-12) ou o id de uma organização. Ausente: o pedido que a tela mostra
 * primeiro. Só serve para escolher entre os pedidos do próprio cadastro (vindo da sessão).
 */
export const phoneVerificationResendSchema = z
  .object({ responsible: z.union([z.literal("platform"), z.uuid()]).optional() })
  .strict();

/** O mesmo no portal: a organização da ficha. Ausente: a organização ativa da sessão. */
export const portalPhoneVerificationResendSchema = z
  .object({ tenantId: z.uuid().optional() })
  .strict();

export const phoneVerificationPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
