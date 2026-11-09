import { and, desc, eq, ne } from "drizzle-orm";
import { withPlatformScope, withTenant } from "@/db/rls";
import { tenantPaymentCredential } from "@/db/schema";
import { rotateChannelSecrets } from "@/lib/channels/credentials";
import {
  currentKeyRing,
  decryptSecret,
  encryptSecret,
  SecretDecryptError,
} from "@/lib/crypto/secrets";
import { notFound } from "@/lib/tenant/errors";

/**
 * Credenciais de provedor de cada tenant, para o fluxo (b). Só repositório: sem rota nem
 * tela. O segredo em claro sai apenas por `readCredentialSecret`, para uso interno.
 */

export type CredentialInput = {
  provider: string;
  label: string;
  secret: string;
  sandbox?: boolean;
};

type CredentialRow = typeof tenantPaymentCredential.$inferSelect;

const MIN_LENGTH_FOR_HINT = 8;

/** A cifra vale para este tenant e provedor, não para outra linha da tabela. */
const aadOf = (tenantId: string, provider: string) => `${tenantId}:${provider}`;

function toStored(tenantId: string, provider: string, secret: string) {
  const ring = currentKeyRing();
  const token = encryptSecret(secret, aadOf(tenantId, provider), ring);

  return {
    encryptedSecret: Buffer.from(token, "utf8"),
    keyVersion: ring.version,
  };
}

function reveal({ encryptedSecret, tenantId, provider }: CredentialRow) {
  return decryptSecret(
    encryptedSecret.toString("utf8"),
    aadOf(tenantId, provider),
  );
}

/** Últimos 4 caracteres. Segredo curto não mostra nada: 4 seria boa parte dele. */
export function maskSecret(secret: string) {
  return secret.length < MIN_LENGTH_FOR_HINT ? "••••" : `••••${secret.slice(-4)}`;
}

/** `null`: não decifra com as chaves atuais. As demais continuam listadas. */
function hintOf(row: CredentialRow) {
  try {
    return maskSecret(reveal(row));
  } catch (error) {
    if (error instanceof SecretDecryptError) return null;
    throw error;
  }
}

export async function saveCredential(tenantId: string, input: CredentialInput) {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .insert(tenantPaymentCredential)
      .values({
        tenantId,
        provider: input.provider,
        label: input.label,
        sandbox: input.sandbox ?? false,
        ...toStored(tenantId, input.provider, input.secret),
      })
      .returning({ id: tenantPaymentCredential.id }),
  );

  if (!row) throw new Error("Credencial não gravada.");
  return row;
}

export async function listCredentials(tenantId: string) {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(tenantPaymentCredential)
      .where(eq(tenantPaymentCredential.tenantId, tenantId))
      .orderBy(desc(tenantPaymentCredential.createdAt)),
  );

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    sandbox: row.sandbox,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt,
    hint: hintOf(row),
  }));
}

/** Para uso interno do servidor: nunca devolva este valor em uma resposta. */
export async function readCredentialSecret(tenantId: string, id: string) {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(tenantPaymentCredential)
      .where(
        and(
          eq(tenantPaymentCredential.id, id),
          eq(tenantPaymentCredential.tenantId, tenantId),
        ),
      ),
  );

  if (!row) throw notFound("Credencial não encontrada.");
  return reveal(row);
}

/**
 * Recifra o que não está na chave atual, nas credenciais de pagamento e nos segredos de canal
 * (`src/lib/channels/credentials.ts`). Idempotente e numa transação só: uma linha ilegível
 * desfaz tudo, e a chave anterior continua necessária.
 */
export function rotateCredentials() {
  const { version } = currentKeyRing();

  return withPlatformScope("rotação de credenciais", async (tx) => {
    const rows = await tx
      .select()
      .from(tenantPaymentCredential)
      .where(ne(tenantPaymentCredential.keyVersion, version));

    for (const row of rows) {
      await tx
        .update(tenantPaymentCredential)
        .set(toStored(row.tenantId, row.provider, reveal(row)))
        .where(eq(tenantPaymentCredential.id, row.id));
    }

    const channels = await rotateChannelSecrets(tx);

    return { rotated: rows.length + channels };
  });
}
