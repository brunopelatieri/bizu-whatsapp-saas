import { z } from "zod";
import { channelTypes } from "@/lib/channels/types";
import { RETENTION_LIMIT_MAX } from "@/lib/inbox/retention-policy";

/**
 * Contratos de `/api/admin/retention/*` (bloco R) e do formulário da tela de retenção (R3b).
 * Cada limite: `null` **herda** o padrão do `.env`; `0` é **sem limite**; o teto é o de
 * `RETENTION_LIMIT_MAX` (o mesmo do `.env`). Os três campos são obrigatórios: herdar é dizer `null`.
 */

const limit = (max: number) =>
  z
    .number("Informe um número ou deixe em branco para herdar.")
    .int("Use um número inteiro.")
    .min(0, "Não pode ser negativo.")
    .max(max, `No máximo ${max.toLocaleString("pt-BR")}.`)
    .nullable();

export const retentionPolicySchema = z.strictObject({
  maxMessages: limit(RETENTION_LIMIT_MAX.maxMessages),
  retentionDays: limit(RETENTION_LIMIT_MAX.retentionDays),
  maxFavorites: limit(RETENTION_LIMIT_MAX.maxFavorites),
});

export type RetentionPolicyInput = z.infer<typeof retentionPolicySchema>;

export const retentionChannelTypeSchema = z.enum(channelTypes);
