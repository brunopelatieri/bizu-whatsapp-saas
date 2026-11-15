import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, conversation, message } from "@/db/schema";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { ProviderError } from "@/lib/channels/errors";
import { setProvidersForTests } from "@/lib/channels/registry";
import type { ChannelProvider, SendResult, SendText } from "@/lib/channels/types";
import { bodyOf, makePlatformUser } from "./billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "./channels-helpers";
import { readAll, seedConversation, seedConversationOnContact } from "./inbox-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * X2, "Continuar por outro número": `GET .../conversations/:id/transfer-channels` e
 * `POST .../conversations/:id/transfer`, nos dois escopos, com Postgres real e o provedor simulado. A
 * conversa com o **mesmo contato** segue por outro número do escopo; o servidor revalida tudo e quem
 * não alcança a origem recebe o mesmo 404 de id inexistente.
 */

type Option = {
  channel: { id: string; name: string; type: string };
  eligible: boolean;
  reason: string | null;
};

const TENANT = "/api/inbox";
const PLATFORM = "/api/admin/inbox";
const DAY = 24 * 60 * 60 * 1000;
const longAgo = () => new Date(Date.now() - 3 * DAY);

describe("continuar a conversa por outro número (X2)", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  let cloudId: string;
  let qrId: string;
  let downId: string;
  let disabledId: string;
  let otherTenantChannelId: string;
  let platformCloudId: string;
  let platformQrId: string;
  const users: Record<string, TestUser> = {};
  const phoneKeys: string[] = [];
  const sent: (SendText & { via: string })[] = [];
  let reply: (input: SendText) => Promise<SendResult>;

  const fake = (type: "whatsapp_cloud" | "whatsapp_qr") =>
    ({
      type,
      sendText: async (_ctx: unknown, input: SendText) => {
        sent.push({ ...input, via: type });
        return reply(input);
      },
    }) as unknown as ChannelProvider;

  beforeAll(async () => {
    owner = connectOwner();
    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner, "Clínica X2")).id;
    users.stranger = await createUser(owner);
    otherTenantId = (await createTenant(users.stranger, "Outra Clínica X2")).id;
    // `memberC`: o limite da rota é de 20 por minuto por pessoa; os pedidos se dividem entre A e C.
    for (const role of ["memberA", "memberB", "memberC"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, "member");
      users[role] = user;
    }
    await createRole(users.owner, "sem-atendimento", ["customer:read"]);
    users.noInbox = await createUser(owner);
    await addMember(owner, tenantId, users.noInbox, "sem-atendimento");
    await createRole(users.owner, "so-leitura", ["inbox:read"]);
    users.reader = await createUser(owner);
    await addMember(owner, tenantId, users.reader, "so-leitura");

    cloudId = (await seedCloudChannel(tenantScope(tenantId), { name: "Oficial-x2" })).id;
    qrId = (await seedQrChannel(tenantScope(tenantId), { name: "Vendas-x2" })).id;
    downId = (await seedQrChannel(tenantScope(tenantId), { name: "Caido-x2", status: "disconnected" })).id;
    disabledId = (await seedQrChannel(tenantScope(tenantId), { name: "Desativado-x2", status: "disabled" })).id;
    otherTenantChannelId = (await seedQrChannel(tenantScope(otherTenantId), { name: "Alheio-x2" })).id;
    platformCloudId = (await seedCloudChannel(platformScope, { name: "PlataformaA-x2-chtest" })).id;
    platformQrId = (await seedQrChannel(platformScope, { name: "PlataformaB-x2-chtest" })).id;

    users.support = await makePlatformUser(owner, "platform_support");
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
      await tx`delete from chat_contact where tenant_id in (${tenantId}, ${otherTenantId})`;
      await tx`delete from chat_contact where tenant_id is null and phone_key = any(${phoneKeys})`;
    });
    phoneKeys.length = 0;
  });

  afterAll(async () => {
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner`delete from "user" where id = ${users.support?.id as string}`;
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);
  const clientId = () => `x2-${randomUUID()}`;

  const transfer = (
    base: string,
    role: string,
    conversationId: string,
    body: Record<string, unknown>,
  ) =>
    call("POST", `${base}/conversations/${conversationId}/transfer`, {
      cookie: as(role),
      body: { text: "Oi, seguimos por aqui.", clientId: clientId(), ...body },
    });
  const optionsOf = async (base: string, role: string, conversationId: string) =>
    call("GET", `${base}/conversations/${conversationId}/transfer-channels`, { cookie: as(role) });

  const conversationsOf = (contactId: string) =>
    readAll((tx) => tx.select().from(conversation).where(eq(conversation.contactId, contactId)));
  const conversationRow = async (id: string) =>
    (await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, id))))[0];
  const messagesOf = (conversationId: string) =>
    readAll((tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)));

  /** Conversa de origem no número oficial, com a janela de 24 h encerrada (a entrada da faixa). */
  const closedWindowOrigin = (seed: { assignedUserId?: string | null } = {}) =>
    seedConversation(scope(), cloudId, { ...seed, lastInboundAt: longAgo(), lastMessageAt: longAgo() });

  describe("tenant: enviar", () => {
    it("cria a conversa do mesmo contato no outro número, envia por ele e audita só ids", async () => {
      const origin = await closedWindowOrigin();
      const before = await conversationRow(origin.id);

      const response = await transfer(TENANT, "memberA", origin.id, {
        channelId: qrId,
        text: "Texto que não vai à auditoria",
      });
      expect(response.status).toBe(201);
      const body = await bodyOf(response);
      const destinationId = body.conversationId as string;
      expect(Object.keys(body).sort()).toEqual(["conversationId", "message"]);
      expect(destinationId).not.toBe(origin.id);
      expect(body.message).toMatchObject({
        conversationId: destinationId,
        status: "sent",
        text: "Texto que não vai à auditoria",
        sender: { id: users.memberA?.id },
      });

      // Saiu pelo número de destino, para o telefone do contato da origem.
      expect(sent).toEqual([{ to: origin.phone, text: "Texto que não vai à auditoria", via: "whatsapp_qr" }]);

      expect(await conversationRow(destinationId)).toMatchObject({
        tenantId,
        channelId: qrId,
        contactId: origin.contactId,
        status: "open",
        assignedUserId: users.memberA?.id,
        lastMessageDirection: "out",
        unreadCount: 0,
      });
      // A origem não é tocada: nem dono, nem situação, nem prévia.
      expect(await conversationRow(origin.id)).toEqual(before);
      expect(await messagesOf(origin.id)).toHaveLength(0);

      const audits = await readAll((tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, destinationId)),
      );
      expect(audits.map((row) => row.action).sort()).toEqual([
        "inbox.conversation_claimed",
        "inbox.conversation_continued",
      ]);
      expect(audits.find((row) => row.action === "inbox.conversation_claimed")?.metadata).toEqual({
        via: "transfer",
      });
      expect(audits.find((row) => row.action === "inbox.conversation_continued")).toMatchObject({
        tenantId,
        actorId: users.memberA?.id,
        metadata: { fromConversationId: origin.id, channelId: qrId, created: true },
      });
      const audited = JSON.stringify(audits);
      expect(audited).not.toContain("Texto que não vai");
      expect(audited).not.toContain(origin.phone);
    });

    it("clientId repetido: uma conversa, uma mensagem e um envio só", async () => {
      const origin = await closedWindowOrigin();
      const id = clientId();
      const body = { channelId: qrId, clientId: id };

      const first = await transfer(TENANT, "memberA", origin.id, body);
      const second = await transfer(TENANT, "memberA", origin.id, body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const a = await bodyOf(first);
      const b = await bodyOf(second);
      expect(b.conversationId).toBe(a.conversationId);
      expect((b.message as { id: string }).id).toBe((a.message as { id: string }).id);

      expect(sent).toHaveLength(1);
      expect(await conversationsOf(origin.contactId)).toHaveLength(2);
      expect(await messagesOf(a.conversationId as string)).toHaveLength(1);
      const continued = await readAll((tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, a.conversationId as string)),
      );
      expect(continued.filter((row) => row.action === "inbox.conversation_continued")).toHaveLength(1);
    });

    it("clientId repetido depois de o número cair: devolve a mesma mensagem, sem recusar nem reenviar", async () => {
      const origin = await closedWindowOrigin();
      const body = { channelId: qrId, clientId: clientId() };
      const setStatus = (status: string) =>
        owner.begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await tx`update channel set status = ${status} where id = ${qrId}`;
        });

      const first = await transfer(TENANT, "memberA", origin.id, body);
      expect(first.status).toBe(201);
      await setStatus("disconnected");
      try {
        const second = await transfer(TENANT, "memberA", origin.id, body);
        expect(second.status).toBe(201);
        expect((await bodyOf(second)).message).toMatchObject({
          id: ((await bodyOf(first)).message as { id: string }).id,
          status: "sent",
        });
        expect(sent).toHaveLength(1);

        // Outro pedido (clientId novo) pelo número caído segue recusado.
        const fresh = await transfer(TENANT, "memberA", origin.id, { channelId: qrId });
        expect(fresh.status).toBe(409);
        expect((await bodyOf(fresh)).code).toBe("CHANNEL_NOT_CONNECTED");
      } finally {
        await setStatus("connected");
      }
    });

    it("dois pedidos ao mesmo tempo não criam duas conversas nem enviam duas vezes", async () => {
      const origin = await closedWindowOrigin();
      const body = { channelId: qrId, clientId: clientId() };

      const responses = await Promise.all([
        transfer(TENANT, "memberA", origin.id, body),
        transfer(TENANT, "memberA", origin.id, body),
      ]);
      expect(responses.map((response) => response.status)).toEqual([201, 201]);

      expect(sent).toHaveLength(1);
      const rows = await conversationsOf(origin.contactId);
      expect(rows).toHaveLength(2);
      const destination = rows.find((row) => row.channelId === qrId);
      expect(await messagesOf(destination?.id as string)).toHaveLength(1);
    });

    it("conversa que já existe no destino: a da fila é assumida e a encerrada reabre", async () => {
      const origin = await closedWindowOrigin();
      const existing = await seedConversationOnContact(scope(), qrId, origin.contactId, {
        status: "closed",
      });

      const response = await transfer(TENANT, "memberA", origin.id, { channelId: qrId });
      expect(response.status).toBe(201);
      expect((await bodyOf(response)).conversationId).toBe(existing.id);

      expect(await conversationRow(existing.id)).toMatchObject({
        status: "open",
        assignedUserId: users.memberA?.id,
      });
      const audits = await readAll((tx) => tx.select().from(auditLog).where(eq(auditLog.targetId, existing.id)));
      expect(audits.find((row) => row.action === "inbox.conversation_continued")?.metadata).toMatchObject({
        created: false,
      });
    });

    it("recusa do provedor: 200 com a mensagem failed, e a conversa de destino fica", async () => {
      const origin = await closedWindowOrigin();
      reply = async () => {
        throw new ProviderError("(#131026) Mensagem não entregável", 400, 131026);
      };

      const response = await transfer(TENANT, "memberA", origin.id, { channelId: qrId });
      expect(response.status).toBe(200);
      const body = await bodyOf(response);
      expect(body.message).toMatchObject({ status: "failed" });
      expect(await conversationRow(body.conversationId as string)).toMatchObject({ channelId: qrId });
    });

    it("valida o corpo: texto vazio, sem clientId, número malformado e campo a mais são 400", async () => {
      const origin = await closedWindowOrigin();
      const post = (body: Record<string, unknown>) =>
        call("POST", `${TENANT}/conversations/${origin.id}/transfer`, { cookie: as("memberC"), body });
      const valid = { channelId: qrId, text: "oi", clientId: clientId() };

      for (const body of [
        { ...valid, text: "   " },
        { ...valid, text: "x".repeat(4097) },
        { channelId: qrId, text: "oi" },
        { ...valid, channelId: "nao-e-id" },
        { ...valid, contactId: randomUUID() },
        { ...valid, tenantId: otherTenantId },
      ]) {
        expect((await post(body)).status).toBe(400);
      }
      expect(sent).toHaveLength(0);
      expect(await conversationsOf(origin.contactId)).toHaveLength(1);
    });
  });

  describe("tenant: recusas", () => {
    /** Nada sai e nenhuma conversa nasce. */
    const expectNothing = async (contactId: string, conversations = 1) => {
      expect(sent).toHaveLength(0);
      expect(await conversationsOf(contactId)).toHaveLength(conversations);
    };

    it("tenant errado: a conversa de outra organização responde 404 igual a id inexistente", async () => {
      const origin = await closedWindowOrigin();

      const foreign = await transfer(TENANT, "stranger", origin.id, { channelId: otherTenantChannelId });
      const missing = await transfer(TENANT, "stranger", randomUUID(), { channelId: otherTenantChannelId });
      expect(foreign.status).toBe(404);
      expect(await bodyOf(foreign)).toEqual(await bodyOf(missing));
      expect((await optionsOf(TENANT, "stranger", origin.id)).status).toBe(404);
      await expectNothing(origin.contactId);
    });

    it("número de outra organização: 404, igual a número inexistente", async () => {
      const origin = await closedWindowOrigin();

      const foreign = await transfer(TENANT, "owner", origin.id, { channelId: otherTenantChannelId });
      const missing = await transfer(TENANT, "owner", origin.id, { channelId: randomUUID() });
      const platform = await transfer(TENANT, "owner", origin.id, { channelId: platformQrId });
      expect(foreign.status).toBe(404);
      expect(platform.status).toBe(404);
      expect(await bodyOf(foreign)).toEqual(await bodyOf(missing));
      await expectNothing(origin.contactId);
      // Nem na outra organização nasceu algo.
      const strays = await readAll((tx) =>
        tx
          .select()
          .from(conversation)
          .where(inArray(conversation.channelId, [otherTenantChannelId, platformQrId])),
      );
      expect(strays).toHaveLength(0);
    });

    it("número desconectado: 409 CHANNEL_NOT_CONNECTED; desativado: 409 CHANNEL_DISABLED", async () => {
      const origin = await closedWindowOrigin();

      const down = await transfer(TENANT, "owner", origin.id, { channelId: downId });
      expect(down.status).toBe(409);
      expect((await bodyOf(down)).code).toBe("CHANNEL_NOT_CONNECTED");

      const disabled = await transfer(TENANT, "owner", origin.id, { channelId: disabledId });
      expect(disabled.status).toBe(409);
      expect((await bodyOf(disabled)).code).toBe("CHANNEL_DISABLED");
      await expectNothing(origin.contactId);
    });

    it("o próprio número da conversa: 400 SAME_CHANNEL", async () => {
      const origin = await closedWindowOrigin();

      const response = await transfer(TENANT, "owner", origin.id, { channelId: cloudId });
      expect(response.status).toBe(400);
      expect((await bodyOf(response)).code).toBe("SAME_CHANNEL");
      await expectNothing(origin.contactId);
    });

    it("sem permissão do atendimento, ou só com leitura: 403", async () => {
      const origin = await closedWindowOrigin();

      for (const role of ["noInbox", "reader"]) {
        expect((await transfer(TENANT, role, origin.id, { channelId: qrId })).status).toBe(403);
        expect((await optionsOf(TENANT, role, origin.id)).status).toBe(403);
      }
      await expectNothing(origin.contactId);
    });

    it("sem sessão: 401", async () => {
      const origin = await closedWindowOrigin();

      const response = await call("POST", `${TENANT}/conversations/${origin.id}/transfer`, {
        body: { channelId: qrId, text: "oi", clientId: clientId() },
      });
      expect(response.status).toBe(401);
      await expectNothing(origin.contactId);
    });

    it("origem que a pessoa não vê (é de outro atendente): 404 igual a id inexistente", async () => {
      const origin = await closedWindowOrigin({ assignedUserId: users.memberB?.id });

      const hidden = await transfer(TENANT, "memberA", origin.id, { channelId: qrId });
      const missing = await transfer(TENANT, "memberA", randomUUID(), { channelId: qrId });
      expect(hidden.status).toBe(404);
      expect(await bodyOf(hidden)).toEqual(await bodyOf(missing));

      const hiddenList = await optionsOf(TENANT, "memberA", origin.id);
      const missingList = await optionsOf(TENANT, "memberA", randomUUID());
      expect(hiddenList.status).toBe(404);
      expect(await bodyOf(hiddenList)).toEqual(await bodyOf(missingList));
      await expectNothing(origin.contactId);

      // O dono da origem e quem supervisiona seguem podendo.
      expect((await transfer(TENANT, "memberB", origin.id, { channelId: qrId })).status).toBe(201);
    });

    it("conversa de destino de outro atendente: 409 ALREADY_ASSIGNED, sem conteúdo dela", async () => {
      const origin = await closedWindowOrigin();
      const taken = await seedConversationOnContact(scope(), qrId, origin.contactId, {
        assignedUserId: users.memberB?.id,
        unreadCount: 7,
      });

      const response = await transfer(TENANT, "memberA", origin.id, { channelId: qrId });
      expect(response.status).toBe(409);
      const body = await bodyOf(response);
      expect(body).toMatchObject({ code: "ALREADY_ASSIGNED", assignedTo: { id: users.memberB?.id } });
      // Só o erro e o dono, como em "iniciar conversa".
      expect(Object.keys(body).sort()).toEqual(["assignedTo", "code", "error"]);
      const text = JSON.stringify(body);
      expect(text).not.toContain("segredo da outra conversa");
      expect(text).not.toContain(taken.id);

      expect(sent).toHaveLength(0);
      expect(await messagesOf(taken.id)).toHaveLength(0);
      expect(await conversationRow(taken.id)).toMatchObject({
        assignedUserId: users.memberB?.id,
        unreadCount: 7,
      });

      // Quem supervisiona envia por ela, e o dono não muda.
      const supervised = await transfer(TENANT, "owner", origin.id, { channelId: qrId });
      expect(supervised.status).toBe(201);
      expect((await bodyOf(supervised)).conversationId).toBe(taken.id);
      expect(await conversationRow(taken.id)).toMatchObject({ assignedUserId: users.memberB?.id });
    });

    it("janela de 24 h no destino: número oficial sem conversa ou com a janela fechada é 409", async () => {
      // Origem no QR; destino no oficial, onde o contato nunca escreveu.
      const origin = await seedConversation(scope(), qrId);

      const never = await transfer(TENANT, "memberC", origin.id, { channelId: cloudId });
      expect(never.status).toBe(409);
      expect((await bodyOf(never)).code).toBe("SESSION_WINDOW_CLOSED");
      // A recusa não deixa conversa vazia para trás.
      await expectNothing(origin.contactId);

      const stale = await seedConversationOnContact(scope(), cloudId, origin.contactId, {
        lastInboundAt: longAgo(),
      });
      const closed = await transfer(TENANT, "memberC", origin.id, { channelId: cloudId });
      expect(closed.status).toBe(409);
      expect((await bodyOf(closed)).code).toBe("SESSION_WINDOW_CLOSED");
      expect(sent).toHaveLength(0);
      expect(await messagesOf(stale.id)).toHaveLength(0);
    });

    it("janela de 24 h no destino: aberta naquela conversa, o texto sai pelo número oficial", async () => {
      const origin = await seedConversation(scope(), qrId);
      const fresh = await seedConversationOnContact(scope(), cloudId, origin.contactId, {
        lastInboundAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const response = await transfer(TENANT, "memberC", origin.id, { channelId: cloudId });
      expect(response.status).toBe(201);
      expect((await bodyOf(response)).conversationId).toBe(fresh.id);
      expect(sent).toMatchObject([{ to: origin.phone, via: "whatsapp_cloud" }]);
    });
  });

  describe("tenant: números oferecidos", () => {
    const itemsOf = async (response: Response) => (await bodyOf(response)).items as Option[];

    it("lista os outros números com o motivo; fora o atual, o desativado e o de outro escopo", async () => {
      const origin = await closedWindowOrigin();

      const response = await optionsOf(TENANT, "memberA", origin.id);
      expect(response.status).toBe(200);
      const body = await bodyOf(response);
      expect(Object.keys(body)).toEqual(["items"]);
      const items = body.items as Option[];

      // Em ordem de nome.
      expect(items).toEqual([
        { channel: { id: downId, name: "Caido-x2", type: "whatsapp_qr" }, eligible: false, reason: "disconnected" },
        { channel: { id: qrId, name: "Vendas-x2", type: "whatsapp_qr" }, eligible: true, reason: null },
      ]);
    });

    it("do QR para o oficial: janela fechada sem conversa, aberta com mensagem recente do contato", async () => {
      const origin = await seedConversation(scope(), qrId);
      const cloud = async () =>
        (await itemsOf(await optionsOf(TENANT, "memberA", origin.id))).find(
          (item) => item.channel.id === cloudId,
        );

      expect(await cloud()).toMatchObject({ eligible: false, reason: "window_closed" });

      await seedConversationOnContact(scope(), cloudId, origin.contactId, {
        lastInboundAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      expect(await cloud()).toMatchObject({ eligible: true, reason: null });
    });

    it("destino de outro atendente: recusado sem dizer a janela, o dono nem a conversa", async () => {
      const origin = await seedConversation(scope(), qrId);
      const taken = await seedConversationOnContact(scope(), cloudId, origin.contactId, {
        assignedUserId: users.memberB?.id,
        lastInboundAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const response = await optionsOf(TENANT, "memberA", origin.id);
      const body = await bodyOf(response);
      const cloud = (body.items as Option[]).find((item) => item.channel.id === cloudId);
      expect(cloud).toEqual({
        channel: { id: cloudId, name: "Oficial-x2", type: "whatsapp_cloud" },
        eligible: false,
        reason: "assigned_to_other",
      });
      const text = JSON.stringify(body);
      expect(text).not.toContain(taken.id);
      expect(text).not.toContain(users.memberB?.id as string);
      expect(text).not.toContain("segredo da outra conversa");

      // Para quem supervisiona, vale a janela daquela conversa.
      const supervised = (await itemsOf(await optionsOf(TENANT, "owner", origin.id))).find(
        (item) => item.channel.id === cloudId,
      );
      expect(supervised).toMatchObject({ eligible: true, reason: null });
    });
  });

  describe("plataforma", () => {
    const seedPlatform = async (channelId: string, seed: Parameters<typeof seedConversation>[2] = {}) => {
      const row = await seedConversation(platformScope, channelId, seed);
      phoneKeys.push(row.phoneKey);
      return row;
    };

    it("segue pelo outro número da plataforma, sem dono, e nunca por número de organização", async () => {
      const origin = await seedPlatform(platformCloudId, {
        lastInboundAt: longAgo(),
        lastMessageAt: longAgo(),
      });

      const list = await optionsOf(PLATFORM, "support", origin.id);
      expect(list.status).toBe(200);
      const mine = ((await bodyOf(list)).items as Option[]).filter((item) =>
        [platformQrId, qrId, cloudId].includes(item.channel.id),
      );
      expect(mine).toEqual([
        {
          channel: { id: platformQrId, name: "PlataformaB-x2-chtest", type: "whatsapp_qr" },
          eligible: true,
          reason: null,
        },
      ]);

      // Número de organização não é destino da plataforma.
      expect((await transfer(PLATFORM, "support", origin.id, { channelId: qrId })).status).toBe(404);
      expect(sent).toHaveLength(0);

      const response = await transfer(PLATFORM, "support", origin.id, { channelId: platformQrId });
      expect(response.status).toBe(201);
      const destinationId = (await bodyOf(response)).conversationId as string;
      expect(await conversationRow(destinationId)).toMatchObject({
        tenantId: null,
        channelId: platformQrId,
        contactId: origin.contactId,
        assignedUserId: null,
      });
      expect(sent).toEqual([{ to: origin.phone, text: "Oi, seguimos por aqui.", via: "whatsapp_qr" }]);

      const audits = await readAll((tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, destinationId)),
      );
      expect(audits.map((row) => row.action)).toEqual(["inbox.conversation_continued"]);
      expect(audits[0]).toMatchObject({ tenantId: null, actorType: "platform" });
    });

    it("os escopos não se cruzam: conversa de organização em /admin e a da plataforma em /app são 404", async () => {
      const tenantOrigin = await closedWindowOrigin();
      const platformOrigin = await seedPlatform(platformCloudId);

      expect(
        (await transfer(PLATFORM, "support", tenantOrigin.id, { channelId: platformQrId })).status,
      ).toBe(404);
      expect((await optionsOf(PLATFORM, "support", tenantOrigin.id)).status).toBe(404);
      expect((await transfer(TENANT, "owner", platformOrigin.id, { channelId: qrId })).status).toBe(404);
      expect((await optionsOf(TENANT, "owner", platformOrigin.id)).status).toBe(404);
      // Quem não é da plataforma não chega à rota.
      expect(
        (await transfer(PLATFORM, "owner", platformOrigin.id, { channelId: platformQrId })).status,
      ).toBe(403);
      expect(sent).toHaveLength(0);
    });
  });
});
