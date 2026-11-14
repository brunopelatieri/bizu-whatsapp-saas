import { z } from "zod";

/**
 * Perfil da própria conta da equipe (bloco F): `PATCH /api/me`. Só o nome; o e-mail, a senha e o
 * telefone têm rotas próprias, com verificação.
 */
export const profileNameSchema = z
  .object({
    name: z.string().trim().min(2, "Informe seu nome.").max(120, "Nome muito longo."),
  })
  .strict();

export type ProfileNameInput = z.infer<typeof profileNameSchema>;

/** `GET /api/avatars/:userId`: id malformado é só algo que não existe (404). */
export const avatarParamSchema = z.object({ userId: z.uuid() });
