import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import { withPlatformScope, withScope } from "@/db/rls";
import { channel, channelEvent, channelEvolution } from "@/db/schema";
import { evolutionCredentials } from "@/lib/channels/credentials";
import {
  processChannelEvent,
  setChannelQueueForTests,
  setInboxHandlers,
} from "@/lib/channels/events";
import {
  FIXTURE_INSTANCE_ID,
  FIXTURE_TOKEN,
  fakeEvolution,
  memoryStorage,
  seedFixtureChannel,
} from "@/lib/channels/providers/whatsapp_qr/db-test-support";
import { setProvidersForTests } from "@/lib/channels/registry";
import { fixture, fixtureText } from "@/lib/channels/test-fixtures";
import { setStorageForTests } from "@/lib/storage";
import {
  cleanUpChannels,
  createTenantRow,
  seedQrChannel,
  tenantScope,
} from "../../../../../tests/db/channels-helpers";
import { connectOwner } from "../../../../../tests/db/tenant-helpers";

/**
 * `POST /api/webhooks/whatsapp/evolution/:secret` pela API e o job `channel.inbound`, com banco
 * e as fixtures de aviso (simuladas: a medição B0 contra o servidor real está pendente). Mora
 * na pasta do módulo para sumir com ela; roda em `npm run test:db`.
 */

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

function post(secret: string, body: string, headers: Record<string, string> = {}) {
  return api.request(`/api/webhooks/whatsapp/evolution/${secret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp(), ...headers },
    body,
  });
}

describe("webhook da Evolution", () => {
  let owner: postgres.Sql;
  let tenantA: string;
  let tenantB: string;
  let queued: string[];
  let storage: ReturnType<typeof memoryStorage>;
  let evolution: ReturnType<typeof fakeEvolution>;

  beforeAll(async () => {
    owner = connectOwner();
    tenantA = await createTenantRow(owner, "evo-a");
    tenantB = await createTenantRow(owner, "evo-b");
  });

  beforeEach(() => {
    queued = [];
    storage = memoryStorage();
    evolution = fakeEvolution();
    setProvidersForTests([evolution.provider]);
    setStorageForTests(storage.storage);
    setChannelQueueForTests(async (id) => {
      queued.push(id);
    });
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    setStorageForTests(undefined);
    setChannelQueueForTests(undefined);
    setInboxHandlers({});
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from channel where tenant_id in (${tenantA}, ${tenantB})`;
      await tx`delete from audit_log where tenant_id in (${tenantA}, ${tenantB})`;
    });
  });

  afterAll(async () => {
    await cleanUpChannels(owner, [tenantA, tenantB]);
    await owner.end();
  });

  const eventsOf = (channelId: string) =>
    withPlatformScope("teste", (tx) =>
      tx.select().from(channelEvent).where(eq(channelEvent.channelId, channelId)),
    );

  const channelOf = async (id: string) =>
    (await withPlatformScope("teste", (tx) => tx.select().from(channel).where(eq(channel.id, id))))[0];

  const evolutionOf = async (id: string) =>
    (
      await withPlatformScope("teste", (tx) =>
        tx.select().from(channelEvolution).where(eq(channelEvolution.channelId, id)),
      )
    )[0];

  const auditActions = async (tenantId: string) =>
    (
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        return tx<{ action: string; target_id: string }[]>`
          select action, target_id from audit_log where tenant_id = ${tenantId} order by created_at`;
      })
    ).map((row) => `${row.action}:${row.target_id}`);

  describe("cadeia de verificação", () => {
    it("segredo desconhecido, instância errada e token errado: 401 igual, nada gravado", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA), { status: "connecting" });
      const body = fixture<Record<string, unknown>>("evolution/message-text");
      const attempts = [
        post("segredo-que-nao-existe-0000000000000000000000", JSON.stringify(body)),
        post("curto", JSON.stringify(body)),
        post(seeded.webhookSecret, JSON.stringify({ ...body, instanceId: crypto.randomUUID() })),
        post(seeded.webhookSecret, JSON.stringify({ ...body, instanceToken: "outro-token" })),
        post(seeded.webhookSecret, JSON.stringify({ ...body, instanceToken: undefined })),
        post(seeded.webhookSecret, "isto não é json"),
      ];
      const responses = await Promise.all(attempts);
      const bodies = await Promise.all(responses.map((response) => response.text()));

      expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
      // Sem detalhe: quem está de fora não distingue o motivo.
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toMatch(/instance|token|segredo/i);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
      expect(queued).toHaveLength(0);
    });

    it("segredo do tenant A com a instância e o token do tenant B: 401, B intocado", async () => {
      const a = await seedQrChannel(tenantScope(tenantA), { status: "connected" });
      const b = await seedFixtureChannel(tenantScope(tenantB), { status: "connected" });

      const response = await post(a.webhookSecret, fixtureText("evolution/logged-out"));

      expect(response.status).toBe(401);
      expect(await eventsOf(a.id)).toHaveLength(0);
      expect(await eventsOf(b.id)).toHaveLength(0);
      expect((await channelOf(b.id))?.status).toBe("connected");
    });

    it("20 falhas do mesmo IP por minuto; depois, 429", async () => {
      const headers = { "X-Forwarded-For": "10.99.99.99" };
      const statuses: number[] = [];

      for (let i = 0; i < 21; i++) {
        statuses.push((await post("segredo-que-nao-existe-0000000000000000000000", "{}", headers)).status);
      }

      expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
      expect(statuses[20]).toBe(429);
    });

    it("acima de 25 MB: 413, antes de procurar a instância", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      const response = await post(seeded.webhookSecret, "{}", {
        "Content-Length": String(25 * 1024 * 1024 + 1),
      });

      expect(response.status).toBe(413);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
    });
  });

  describe("recebimento", () => {
    it("aviso válido: 200, grava pending sem o token da instância e enfileira", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      const response = await post(seeded.webhookSecret, fixtureText("evolution/message-text"));
      const [event] = await eventsOf(seeded.id);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
      expect(event).toMatchObject({
        tenantId: tenantA,
        provider: "whatsapp_qr",
        kind: "message",
        status: "pending",
        dedupeKey: "MESSAGE:3EB0AAAA0001",
      });
      expect(JSON.stringify(event?.raw)).not.toContain(FIXTURE_TOKEN);
      expect(queued).toEqual([event?.id]);
    });

    it("reentrega (dedupe_key da Evolution): 200, um só evento", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      const body = fixtureText("evolution/receipt-delivered");

      await post(seeded.webhookSecret, body);
      const again = await post(seeded.webhookSecret, body);
      const events = await eventsOf(seeded.id);

      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ received: true, status: "duplicate" });
      expect(events).toHaveLength(1);
      expect(events[0]?.dedupeKey).toBe("RECEIPT:delivered:3EB0OUT00001,3EB0OUT00002");
    });

    it("canal disabled: 200 e descarta (nem lê o corpo)", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA), { status: "disabled" });
      const response = await post(seeded.webhookSecret, "corpo qualquer, nem é lido");

      expect(response.status).toBe(200);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
      expect(queued).toHaveLength(0);
    });

    it("módulo desligado neste servidor: 503, para a Evolution tentar depois", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      setProvidersForTests([]);

      expect((await post(seeded.webhookSecret, fixtureText("evolution/message-text"))).status).toBe(503);
    });
  });

  describe("mídia", () => {
    it("base64 vai ao armazenamento sob inbound/ e não ao raw", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      const name = "evolution/message-image-base64-caption";
      const base64 = fixture<{ data: { Message: { base64: string } } }>(name).data.Message.base64;

      const response = await post(seeded.webhookSecret, fixtureText(name));
      const [event] = await eventsOf(seeded.id);
      const [key] = [...storage.objects.keys()];
      const raw = event?.raw as { data: { Message: { base64: unknown } } };

      expect(response.status).toBe(200);
      expect(key).toMatch(/^inbound\/[A-Za-z0-9_-]{32}$/);
      expect(storage.objects.get(key ?? "")?.body.equals(Buffer.from(base64, "base64"))).toBe(true);
      expect(storage.objects.get(key ?? "")?.contentType).toBe("image/jpeg");
      expect(JSON.stringify(raw)).not.toContain(base64);
      expect(raw.data.Message.base64).toEqual({
        storageKey: key,
        mime: "image/jpeg",
        size: Buffer.from(base64, "base64").byteLength,
      });
    });

    it("reentrega de aviso com mídia não sobe o objeto de novo", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      const body = fixtureText("evolution/message-audio-base64");

      await post(seeded.webhookSecret, body);
      await post(seeded.webhookSecret, body);

      expect(storage.objects.size).toBe(1);
    });

    it("evento ignored apaga o objeto; processado pela caixa de entrada, mantém", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));

      await post(seeded.webhookSecret, fixtureText("evolution/message-audio-base64"));
      await expect(processChannelEvent(queued[0] ?? "")).resolves.toBe("ignored");
      expect(storage.objects.size).toBe(0);

      setInboxHandlers({ message: async () => true });
      await post(seeded.webhookSecret, fixtureText("evolution/message-image-base64-caption"));
      await expect(processChannelEvent(queued[1] ?? "")).resolves.toBe("processed");
      expect(storage.objects.size).toBe(1);
    });

    it("falha definitiva (última tentativa) apaga o objeto", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      setInboxHandlers({
        message: async () => {
          throw new Error("falhou");
        },
      });

      await post(seeded.webhookSecret, fixtureText("evolution/message-audio-base64"));
      await expect(processChannelEvent(queued[0] ?? "")).rejects.toThrow();
      expect(storage.objects.size).toBe(1);

      await expect(processChannelEvent(queued[0] ?? "", { lastAttempt: true })).rejects.toThrow();
      expect(storage.objects.size).toBe(0);
      expect((await eventsOf(seeded.id))[0]?.status).toBe("failed");
    });

    it("mediaUrl de origem fora da lista é ignorada, sem baixar", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));

      await post(seeded.webhookSecret, fixtureText("evolution/message-image-mediaurl"));
      const before = evolution.fetchFn.mock.calls.length;

      await expect(processChannelEvent(queued[0] ?? "")).resolves.toBe("ignored");
      const [event] = await eventsOf(seeded.id);

      expect(event?.status).toBe("ignored");
      expect(event?.error).toContain("fora da lista");
      expect(evolution.fetchFn.mock.calls.length).toBe(before);
      expect(storage.objects.size).toBe(0);
    });

    it("mediaUrl de origem listada: 404 vira failed na hora; 200 vai ao armazenamento", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA));
      let status = 404;
      const downloads: string[] = [];
      const listed = fakeEvolution(
        {},
        {
          mediaOrigins: ["https://s3.exemplo.test"],
          fetchFn: async (input) => {
            downloads.push(String(input));
            return new Response(status === 200 ? "jpeg" : "", { status });
          },
        },
      );
      setProvidersForTests([listed.provider]);
      setInboxHandlers({ message: async () => true });

      await post(seeded.webhookSecret, fixtureText("evolution/message-image-mediaurl"));
      await expect(processChannelEvent(queued[0] ?? "")).resolves.toBe("failed");
      let [event] = await eventsOf(seeded.id);
      expect(event).toMatchObject({ status: "failed", attempts: 1 });
      expect(event?.error).toContain("404");
      // O motivo gravado não leva o endereço (tem assinatura na query).
      expect(event?.error).not.toContain("X-Amz");

      status = 200;
      await withPlatformScope("teste", (tx) =>
        tx.update(channelEvent).set({ status: "pending" }).where(eq(channelEvent.id, event?.id ?? "")),
      );
      await expect(processChannelEvent(queued[0] ?? "")).resolves.toBe("processed");
      [event] = await eventsOf(seeded.id);

      expect(downloads).toHaveLength(2);
      expect(storage.objects.size).toBe(1);
      expect(event?.raw).toMatchObject({
        data: {
          Message: {
            base64: { storageKey: [...storage.objects.keys()][0], mime: "image/jpeg", size: 4 },
          },
        },
      });
    });
  });

  describe("eventos de conexão", () => {
    it("Connected: canal conectado, telefone e JID gravados, auditoria", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA), { status: "connecting" });

      await post(seeded.webhookSecret, fixtureText("evolution/connected"));
      await expect(processChannelEvent(queued[0] ?? "")).resolves.toBe("processed");

      expect(await channelOf(seeded.id)).toMatchObject({
        status: "connected",
        identifier: "5511999990001",
        statusDetail: null,
      });
      expect((await channelOf(seeded.id))?.connectedAt).toBeInstanceOf(Date);
      expect(await evolutionOf(seeded.id)).toMatchObject({
        connectedPhone: "5511999990001",
        connectedJid: "5511999990001:12@s.whatsapp.net",
      });
      expect(await auditActions(tenantA)).toEqual([`channel.connected:${seeded.id}`]);
    });

    it("LoggedOut: desconectado, com o motivo; o telefone conectado fica", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA), { status: "connecting" });

      await post(seeded.webhookSecret, fixtureText("evolution/connected"));
      await post(seeded.webhookSecret, fixtureText("evolution/logged-out"));
      for (const id of queued) await processChannelEvent(id);

      expect(await channelOf(seeded.id)).toMatchObject({
        status: "disconnected",
        statusDetail: "Desconectado no celular.",
      });
      expect((await evolutionOf(seeded.id))?.connectedPhone).toBe("5511999990001");
      expect(await auditActions(tenantA)).toEqual([
        `channel.connected:${seeded.id}`,
        `channel.disconnected:${seeded.id}`,
      ]);
    });

    it("o mesmo aviso de novo não audita duas vezes", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantA), { status: "connecting" });

      await post(seeded.webhookSecret, fixtureText("evolution/connected"));
      await post(seeded.webhookSecret, fixtureText("evolution/pair-success"));
      for (const id of queued) await processChannelEvent(id);

      expect(queued).toHaveLength(2);
      expect(await auditActions(tenantA)).toEqual([`channel.connected:${seeded.id}`]);
    });

    it("mesmo número reconecta em canal novo: o antigo (desativado) é readotado", async () => {
      const scope = tenantScope(tenantA);
      const old = await seedQrChannel(scope, { name: "Antigo", status: "disabled" });
      await withScope(scope, (tx) =>
        tx
          .update(channelEvolution)
          .set({
            connectedPhone: "5511999990001",
            instanceTokenEnc: null,
            webhookSecretEnc: null,
            remoteInstanceId: null,
          })
          .where(eq(channelEvolution.channelId, old.id)),
      );
      const fresh = await seedFixtureChannel(scope, {
        name: "Novo",
        status: "connecting",
        isDefault: true,
      });

      await post(fresh.webhookSecret, fixtureText("evolution/connected"));
      await post(fresh.webhookSecret, fixtureText("evolution/message-text"));
      await expect(processChannelEvent(queued[0] ?? "")).resolves.not.toBe("failed");

      // O canal novo deixou de existir; o antigo voltou, com o nome novo e a instância nova.
      expect(await channelOf(fresh.id)).toBeUndefined();
      expect(await channelOf(old.id)).toMatchObject({
        name: "Novo",
        status: "connected",
        identifier: "5511999990001",
        isDefault: true,
      });

      const adopted = await evolutionOf(old.id);
      expect(adopted?.remoteInstanceId).toBe(FIXTURE_INSTANCE_ID);
      // Os segredos foram recifrados para o id do canal antigo.
      expect(adopted && evolutionCredentials(adopted)).toMatchObject({
        instanceToken: FIXTURE_TOKEN,
        webhookSecret: fresh.webhookSecret,
      });

      // O aviso que já estava na caixa seguiu para o canal antigo, e o endereço continua valendo.
      expect((await eventsOf(old.id)).map((event) => event.kind).sort()).toEqual([
        "connection",
        "message",
      ]);
      const next = await post(fresh.webhookSecret, fixtureText("evolution/receipt-read"));
      expect(next.status).toBe(200);
      expect(await eventsOf(old.id)).toHaveLength(3);
    });

    it("canal antigo caído (não removido): readotado, e a instância velha é apagada no servidor", async () => {
      const scope = tenantScope(tenantA);
      const oldInstance = crypto.randomUUID();
      const old = await seedQrChannel(scope, {
        name: "Caído",
        status: "disconnected",
        instanceId: oldInstance,
      });
      await withScope(scope, (tx) =>
        tx
          .update(channelEvolution)
          .set({ connectedPhone: "5511999990001" })
          .where(eq(channelEvolution.channelId, old.id)),
      );
      const fresh = await seedFixtureChannel(scope, { name: "Novo", status: "connecting" });

      await post(fresh.webhookSecret, fixtureText("evolution/connected"));
      await processChannelEvent(queued[0] ?? "");

      expect(await channelOf(fresh.id)).toBeUndefined();
      expect((await channelOf(old.id))?.status).toBe("connected");
      expect(evolution.called("DELETE", `/instance/delete/${oldInstance}`)).toHaveLength(1);
    });

    it("número de outro tenant não é readotado", async () => {
      const theirs = await seedQrChannel(tenantScope(tenantB), { name: "Do B", status: "disconnected" });
      await withScope(tenantScope(tenantB), (tx) =>
        tx
          .update(channelEvolution)
          .set({ connectedPhone: "5511999990001" })
          .where(eq(channelEvolution.channelId, theirs.id)),
      );
      const mine = await seedFixtureChannel(tenantScope(tenantA), { status: "connecting" });

      await post(mine.webhookSecret, fixtureText("evolution/connected"));
      await processChannelEvent(queued[0] ?? "");

      expect((await channelOf(mine.id))?.status).toBe("connected");
      expect(await channelOf(theirs.id)).toMatchObject({ name: "Do B", status: "disconnected" });
    });
  });
});
