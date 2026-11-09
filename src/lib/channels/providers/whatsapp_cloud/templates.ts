import { and, asc, eq, inArray, max, type SQL, sql } from "drizzle-orm";
import { type Scope, type Tx, withScope } from "@/db/rls";
import { channelWhatsappCloud, messageTemplate } from "@/db/schema";
import { openSecret } from "@/lib/channels/credentials";
import { logChannelError } from "@/lib/channels/log";
import {
  listTemplates,
  MetaApiError,
  type MetaTemplate,
} from "@/lib/channels/providers/whatsapp_cloud/graph";
import { requireChannelRow } from "@/lib/channels/service";
import { SecretDecryptError } from "@/lib/crypto/secrets";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Modelos de mensagem (`message_template`). Só leitura: a fonte é a Meta. O modelo é do WABA,
 * não do canal: dois números do mesmo WABA veem os mesmos.
 */

const scopeFilter = (scope: Scope): SQL =>
  scope.kind === "tenant"
    ? eq(messageTemplate.tenantId, scope.tenantId)
    : sql`${messageTemplate.tenantId} is null`;

async function cloudOf(tx: Tx, scope: Scope, id: string) {
  const row = await requireChannelRow(tx, scope, id);
  const [cloud] = await tx
    .select()
    .from(channelWhatsappCloud)
    .where(eq(channelWhatsappCloud.channelId, id));

  if (!cloud) throw notFound("Canal não encontrado.");
  return { row, cloud };
}

export type TemplateView = {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown[];
};

export async function listChannelTemplates(scope: Scope, id: string, status?: string) {
  return withScope(scope, async (tx) => {
    const { cloud } = await cloudOf(tx, scope, id);
    const ofWaba = and(scopeFilter(scope), eq(messageTemplate.wabaId, cloud.wabaId));

    const templates: TemplateView[] = await tx
      .select({
        id: messageTemplate.id,
        name: messageTemplate.name,
        language: messageTemplate.language,
        category: messageTemplate.category,
        status: messageTemplate.status,
        components: messageTemplate.components,
      })
      .from(messageTemplate)
      .where(status ? and(ofWaba, eq(messageTemplate.status, status)) : ofWaba)
      .orderBy(asc(messageTemplate.name), asc(messageTemplate.language));
    const [synced] = await tx
      .select({ at: max(messageTemplate.syncedAt) })
      .from(messageTemplate)
      .where(ofWaba);

    return { templates, syncedAt: synced?.at ?? null };
  });
}

const keyOf = (item: { name: string; language: string }) => `${item.name}|${item.language}`;

/**
 * Lê os modelos do WABA na Meta e iguala a tabela: cria, atualiza e **apaga** o que sumiu lá.
 * A leitura da Meta vem antes da transação.
 */
export async function syncChannelTemplates(scope: Scope, id: string) {
  const { row, cloud } = await withScope(scope, (tx) => cloudOf(tx, scope, id));

  if (row.status === "disabled" || !cloud.accessTokenEnc) {
    throw new TenantRuleError(409, "CHANNEL_DISABLED", "Este número está desativado.");
  }

  let remote: MetaTemplate[];
  try {
    const accessToken = openSecret(id, "accessToken", cloud.accessTokenEnc);
    remote = await listTemplates({ accessToken, wabaId: cloud.wabaId });
  } catch (error) {
    if (error instanceof MetaApiError && error.isRejection) {
      throw new TenantRuleError(400, "META_REJECTED", error.message);
    }
    if (!(error instanceof SecretDecryptError)) {
      logChannelError("Falha ao sincronizar modelos", error);
    }
    throw new TenantRuleError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Não foi possível ler os modelos na Meta agora. Tente de novo em instantes.",
    );
  }

  // A Meta não repete nome + idioma; se repetir, vale o último.
  const wanted = new Map(
    remote
      .filter((item) => item.name && item.language && item.status)
      .map((item) => [keyOf(item), item]),
  );
  const now = new Date();
  const tenantId = scope.kind === "tenant" ? scope.tenantId : null;

  return withScope(scope, async (tx) => {
    const ofWaba = and(scopeFilter(scope), eq(messageTemplate.wabaId, cloud.wabaId));
    const existing = await tx
      .select({
        id: messageTemplate.id,
        name: messageTemplate.name,
        language: messageTemplate.language,
      })
      .from(messageTemplate)
      .where(ofWaba)
      .for("update");
    const known = new Map(existing.map((item) => [keyOf(item), item.id]));

    for (const [key, item] of wanted) {
      const values = {
        category: item.category ?? null,
        status: item.status,
        components: Array.isArray(item.components) ? item.components : [],
        providerTemplateId: item.id ?? null,
        syncedAt: now,
      };
      const current = known.get(key);

      if (current) {
        await tx.update(messageTemplate).set(values).where(eq(messageTemplate.id, current));
      } else {
        await tx.insert(messageTemplate).values({
          ...values,
          tenantId,
          wabaId: cloud.wabaId,
          name: item.name,
          language: item.language,
        });
      }
    }

    const gone = existing.filter((item) => !wanted.has(keyOf(item))).map((item) => item.id);
    if (gone.length > 0) {
      await tx.delete(messageTemplate).where(and(ofWaba, inArray(messageTemplate.id, gone)));
    }

    return { synced: wanted.size, removed: gone.length };
  });
}
