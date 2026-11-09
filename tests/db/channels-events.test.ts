import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withPlatformScope } from "@/db/rls";
import { channel, channelEvent, channelEvolution, messageTemplate } from "@/db/schema";
import { pruneOldData } from "@/jobs/maintenance";
import {
  classifyEvents,
  listChannelEvents,
  processChannelEvent,
  receiveChannelEvent,
  reprocessChannelEvent,
  requeueStuckChannelEvents,
  scopeOf,
  setChannelQueueForTests,
  setInboxHandlers,
} from "@/lib/channels/events";
import { checkChannelsHealth } from "@/lib/channels/health";
import { setProvidersForTests } from "@/lib/channels/registry";
import type {
  ChannelProvider,
  NormalizedEvent,
  ProbeResult,
} from "@/lib/channels/types";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import {
  cleanUpChannels,
  createTenantRow,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "./channels-helpers";
import { connectOwner } from "./tenant-helpers";

const DAY = 86_400_000;

describe("avisos de canal", () => {
  let owner: postgres.Sql;
  let tenantA: string;
  let tenantB: string;
  const enqueued: string[] = [];

  beforeAll(async () => {
    owner = connectOwner();
    tenantA = await createTenantRow(owner, "evt-a");
    tenantB = await createTenantRow(owner, "evt-b");
    setChannelQueueForTests(async (id) => {
      enqueued.push(id);
    });
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    setInboxHandlers({});
    enqueued.length = 0;
    // O `phone_number_id` das fixtures é fixo e único no banco: cada teste começa sem canais.
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from channel where tenant_id in (${tenantA}, ${tenantB}) or name like ${"%-chtest"}`;
    });
  });

  afterAll(async () => {
    setChannelQueueForTests(undefined);
    await cleanUpChannels(owner, [tenantA, tenantB]);
    await owner.end();
  });

  const eventRow = async (id: string) =>
    (await withPlatformScope("teste", (tx) => tx.select().from(channelEvent).where(eq(channelEvent.id, id))))[0];
  const channelRow = async (id: string) =>
    (await withPlatformScope("teste", (tx) => tx.select().from(channel).where(eq(channel.id, id))))[0];

  /** Insere o aviso como o webhook o faria. */
  async function receive(
    row: { id: string; tenantId: string | null; type: "whatsapp_cloud" | "whatsapp_qr" },
    raw: unknown,
    dedupeKey = randomUUID(),
  ) {
    return receiveChannelEvent({
      scope: scopeOf(row.tenantId),
      channelId: row.id,
      provider: row.type,
      dedupeKey,
      kind: "other",
      raw,
    });
  }

  const fakeProvider = (
    type: "whatsapp_cloud" | "whatsapp_qr",
    normalize: (raw: unknown) => NormalizedEvent[],
    probe?: () => Promise<ProbeResult>,
  ) =>
    ({
      type,
      normalizeEvents: normalize,
      probe: probe ?? (async () => ({ status: "connected", detail: null })),
    }) as unknown as ChannelProvider;

  /** O corpo do aviso já é a lista de eventos normalizados: o módulo real é testado em `providers/`. */
  const passThrough = fakeProvider("whatsapp_cloud", (raw) => raw as NormalizedEvent[]);
  const message = (phoneNumberId: string): NormalizedEvent => ({
    type: "message",
    fromPhone: "5511988880001",
    fromExternalId: null,
    pushName: null,
    providerMessageId: randomUUID(),
    fromMe: false,
    messageType: "text",
    text: "oi",
    media: null,
    replyToProviderMessageId: null,
    occurredAt: new Date(),
    channelPhoneNumberId: phoneNumberId,
  });
  const approvedTemplate: NormalizedEvent = {
    type: "template",
    event: "status",
    providerTemplateId: "400000000000001",
    name: "boas_vindas",
    language: "pt_BR",
    templateStatus: "APPROVED",
    reason: null,
    wabaId: "100000000000001",
  };

  describe("recebimento", () => {
    it("grava pending; o mesmo aviso de novo é duplicado e continua pendente", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantA));
      const key = randomUUID();

      const first = await receive(seeded, { a: 1 }, key);
      const second = await receive(seeded, { a: 1 }, key);

      expect(first).toMatchObject({ duplicate: false, pending: true });
      expect(second).toEqual({ id: first.id, duplicate: true, pending: true });
    });

    it("duplicado de aviso já tratado não volta à fila", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantA));
      setProvidersForTests([fakeProvider("whatsapp_cloud", () => [])]);
      const key = randomUUID();
      const first = await receive(seeded, {}, key);
      await processChannelEvent(first.id);

      const again = await receive(seeded, {}, key);

      expect(again).toMatchObject({ id: first.id, duplicate: true, pending: false });
    });

    it("o mesmo dedupe_key em outro canal é outro aviso", async () => {
      const one = await seedCloudChannel(tenantScope(tenantA));
      const two = await seedCloudChannel(tenantScope(tenantA));
      const key = randomUUID();

      const a = await receive(one, {}, key);
      const b = await receive(two, {}, key);

      expect(a.id).not.toBe(b.id);
    });

    it("o aviso da plataforma fica sem tenant", async () => {
      const seeded = await seedCloudChannel(platformScope, { name: "Plat-chtest" });

      const received = await receive(seeded, {});

      expect((await eventRow(received.id))?.tenantId).toBeNull();
      await cleanUpChannels(owner, []);
    });

    it("classifyEvents usa o tipo do primeiro evento", () => {
      expect(classifyEvents([])).toBe("other");
      expect(
        classifyEvents([{ type: "status" } as NormalizedEvent, { type: "message" } as NormalizedEvent]),
      ).toBe("status");
    });
  });

  describe("aplicação (job channel.inbound)", () => {
    it("conexão da Evolution: muda o estado, grava telefone e JID, limpa o motivo ao conectar", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA), { status: "connecting" });
      setProvidersForTests([
        fakeProvider("whatsapp_qr", () => [
          { type: "connection", status: "connected", detail: null, phone: "5511999990001", jid: "5511999990001:12@s.whatsapp.net" },
        ]),
      ]);
      const { id } = await receive(seeded, {});

      await expect(processChannelEvent(id)).resolves.toBe("processed");

      expect(await channelRow(seeded.id)).toMatchObject({
        status: "connected",
        identifier: "5511999990001",
        statusDetail: null,
      });
      expect((await channelRow(seeded.id))?.connectedAt).not.toBeNull();
      const [evolution] = await withPlatformScope("teste", (tx) =>
        tx.select().from(channelEvolution).where(eq(channelEvolution.channelId, seeded.id)),
      );
      expect(evolution).toMatchObject({
        connectedPhone: "5511999990001",
        connectedJid: "5511999990001:12@s.whatsapp.net",
      });
      expect((await eventRow(id))).toMatchObject({ status: "processed", error: null });
    });

    it("desconectar no celular muda o estado para disconnected, com o motivo", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA), { status: "connected" });
      setProvidersForTests([
        fakeProvider("whatsapp_qr", () => [
          { type: "connection", status: "disconnected", detail: "Desconectado no celular.", phone: null, jid: null },
        ]),
      ]);
      const { id } = await receive(seeded, {});

      await processChannelEvent(id);

      expect(await channelRow(seeded.id)).toMatchObject({
        status: "disconnected",
        statusDetail: "Desconectado no celular.",
      });
    });

    it("processar de novo (retry ou job duplicado) não repete nada", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA), { status: "connecting" });
      const normalize = vi.fn(() => [
        { type: "connection", status: "connected", detail: null, phone: null, jid: null } as NormalizedEvent,
      ]);
      setProvidersForTests([fakeProvider("whatsapp_qr", normalize)]);
      const { id } = await receive(seeded, {});

      await processChannelEvent(id);
      await expect(processChannelEvent(id)).resolves.toBe("skipped");

      expect(normalize).toHaveBeenCalledTimes(1);
    });

    it("mensagem e status ficam ignored enquanto a caixa de entrada não existe", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantA));
      setProvidersForTests([passThrough]);
      const { id } = await receive(seeded, [message("200000000000001")]);

      await expect(processChannelEvent(id)).resolves.toBe("ignored");

      expect(await eventRow(id)).toMatchObject({ status: "ignored" });
    });

    it("mensagem vai ao tratador da caixa de entrada, no canal certo", async () => {
      const own = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000001" });
      const handler = vi.fn(async () => true);
      setInboxHandlers({ message: handler });
      setProvidersForTests([passThrough]);
      const { id } = await receive(own, [message("200000000000001")]);

      await expect(processChannelEvent(id)).resolves.toBe("processed");

      expect(handler).toHaveBeenCalledTimes(1);
      const call = handler.mock.calls[0] as unknown as [unknown, unknown, { id: string }];
      expect(call[2].id).toBe(own.id);
    });

    it("dois números do mesmo escopo no mesmo aplicativo: cada mudança vai ao número dela", async () => {
      const a = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000001" });
      const b = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000002" });
      const targets: string[] = [];
      setInboxHandlers({
        message: async (_tx, _scope, target) => {
          targets.push(target.id);
          return true;
        },
      });
      setProvidersForTests([passThrough]);
      // O aviso chega na chave do canal A e traz mudança dos números A e B.
      const { id } = await receive(a, [message("200000000000001"), message("200000000000002")]);

      await processChannelEvent(id);

      expect(targets).toEqual([a.id, b.id]);
    });

    it("aviso assinado pelo tenant A citando número do tenant B não toca em B", async () => {
      const a = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000001" });
      const b = await seedCloudChannel(tenantScope(tenantB), { phoneNumberId: "200000000000002" });
      const targets: string[] = [];
      setInboxHandlers({
        message: async (_tx, _scope, target) => {
          targets.push(target.id);
          return true;
        },
      });
      setProvidersForTests([passThrough]);
      const { id } = await receive(a, [message("200000000000001"), message("200000000000002")]);

      await processChannelEvent(id);

      expect(targets).toEqual([a.id]);
      expect(targets).not.toContain(b.id);
    });

    it("número da plataforma citado por aviso de tenant também é descartado", async () => {
      const a = await seedCloudChannel(tenantScope(tenantA), { phoneNumberId: "200000000000001" });
      const p = await seedCloudChannel(platformScope, {
        phoneNumberId: "200000000000002",
        name: "Plat2-chtest",
      });
      const targets: string[] = [];
      setInboxHandlers({
        message: async (_tx, _scope, target) => {
          targets.push(target.id);
          return true;
        },
      });
      setProvidersForTests([passThrough]);
      const { id } = await receive(a, [message("200000000000001"), message("200000000000002")]);

      await processChannelEvent(id);

      expect(targets).toEqual([a.id]);
      expect(targets).not.toContain(p.id);
      await cleanUpChannels(owner, []);
    });

    it("status do modelo atualiza só o modelo existente do escopo", async () => {
      const a = await seedCloudChannel(tenantScope(tenantA), { wabaId: "100000000000001" });
      const waba = "100000000000001";
      await withPlatformScope("teste", async (tx) => {
        await tx.insert(messageTemplate).values([
          { tenantId: tenantA, wabaId: waba, name: "boas_vindas", language: "pt_BR", status: "PENDING", providerTemplateId: "400000000000001" },
          { tenantId: tenantB, wabaId: waba, name: "boas_vindas", language: "pt_BR", status: "PENDING", providerTemplateId: "400000000000001" },
        ]);
      });
      setProvidersForTests([passThrough]);
      const { id } = await receive(a, [approvedTemplate]);

      await expect(processChannelEvent(id)).resolves.toBe("processed");

      const rows = await withPlatformScope("teste", (tx) =>
        tx.select().from(messageTemplate).where(eq(messageTemplate.wabaId, waba)),
      );
      expect(rows.map((row) => [row.tenantId, row.status]).sort()).toEqual(
        [[tenantA, "APPROVED"], [tenantB, "PENDING"]].sort(),
      );
      await withPlatformScope("teste", (tx) => tx.delete(messageTemplate).where(eq(messageTemplate.wabaId, waba)));
    });

    it("modelo que não existe aqui é ignorado (a sincronização o traz)", async () => {
      const a = await seedCloudChannel(tenantScope(tenantA), { wabaId: "100000000000001" });
      setProvidersForTests([passThrough]);
      const { id } = await receive(a, [approvedTemplate]);

      await expect(processChannelEvent(id)).resolves.toBe("ignored");
    });

    it("canal desativado e organização suspensa: ignored, sem aplicar nada", async () => {
      const off = await seedQrChannel(tenantScope(tenantA), { status: "disabled" });
      const normalize = vi.fn(() => []);
      setProvidersForTests([fakeProvider("whatsapp_qr", normalize)]);
      const { id } = await receive(off, {});

      await expect(processChannelEvent(id)).resolves.toBe("ignored");
      expect(await eventRow(id)).toMatchObject({ status: "ignored", error: "canal desativado" });

      const suspended = await createTenantRow(owner, "evt-sus");
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update organization set status = 'suspended' where id = ${suspended}`;
      });
      const live = await seedQrChannel(tenantScope(suspended), { status: "connected" });
      const second = await receive(live, {});

      await expect(processChannelEvent(second.id)).resolves.toBe("ignored");
      expect(await eventRow(second.id)).toMatchObject({ error: "organização inativa" });
      expect(normalize).not.toHaveBeenCalled();
      await cleanUpChannels(owner, [suspended]);
    });
  });

  describe("falhas e retry", () => {
    const boom = () => {
      throw new Error("falhou para 5511988880001 e ana@exemplo.com");
    };

    it("falha soma tentativa, guarda o erro sem telefone nem e-mail e segue pendente", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA));
      setProvidersForTests([fakeProvider("whatsapp_qr", boom)]);
      const { id } = await receive(seeded, {});

      await expect(processChannelEvent(id)).rejects.toThrow();

      const row = await eventRow(id);
      expect(row).toMatchObject({ status: "pending", attempts: 1 });
      expect(row?.error).not.toMatch(/5511988880001|ana@exemplo/);
      expect(row?.error).toContain("[número]");
    });

    it("na última tentativa o aviso vira failed", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA));
      setProvidersForTests([fakeProvider("whatsapp_qr", boom)]);
      const { id } = await receive(seeded, {});

      await expect(processChannelEvent(id, { lastAttempt: true })).rejects.toThrow();

      expect(await eventRow(id)).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("módulo desligado: erro de configuração, não ignora em silêncio", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA));
      setProvidersForTests([]);
      const { id } = await receive(seeded, {});

      await expect(processChannelEvent(id)).rejects.toThrow(/não está configurado/);
    });

    it("reprocessar: só failed ou ignored, volta a pending, zera tentativas e enfileira", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA));
      setProvidersForTests([fakeProvider("whatsapp_qr", boom)]);
      const { id } = await receive(seeded, {});
      await processChannelEvent(id, { lastAttempt: true }).catch(() => {});

      // pending não reprocessa; processed também não.
      const pending = await receive(seeded, {});
      await expect(reprocessChannelEvent(pending.id)).rejects.toMatchObject({ status: 409 });
      await expect(reprocessChannelEvent(randomUUID())).rejects.toMatchObject({ status: 404 });

      await reprocessChannelEvent(id);

      expect(await eventRow(id)).toMatchObject({ status: "pending", attempts: 0, error: null });
      expect(enqueued).toEqual([id]);

      // Aviso já processado não repete (duplicaria o efeito).
      setProvidersForTests([
        fakeProvider("whatsapp_qr", () => [
          { type: "connection", status: "connected", detail: null, phone: null, jid: null },
        ]),
      ]);
      await processChannelEvent(id);
      expect(await eventRow(id)).toMatchObject({ status: "processed" });
      await expect(reprocessChannelEvent(id)).rejects.toMatchObject({
        status: 409,
        code: "NOT_REPROCESSABLE",
      });
    });

    it("aviso parado há mais de 10 minutos volta à fila", async () => {
      const seeded = await seedQrChannel(tenantScope(tenantA));
      const stuck = await receive(seeded, {});
      const fresh = await receive(seeded, {});
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update channel_event set received_at = now() - interval '20 minutes' where id = ${stuck.id}`;
      });

      const total = await requeueStuckChannelEvents(new Date());

      expect(total).toBeGreaterThanOrEqual(1);
      expect(enqueued).toContain(stuck.id);
      expect(enqueued).not.toContain(fresh.id);
    });
  });

  describe("listagem do admin", () => {
    it("traz todos os escopos, sem o corpo bruto", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantA), { name: "Listada" });
      const { id } = await receive(seeded, { segredo: "5511988880001" });

      const { items } = await listChannelEvents({ status: "pending", page: 1 });
      const item = items.find((row) => row.id === id);

      expect(item).toMatchObject({ channelName: "Listada", status: "pending", provider: "whatsapp_cloud" });
      expect(JSON.stringify(items)).not.toContain("5511988880001");
      expect(item).not.toHaveProperty("raw");
    });
  });

  describe("retenção (maintenance.prune)", () => {
    it("apaga avisos tratados com mais de 30 dias; pendente e recente ficam", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantA));
      const make = async (status: "pending" | "processed" | "ignored" | "failed", days: number) => {
        const { id } = await receive(seeded, {});
        await owner.begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await tx`update channel_event set status = ${status}, received_at = now() - ${`${days} days`}::interval where id = ${id}`;
        });
        return id;
      };

      const old = await Promise.all([make("processed", 31), make("ignored", 40), make("failed", 35)]);
      const keepPending = await make("pending", 60);
      const keepRecent = await make("processed", 5);

      const result = await pruneOldData();

      expect(result.channelEvents).toBeGreaterThanOrEqual(3);
      for (const id of old) expect(await eventRow(id)).toBeUndefined();
      expect(await eventRow(keepPending)).toBeDefined();
      expect(await eventRow(keepRecent)).toBeDefined();
      expect(DAY).toBeGreaterThan(0);
    });
  });

  describe("saúde (channel.health)", () => {
    const mail = createMemoryProvider();

    afterEach(() => {
      setEmailProviderForTests(undefined);
      mail.reset();
    });

    it("grava o estado real e o last_seen_at; falha transitória não muda nada", async () => {
      const connected = await seedCloudChannel(tenantScope(tenantA), { status: "error" });
      const flaky = await seedCloudChannel(tenantScope(tenantA), { status: "connected" });
      setProvidersForTests([
        fakeProvider(
          "whatsapp_cloud",
          () => [],
          async () => {
            throw new Error("timeout");
          },
        ),
      ]);
      const before = await checkChannelsHealth();
      expect(before.skipped).toBeGreaterThanOrEqual(2);
      expect((await channelRow(flaky.id))?.status).toBe("connected");

      setProvidersForTests([
        fakeProvider("whatsapp_cloud", () => [], async () => ({
          status: "connected",
          detail: null,
          identifier: "+55 11 99999-0001",
        })),
      ]);
      await checkChannelsHealth();

      expect(await channelRow(connected.id)).toMatchObject({ status: "connected" });
      expect((await channelRow(connected.id))?.lastSeenAt).not.toBeNull();
    });

    it("avisa os owners uma vez por queda (connected → error), não a cada passagem", async () => {
      setEmailProviderForTests(mail);
      const tenant = await createTenantRow(owner, "health-mail");
      const user = randomUUID();
      const email = `owner-${user}@tenant-test.bizu.local`;
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into "user" (id, name, email, email_verified) values (${user}, 'Dona', ${email}, true)`;
        await tx`insert into member (organization_id, user_id, role) values (${tenant}, ${user}, 'owner')`;
      });
      const seeded = await seedCloudChannel(tenantScope(tenant), { name: "Vendas", status: "connected" });
      setProvidersForTests([
        fakeProvider("whatsapp_cloud", () => [], async () => ({
          status: "error",
          detail: "(#190) Invalid OAuth access token",
        })),
      ]);

      await checkChannelsHealth();
      await checkChannelsHealth();

      expect(await channelRow(seeded.id)).toMatchObject({
        status: "error",
        statusDetail: "(#190) Invalid OAuth access token",
      });
      const sent = mail.sent.filter((message) => message.to === email);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.subject).toContain("Vendas");

      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`delete from member where organization_id = ${tenant}`;
        await tx`delete from "user" where id = ${user}`;
      });
      await cleanUpChannels(owner, [tenant]);
    });

    it("canal desativado não é conferido", async () => {
      const off = await seedCloudChannel(tenantScope(tenantA), { status: "disabled" });
      const probe = vi.fn(async () => ({ status: "connected" as const, detail: null }));
      setProvidersForTests([fakeProvider("whatsapp_cloud", () => [], probe)]);

      await checkChannelsHealth();

      expect((await channelRow(off.id))?.status).toBe("disabled");
    });
  });
});
