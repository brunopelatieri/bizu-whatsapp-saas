import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPlatformScope } from "@/db/rls";
import { channel, channelEvent } from "@/db/schema";
import { startJobs } from "@/jobs";
import { getBoss, stopBoss } from "@/jobs/boss";
import { handleChannelInbound } from "@/jobs/channels";
import { type ChannelInboundJob, QUEUE, queueDefinitions, scheduleDefinitions } from "@/jobs/queues";
import { enqueueChannelEvent, receiveChannelEvent, scopeOf } from "@/lib/channels/events";
import { setProvidersForTests } from "@/lib/channels/registry";
import type { ChannelProvider, NormalizedEvent } from "@/lib/channels/types";
import { cleanUpChannels, createTenantRow, seedQrChannel, tenantScope } from "./channels-helpers";
import { connectOwner } from "./tenant-helpers";

/**
 * A fila de verdade: política `exclusive`, retry, o aviso gravado que sobrevive a um reinício e o
 * caminho enfileirar → pg-boss → worker → `channel_event`. Exige `npm run jobs:install`.
 */

let owner: postgres.Sql;
let jobs: Awaited<ReturnType<typeof startJobs>>;
let tenantId: string;

const connected: NormalizedEvent = {
  type: "connection",
  status: "connected",
  detail: null,
  phone: "5511999990001",
  jid: null,
};

const provider = (normalize: () => NormalizedEvent[]) =>
  ({ type: "whatsapp_qr", normalizeEvents: normalize }) as unknown as ChannelProvider;

const eventRow = async (id: string) =>
  (await withPlatformScope("teste", (tx) => tx.select().from(channelEvent).where(eq(channelEvent.id, id))))[0];

async function waitForStatus(id: string, status: string) {
  const deadline = Date.now() + 15_000;
  let current = await eventRow(id);

  while (current?.status !== status && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await eventRow(id);
  }
  return current;
}

async function pendingEvent() {
  const seeded = await seedQrChannel(tenantScope(tenantId), { status: "connecting" });
  const received = await receiveChannelEvent({
    scope: scopeOf(tenantId),
    channelId: seeded.id,
    provider: "whatsapp_qr",
    dedupeKey: randomUUID(),
    kind: "connection",
    raw: {},
  });

  return { seeded, id: received.id };
}

beforeAll(async () => {
  owner = connectOwner();
  tenantId = await createTenantRow(owner, "queue");
  setProvidersForTests([provider(() => [connected])]);
  jobs = await startJobs({ pollingIntervalSeconds: 0.5 });
});

afterAll(async () => {
  setProvidersForTests(undefined);
  await jobs.stop();
  await stopBoss();
  await cleanUpChannels(owner, [tenantId]);
  await owner.end();
});

describe("filas de canal", () => {
  it("toda fila agendada existe e tem dead letter", () => {
    const names = new Set(queueDefinitions.map(({ name }) => name));

    for (const { queue } of scheduleDefinitions) expect(names.has(queue)).toBe(true);
    for (const { options } of queueDefinitions) {
      if (options.deadLetter) expect(names.has(options.deadLetter)).toBe(true);
    }
  });

  it("channel.inbound: exclusive, 5 tentativas com backoff e fila morta", async () => {
    const boss = await getBoss();

    expect(await boss.getQueue(QUEUE.channelInbound)).toMatchObject({
      policy: "exclusive",
      retryLimit: 5,
      retryBackoff: true,
      retryDelay: 30,
      deadLetter: QUEUE.channelInboundDead,
    });
    expect(await boss.getQueue(QUEUE.channelInboundDead)).not.toBeNull();
  });

  it("channel.health: cron de 15 em 15 minutos", async () => {
    const boss = await getBoss();
    const schedule = (await boss.getSchedules()).find(({ name }) => name === QUEUE.channelHealth);

    expect(schedule?.cron).toBe("*/15 * * * *");
  });

  it("do aviso gravado ao processado, pelo worker real", async () => {
    const { seeded, id } = await pendingEvent();

    await enqueueChannelEvent(id);

    expect(await waitForStatus(id, "processed")).toMatchObject({ status: "processed" });
    const [row] = await withPlatformScope("teste", (tx) => tx.select().from(channel).where(eq(channel.id, seeded.id)));
    expect(row).toMatchObject({ status: "connected", identifier: "5511999990001" });
  });

  it("aviso gravado e servidor reiniciado antes do processamento: processa na volta", async () => {
    await jobs.stop();
    await stopBoss();
    const { id } = await pendingEvent();

    // O processo cai com o aviso na fila: nada o consome enquanto não há worker.
    await enqueueChannelEvent(id);
    expect((await eventRow(id))?.status).toBe("pending");
    await stopBoss();

    jobs = await startJobs({ pollingIntervalSeconds: 0.5 });

    expect(await waitForStatus(id, "processed")).toMatchObject({ status: "processed" });
  });

  it("singletonKey: com um job vivo, enfileirar de novo não cria outro", async () => {
    await jobs.stop();

    try {
      const boss = await getBoss();
      const key = randomUUID();

      const first = await boss.send(QUEUE.channelInbound, { channelEventId: key }, { singletonKey: key });
      const second = await boss.send(QUEUE.channelInbound, { channelEventId: key }, { singletonKey: key });

      expect(first).toEqual(expect.any(String));
      expect(second).toBeNull();

      await boss.deleteJob(QUEUE.channelInbound, first as string);
    } finally {
      await stopBoss();
      jobs = await startJobs({ pollingIntervalSeconds: 0.5 });
    }
  });

  it("na última tentativa do job, o aviso vira failed", async () => {
    setProvidersForTests([
      provider(() => {
        throw new Error("falha do provedor");
      }),
    ]);
    const { id } = await pendingEvent();
    const job = {
      data: { channelEventId: id },
      retryCount: 5,
      retryLimit: 5,
    } as unknown as JobWithMetadata<ChannelInboundJob>;

    await expect(handleChannelInbound([job])).rejects.toThrow("falha do provedor");

    expect(await eventRow(id)).toMatchObject({ status: "failed", attempts: 1 });
    setProvidersForTests([provider(() => [connected])]);
  });
});
