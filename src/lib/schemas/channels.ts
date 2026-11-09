import { z } from "zod";
import { channelStatuses, channelTypes } from "@/lib/channels/types";

/** Contratos de `/api/channels/*` e `/api/admin/channels/*` (`docs/specs/whatsapp-canais`). */

export const channelTypeSchema = z.enum(channelTypes);
export const channelStatusSchema = z.enum(channelStatuses);

export const CHANNEL_NAME_MAX = 60;

const nameSchema = z
  .string("Informe o nome.")
  .trim()
  .min(1, "Informe o nome.")
  .max(CHANNEL_NAME_MAX, `Use até ${CHANNEL_NAME_MAX} caracteres.`);

/** Id da Meta: só dígitos. Também fecha a porta para mudar o caminho da URL da Graph API. */
const metaId = (label: string) =>
  z
    .string(`Informe ${label}.`)
    .trim()
    .regex(/^\d{5,32}$/, `${label[0]?.toUpperCase()}${label.slice(1)} tem só números.`);

const secretText = (label: string) =>
  z
    .string(`Informe ${label}.`)
    .trim()
    .min(8, `${label[0]?.toUpperCase()}${label.slice(1)} parece curto demais.`)
    .max(1024, `${label[0]?.toUpperCase()}${label.slice(1)} é longo demais.`);

/** PIN de duas etapas do número: 6 dígitos. */
const pinSchema = z.string().regex(/^\d{6}$/, "O PIN tem 6 números.");

/**
 * Vazio ou ausente = "manter o que está gravado" (RF-14). Na edição, o formulário manda `""`
 * para o campo que o usuário não tocou.
 */
const keepWhenEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());

export const createCloudChannelSchema = z.strictObject({
  name: nameSchema,
  phoneNumberId: metaId("o identificador do número"),
  wabaId: metaId("o identificador da conta WhatsApp Business"),
  accessToken: secretText("o token de acesso"),
  appSecret: secretText("o segredo do aplicativo"),
  appId: keepWhenEmpty(metaId("o identificador do aplicativo")),
  pin: keepWhenEmpty(pinSchema),
});
export type CreateCloudChannelInput = z.infer<typeof createCloudChannelSchema>;

export const createQrChannelSchema = z.strictObject({ name: nameSchema });
export type CreateQrChannelInput = z.infer<typeof createQrChannelSchema>;

/**
 * Edição. Os campos de Cloud valem só para canal Cloud e `advancedSettings` só para QR: o
 * serviço recusa o que não é do tipo. Token, segredo e PIN ausentes ou vazios mantêm o gravado.
 */
export const updateChannelSchema = z.strictObject({
  name: nameSchema.optional(),
  wabaId: keepWhenEmpty(metaId("o identificador da conta WhatsApp Business")),
  accessToken: keepWhenEmpty(secretText("o token de acesso")),
  appSecret: keepWhenEmpty(secretText("o segredo do aplicativo")),
  appId: keepWhenEmpty(metaId("o identificador do aplicativo")),
  pin: keepWhenEmpty(pinSchema),
  advancedSettings: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

/** Remover pede o nome digitado (RF-07). */
export const deleteChannelSchema = z.strictObject({
  confirm: z.string("Digite o nome do número para confirmar."),
});

/**
 * Telefone para o código de pareamento: só dígitos, com DDI. Provisório: troca pelo
 * normalizador de `src/lib/phone/` quando a trilha A (A1) entrar em `main`.
 */
export const pairChannelSchema = z.strictObject({
  phone: z
    .string("Informe o telefone.")
    .trim()
    .regex(/^\d{10,15}$/, "Use só números, com o código do país (ex.: 5511999990001)."),
});

export const channelEventStatusSchema = z.enum(["pending", "processed", "ignored", "failed"]);

export const listTemplatesQuerySchema = z.object({
  status: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z_]{3,30}$/)
    .optional(),
});

export const listChannelEventsQuerySchema = z.object({
  status: channelEventStatusSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export type ChannelErrorCode =
  | "META_REJECTED"
  | "PHONE_NUMBER_IN_USE"
  | "PLAN_LIMIT_REACHED"
  | "SERVER_LIMIT_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "CHANNEL_DISABLED"
  | "CHANNEL_NOT_CONNECTED"
  | "CONFIRMATION_MISMATCH";
