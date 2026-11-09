import { z } from "zod";
import { emailOnlySchema, signupSchema } from "@/lib/schemas/auth";
import { phoneSchema } from "@/lib/schemas/phone";
import { slugSchema } from "@/lib/schemas/tenant";

/** Contratos de `/api/portal/*` e dos formulários de `/portal`. */

export const magicLinkRequestSchema = emailOnlySchema.extend({ org: slugSchema });
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

/** `org` só escolhe entre os tenants da pessoa: quem autoriza é `customer`. */
export const portalTokenSchema = z.object({
  token: z.string().min(1, "Link inválido ou expirado.").max(4096),
  org: slugSchema.optional(),
});

export const portalSignupSchema = signupSchema.extend({ org: slugSchema });
export type PortalSignupInput = z.infer<typeof portalSignupSchema>;

export const portalProfileSchema = z.object({
  name: z.string().trim().min(2, "Informe seu nome.").max(120, "Nome muito longo."),
  phone: phoneSchema,
});
export type PortalProfileInput = z.infer<typeof portalProfileSchema>;
export type PortalProfileValues = z.input<typeof portalProfileSchema>;

export const setPasswordSchema = z.object({
  newPassword: signupSchema.shape.password,
  currentPassword: z.string().min(1).max(128).optional(),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
