import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, conversation, message } from "@/db/schema";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { ProviderError } from "@/lib/channels/errors";
import { setProvidersForTests } from "@/lib/channels/registry";
import type { ChannelProvider, SendResult, SendText } from "@/lib/channels/types";
import { sweepQueuedMessages, UNKNOWN_RESULT } from "@/lib/inbox/send";
import { bodyOf } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, seedQrChannel, tenantScope } from "./channels-helpers";
import { readAll, seedConversation, seedMessage } from "./inbox-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * Envio de texto (SPEC, passo 4), pela API, com o provedor simulado: sucesso, recusa (fica
 * `failed`), sem resposta (fica `queued` e a varredura decide), `clientId` repetido, resposta que
 * assume, janela de 24 h e reenvio.
 */

type View = {
  id: string;
  status: string | null;
  text: string | null;
  error: { code: string | null; message: string | null } | null;
  sender: { id: string } | null;
};

describe("/api/inbox: envio de texto", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let cloudId: string;
  let qrId: string;
  let downId: string;
  const users: Record<string, TestUser> = {};
  const sent: SendText[] = [];
  let reply: (input: SendText) => Promise<SendResult>;

  const fake = (type: "whatsapp_cloud" | "whatsapp_qr") =>
    ({
      type,
      sendText: async (_ctx: unknown, input: SendText) => {
        sent.push(input);
        return reply(input);
      },
    }) as unknown as ChannelProvider;

  beforeAll(async () => {
    owner = connectOwner();
    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;
    for (const role of ["admin", "memberA", "memberB"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, role === "admin" ? "admin" : "member");
      users[role] = user;
    }
    cloudId = (await seedCloudChannel(tenantScope(tenantId))).id;
    qrId = (await seedQrChannel(tenantScope(tenantId))).id;
    downId = (await seedCloudChannel(tenantScope(tenantId), { status: "disconnected" })).id;
  });

  beforeEach(() => {
    setProvidersForTests([fake("whatsapp_cloud"), fake("whatsapp_qr")]);
    reply = async () => ({ providerMessageId: `wamid.${randomUUID()}` });
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    sent.length = 0;
    await waitForBackgroundTasks();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id = ${tenantId}`;
    });
  });

  afterAll(async () => {
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);
  const clientId = () => `c-${randomUUID()}`;

  const send = (role: string, conversationId: string, body: Record<string, unknown>) =>
    call("POST", `/api/inbox/conversations/${conversationId}/messages`, {
      cookie: as(role),
      body: { type: "text", clientId: clientId(), ...body },
    });

  const conversationRow = async (id: string) =>
    (await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, id))))[0];
  const messagesOf = (conversationId: string) =>
    readAll((tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)));

  it("envia, grava sent com o id do provedor e assume a conversa da fila", async () => {
    const q = await seedConversation(scope(), cloudId, { unreadCount: 4 });

    const response = await send("memberA", q.id, { text: "Olá, tudo bem?" });
    expect(response.status).toBe(201);
    const view = (await bodyOf(response)).message as View;
    expect(view).toMatchObject({ status: "sent", text: "Olá, tudo bem?", sender: { id: users.memberA?.id } });

    expect(sent).toEqual([{ to: q.phone, text: "Olá, tudo bem?" }]);
    const [row] = await messagesOf(q.id);
    expect(row?.providerMessageId).toMatch(/^wamid\./);

    expect(await conversationRow(q.id)).toMatchObject({
      assignedUserId: users.memberA?.id,
      unreadCount: 0,
      lastMessageDirection: "out",
      lastMessagePreview: "Olá, tudo bem?",
    });

    const audits = await readAll((tx) => tx.select().from(auditLog).where(eq(auditLog.targetId, q.id)));
    const claimed = audits.find((entry) => entry.action === "inbox.conversation_claimed");
    expect(claimed?.metadata).toEqual({ via: "reply" });
    // Conteúdo nunca vai à auditoria.
    expect(JSON.stringify(audits)).not.toContain("Olá");
  });

  it("clientId repetido devolve a mesma mensagem e não envia de novo", async () => {
    const q = await seedConversation(scope(), cloudId);
    const id = clientId();

    const first = await send("memberA", q.id, { text: "uma vez", clientId: id });
    const second = await send("memberA", q.id, { text: "uma vez", clientId: id });

    expect(((await bodyOf(first)).message as View).id).toBe(((await bodyOf(second)).message as View).id);
    expect(sent).toHaveLength(1);
    expect(await messagesOf(q.id)).toHaveLength(1);
  });

  it("recusa do provedor: 200 com a mensagem failed e o motivo; reenviar troca pela nova", async () => {
    const q = await seedConversation(scope(), cloudId);
    reply = async () => {
      throw new ProviderError("(#131026) Mensagem não entregável", 400, 131026);
    };

    const response = await send("memberA", q.id, { text: "vai falhar" });
    expect(response.status).toBe(200);
    const failed = (await bodyOf(response)).message as View;
    expect(failed).toMatchObject({ status: "failed", error: { code: "131026" } });

    reply = async () => ({ providerMessageId: "wamid.retry" });
    const retried = await call("POST", `/api/inbox/messages/${failed.id}/retry`, { cookie: as("memberA") });
    expect(retried.status).toBe(201);
    const view = (await bodyOf(retried)).message as View;
    expect(view).toMatchObject({ status: "sent", text: "vai falhar" });
    expect(view.id).not.toBe(failed.id);

    const rows = await messagesOf(q.id);
    expect(rows.map((row) => row.id)).toEqual([view.id]);

    // Reenviar o que não falhou (ou já foi trocado) não é possível.
    expect((await call("POST", `/api/inbox/messages/${view.id}/retry`, { cookie: as("memberA") })).status).toBe(409);
    expect((await call("POST", `/api/inbox/messages/${failed.id}/retry`, { cookie: as("memberA") })).status).toBe(404);
  });

  it("sem resposta do provedor: fica queued, e a varredura marca UNKNOWN_RESULT depois de 2 min", async () => {
    const q = await seedConversation(scope(), cloudId);
    reply = async () => {
      throw new ProviderError("tempo esgotado", 0);
    };

    const response = await send("memberA", q.id, { text: "e aí?" });
    expect(response.status).toBe(201);
    const view = (await bodyOf(response)).message as View;
    expect(view.status).toBe("queued");

    // Recente: a varredura não toca.
    await sweepQueuedMessages();
    expect((await messagesOf(q.id))[0]?.status).toBe("queued");

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`update message set created_at = now() - interval '3 minutes' where id = ${view.id}`;
    });
    expect(await sweepQueuedMessages()).toBeGreaterThanOrEqual(1);

    const [row] = await messagesOf(q.id);
    expect(row).toMatchObject({ status: "failed", errorCode: UNKNOWN_RESULT });
  });

  it("janela de 24 h: Cloud com a última mensagem do contato há 25 h é 409; QR envia", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const cloud = await seedConversation(scope(), cloudId, { lastInboundAt: old, lastMessageAt: old });
    const qr = await seedConversation(scope(), qrId, { lastInboundAt: old, lastMessageAt: old });

    const closed = await send("memberA", cloud.id, { text: "oi" });
    expect(closed.status).toBe(409);
    expect(await bodyOf(closed)).toMatchObject({ code: "SESSION_WINDOW_CLOSED" });
    expect(await messagesOf(cloud.id)).toHaveLength(0);

    expect((await send("memberA", qr.id, { text: "oi" })).status).toBe(201);
  });

  it("canal desconectado: 409 CHANNEL_NOT_CONNECTED, nada gravado", async () => {
    const q = await seedConversation(scope(), downId);
    const response = await send("memberA", q.id, { text: "oi" });
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({ code: "CHANNEL_NOT_CONNECTED" });
    expect(await messagesOf(q.id)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("o supervisor responde a conversa de outro sem tomar o dono; encerrada reabre", async () => {
    const b = await seedConversation(scope(), cloudId, { assignedUserId: users.memberB?.id, status: "closed" });

    expect((await send("admin", b.id, { text: "posso ajudar?" })).status).toBe(201);
    expect(await conversationRow(b.id)).toMatchObject({
      assignedUserId: users.memberB?.id,
      status: "open",
      closedAt: null,
    });
  });

  it("o membro não envia na conversa de outro (404) e a citação precisa ser da conversa", async () => {
    const b = await seedConversation(scope(), cloudId, { assignedUserId: users.memberB?.id });
    expect((await send("memberA", b.id, { text: "intruso" })).status).toBe(404);
    expect(sent).toHaveLength(0);

    const q = await seedConversation(scope(), cloudId);
    const elsewhere = await seedMessage(scope(), { conversationId: b.id, channelId: cloudId });
    const invalid = await send("memberA", q.id, { text: "citando", replyTo: elsewhere.id });
    expect(invalid.status).toBe(400);
    expect(await bodyOf(invalid)).toMatchObject({ code: "INVALID_REPLY" });

    const own = await seedMessage(scope(), { conversationId: q.id, channelId: cloudId });
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`update message set provider_message_id = 'wamid.IN1' where id = ${own.id}`;
    });
    expect((await send("memberA", q.id, { text: "citando", replyTo: own.id })).status).toBe(201);
    expect(sent.at(-1)).toEqual({ to: q.phone, text: "citando", quotedProviderMessageId: "wamid.IN1" });
  });

  it("eco do aparelho gravado antes do id: a mensagem do sistema fica, o eco sai", async () => {
    const q = await seedConversation(scope(), qrId);
    reply = async () => {
      // O eco (Evolution) chega antes de a resposta do envio ser gravada.
      const echo = await seedMessage(scope(), { conversationId: q.id, channelId: qrId }, { direction: "out" });
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update message set sender_type = 'device', provider_message_id = 'echo-1' where id = ${echo.id}`;
      });
      return { providerMessageId: "echo-1" };
    };

    expect((await send("memberA", q.id, { text: "do sistema" })).status).toBe(201);
    const rows = await readAll((tx) =>
      tx.select().from(message).where(and(eq(message.conversationId, q.id), eq(message.providerMessageId, "echo-1"))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ senderType: "user", status: "sent" });
  });

  it("valida o corpo: texto vazio, longo demais, tipo sem suporte e clientId ruim são 400", async () => {
    const q = await seedConversation(scope(), cloudId);
    for (const body of [
      { text: "   " },
      { text: "x".repeat(4097) },
      { type: "template", text: "oi" },
      { text: "oi", clientId: "a b" },
    ]) {
      expect((await send("memberA", q.id, body)).status).toBe(400);
    }
  });
});
