import { z } from "zod";
import {
  evaluatePassword,
  isPasswordValid,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
} from "@/lib/auth/password-policy";
import { phoneSchema } from "@/lib/schemas/phone";

export const MIN_PASSWORD_LENGTH = PASSWORD_MIN_LENGTH;
const MAX_PASSWORD_LENGTH = PASSWORD_MAX_LENGTH;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "E-mail muito longo.")
  .email("Informe um e-mail válido.");

/** A forma gravada e conferida: sem espaço nas pontas, em NFC (`password-policy.ts`). */
const normalizedPassword = z.string().transform(normalizePassword);

/**
 * Senha nova, em cadastro, convite, redefinição e portal: normalizada e dentro da política.
 * O servidor repete a regra no hook do Better Auth (`src/lib/auth/password-hook.ts`).
 */
const newPassword = normalizedPassword.pipe(
  z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    )
    .max(MAX_PASSWORD_LENGTH, "Senha muito longa.")
    .refine(
      (password) => isPasswordValid(evaluatePassword(password)),
      PASSWORD_POLICY_MESSAGE,
    ),
);

export const loginSchema = z.object({
  email,
  // Sem regra de tamanho nem de complexidade: quem decide se a senha confere é o servidor,
  // que a normaliza como na gravação.
  password: z.string().min(1, "Informe sua senha.").max(MAX_PASSWORD_LENGTH),
});

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Informe seu nome.").max(120, "Nome muito longo."),
  email,
  /** Obrigatório em toda conta: o WhatsApp é o canal da base (`docs/specs/crm-cadastro`). */
  phone: phoneSchema,
  password: newPassword,
  acceptTerms: z.literal(true, {
    error: "Aceite os termos de uso e a política de privacidade.",
  }),
  termsVersion: z.string().min(1).max(32),
  /** Opcional: ausente não grava nada; `false` grava a recusa. */
  marketing: z.boolean().optional(),
});

export const emailOnlySchema = z.object({ email });

export const verifyEmailSchema = z.object({
  token: z.string().min(1, "Link inválido ou expirado.").max(4096),
});

export const resetPasswordSchema = z
  .object({ password: newPassword, confirmPassword: normalizedPassword })
  .refine((values) => values.password === values.confirmPassword, {
    message: "As senhas não conferem.",
    path: ["confirmPassword"],
  });

/** Resultado do POST em `/api/auth/verify-email`: a página escolhe o que mostrar. */
export type VerificationStep = "verified" | "change-approved" | "change-done";

export type LoginInput = z.infer<typeof loginSchema>;
export type SignupInput = z.infer<typeof signupSchema>;
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
