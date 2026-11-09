import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Tx, withPlatformScope, withScope } from "@/db/rls";
import { channel, channelEvolution, channelWhatsappCloud } from "@/db/schema";
import { ProviderError } from "@/lib/channels/errors";
import { setProvidersForTests } from "@/lib/channels/registry";
import {
  assertChannelWithinLimit,
  channelLimits,
  getChannelView,
  insertChannelRow,
  listChannels,
  lockScopeType,
  removeChannel,
  renameChannel,
  setConversationCheck,
  setDefaultChannel,
} from "@/lib/channels/service";
import type { ChannelProvider } from "@/lib/channels/types";
import type { TenantRuleError } from "@/lib/tenant/errors";
import { cleanUpBilling, createPlanRow, ensureSubscription } from "./billing-helpers";
import {
  cleanUpChannels,
  createTenantRow,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  TEST_APP_SECRET,
  TEST_TOKEN,
  tenantScope,
} from "./channels-helpers";
import { connectOwner } from "./tenant-helpers";

const actor = { userId: null, ip: "10.1.1.1" };

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (error: unknown) => error as TenantRuleError,
  );
}

describe("serviço de canais", () => {
  let owner: postgres.Sql;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    owner = connectOwner();
    tenantA = await createTenantRow(owner, "svc-a");
    tenantB = await createTenantRow(owner, "svc-b");
  });

  afterEach(() => {
    setConversationCheck(undefined);
    setProvidersForTests(undefined);
  });

  afterAll(async () => {
    await cleanUpChannels(owner, [tenantA, tenantB]);
    await cleanUpBilling(owner);
    await owner.end();
  });

  const scopeA = () => tenantScope(tenantA);
  const scopeB = () => tenantScope(tenantB);
  /** `audit_log` tem RLS forçado: o dono também precisa do bypass para ler. */
  const auditOf = (targetId: string) =>
    owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ action: string; tenant_id: string | null; metadata: unknown }[]>`
        select action, tenant_id, metadata from audit_log where target_id = ${targetId}
      `;
    });
  const rowOf = (id: string) =>
    withPlatformScope("teste", (tx) => tx.select().from(channel).where(eq(channel.id, id)));

  describe("leitura", () => {
    it("a visão não traz coluna _enc nem o valor dos segredos; o token vira dica de 4 caracteres", async () => {
      const seeded = await seedCloudChannel(scopeA(), { name: "Vendas" });

      const views = await listChannels(scopeA());
      const view = views.find((item) => item.id === seeded.id);
      const json = JSON.stringify(views);

      expect(view).toMatchObject({
        name: "Vendas",
        type: "whatsapp_cloud",
        verifiedName: "Empresa Teste",
        accessTokenHint: "••••1234",
        hasConversations: false,
      });
      expect(json).not.toContain(TEST_TOKEN);
      expect(json).not.toContain(TEST_APP_SECRET);
      expect(json).not.toContain("token-de-verificacao");
      expect(json).not.toMatch(/_enc|Enc"|webhookKey/);
    });

    it("lista só os canais do escopo", async () => {
      const a = await seedCloudChannel(scopeA());
      const b = await seedCloudChannel(scopeB());

      const idsA = (await listChannels(scopeA())).map((item) => item.id);

      expect(idsA).toContain(a.id);
      expect(idsA).not.toContain(b.id);
    });

    it("id de outro tenant ou da plataforma responde 404, igual ao inexistente", async () => {
      const b = await seedCloudChannel(scopeB());

      for (const scope of [scopeA(), platformScope]) {
        await expect(getChannelView(scope, b.id)).rejects.toMatchObject({ status: 404 });
      }
      await expect(getChannelView(scopeA(), randomUUID())).rejects.toMatchObject({ status: 404 });
    });

    it("segredo que não decifra não derruba a lista (dica nula)", async () => {
      const seeded = await seedCloudChannel(scopeA());
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update channel_whatsapp_cloud set access_token_enc = 'v1:AAAA:BBBB:CCCC' where channel_id = ${seeded.id}`;
      });

      const view = (await listChannels(scopeA())).find((item) => item.id === seeded.id);

      expect(view?.accessTokenHint).toBeNull();
    });
  });

  describe("renomear", () => {
    it("muda o nome e audita (no tenant, com tipo e id, sem nome nem telefone)", async () => {
      const seeded = await seedCloudChannel(scopeA(), { name: "Antigo" });

      await renameChannel(scopeA(), seeded.id, "Novo", actor);

      expect((await rowOf(seeded.id))[0]?.name).toBe("Novo");
      const audits = await auditOf(seeded.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "channel.updated",
        metadata: { type: "whatsapp_cloud", channelId: seeded.id },
      });
      expect(JSON.stringify(audits)).not.toContain("Novo");
    });

    it("de outro escopo: 404 e nada muda", async () => {
      const b = await seedCloudChannel(scopeB(), { name: "Intocado" });

      await expect(renameChannel(scopeA(), b.id, "Hack", actor)).rejects.toMatchObject({ status: 404 });
      expect((await rowOf(b.id))[0]?.name).toBe("Intocado");
    });
  });

  describe("padrão por tipo", () => {
    it("o primeiro canal ativo do tipo vira padrão; o seguinte não", async () => {
      const tenant = await createTenantRow(owner, "default-a");
      const scope = tenantScope(tenant);
      const create = (name: string) =>
        withScope(scope, async (tx) => {
          await lockScopeType(tx, scope, "whatsapp_cloud");
          return insertChannelRow(tx, scope, {
            type: "whatsapp_cloud",
            name,
            status: "connecting",
            createdBy: null,
          });
        });

      const first = await create("um");
      const second = await create("dois");

      expect([first.isDefault, second.isDefault]).toEqual([true, false]);
      await cleanUpChannels(owner, [tenant]);
    });

    it("setDefault troca o padrão; recusa canal desativado (409)", async () => {
      const tenant = await createTenantRow(owner, "default-b");
      const scope = tenantScope(tenant);
      const one = await seedCloudChannel(scope, { isDefault: true });
      const two = await seedCloudChannel(scope);
      const off = await seedCloudChannel(scope, { status: "disabled" });

      await setDefaultChannel(scope, two.id, actor);

      expect((await rowOf(one.id))[0]?.isDefault).toBe(false);
      expect((await rowOf(two.id))[0]?.isDefault).toBe(true);
      await expect(setDefaultChannel(scope, off.id, actor)).rejects.toMatchObject({
        status: 409,
        code: "CHANNEL_DISABLED",
      });
      await cleanUpChannels(owner, [tenant]);
    });

    it("duas trocas ao mesmo tempo terminam com um só padrão (sem violar a única)", async () => {
      const tenant = await createTenantRow(owner, "default-c");
      const scope = tenantScope(tenant);
      const one = await seedCloudChannel(scope, { isDefault: true });
      const two = await seedCloudChannel(scope);
      const three = await seedCloudChannel(scope);

      await Promise.all([
        setDefaultChannel(scope, two.id, actor),
        setDefaultChannel(scope, three.id, actor),
      ]);

      const defaults = (await listChannels(scope)).filter((item) => item.isDefault);
      expect(defaults).toHaveLength(1);
      expect([two.id, three.id]).toContain(defaults[0]?.id);
      expect(defaults[0]?.id).not.toBe(one.id);
      await cleanUpChannels(owner, [tenant]);
    });

    it("tipos diferentes têm padrão próprio", async () => {
      const tenant = await createTenantRow(owner, "default-d");
      const scope = tenantScope(tenant);
      const cloud = await seedCloudChannel(scope, { isDefault: true });
      const qr = await seedQrChannel(scope);

      await setDefaultChannel(scope, qr.id, actor);

      expect((await rowOf(cloud.id))[0]?.isDefault).toBe(true);
      expect((await rowOf(qr.id))[0]?.isDefault).toBe(true);
      await cleanUpChannels(owner, [tenant]);
    });
  });

  describe("remoção", () => {
    it("o nome digitado precisa conferir (400) e nada é apagado", async () => {
      const seeded = await seedCloudChannel(scopeA(), { name: "Confirma" });

      const error = await rejection(removeChannel(scopeA(), seeded.id, "confirma", actor));

      expect(error).toMatchObject({ status: 400, code: "CONFIRMATION_MISMATCH" });
      expect(await rowOf(seeded.id)).toHaveLength(1);
    });

    it("sem conversas, apaga o canal e a linha do provedor; audita channel.deleted", async () => {
      const seeded = await seedCloudChannel(scopeA(), { name: "Apagar" });

      await expect(removeChannel(scopeA(), seeded.id, "Apagar", actor)).resolves.toEqual({
        outcome: "deleted",
      });

      expect(await rowOf(seeded.id)).toEqual([]);
      const cloud = await withPlatformScope("teste", (tx) =>
        tx.select().from(channelWhatsappCloud).where(eq(channelWhatsappCloud.channelId, seeded.id)),
      );
      expect(cloud).toEqual([]);
      const [audit] = await auditOf(seeded.id);
      expect(audit).toMatchObject({ action: "channel.deleted", tenant_id: tenantA });
    });

    it("com conversas, desativa: status disabled, segredos nulos, sem padrão; o histórico fica", async () => {
      const tenant = await createTenantRow(owner, "remove-a");
      const scope = tenantScope(tenant);
      const seeded = await seedCloudChannel(scope, { name: "Histórico", isDefault: true });
      setConversationCheck(async (_tx: Tx, id: string) => id === seeded.id);

      await expect(removeChannel(scope, seeded.id, "Histórico", actor)).resolves.toEqual({
        outcome: "disabled",
      });

      const [row] = await rowOf(seeded.id);
      expect(row).toMatchObject({ status: "disabled", isDefault: false });
      const [cloud] = await withPlatformScope("teste", (tx) =>
        tx.select().from(channelWhatsappCloud).where(eq(channelWhatsappCloud.channelId, seeded.id)),
      );
      expect(cloud).toMatchObject({
        accessTokenEnc: null,
        appSecretEnc: null,
        verifyTokenEnc: null,
      });
      // O número continua gravado: readicionar o mesmo `phone_number_id` readota o canal.
      expect(cloud?.phoneNumberId).toBeTruthy();
      await cleanUpChannels(owner, [tenant]);
    });

    it("apagar o padrão elege o conectado mais antigo; sem conectado, o tipo fica sem padrão", async () => {
      const tenant = await createTenantRow(owner, "remove-b");
      const scope = tenantScope(tenant);
      const old = new Date("2026-01-01T00:00:00Z");
      const recent = new Date("2026-06-01T00:00:00Z");
      const def = await seedCloudChannel(scope, { name: "Padrão", isDefault: true });
      const newer = await seedCloudChannel(scope, { status: "connected", connectedAt: recent });
      const older = await seedCloudChannel(scope, { status: "connected", connectedAt: old });
      const offline = await seedCloudChannel(scope, { status: "error" });

      await removeChannel(scope, def.id, "Padrão", actor);

      expect((await rowOf(older.id))[0]?.isDefault).toBe(true);
      expect((await rowOf(newer.id))[0]?.isDefault).toBe(false);
      expect((await rowOf(offline.id))[0]?.isDefault).toBe(false);
      await cleanUpChannels(owner, [tenant]);
    });

    it("remover canal que não é o padrão não mexe no padrão", async () => {
      const tenant = await createTenantRow(owner, "remove-c");
      const scope = tenantScope(tenant);
      const def = await seedCloudChannel(scope, { isDefault: true });
      const other = await seedCloudChannel(scope, { name: "Outro" });

      await removeChannel(scope, other.id, "Outro", actor);

      expect((await rowOf(def.id))[0]?.isDefault).toBe(true);
      await cleanUpChannels(owner, [tenant]);
    });

    it("de outro escopo: 404 antes de qualquer coisa", async () => {
      const b = await seedCloudChannel(scopeB(), { name: "Do B" });

      await expect(removeChannel(scopeA(), b.id, "Do B", actor)).rejects.toMatchObject({ status: 404 });
      expect(await rowOf(b.id)).toHaveLength(1);
    });

    it("na Evolution, apaga a instância no servidor antes de mexer no banco", async () => {
      const seeded = await seedQrChannel(scopeA(), { name: "Instância" });
      const destroy = vi.fn(async () => {});
      setProvidersForTests([{ type: "whatsapp_qr", destroy } as unknown as ChannelProvider]);

      await removeChannel(scopeA(), seeded.id, "Instância", actor);

      expect(destroy).toHaveBeenCalledTimes(1);
      const call = destroy.mock.calls[0] as unknown as [{ credentials: Record<string, string> }];
      expect(call[0].credentials.instanceToken).toBe("token-da-instancia-de-teste");
      expect(call[0].credentials.remoteInstanceId).toBeTruthy();
      expect(await rowOf(seeded.id)).toEqual([]);
    });

    it("falha do servidor Evolution: 503 PROVIDER_UNAVAILABLE e o canal fica como estava", async () => {
      const seeded = await seedQrChannel(scopeA(), { name: "Falha" });
      setProvidersForTests([
        {
          type: "whatsapp_qr",
          destroy: async () => {
            throw new ProviderError("connect ECONNREFUSED 10.0.0.9", 500);
          },
        } as unknown as ChannelProvider,
      ]);

      const error = await rejection(removeChannel(scopeA(), seeded.id, "Falha", actor));

      expect(error).toMatchObject({ status: 503, code: "PROVIDER_UNAVAILABLE" });
      expect(error?.message).not.toContain("10.0.0.9");
      const [evolution] = await withPlatformScope("teste", (tx) =>
        tx.select().from(channelEvolution).where(eq(channelEvolution.channelId, seeded.id)),
      );
      expect(evolution?.instanceTokenEnc).not.toBeNull();
      expect(await rowOf(seeded.id)).toHaveLength(1);
    });

    it("segredo ilegível não impede remover o canal Cloud", async () => {
      const seeded = await seedCloudChannel(scopeA(), { name: "Ilegível" });
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update channel_whatsapp_cloud set app_secret_enc = 'v1:AAAA:BBBB:CCCC' where channel_id = ${seeded.id}`;
      });

      await expect(removeChannel(scopeA(), seeded.id, "Ilegível", actor)).resolves.toEqual({
        outcome: "deleted",
      });
    });

    it("plataforma: remove com auditoria sem tenant", async () => {
      const seeded = await seedCloudChannel(platformScope, { name: "Plataforma-chtest" });

      await removeChannel(platformScope, seeded.id, "Plataforma-chtest", actor);

      const [audit] = await auditOf(seeded.id);
      expect(audit).toMatchObject({ action: "channel.deleted", tenant_id: null });
      await cleanUpChannels(owner, []);
    });
  });

  describe("limites do plano", () => {
    it("o limite conta canais ativos do tipo; desativado não conta; a plataforma não tem limite", async () => {
      const tenant = await createTenantRow(owner, "limit-a");
      const scope = tenantScope(tenant);
      const plan = await createPlanRow(owner, {
        isFree: false,
        limits: { channels_whatsapp_cloud: 1, channels_whatsapp_qr: 2 },
      });
      await ensureSubscription(owner, tenant, plan.id);

      await assertChannelWithinLimit(scope, "whatsapp_cloud");
      const cloud = await seedCloudChannel(scope);

      const error = await rejection(assertChannelWithinLimit(scope, "whatsapp_cloud"));
      expect(error).toMatchObject({ status: 403, code: "PLAN_LIMIT_REACHED" });
      // O outro tipo tem o próprio limite.
      await assertChannelWithinLimit(scope, "whatsapp_qr");

      expect(await channelLimits(scope)).toMatchObject({
        whatsapp_cloud: { limit: 1, used: 1, allowed: false },
        whatsapp_qr: { limit: 2, used: 0, allowed: true },
      });

      // Desativar libera a vaga.
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update channel set status = 'disabled' where id = ${cloud.id}`;
      });
      await assertChannelWithinLimit(scope, "whatsapp_cloud");

      expect(await channelLimits(platformScope)).toMatchObject({
        whatsapp_cloud: { limit: null, allowed: true },
      });
      await cleanUpChannels(owner, [tenant]);
      await cleanUpBilling(owner);
    });

    it("limite ausente no plano é ilimitado", async () => {
      const tenant = await createTenantRow(owner, "limit-b");
      const plan = await createPlanRow(owner, { isFree: false, limits: {} });
      await ensureSubscription(owner, tenant, plan.id);
      await seedCloudChannel(tenantScope(tenant));
      await seedCloudChannel(tenantScope(tenant));

      await assertChannelWithinLimit(tenantScope(tenant), "whatsapp_cloud");
      await cleanUpChannels(owner, [tenant]);
      await cleanUpBilling(owner);
    });
  });
});
