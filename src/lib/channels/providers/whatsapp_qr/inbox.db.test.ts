import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import { withPlatformScope, withScope } from "@/db/rls";
import { channel, channelEvolution, chatContact, conversation, file, message } from "@/db/schema";
import {
  processChannelEvent,
  setChannelQueueForTests,
  setInboxHandlers,
} from "@/lib/channels/events";
import {
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
 * Avisos da Evolution (fixtures de B0) pela caixa de entrada: `POST` do webhook (base64 vai ao
 * armazenamento) → `channel.inbound` → ingestão. Mora na pasta do módulo para sumir com ela.
 */

let ipCounter = 0;
const nextIp = () => `10.78.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

describe("caixa de entrada com avisos da Evolution", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let queued: string[];
  let storage: ReturnType<typeof memoryStorage>;

  beforeAll(async () => {
    owner = connectOwner();
    tenantId = await createTenantRow(owner, "evo-inbox");
    setInboxHandlers(undefined);
  });

  beforeEach(() => {
    queued = [];
    storage = memoryStorage();
    setProvidersForTests([fakeEvolution().provider]);
    setStorageForTests(storage.storage);
    setChannelQueueForTests(async (id) => {
      queued.push(id);
    });
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    setStorageForTests(undefined);
    setChannelQueueForTests(undefined);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id = ${tenantId}`;
      await tx`delete from file where tenant_id = ${tenantId}`;
      await tx`delete from channel where tenant_id = ${tenantId}`;
    });
  });

  afterAll(async () => {
    await cleanUpChannels(owner, [tenantId]);
    await owner.end();
  });

  /** Entrega o aviso pelo webhook e roda o job que ele enfileirou. */
  async function deliver(secret: string, body: string) {
    const before = queued.length;
    const response = await api.request(`/api/webhooks/whatsapp/evolution/${secret}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": nextIp() },
      body,
    });
    expect(response.status).toBe(200);
    const id = queued[before];
    return id ? processChannelEvent(id) : "duplicate";
  }

  const read = <T>(fn: Parameters<typeof withPlatformScope<T>>[1]) => withPlatformScope("teste", fn);
  const messages = (channelId: string) =>
    read((tx) => tx.select().from(message).where(eq(message.channelId, channelId)).orderBy(message.createdAt));
  const threadOf = async (channelId: string) =>
    (await read((tx) => tx.select().from(conversation).where(eq(conversation.channelId, channelId))))[0];

  it("texto: contato, conversa na fila e mensagem; reentrega não duplica", async () => {
    const ch = await seedFixtureChannel(tenantScope(tenantId));

    await expect(deliver(ch.webhookSecret, fixtureText("evolution/message-text"))).resolves.toBe("processed");
    await expect(deliver(ch.webhookSecret, fixtureText("evolution/message-text"))).resolves.toBe("duplicate");

    const [contact] = await read((tx) => tx.select().from(chatContact).where(eq(chatContact.tenantId, tenantId)));
    expect(contact).toMatchObject({ phone: "5511988880001", phoneKey: "551188880001", waName: "Cliente Teste" });
    expect(await threadOf(ch.id)).toMatchObject({ status: "open", assignedUserId: null, unreadCount: 1 });
    expect((await messages(ch.id)).map((row) => row.text)).toEqual(["Oi, tudo bem?"]);
  });

  it("imagem em base64: o objeto do webhook vira file e a mensagem nasce ready", async () => {
    const ch = await seedFixtureChannel(tenantScope(tenantId));
    const name = "evolution/message-image-base64-caption";
    const base64 = fixture<{ data: { Message: { base64: string } } }>(name).data.Message.base64;

    await expect(deliver(ch.webhookSecret, fixtureText(name))).resolves.toBe("processed");

    const [row] = await messages(ch.id);
    expect(row).toMatchObject({ type: "image", mediaStatus: "ready" });
    const [stored] = await read((tx) => tx.select().from(file).where(eq(file.id, row?.fileId ?? crypto.randomUUID())));
    expect(stored).toMatchObject({ ownerType: "message", ownerId: row?.id, mime: "image/jpeg" });
    expect(stored?.size).toBe(Buffer.from(base64, "base64").byteLength);
    // Processado e referenciado: o objeto fica.
    expect(storage.objects.has(stored?.key ?? "")).toBe(true);
  });

  it("eco do celular: enviada pelo aparelho, sem somar não lida", async () => {
    const ch = await seedFixtureChannel(tenantScope(tenantId));
    await deliver(ch.webhookSecret, fixtureText("evolution/message-text"));

    await expect(deliver(ch.webhookSecret, fixtureText("evolution/send-message-echo"))).resolves.toBe("processed");

    const echo = (await messages(ch.id)).find((row) => row.providerMessageId === "3EB0OUT00002");
    expect(echo).toMatchObject({ direction: "out", senderType: "device", status: "sent", text: "Enviado pelo celular" });
    expect(await threadOf(ch.id)).toMatchObject({ unreadCount: 1, lastMessageDirection: "out" });
    // O `PushName` do eco é o do dono do número.
    const [contact] = await read((tx) => tx.select().from(chatContact).where(eq(chatContact.tenantId, tenantId)));
    expect(contact?.waName).toBe("Cliente Teste");
  });

  it("recibo de leitura da mensagem enviada a marca lida", async () => {
    const ch = await seedFixtureChannel(tenantScope(tenantId));
    await deliver(ch.webhookSecret, fixtureText("evolution/message-text"));
    const thread = await threadOf(ch.id);
    await read((tx) =>
      tx.insert(message).values({
        tenantId,
        conversationId: thread?.id ?? "",
        channelId: ch.id,
        direction: "out",
        senderType: "user",
        type: "text",
        providerMessageId: "3EB0OUT00001",
        status: "sent",
      }),
    );

    await expect(deliver(ch.webhookSecret, fixtureText("evolution/receipt-read"))).resolves.toBe("processed");

    expect((await messages(ch.id)).find((row) => row.providerMessageId === "3EB0OUT00001")?.status).toBe("read");
  });

  it("canal novo que já tem conversa conecta sem readotar o antigo (o histórico não muda de número)", async () => {
    const scope = tenantScope(tenantId);
    const old = await seedQrChannel(scope, { name: "Antigo", status: "disabled" });
    await withScope(scope, (tx) =>
      tx
        .update(channelEvolution)
        .set({ connectedPhone: "5511999990001", instanceTokenEnc: null, webhookSecretEnc: null, remoteInstanceId: null })
        .where(eq(channelEvolution.channelId, old.id)),
    );
    const fresh = await seedFixtureChannel(scope, { name: "Novo", status: "connecting" });

    // A mensagem chega e é aplicada antes do aviso de conexão.
    await expect(deliver(fresh.webhookSecret, fixtureText("evolution/message-text"))).resolves.toBe("processed");
    await expect(deliver(fresh.webhookSecret, fixtureText("evolution/connected"))).resolves.toBe("processed");

    const channels = await read((tx) => tx.select().from(channel).where(eq(channel.tenantId, tenantId)));
    expect(channels.find((row) => row.id === fresh.id)).toMatchObject({ status: "connected" });
    expect(channels.find((row) => row.id === old.id)).toMatchObject({ status: "disabled" });
    expect(await threadOf(fresh.id)).toBeDefined();
  });

  it("LID sem telefone conhecido e mensagem de grupo ficam ignored, sem contato", async () => {
    const ch = await seedFixtureChannel(tenantScope(tenantId));

    await expect(deliver(ch.webhookSecret, fixtureText("evolution/message-lid"))).resolves.toBe("ignored");
    await expect(deliver(ch.webhookSecret, fixtureText("evolution/message-group"))).resolves.toBe("ignored");

    expect(await read((tx) => tx.select().from(chatContact).where(eq(chatContact.tenantId, tenantId)))).toEqual([]);
  });
});
