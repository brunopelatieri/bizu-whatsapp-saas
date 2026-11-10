import type { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withPlatformScope } from "@/db/rls";
import { chatContact, conversation, file, message } from "@/db/schema";
import type { InboxMediaJob } from "@/jobs/queues";
import {
  processChannelEvent,
  receiveChannelEvent,
  scopeOf,
  setInboxHandlers,
} from "@/lib/channels/events";
import { createCloudProvider } from "@/lib/channels/providers/whatsapp_cloud";
import { setProvidersForTests } from "@/lib/channels/registry";
import { fixture, jsonResponse } from "@/lib/channels/test-fixtures";
import { processInboxMedia, setInboxMediaQueueForTests } from "@/lib/inbox/media";
import { setStorageForTests } from "@/lib/storage";
import type { StorageProvider } from "@/lib/storage/types";
import {
  cleanUpChannels,
  createTenantRow,
  seedCloudChannel,
  tenantScope,
} from "../../../../../tests/db/channels-helpers";
import { connectOwner } from "../../../../../tests/db/tenant-helpers";

/**
 * Avisos da Meta (fixtures de B0) pela caixa de entrada: webhook gravado → `channel.inbound` →
 * ingestão → `inbox.media`. Mora na pasta do módulo para sumir com ela; roda em `test:db`.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe("caixa de entrada com avisos da Meta", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  const jobs: InboxMediaJob[] = [];
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const storage: StorageProvider = {
    id: "local",
    async put(key, body, options) {
      objects.set(key, { body, contentType: options?.contentType });
    },
    async get() {
      return null as Readable | null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };

  beforeAll(async () => {
    owner = connectOwner();
    tenantId = await createTenantRow(owner, "cloud-inbox");
    setInboxHandlers(undefined);
    setInboxMediaQueueForTests(async (job) => {
      jobs.push(job);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setProvidersForTests(undefined);
    setStorageForTests(undefined);
    jobs.length = 0;
    objects.clear();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id = ${tenantId}`;
      await tx`delete from file where tenant_id = ${tenantId}`;
      await tx`delete from channel where tenant_id = ${tenantId}`;
    });
  });

  afterAll(async () => {
    setInboxMediaQueueForTests(undefined);
    await cleanUpChannels(owner, [tenantId]);
    await owner.end();
  });

  async function deliver(channelId: string, name: string) {
    setProvidersForTests([createCloudProvider()]);
    const { id } = await receiveChannelEvent({
      scope: scopeOf(tenantId),
      channelId,
      provider: "whatsapp_cloud",
      dedupeKey: crypto.randomUUID(),
      kind: "other",
      raw: fixture(name),
    });
    return processChannelEvent(id);
  }

  const read = <T>(fn: Parameters<typeof withPlatformScope<T>>[1]) => withPlatformScope("teste", fn);
  const messages = (channelId: string) =>
    read((tx) => tx.select().from(message).where(eq(message.channelId, channelId)));

  it("texto: contato com o nome do perfil, conversa na fila e a mensagem", async () => {
    const ch = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: "200000000000001" });

    await expect(deliver(ch.id, "cloud/message-text")).resolves.toBe("processed");
    await expect(deliver(ch.id, "cloud/message-text")).resolves.toBe("ignored");

    const [contact] = await read((tx) => tx.select().from(chatContact).where(eq(chatContact.tenantId, tenantId)));
    expect(contact).toMatchObject({ phone: "5511988880001", waName: "Cliente Teste" });
    const [thread] = await read((tx) => tx.select().from(conversation).where(eq(conversation.channelId, ch.id)));
    expect(thread).toMatchObject({ status: "open", assignedUserId: null, unreadCount: 1 });
    const rows = await messages(ch.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "Olá, quero saber o preço", direction: "in" });
    expect(rows[0]?.providerTimestamp?.toISOString()).toBe(new Date(1793620800 * 1000).toISOString());
  });

  it("imagem: pending, e o job baixa da Meta e grava com o tipo do conteúdo", async () => {
    setStorageForTests(storage);
    const ch = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: "200000000000001" });

    await deliver(ch.id, "cloud/message-image");

    const [pending] = await messages(ch.id);
    expect(pending).toMatchObject({
      type: "image",
      text: "Segue o comprovante",
      mediaStatus: "pending",
      providerMediaId: "300000000000001",
    });
    expect(jobs).toHaveLength(1);

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes("lookaside.fbsbx.com")
        ? new Response(JPEG, { headers: { "content-type": "image/jpeg" } })
        : jsonResponse("cloud/api/media-url");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(processInboxMedia(jobs[0] as InboxMediaJob)).resolves.toBe("ready");

    const [ready] = await messages(ch.id);
    expect(ready?.mediaStatus).toBe("ready");
    const [stored] = await read((tx) => tx.select().from(file).where(eq(file.id, ready?.fileId ?? crypto.randomUUID())));
    expect(stored).toMatchObject({ mime: "image/jpeg", size: JPEG.byteLength, ownerType: "message" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("status: enviada, lida e entregue fora de ordem terminam lida; falha depois de lida não volta", async () => {
    const ch = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: "200000000000001" });
    await deliver(ch.id, "cloud/message-text");
    const [thread] = await read((tx) => tx.select().from(conversation).where(eq(conversation.channelId, ch.id)));
    await read((tx) =>
      tx.insert(message).values({
        tenantId,
        conversationId: thread?.id ?? "",
        channelId: ch.id,
        direction: "out",
        senderType: "user",
        type: "text",
        text: "resposta",
        providerMessageId: "wamid.OUT0001",
        status: "queued",
      }),
    );

    await expect(deliver(ch.id, "cloud/status-sent")).resolves.toBe("processed");
    await expect(deliver(ch.id, "cloud/status-read")).resolves.toBe("processed");
    await expect(deliver(ch.id, "cloud/status-delivered")).resolves.toBe("ignored");
    await expect(deliver(ch.id, "cloud/status-failed")).resolves.toBe("ignored");

    const out = (await messages(ch.id)).find((row) => row.providerMessageId === "wamid.OUT0001");
    expect(out).toMatchObject({ status: "read", errorCode: null });
  });

  it("status failed a partir de enviada grava o código da Meta", async () => {
    const ch = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: "200000000000001" });
    await deliver(ch.id, "cloud/message-text");
    const [thread] = await read((tx) => tx.select().from(conversation).where(eq(conversation.channelId, ch.id)));
    await read((tx) =>
      tx.insert(message).values({
        tenantId,
        conversationId: thread?.id ?? "",
        channelId: ch.id,
        direction: "out",
        senderType: "user",
        type: "text",
        providerMessageId: "wamid.OUT0001",
        status: "sent",
      }),
    );

    await expect(deliver(ch.id, "cloud/status-failed")).resolves.toBe("processed");

    const out = (await messages(ch.id)).find((row) => row.providerMessageId === "wamid.OUT0001");
    expect(out).toMatchObject({ status: "failed", errorCode: "131047" });
    expect(out?.errorMessage).toContain("Re-engagement message");
  });

  it("dois números do mesmo aplicativo: cada mensagem vai à conversa do seu número", async () => {
    const a = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: "200000000000001" });
    const b = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: "200000000000002" });

    await expect(deliver(a.id, "cloud/two-numbers-same-waba")).resolves.toBe("processed");

    expect(await messages(a.id)).toHaveLength(1);
    expect(await messages(b.id)).toHaveLength(1);
  });
});
