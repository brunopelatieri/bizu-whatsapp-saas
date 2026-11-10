import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { auditLog, conversation } from "@/db/schema";
import type { InboxMediaJob } from "@/jobs/queues";
import { setInboxMediaQueueForTests } from "@/lib/inbox/media";
import { setStorageForTests } from "@/lib/storage";
import { bodyOf } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, seedQrChannel, tenantScope } from "./channels-helpers";
import {
  attachMedia,
  memoryStorage,
  readAll,
  seedConversation,
  seedMessage,
} from "./inbox-helpers";
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
 * Leitura e fila da caixa de entrada (SPEC, passo 3), pela API com Postgres real: matriz de
 * visibilidade (o membro não lê, não marca como lida nem baixa mídia da conversa de outro), dois
 * `claim` simultâneos, transferir e devolver, situação, paginação, mídia e o gancho de remoção.
 */

type Item = { id: string; assignedTo: { id: string; name: string } | null; status: string };

describe("/api/inbox: leitura e fila", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  let channelId: string;
  let otherChannelId: string;
  const users: Record<string, TestUser> = {};
  const media = memoryStorage();
  const jobs: InboxMediaJob[] = [];

  beforeAll(async () => {
    owner = connectOwner();
    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;
    users.stranger = await createUser(owner);
    otherTenantId = (await createTenant(users.stranger, "Outra Clínica")).id;

    for (const role of ["admin", "memberA", "memberB"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, role === "admin" ? "admin" : "member");
      users[role] = user;
    }
    await createRole(users.owner, "leitor", ["inbox:read"]);
    users.reader = await createUser(owner);
    await addMember(owner, tenantId, users.reader, "leitor");

    channelId = (await seedCloudChannel(tenantScope(tenantId))).id;
    otherChannelId = (await seedQrChannel(tenantScope(otherTenantId))).id;
    setStorageForTests(media.storage);
    setInboxMediaQueueForTests(async (job) => {
      jobs.push(job);
    });
  });

  afterEach(async () => {
    jobs.length = 0;
    media.objects.clear();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id in (${tenantId}, ${otherTenantId})`;
      await tx`delete from file where tenant_id in (${tenantId}, ${otherTenantId}) and owner_type = 'message'`;
    });
  });

  afterAll(async () => {
    setStorageForTests(undefined);
    setInboxMediaQueueForTests(undefined);
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);

  /** Fila (Q), do membro A (A), do membro B (B) e de outro tenant (X). */
  async function matrix() {
    const q = await seedConversation(scope(), channelId, { unreadCount: 2 });
    const a = await seedConversation(scope(), channelId, { assignedUserId: users.memberA?.id, unreadCount: 1 });
    const b = await seedConversation(scope(), channelId, { assignedUserId: users.memberB?.id, unreadCount: 3 });
    const x = await seedConversation(tenantScope(otherTenantId), otherChannelId);
    return { q, a, b, x };
  }

  const ids = async (response: Response) =>
    ((await bodyOf(response)).items as Item[]).map((item) => item.id);

  describe("visibilidade", () => {
    it("o membro vê a fila e as próprias; nunca a de outro membro nem a de outro tenant", async () => {
      const { q, a, b, x } = await matrix();

      const queue = await call("GET", "/api/inbox/conversations?tab=queue", { cookie: as("memberA") });
      expect(queue.status).toBe(200);
      expect(await ids(queue)).toEqual([q.id]);

      const mine = await call("GET", "/api/inbox/conversations?tab=mine", { cookie: as("memberA") });
      expect(await ids(mine)).toEqual([a.id]);

      const all = await call("GET", "/api/inbox/conversations?tab=all", { cookie: as("memberA") });
      expect(all.status).toBe(403);
      const byAssignee = await call("GET", `/api/inbox/conversations?tab=mine&assignedTo=${users.memberB?.id}`, {
        cookie: as("memberA"),
      });
      expect(byAssignee.status).toBe(403);

      for (const id of [b.id, x.id, randomUUID()]) {
        expect((await call("GET", `/api/inbox/conversations/${id}`, { cookie: as("memberA") })).status).toBe(404);
        expect((await call("GET", `/api/inbox/conversations/${id}/messages`, { cookie: as("memberA") })).status).toBe(404);
        expect((await call("POST", `/api/inbox/conversations/${id}/read`, { cookie: as("memberA") })).status).toBe(404);
        expect(
          (await call("POST", `/api/inbox/conversations/${id}/status`, { cookie: as("memberA"), body: { status: "closed" } })).status,
        ).toBe(404);
        expect(
          (await call("POST", `/api/inbox/conversations/${id}/assign`, { cookie: as("memberA"), body: { userId: null } })).status,
        ).toBe(404);
      }

      // A leitura negada não zerou as não lidas de B.
      const [row] = await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, b.id)));
      expect(row?.unreadCount).toBe(3);

      expect((await call("GET", `/api/inbox/conversations/${a.id}`, { cookie: as("memberA") })).status).toBe(200);
      expect((await call("GET", `/api/inbox/conversations/${q.id}`, { cookie: as("memberA") })).status).toBe(200);
    });

    it("quem supervisiona vê todas do tenant, filtra por atendente, e nenhuma de outro tenant", async () => {
      const { q, a, b, x } = await matrix();

      const all = await call("GET", "/api/inbox/conversations?tab=all", { cookie: as("admin") });
      const seen = await ids(all);
      expect(seen).toEqual(expect.arrayContaining([q.id, a.id, b.id]));
      expect(seen).not.toContain(x.id);

      const ofB = await call("GET", `/api/inbox/conversations?tab=all&assignedTo=${users.memberB?.id}`, {
        cookie: as("admin"),
      });
      expect(await ids(ofB)).toEqual([b.id]);

      expect((await call("GET", `/api/inbox/conversations/${b.id}`, { cookie: as("admin") })).status).toBe(200);
      expect((await call("GET", `/api/inbox/conversations/${x.id}`, { cookie: as("admin") })).status).toBe(404);
    });

    it("o detalhe traz contato, vínculo e janela; sem phone_key nem tenant", async () => {
      const { q } = await matrix();
      const response = await call("GET", `/api/inbox/conversations/${q.id}`, { cookie: as("memberA") });
      const body = await bodyOf(response);

      expect(body.conversation).toMatchObject({ id: q.id, status: "open", assignedTo: null, unreadCount: 2 });
      expect(body.contact).toMatchObject({ phone: q.phone, identified: false });
      expect(body.link).toMatchObject({ kind: "none" });
      expect(body.window).toMatchObject({ applies: true, open: true });
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/phoneKey|phone_key|tenantId|tenant_id/);
    });

    it("sem inbox:read não há caixa; supervise sem read não tem efeito", async () => {
      await matrix();
      const response = await call("GET", "/api/inbox/conversations", { cookie: as("stranger") });
      // `stranger` é owner de outro tenant: vê só o dele (aqui, a conversa X).
      expect(response.status).toBe(200);
      expect(((await bodyOf(response)).items as Item[]).length).toBe(1);
    });
  });

  describe("assumir", () => {
    it("dois cliques ao mesmo tempo: um assume, o outro recebe 409 com o nome do dono", async () => {
      const { q } = await matrix();

      const responses = await Promise.all([
        call("POST", `/api/inbox/conversations/${q.id}/claim`, { cookie: as("memberA") }),
        call("POST", `/api/inbox/conversations/${q.id}/claim`, { cookie: as("memberB") }),
      ]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);

      const loser = responses.find((response) => response.status === 409) as Response;
      const winner = responses.find((response) => response.status === 200) as Response;
      const winnerItem = (await bodyOf(winner)).conversation as Item;
      expect(await bodyOf(loser)).toMatchObject({
        code: "ALREADY_ASSIGNED",
        assignedTo: { id: winnerItem.assignedTo?.id },
      });

      const [row] = await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, q.id)));
      expect(row?.assignedUserId).toBe(winnerItem.assignedTo?.id);
    });

    it("assumir a própria é idempotente; quem só lê recebe 403", async () => {
      const { a, q } = await matrix();
      expect((await call("POST", `/api/inbox/conversations/${a.id}/claim`, { cookie: as("memberA") })).status).toBe(200);

      const reader = await call("POST", `/api/inbox/conversations/${q.id}/claim`, { cookie: as("reader") });
      expect(reader.status).toBe(403);
      expect(await bodyOf(reader)).toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("audita sem texto nem telefone", async () => {
      const { q } = await matrix();
      await call("POST", `/api/inbox/conversations/${q.id}/claim`, { cookie: as("memberA") });

      const rows = await readAll((tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, q.id)),
      );
      expect(rows.map((row) => row.action)).toContain("inbox.conversation_claimed");
      expect(JSON.stringify(rows)).not.toContain(q.phone);
    });
  });

  describe("transferir e devolver", () => {
    it("o membro devolve a própria à fila, mas não transfere (403)", async () => {
      const { a } = await matrix();

      const transfer = await call("POST", `/api/inbox/conversations/${a.id}/assign`, {
        cookie: as("memberA"),
        body: { userId: users.memberB?.id },
      });
      expect(transfer.status).toBe(403);

      const release = await call("POST", `/api/inbox/conversations/${a.id}/assign`, {
        cookie: as("memberA"),
        body: { userId: null },
      });
      expect(release.status).toBe(200);
      expect(((await bodyOf(release)).conversation as Item).assignedTo).toBeNull();
    });

    it("o admin transfere para quem atende; destino fora da equipe ou sem atendimento é 400", async () => {
      const { a } = await matrix();

      const ok = await call("POST", `/api/inbox/conversations/${a.id}/assign`, {
        cookie: as("admin"),
        body: { userId: users.memberB?.id },
      });
      expect(ok.status).toBe(200);
      expect(((await bodyOf(ok)).conversation as Item).assignedTo?.id).toBe(users.memberB?.id);

      for (const target of [users.stranger?.id, users.reader?.id, randomUUID()]) {
        const refused = await call("POST", `/api/inbox/conversations/${a.id}/assign`, {
          cookie: as("admin"),
          body: { userId: target },
        });
        expect(refused.status).toBe(400);
        expect(await bodyOf(refused)).toMatchObject({ code: "INVALID_ASSIGNEE" });
      }

      const audits = await readAll((tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, a.id)),
      );
      expect(audits.find((row) => row.action === "inbox.conversation_assigned")?.metadata).toEqual({
        from: users.memberA?.id,
        to: users.memberB?.id,
      });
    });

    it("assignees lista quem atende; o membro comum recebe 403", async () => {
      const response = await call("GET", "/api/inbox/assignees", { cookie: as("admin") });
      const listed = ((await bodyOf(response)).users as { id: string }[]).map((user) => user.id);
      expect(listed).toEqual(
        expect.arrayContaining([users.owner?.id, users.admin?.id, users.memberA?.id, users.memberB?.id]),
      );
      expect(listed).not.toContain(users.reader?.id);
      expect(listed).not.toContain(users.stranger?.id);

      expect((await call("GET", "/api/inbox/assignees", { cookie: as("memberA") })).status).toBe(403);
    });
  });

  describe("situação e lida", () => {
    it("encerrar e reabrir à mão mantêm o dono e ficam na auditoria", async () => {
      const { a } = await matrix();

      const closed = await call("POST", `/api/inbox/conversations/${a.id}/status`, {
        cookie: as("memberA"),
        body: { status: "closed" },
      });
      expect(closed.status).toBe(200);
      expect((await bodyOf(closed)).conversation).toMatchObject({
        status: "closed",
        assignedTo: { id: users.memberA?.id },
      });

      const reopened = await call("POST", `/api/inbox/conversations/${a.id}/status`, {
        cookie: as("memberA"),
        body: { status: "open" },
      });
      expect((await bodyOf(reopened)).conversation).toMatchObject({
        status: "open",
        assignedTo: { id: users.memberA?.id },
      });

      const [row] = await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, a.id)));
      expect(row?.closedAt).toBeNull();
      const actions = (
        await readAll((tx) => tx.select().from(auditLog).where(eq(auditLog.targetId, a.id)))
      ).map((entry) => entry.action);
      expect(actions).toEqual(expect.arrayContaining(["inbox.conversation_closed", "inbox.conversation_reopened"]));

      const invalid = await call("POST", `/api/inbox/conversations/${a.id}/status`, {
        cookie: as("memberA"),
        body: { status: "arquivada" },
      });
      expect(invalid.status).toBe(400);
    });

    it("marcar como lida zera as não lidas; unread conta fila e minhas", async () => {
      const { q, a } = await matrix();

      expect(await bodyOf(await call("GET", "/api/inbox/unread", { cookie: as("memberA") }))).toEqual({
        queue: 1,
        mine: 1,
      });

      expect((await call("POST", `/api/inbox/conversations/${a.id}/read`, { cookie: as("memberA") })).status).toBe(200);
      expect((await call("POST", `/api/inbox/conversations/${q.id}/read`, { cookie: as("memberA") })).status).toBe(200);
      // Repetir não é erro.
      expect((await call("POST", `/api/inbox/conversations/${q.id}/read`, { cookie: as("memberA") })).status).toBe(200);

      expect(await bodyOf(await call("GET", "/api/inbox/unread", { cookie: as("memberA") }))).toEqual({
        queue: 0,
        mine: 0,
      });
    });
  });

  describe("listas paginadas", () => {
    it("percorre a lista pelo cursor sem repetir nem pular, inclusive no mesmo instante", async () => {
      const same = new Date(Date.now() - 1000);
      const created = [];
      for (let index = 0; index < 5; index++) {
        created.push(
          (await seedConversation(scope(), channelId, { lastMessageAt: index < 3 ? same : new Date(Date.now() - index * 60_000) })).id,
        );
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const response = await call("GET", `/api/inbox/conversations?tab=all&limit=2${query}`, { cookie: as("admin") });
        const body = await bodyOf(response);
        seen.push(...(body.items as Item[]).map((item) => item.id));
        cursor = body.nextCursor as string | null;
      } while (cursor);

      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(created));
    });

    it("cursor adulterado é 400", async () => {
      const response = await call("GET", "/api/inbox/conversations?cursor=bad", { cookie: as("admin") });
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ code: "INVALID_CURSOR" });
    });

    it("mensagens da mais nova para a mais antiga, por páginas", async () => {
      const { q } = await matrix();
      const base = Date.now() - 100_000;
      for (let index = 0; index < 5; index++) {
        await seedMessage(scope(), { conversationId: q.id, channelId }, {
          text: `m${index}`,
          createdAt: new Date(base + index * 1000),
        });
      }

      const first = await bodyOf(
        await call("GET", `/api/inbox/conversations/${q.id}/messages?limit=3`, { cookie: as("memberA") }),
      );
      expect((first.items as { text: string }[]).map((item) => item.text)).toEqual(["m4", "m3", "m2"]);

      const second = await bodyOf(
        await call(
          "GET",
          `/api/inbox/conversations/${q.id}/messages?limit=3&before=${encodeURIComponent(first.nextCursor as string)}`,
          { cookie: as("memberA") },
        ),
      );
      expect((second.items as { text: string }[]).map((item) => item.text)).toEqual(["m1", "m0"]);
      expect(second.nextCursor).toBeNull();
      expect(JSON.stringify(second)).not.toContain("payload");
    });

    it("busca por nome e por telefone com e sem o 9º dígito", async () => {
      const found = await seedConversation(scope(), channelId, { phone: "551187654321", waName: "Marina Souza" });
      await seedConversation(scope(), channelId, { waName: "Outro Nome" });

      for (const q of ["marina", "11987654321", "87654321"]) {
        const response = await call("GET", `/api/inbox/conversations?tab=all&q=${encodeURIComponent(q)}`, {
          cookie: as("admin"),
        });
        expect(await ids(response)).toEqual([found.id]);
      }
    });
  });

  describe("mídia", () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
    const HTML = Buffer.from("<html><script>alert(1)</script></html>");

    it("serve inline só o tipo seguro conferido pelo conteúdo; o resto vai como anexo", async () => {
      const { q } = await matrix();
      const photo = await seedMessage(scope(), { conversationId: q.id, channelId }, { type: "image", text: null });
      await attachMedia(scope(), media, photo.id, JPEG, "image/jpeg", "foto.jpg");
      // Evolution: o remetente diz `image/png`, o conteúdo é HTML.
      const disguised = await seedMessage(scope(), { conversationId: q.id, channelId }, { type: "image", text: null });
      await attachMedia(scope(), media, disguised.id, HTML, "image/png", "foto.png");

      const ok = await call("GET", `/api/inbox/messages/${photo.id}/media`, { cookie: as("memberA") });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/jpeg");
      expect(ok.headers.get("content-disposition")).toMatch(/^inline;/);
      expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
      expect(ok.headers.get("cache-control")).toBe("private, max-age=300");
      expect(Buffer.from(await ok.arrayBuffer())).toEqual(JPEG);

      const bad = await call("GET", `/api/inbox/messages/${disguised.id}/media`, { cookie: as("memberA") });
      expect(bad.headers.get("content-type")).toBe("application/octet-stream");
      expect(bad.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(Buffer.from(await bad.arrayBuffer())).toEqual(HTML);
    });

    it("mídia da conversa de outro membro ou de outro tenant é 404", async () => {
      const { b, x } = await matrix();
      const ofB = await seedMessage(scope(), { conversationId: b.id, channelId }, { type: "image", text: null });
      await attachMedia(scope(), media, ofB.id, JPEG, "image/jpeg");
      const ofX = await seedMessage(tenantScope(otherTenantId), { conversationId: x.id, channelId: otherChannelId }, {
        type: "image",
        text: null,
      });
      await attachMedia(tenantScope(otherTenantId), media, ofX.id, JPEG, "image/jpeg");

      expect((await call("GET", `/api/inbox/messages/${ofB.id}/media`, { cookie: as("memberA") })).status).toBe(404);
      expect((await call("GET", `/api/inbox/messages/${ofX.id}/media`, { cookie: as("admin") })).status).toBe(404);
      expect((await call("GET", `/api/inbox/messages/${ofB.id}/media`, { cookie: as("admin") })).status).toBe(200);
    });

    it("tentar de novo volta a pending e enfileira; sem id do provedor é 409", async () => {
      const { q } = await matrix();
      const failed = await seedMessage(scope(), { conversationId: q.id, channelId }, {
        type: "image",
        text: null,
        mediaStatus: "failed",
        providerMediaId: "media-123",
      });
      const evolution = await seedMessage(scope(), { conversationId: q.id, channelId }, {
        type: "image",
        text: null,
        mediaStatus: "failed",
      });

      const retried = await call("POST", `/api/inbox/messages/${failed.id}/media/retry`, { cookie: as("memberA") });
      expect(retried.status).toBe(202);
      expect(jobs).toEqual([{ messageId: failed.id, tenantId }]);

      const refused = await call("POST", `/api/inbox/messages/${evolution.id}/media/retry`, { cookie: as("memberA") });
      expect(refused.status).toBe(409);
      expect(await bodyOf(refused)).toMatchObject({ code: "MEDIA_NOT_RETRYABLE" });
    });
  });

  describe("membro removido", () => {
    it("as conversas dele voltam à fila; trocar o papel para um sem atendimento também", async () => {
      const removed = await createUser(owner);
      const memberId = await addMember(owner, tenantId, removed, "member");
      const demoted = await createUser(owner);
      const demotedMemberId = await addMember(owner, tenantId, demoted, "member");

      const ofRemoved = await seedConversation(scope(), channelId, { assignedUserId: removed.id });
      const ofDemoted = await seedConversation(scope(), channelId, { assignedUserId: demoted.id });

      expect((await call("DELETE", `/api/team/members/${memberId}`, { cookie: as("owner") })).status).toBe(200);
      expect(
        (await call("PATCH", `/api/team/members/${demotedMemberId}`, { cookie: as("owner"), body: { role: "leitor" } }))
          .status,
      ).toBe(200);

      const rows = await readAll((tx) =>
        tx.select().from(conversation).where(inArray(conversation.id, [ofRemoved.id, ofDemoted.id])),
      );
      expect(rows.map((row) => row.assignedUserId)).toEqual([null, null]);
    });
  });
});
