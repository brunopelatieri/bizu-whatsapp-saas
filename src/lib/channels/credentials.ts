import { createHash, randomBytes } from "node:crypto";
import { eq, ne } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { channelEvolution, channelWhatsappCloud } from "@/db/schema";
import {
  currentKeyRing,
  decryptSecret,
  encryptSecret,
  type SecretKeyRing,
} from "@/lib/crypto/secrets";

/**
 * Cifra e leitura dos segredos de canal. É o **único** lugar que decifra, para uso do servidor
 * (chamar o provedor, conferir assinatura). Nada daqui sai em resposta, em log ou em auditoria.
 *
 * `aad` = `channel:<id>:<campo>`: a cifra copiada para outra linha, ou para outro campo da
 * mesma linha, não decifra.
 */

export type ChannelSecretField =
  | "accessToken"
  | "appSecret"
  | "verifyToken"
  | "instanceToken"
  | "webhookSecret";

export const aadOf = (channelId: string, field: ChannelSecretField) =>
  `channel:${channelId}:${field}`;

export function sealSecret(
  channelId: string,
  field: ChannelSecretField,
  value: string,
  ring: SecretKeyRing = currentKeyRing(),
) {
  return encryptSecret(value, aadOf(channelId, field), ring);
}

/** Lança `SecretDecryptError` com chave errada, texto adulterado ou cifra de outro canal. */
export function openSecret(
  channelId: string,
  field: ChannelSecretField,
  token: string,
  ring: SecretKeyRing = currentKeyRing(),
) {
  return decryptSecret(token, aadOf(channelId, field), ring);
}

/** Chave do caminho do webhook da Cloud API: 32 hex, aleatórios. */
export const generateWebhookKey = () => randomBytes(16).toString("hex");

/** Token de verificação do `GET` da Meta: gerado aqui, mostrado ao dono para colar na Meta. */
export const generateVerifyToken = () => randomBytes(24).toString("hex");

/** Segredo no caminho do webhook da Evolution (256 bits). */
export const generateWebhookSecret = () => randomBytes(32).toString("base64url");

/** sha256 (hex) do segredo do caminho: acha a instância sem varrer nem decifrar. */
export const hashWebhookSecret = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");

/** Token da instância: o `/instance/create` o exige e ele nasce do nosso lado. */
export const generateInstanceToken = () => crypto.randomUUID();

type CloudRow = typeof channelWhatsappCloud.$inferSelect;
type EvolutionRow = typeof channelEvolution.$inferSelect;

/**
 * Credenciais da Cloud API prontas para o `ChannelContext`. Canal desativado (os `_enc` nulos)
 * devolve só o que não é segredo: o provedor vai recusar a chamada, a falha é fechada.
 */
export function cloudCredentials(row: CloudRow): Record<string, string> {
  const credentials: Record<string, string> = {
    phoneNumberId: row.phoneNumberId,
    wabaId: row.wabaId,
  };

  if (row.accessTokenEnc) {
    credentials.accessToken = openSecret(row.channelId, "accessToken", row.accessTokenEnc);
  }
  if (row.appSecretEnc) {
    credentials.appSecret = openSecret(row.channelId, "appSecret", row.appSecretEnc);
  }
  if (row.verifyTokenEnc) {
    credentials.verifyToken = openSecret(row.channelId, "verifyToken", row.verifyTokenEnc);
  }
  return credentials;
}

export function evolutionCredentials(row: EvolutionRow): Record<string, string> {
  const credentials: Record<string, string> = {};

  if (row.remoteInstanceId) credentials.remoteInstanceId = row.remoteInstanceId;
  if (row.instanceTokenEnc) {
    credentials.instanceToken = openSecret(row.channelId, "instanceToken", row.instanceTokenEnc);
  }
  if (row.webhookSecretEnc) {
    credentials.webhookSecret = openSecret(row.channelId, "webhookSecret", row.webhookSecretEnc);
  }
  return credentials;
}

/**
 * Segredos de uma instância recifrados para outro canal (readoção: o mesmo número volta ao
 * canal antigo). O `aad` leva o id do canal, então copiar a cifra não serviria.
 */
export function transferPairingSecrets(from: EvolutionRow, toChannelId: string) {
  const ring = currentKeyRing();
  const move = (field: ChannelSecretField, token: string | null) =>
    token ? sealSecret(toChannelId, field, openSecret(from.channelId, field, token), ring) : null;

  return {
    instanceTokenEnc: move("instanceToken", from.instanceTokenEnc),
    webhookSecretEnc: move("webhookSecret", from.webhookSecretEnc),
    keyVersion: ring.version,
  };
}

/** Texto que não é segredo e que o ChannelContext/WebhookContext leva em `config`. */
export const evolutionConfigOf = (
  row: Pick<EvolutionRow, "remoteInstanceId">,
): Record<string, string> =>
  row.remoteInstanceId ? { remoteInstanceId: row.remoteInstanceId } : {};

/**
 * Recifra o que não está na chave atual, nas duas tabelas. Roda dentro da transação de
 * `rotateCredentials()` (`src/lib/tenant/credentials.ts`): uma linha ilegível desfaz tudo.
 */
export async function rotateChannelSecrets(tx: Tx) {
  const ring = currentKeyRing();
  let rotated = 0;

  const clouds = await tx
    .select()
    .from(channelWhatsappCloud)
    .where(ne(channelWhatsappCloud.keyVersion, ring.version));

  for (const row of clouds) {
    const seal = (field: ChannelSecretField, token: string | null) =>
      token ? sealSecret(row.channelId, field, openSecret(row.channelId, field, token), ring) : null;

    await tx
      .update(channelWhatsappCloud)
      .set({
        accessTokenEnc: seal("accessToken", row.accessTokenEnc),
        appSecretEnc: seal("appSecret", row.appSecretEnc),
        verifyTokenEnc: seal("verifyToken", row.verifyTokenEnc),
        keyVersion: ring.version,
      })
      .where(eq(channelWhatsappCloud.channelId, row.channelId));
    rotated += 1;
  }

  const evolutions = await tx
    .select()
    .from(channelEvolution)
    .where(ne(channelEvolution.keyVersion, ring.version));

  for (const row of evolutions) {
    const seal = (field: ChannelSecretField, token: string | null) =>
      token ? sealSecret(row.channelId, field, openSecret(row.channelId, field, token), ring) : null;

    await tx
      .update(channelEvolution)
      .set({
        instanceTokenEnc: seal("instanceToken", row.instanceTokenEnc),
        webhookSecretEnc: seal("webhookSecret", row.webhookSecretEnc),
        keyVersion: ring.version,
      })
      .where(eq(channelEvolution.channelId, row.channelId));
    rotated += 1;
  }

  return rotated;
}
