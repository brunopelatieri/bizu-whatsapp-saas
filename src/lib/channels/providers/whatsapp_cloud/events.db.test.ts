import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withPlatformScope } from "@/db/rls";
import { channelEvent, messageTemplate } from "@/db/schema";
import {
  processChannelEvent,
  receiveChannelEvent,
  scopeOf,
  setInboxHandlers,
} from "@/lib/channels/events";
import { createCloudProvider } from "@/lib/channels/providers/whatsapp_cloud";
import { setProvidersForTests } from "@/lib/channels/registry";
import { fixture } from "@/lib/channels/test-fixtures";
import {
  cleanUpChannels,
  createTenantRow,
  seedCloudChannel,
  tenantScope,
} from "../../../../../tests/db/channels-helpers";
import { connectOwner } from "../../../../../tests/db/tenant-helpers";

/**
 * Avisos reais da Meta (fixtures) pelo job `channel.inbound`, com banco. Mora na pasta do módulo
 * para sumir com ela (`npm run check:module-removal -- whatsapp_cloud`); roda em `npm run test:db`.
 */

describe("avisos da Meta pelo job", () => {
  let owner: postgres.Sql;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    owner = connectOwner();
    tenantA = await createTenantRow(owner, "cloud-a");
    tenantB = await createTenantRow(owner, "cloud-b");
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    setInboxHandlers({});
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from channel where tenant_id in (${tenantA}, ${tenantB})`;
    });
  });

  afterAll(async () => {
    await cleanUpChannels(owner, [tenantA, tenantB]);
    await owner.end();
  });

  const receive = (row: { id: string; tenantId: string | null }, raw: unknown) =>
    receiveChannelEvent({
      scope: scopeOf(row.tenantId),
      channelId: row.id,
      provider: "whatsapp_cloud",
      dedupeKey: crypto.randomUUID(),
      kind: "other",
      raw,
    });

  const status = async (id: string) =>
    (await withPlatformScope("teste", (tx) => tx.select().from(channelEvent).where(eq(channelEvent.id, id))))[0]
      ?.status;

  it("mensagem fica ignored enquanto a caixa de entrada não existe", async () => {
    const seeded = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000001" });
    setProvidersForTests([createCloudProvider()]);
    const { id } = await receive(seeded, fixture("cloud/message-text"));

    await expect(processChannelEvent(id)).resolves.toBe("ignored");
    expect(await status(id)).toBe("ignored");
  });

  it("dois números do mesmo aplicativo: cada mudança vai ao número dela, dentro do escopo", async () => {
    const a = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000001" });
    const b = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000002" });
    const targets: string[] = [];
    setInboxHandlers({
      message: async (_tx, _scope, target) => {
        targets.push(target.id);
        return true;
      },
    });
    setProvidersForTests([createCloudProvider()]);
    const { id } = await receive(a, fixture("cloud/two-numbers-same-waba"));

    await processChannelEvent(id);

    expect(targets).toEqual([a.id, b.id]);
  });

  it("aviso assinado pelo tenant A citando número do tenant B não toca em B", async () => {
    const a = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000001" });
    const b = await seedCloudChannel(tenantScope(tenantB), { phoneNumberId: "200000000000002" });
    const handler = vi.fn(async () => true);
    setInboxHandlers({ message: handler });
    setProvidersForTests([createCloudProvider()]);
    const { id } = await receive(a, fixture("cloud/two-numbers-same-waba"));

    await processChannelEvent(id);

    const targets = handler.mock.calls.map((call) => (call as unknown as [unknown, unknown, { id: string }])[2].id);
    expect(targets).toEqual([a.id]);
    expect(targets).not.toContain(b.id);
  });

  it("status do modelo atualiza só o modelo do escopo do canal", async () => {
    const a = await seedCloudChannel(tenantScope(tenantA), { wabaId: "100000000000001", phoneNumberId: "200000000000001" });
    const waba = "100000000000001";
    await withPlatformScope("teste", (tx) =>
      tx.insert(messageTemplate).values(
        [tenantA, tenantB].map((tenantId) => ({
          tenantId,
          wabaId: waba,
          name: "boas_vindas",
          language: "pt_BR",
          status: "PENDING",
          providerTemplateId: "400000000000001",
        })),
      ),
    );
    setProvidersForTests([createCloudProvider()]);
    const { id } = await receive(a, fixture("cloud/template-status-approved"));

    await expect(processChannelEvent(id)).resolves.toBe("processed");

    const rows = await withPlatformScope("teste", (tx) =>
      tx.select().from(messageTemplate).where(eq(messageTemplate.wabaId, waba)),
    );
    expect(rows.map((row) => [row.tenantId, row.status]).sort()).toEqual(
      [
        [tenantA, "APPROVED"],
        [tenantB, "PENDING"],
      ].sort(),
    );
    await withPlatformScope("teste", (tx) => tx.delete(messageTemplate).where(eq(messageTemplate.wabaId, waba)));
  });

  it("modelo que ainda não existe aqui é ignorado (a sincronização o traz)", async () => {
    const a = await seedCloudChannel(tenantScope(tenantA), { wabaId: "100000000000001", phoneNumberId: "200000000000001" });
    setProvidersForTests([createCloudProvider()]);
    const { id } = await receive(a, fixture("cloud/template-status-approved"));

    await expect(processChannelEvent(id)).resolves.toBe("ignored");
  });
});
