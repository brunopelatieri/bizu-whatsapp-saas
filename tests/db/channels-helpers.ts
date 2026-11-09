import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { type Scope, withScope } from "@/db/rls";
import { channel, channelEvolution, channelWhatsappCloud } from "@/db/schema";
import {
  generateWebhookKey,
  generateWebhookSecret,
  hashWebhookSecret,
  sealSecret,
} from "@/lib/channels/credentials";
import type { ChannelStatus, ChannelType } from "@/lib/channels/types";

/** Apoio dos testes de canal: tenants, canais prontos e limpeza. */

export const TEST_TOKEN = "EAAB-token-de-teste-1234";
export const TEST_APP_SECRET = "segredo-do-aplicativo-de-teste";

export async function createTenantRow(owner: postgres.Sql, tag: string) {
  const id = randomUUID();

  await owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    await tx`insert into organization (id, name, slug) values (${id}, ${`Canais ${tag}`}, ${`canais-${tag}-${id.slice(0, 8)}`})`;
  });
  return id;
}

export const tenantScope = (tenantId: string): Scope => ({ kind: "tenant", tenantId });
export const platformScope: Scope = { kind: "platform" };

type SeedOptions = {
  name?: string;
  status?: ChannelStatus;
  isDefault?: boolean;
  phoneNumberId?: string;
  wabaId?: string;
  connectedAt?: Date;
};

let phoneCounter = Math.floor(Math.random() * 1e9);
export const nextPhoneNumberId = () => `5${Date.now()}${phoneCounter++}`;

/** Canal Cloud completo, com os três segredos cifrados como o serviço os grava. */
export async function seedCloudChannel(scope: Scope, options: SeedOptions = {}) {
  const tenantId = scope.kind === "tenant" ? scope.tenantId : null;

  return withScope(scope, async (tx) => {
    const [row] = await tx
      .insert(channel)
      .values({
        tenantId,
        type: "whatsapp_cloud",
        name: options.name ?? `Cloud ${randomUUID().slice(0, 6)}`,
        status: options.status ?? "connected",
        isDefault: options.isDefault ?? false,
        connectedAt: options.connectedAt,
        identifier: "+55 11 99999-0001",
      })
      .returning();
    if (!row) throw new Error("canal não criado");

    const webhookKey = generateWebhookKey();
    await tx.insert(channelWhatsappCloud).values({
      channelId: row.id,
      tenantId,
      phoneNumberId: options.phoneNumberId ?? nextPhoneNumberId(),
      wabaId: options.wabaId ?? "100000000000001",
      accessTokenEnc: sealSecret(row.id, "accessToken", TEST_TOKEN),
      appSecretEnc: sealSecret(row.id, "appSecret", TEST_APP_SECRET),
      verifyTokenEnc: sealSecret(row.id, "verifyToken", "token-de-verificacao"),
      webhookKey,
      verifiedName: "Empresa Teste",
    });

    return { ...row, webhookKey };
  });
}

/** Canal QR com instância, token e segredo de webhook cifrados. */
export async function seedQrChannel(scope: Scope, options: SeedOptions & { instanceId?: string } = {}) {
  const tenantId = scope.kind === "tenant" ? scope.tenantId : null;

  return withScope(scope, async (tx) => {
    const [row] = await tx
      .insert(channel)
      .values({
        tenantId,
        type: "whatsapp_qr",
        name: options.name ?? `QR ${randomUUID().slice(0, 6)}`,
        status: options.status ?? "connected",
        isDefault: options.isDefault ?? false,
        connectedAt: options.connectedAt,
      })
      .returning();
    if (!row) throw new Error("canal não criado");

    const webhookSecret = generateWebhookSecret();
    await tx.insert(channelEvolution).values({
      channelId: row.id,
      tenantId,
      remoteInstanceId: options.instanceId ?? randomUUID(),
      remoteInstanceName: `bizu_test_${randomUUID().slice(0, 12)}`,
      instanceTokenEnc: sealSecret(row.id, "instanceToken", "token-da-instancia-de-teste"),
      webhookSecretEnc: sealSecret(row.id, "webhookSecret", webhookSecret),
      webhookSecretHash: hashWebhookSecret(webhookSecret),
    });

    return { ...row, webhookSecret };
  });
}

export async function cleanUpChannels(owner: postgres.Sql, tenantIds: string[]) {
  await owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    for (const id of tenantIds) {
      await tx`delete from audit_log where tenant_id = ${id}`;
    }
    await tx`delete from channel where tenant_id is null and name like ${"%-chtest"}`;
    await tx`delete from audit_log where tenant_id is null and action like 'channel.%'`;
    if (tenantIds.length) await tx`delete from organization where id = any(${tenantIds})`;
  });
}

export type { ChannelType };
