import { desc, eq } from "drizzle-orm";
import { isUniqueViolation } from "@/db/errors";
import { type Scope, type Tx, withPlatformScope, withScope } from "@/db/rls";
import { channel, channelEvent, channelWhatsappCloud } from "@/db/schema";
import {
  cloudCredentials,
  generateVerifyToken,
  generateWebhookKey,
  sealSecret,
} from "@/lib/channels/credentials";
import { logChannelError } from "@/lib/channels/log";
import {
  getSubscribedApps,
  MetaApiError,
  type MetaPhoneInfo,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from "@/lib/channels/providers/whatsapp_cloud/graph";
import { verifyChallenge } from "@/lib/channels/providers/whatsapp_cloud/webhook";
import type { ChannelActor, ChannelWebhookTarget } from "@/lib/channels/registry";
import {
  applyChannelStatus,
  assertChannelWithinLimit,
  type ChannelView,
  channelLimit,
  electDefault,
  getChannelView,
  insertChannelRow,
  lockScopeType,
  requireChannelRow,
  runInScope,
} from "@/lib/channels/service";
import type { ChannelStatus } from "@/lib/channels/types";
import { currentKeyRing, SecretDecryptError } from "@/lib/crypto/secrets";
import { getEnv } from "@/lib/env";
import type { CreateCloudChannelInput, UpdateChannelInput } from "@/lib/schemas/channels";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Regras do canal WhatsApp Cloud: salvar, editar, endereço de webhook, diagnóstico. Recebe
 * `Scope`, como o serviço comum. Falar com a Meta vem sempre **antes** da transação local.
 *
 * Nada daqui devolve coluna `_enc`. O token de verificação e o endereço do webhook saem só em
 * `webhookOf`/`rotateWebhook`, para quem tem `channel:manage` colar na Meta.
 */

const TYPE = "whatsapp_cloud" as const;
export const CLOUD_WEBHOOK_SEGMENT = "cloud";

type CloudRow = typeof channelWhatsappCloud.$inferSelect;

const NOT_FOUND = "Canal não encontrado.";

const phoneInUse = () =>
  new TenantRuleError(409, "PHONE_NUMBER_IN_USE", "Este número já está conectado a uma conta.");

const channelDisabled = () =>
  new TenantRuleError(409, "CHANNEL_DISABLED", "Este número está desativado.");

const unavailable = () =>
  new TenantRuleError(
    503,
    "PROVIDER_UNAVAILABLE",
    "Não foi possível falar com a Meta agora. Tente de novo em instantes.",
  );

/**
 * Recusa da Meta (4xx) vira 400 `META_REJECTED` com a mensagem dela, para o dono do número
 * corrigir a credencial. Indisponibilidade (5xx, 429, timeout) vira 503 e nada é gravado.
 */
function metaFailure(error: unknown): never {
  if (error instanceof MetaApiError && error.isRejection) {
    throw new TenantRuleError(400, "META_REJECTED", error.message);
  }

  logChannelError("Falha ao falar com a Meta", error);
  throw unavailable();
}

async function callMeta<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    return metaFailure(error);
  }
}

export const webhookUrl = (webhookKey: string) =>
  new URL(
    `/api/webhooks/whatsapp/${CLOUD_WEBHOOK_SEGMENT}/${webhookKey}`,
    getEnv().APP_URL,
  ).toString();

export type CloudWebhookInfo = { url: string; verifyToken: string };

/** Linha da Cloud do canal, no escopo; canal de outro tipo é 404, como inexistente. */
async function requireCloud(tx: Tx, scope: Scope, id: string, lock = false) {
  const row = await requireChannelRow(tx, scope, id, lock);
  const [cloud] = await tx
    .select()
    .from(channelWhatsappCloud)
    .where(eq(channelWhatsappCloud.channelId, id));

  if (row.type !== TYPE || !cloud) throw notFound(NOT_FOUND);
  return { row, cloud };
}

const sameScope = (scope: Scope, tenantId: string | null) =>
  scope.kind === "tenant" ? tenantId === scope.tenantId : tenantId === null;

// ---------------------------------------------------------------------------
// Salvar
// ---------------------------------------------------------------------------

/**
 * Salvar um número: `verifyPhoneNumber` → (PIN) `registerPhoneNumber` → `subscribeWabaToApp` →
 * uma transação com `channel` + `channel_whatsapp_cloud`. A chave do endereço e o token de
 * verificação nascem aqui, no servidor.
 *
 * `phone_number_id` é único em todos os escopos: já usado é 409, sem dizer por quem. A
 * conferência vem **depois** do token aceito pela Meta: só quem tem credencial válida daquele
 * número fica sabendo que ele já está em uso. No mesmo escopo, um canal desativado com o mesmo
 * número é readotado, para o histórico não se partir.
 */
export async function createCloudChannel(
  scope: Scope,
  input: CreateCloudChannelInput,
  actor: ChannelActor,
): Promise<{ channel: ChannelView; webhook: CloudWebhookInfo }> {
  // Recusa barata antes de ir à Meta; a que vale é a da transação, com a trava.
  const limit = await channelLimit(scope, TYPE);
  if (!limit.allowed) await assertChannelWithinLimit(scope, TYPE);

  const credentials = { accessToken: input.accessToken };
  const info = await callMeta(() =>
    verifyPhoneNumber({ ...credentials, phoneNumberId: input.phoneNumberId }),
  );

  const [taken] = await withPlatformScope("canal Cloud: número já em uso", (tx) =>
    tx
      .select({ id: channel.id, tenantId: channel.tenantId, status: channel.status })
      .from(channelWhatsappCloud)
      .innerJoin(channel, eq(channel.id, channelWhatsappCloud.channelId))
      .where(eq(channelWhatsappCloud.phoneNumberId, input.phoneNumberId)),
  );
  if (taken && (!sameScope(scope, taken.tenantId) || taken.status !== "disabled")) {
    throw phoneInUse();
  }

  const { pin } = input;
  const registered = pin
    ? await callMeta(() =>
        registerPhoneNumber({ ...credentials, phoneNumberId: input.phoneNumberId, pin }),
      )
    : null;
  await callMeta(() => subscribeWabaToApp({ ...credentials, wabaId: input.wabaId }));

  const webhookKey = generateWebhookKey();
  const verifyToken = generateVerifyToken();
  const now = new Date();

  let id: string;
  try {
    id = await runInScope(scope, actor, async (tx, record) => {
      await lockScopeType(tx, scope, TYPE);
      await assertChannelWithinLimit(scope, TYPE);

      const channelId = taken
        ? await readopt(tx, scope, taken.id, input.name)
        : (
            await insertChannelRow(tx, scope, {
              type: TYPE,
              name: input.name,
              status: "connected",
              identifier: info.display_phone_number,
              createdBy: actor.userId,
            })
          ).id;

      const values = {
        wabaId: input.wabaId,
        appId: input.appId ?? null,
        accessTokenEnc: sealSecret(channelId, "accessToken", input.accessToken),
        appSecretEnc: sealSecret(channelId, "appSecret", input.appSecret),
        verifyTokenEnc: sealSecret(channelId, "verifyToken", verifyToken),
        keyVersion: currentKeyRing().version,
        webhookKey,
        webhookVerifiedAt: null,
        ...phoneColumns(info),
        ...(registered ? { registeredAt: now } : {}),
        subscribedAt: now,
        lastError: null,
      };

      if (taken) {
        await tx
          .update(channelWhatsappCloud)
          .set(values)
          .where(eq(channelWhatsappCloud.channelId, channelId));
      } else {
        await tx.insert(channelWhatsappCloud).values({
          ...values,
          channelId,
          tenantId: scope.kind === "tenant" ? scope.tenantId : null,
          phoneNumberId: input.phoneNumberId,
        });
      }

      await applyChannelStatus(
        tx,
        channelId,
        { status: "connected", identifier: info.display_phone_number },
        now,
      );
      if (taken) await electDefault(tx, scope, TYPE);

      await record("channel.created", { id: channelId, type: TYPE });
      return channelId;
    });
  } catch (error) {
    // Dois pedidos com o mesmo número ao mesmo tempo: a única decide.
    if (isUniqueViolation(error)) throw phoneInUse();
    throw error;
  }

  return {
    channel: await getChannelView(scope, id),
    webhook: { url: webhookUrl(webhookKey), verifyToken },
  };
}

const phoneColumns = (info: MetaPhoneInfo) => ({
  displayPhone: info.display_phone_number,
  verifiedName: info.verified_name ?? null,
  qualityRating: info.quality_rating ?? null,
});

/** Canal desativado volta à vida com o mesmo id: as conversas antigas continuam nele. */
async function readopt(tx: Tx, scope: Scope, id: string, name: string) {
  const row = await requireChannelRow(tx, scope, id, true);
  // Outro pedido o reativou enquanto este falava com a Meta.
  if (row.status !== "disabled") throw phoneInUse();

  await tx
    .update(channel)
    .set({ name, status: "connected", statusDetail: null })
    .where(eq(channel.id, id));
  return id;
}

// ---------------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------------

/**
 * Token, segredo do aplicativo e PIN ausentes (o schema troca vazio por ausente) **mantêm** o
 * que está gravado. A chave do endereço e o token de verificação não mudam aqui. Credencial ou
 * WABA novos são conferidos na Meta antes de gravar.
 */
export async function updateCloudChannel(
  scope: Scope,
  id: string,
  input: UpdateChannelInput,
  actor: ChannelActor,
) {
  if (input.advancedSettings !== undefined) {
    throw new TenantRuleError(400, "UNSUPPORTED_FIELDS", "Este campo não vale para número oficial.");
  }

  const { row, cloud } = await withScope(scope, (tx) => requireCloud(tx, scope, id));
  if (row.status === "disabled") throw channelDisabled();

  const stored = readCredentials(cloud);
  const accessToken = input.accessToken ?? stored?.accessToken;
  const wabaId = input.wabaId ?? cloud.wabaId;
  // O formulário reenvia o WABA que já está gravado: só a troca leva à Meta.
  const touchesMeta = Boolean(input.accessToken || input.pin || wabaId !== cloud.wabaId);

  let info: MetaPhoneInfo | null = null;
  let registered = false;

  if (touchesMeta) {
    if (!accessToken) {
      throw new TenantRuleError(400, "TOKEN_REQUIRED", "Informe o token de acesso de novo.");
    }
    const credentials = { accessToken };

    info = await callMeta(() =>
      verifyPhoneNumber({ ...credentials, phoneNumberId: cloud.phoneNumberId }),
    );
    const { pin } = input;
    if (pin) {
      await callMeta(() =>
        registerPhoneNumber({ ...credentials, phoneNumberId: cloud.phoneNumberId, pin }),
      );
      registered = true;
    }
    await callMeta(() => subscribeWabaToApp({ ...credentials, wabaId }));
  }

  const now = new Date();

  await runInScope(scope, actor, async (tx, record) => {
    const current = await requireCloud(tx, scope, id, true);
    if (current.row.status === "disabled") throw channelDisabled();

    if (input.name !== undefined) {
      await tx.update(channel).set({ name: input.name }).where(eq(channel.id, id));
    }

    await tx
      .update(channelWhatsappCloud)
      .set({
        ...(input.wabaId ? { wabaId: input.wabaId } : {}),
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.accessToken
          ? { accessTokenEnc: sealSecret(id, "accessToken", input.accessToken) }
          : {}),
        ...(input.appSecret ? { appSecretEnc: sealSecret(id, "appSecret", input.appSecret) } : {}),
        ...(info ? { ...phoneColumns(info), subscribedAt: now, lastError: null } : {}),
        ...(registered ? { registeredAt: now } : {}),
        // `key_version` fica como está: cada cifra leva a própria versão, e
        // `rotateChannelSecrets` recifra a linha inteira na troca de chave.
        updatedAt: now,
      })
      .where(eq(channelWhatsappCloud.channelId, id));

    // A Meta aceitou a credencial nova: o canal que estava em erro volta.
    if (info) {
      await applyChannelStatus(
        tx,
        id,
        { status: "connected", identifier: info.display_phone_number },
        now,
      );
    }

    await record("channel.updated", { id, type: TYPE });
  });
}

/** Segredos decifrados, ou `null` se não decifram com as chaves atuais. */
function readCredentials(cloud: CloudRow) {
  try {
    return cloudCredentials(cloud);
  } catch (error) {
    if (error instanceof SecretDecryptError) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Endereço de webhook
// ---------------------------------------------------------------------------

/** Endereço e token para colar na Meta. Só para quem gerencia o canal. */
export async function webhookOf(scope: Scope, id: string): Promise<CloudWebhookInfo> {
  const { row, cloud } = await withScope(scope, (tx) => requireCloud(tx, scope, id));
  if (row.status === "disabled") throw channelDisabled();

  const verifyToken = readCredentials(cloud)?.verifyToken;
  if (!verifyToken) {
    throw new TenantRuleError(
      409,
      "WEBHOOK_UNREADABLE",
      "Não foi possível ler o token deste número. Gere um novo endereço.",
    );
  }

  return { url: webhookUrl(cloud.webhookKey), verifyToken };
}

/**
 * "Gerar novo endereço": troca a chave do caminho e o token de verificação. O endereço antigo
 * para de valer na hora, e a Meta precisa ser reconfigurada com o novo.
 */
export async function rotateWebhook(
  scope: Scope,
  id: string,
  actor: ChannelActor,
): Promise<CloudWebhookInfo> {
  const webhookKey = generateWebhookKey();
  const verifyToken = generateVerifyToken();

  await runInScope(scope, actor, async (tx, record) => {
    const { row } = await requireCloud(tx, scope, id, true);
    if (row.status === "disabled") throw channelDisabled();

    await tx
      .update(channelWhatsappCloud)
      .set({
        webhookKey,
        verifyTokenEnc: sealSecret(id, "verifyToken", verifyToken),
        webhookVerifiedAt: null,
      })
      .where(eq(channelWhatsappCloud.channelId, id));

    await record("channel.webhook_rotated", { id, type: TYPE });
  });

  return { url: webhookUrl(webhookKey), verifyToken };
}

/** `ChannelModule.webhook.findTarget`: só a linha de configuração do dono da chave. */
export async function findCloudWebhookTarget(key: string): Promise<ChannelWebhookTarget | null> {
  if (!/^[0-9a-f]{32}$/.test(key)) return null;

  const [found] = await withPlatformScope("webhook de canal", (tx) =>
    tx
      .select({ row: channel, cloud: channelWhatsappCloud })
      .from(channelWhatsappCloud)
      .innerJoin(channel, eq(channel.id, channelWhatsappCloud.channelId))
      .where(eq(channelWhatsappCloud.webhookKey, key)),
  );
  if (!found) return null;

  const { id, tenantId, type, status } = found.row;

  return {
    channel: { id, tenantId, type, status },
    // Segredo que não decifra: sem `appSecret`, a verificação recusa (falha fechada).
    credentials: readCredentials(found.cloud) ?? {},
    config: {},
  };
}

/**
 * `GET` de verificação da Meta. Confere o token em tempo constante e marca
 * `webhook_verified_at`. Chave desconhecida e token errado caem no mesmo `null`.
 */
export async function cloudHandshake(
  target: ChannelWebhookTarget | null,
  query: Record<string, string>,
): Promise<string | null> {
  const challenge = verifyChallenge(
    {
      mode: query["hub.mode"],
      token: query["hub.verify_token"],
      challenge: query["hub.challenge"],
    },
    target?.credentials.verifyToken,
  );
  if (!target || challenge === null || target.channel.status === "disabled") return null;

  await withScope(scopeOfTarget(target), (tx) =>
    tx
      .update(channelWhatsappCloud)
      .set({ webhookVerifiedAt: new Date() })
      .where(eq(channelWhatsappCloud.channelId, target.channel.id)),
  );
  return challenge;
}

const scopeOfTarget = (target: ChannelWebhookTarget): Scope =>
  target.channel.tenantId
    ? { kind: "tenant", tenantId: target.channel.tenantId }
    : { kind: "platform" };

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------

export type DiagnosticCheck = {
  id:
    | "credentials_readable"
    | "token_valid"
    | "phone_reachable"
    | "waba_subscribed"
    | "webhook_verified"
    | "last_event_at";
  ok: boolean;
  detail?: string;
};

const TRANSIENT = "A Meta não respondeu agora; tente de novo.";

/**
 * Confere o canal de ponta a ponta. Recusa da Meta (4xx) marca o canal `error`; 5xx, 429 e
 * timeout não mudam o estado. Tudo certo com a Meta devolve o canal a `connected`.
 */
export async function diagnoseCloudChannel(
  scope: Scope,
  id: string,
): Promise<{ checks: DiagnosticCheck[]; status: ChannelStatus }> {
  const { row, cloud, lastEventAt } = await withScope(scope, async (tx) => {
    const found = await requireCloud(tx, scope, id);
    const [last] = await tx
      .select({ receivedAt: channelEvent.receivedAt })
      .from(channelEvent)
      .where(eq(channelEvent.channelId, id))
      .orderBy(desc(channelEvent.receivedAt))
      .limit(1);

    return { ...found, lastEventAt: last?.receivedAt ?? null };
  });
  if (row.status === "disabled") throw channelDisabled();

  const credentials = readCredentials(cloud);
  const readable = Boolean(credentials?.accessToken && credentials.appSecret);
  const checks: DiagnosticCheck[] = [{ id: "credentials_readable", ok: readable }];

  let rejection: string | null = null;
  let info: MetaPhoneInfo | null = null;
  let subscribed: boolean | null = null;
  let transient = false;

  const note = (error: unknown) => {
    if (error instanceof MetaApiError && error.isRejection) rejection ??= error.message;
    else {
      transient = true;
      logChannelError("Falha no diagnóstico do canal", error);
    }
  };

  if (readable && credentials?.accessToken) {
    const { accessToken } = credentials;

    try {
      info = await verifyPhoneNumber({ accessToken, phoneNumberId: cloud.phoneNumberId });
    } catch (error) {
      note(error);
    }

    if (info) {
      try {
        const apps = await getSubscribedApps({ accessToken, wabaId: cloud.wabaId });
        subscribed = cloud.appId
          ? apps.some((app) => app.whatsapp_business_api_data?.id === cloud.appId)
          : apps.length > 0;
      } catch (error) {
        note(error);
      }
    }
  }

  const failed = rejection ?? (transient ? TRANSIENT : undefined);
  checks.push(
    { id: "token_valid", ok: info !== null, ...(info ? {} : { detail: failed }) },
    { id: "phone_reachable", ok: info !== null, ...(info ? {} : { detail: failed }) },
    { id: "waba_subscribed", ok: subscribed === true, ...(subscribed === null ? { detail: failed } : {}) },
    { id: "webhook_verified", ok: cloud.webhookVerifiedAt !== null },
    {
      id: "last_event_at",
      ok: lastEventAt !== null,
      ...(lastEventAt ? { detail: lastEventAt.toISOString() } : {}),
    },
  );

  const next: ChannelStatus | null = rejection ? "error" : info && !transient ? "connected" : null;

  if (next) {
    await withScope(scope, async (tx) => {
      // Já conectado e segue conectado: `connected_at` não anda.
      if (next !== row.status || next === "error") {
        await applyChannelStatus(tx, id, {
          status: next,
          detail: rejection,
          identifier: info?.display_phone_number,
        });
      } else {
        await tx.update(channel).set({ lastSeenAt: new Date() }).where(eq(channel.id, id));
      }
      await tx
        .update(channelWhatsappCloud)
        .set({ lastError: rejection, ...(info ? phoneColumns(info) : {}) })
        .where(eq(channelWhatsappCloud.channelId, id));
    });
  }

  return { checks, status: next ?? row.status };
}
