import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { auditLog, message } from "@/db/schema";
import { bodyOf, makePlatformUser } from "./billing-helpers";
import { cleanUpChannels, platformScope, seedCloudChannel, tenantScope } from "./channels-helpers";
import { readAll, seedConversation, seedMessage } from "./inbox-helpers";
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
 * Estrela da mensagem (bloco R, fase R3a), pela API com Postgres real: `PUT
 * /api/inbox/messages/:id/favorite` (e a versão da plataforma). Permissão `inbox:reply`, visibilidade
 * por pessoa (404 igual a id inexistente), os três campos gravados e zerados juntos, idempotência,
 * auditoria sem texto e aviso só com ids. A personificação está em `impersonation.test.ts` e a matriz
 * de papéis em `rbac.test.ts`.
 */

type View = { id: string; isFavorite: boolean; text: string | null };

describe("PUT /api/inbox/messages/:id/favorite", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  let channelId: string;
  let otherChannelId: string;
  let platformChannelId: string;
  const users: Record<string, TestUser> = {};
  const platformUsers: string[] = [];
  const platformPhoneKeys: string[] = [];
  const raw: string[] = [];
  let unlisten: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    owner = connectOwner();
    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;
    users.stranger = await createUser(owner);
    otherTenantId = (await createTenant(users.stranger, "Outra Clínica")).id;

    for (const role of ["memberA", "memberB"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, "member");
      users[role] = user;
    }
    await createRole(users.owner, "leitor", ["inbox:read"]);
    users.reader = await createUser(owner);
    await addMember(owner, tenantId, users.reader, "leitor");

    users.platformOwner = await makePlatformUser(owner, "platform_owner");
    users.support = await makePlatformUser(owner, "platform_support");
    platformUsers.push(users.platformOwner.id, users.support.id);

    channelId = (await seedCloudChannel(tenantScope(tenantId))).id;
    otherChannelId = (await seedCloudChannel(tenantScope(otherTenantId))).id;
    platformChannelId = (await seedCloudChannel(platformScope, { name: "Plataforma-favtest-chtest" })).id;

    const listening = await owner.listen("inbox", (payload) => raw.push(payload));
    unlisten = listening.unlisten;
  });

  afterEach(async () => {
    raw.length = 0;
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id in (${tenantId}, ${otherTenantId})`;
      await tx`delete from chat_contact where tenant_id is null and phone_key = any(${platformPhoneKeys})`;
      await tx`delete from retention_policy where tenant_id in (${tenantId}, ${otherTenantId})`;
      await tx`delete from audit_log where tenant_id is null and action like 'inbox.message_%' and actor_id = any(${platformUsers})`;
    });
  });

  afterAll(async () => {
    await unlisten?.();
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner`delete from "user" where id = any(${platformUsers})`;
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);
  const put = (path: string, cookie: string | undefined, body: unknown = { favorite: true }) =>
    call("PUT", path, { cookie, body });
  const favorite = (role: string, messageId: string, value = true) =>
    put(`/api/inbox/messages/${messageId}/favorite`, as(role), { favorite: value });
  const rowOf = async (messageId: string) =>
    (await readAll((tx) => tx.select().from(message).where(eq(message.id, messageId))))[0];

  /** Uma conversa na fila, uma de cada membro e uma de outro tenant, cada uma com uma mensagem. */
  async function matrix() {
    const textOf = (label: string) => `texto-secreto-${label}-${randomUUID()}`;
    const make = async (
      scopeOf: ReturnType<typeof tenantScope>,
      channel: string,
      assignedUserId: string | null,
      text: string,
    ) => {
      const conversation = await seedConversation(scopeOf, channel, { assignedUserId });
      const sent = await seedMessage(scopeOf, { conversationId: conversation.id, channelId: channel }, { text });
      return { conversation, message: sent, text };
    };

    return {
      queue: await make(scope(), channelId, null, textOf("fila")),
      a: await make(scope(), channelId, users.memberA?.id as string, textOf("a")),
      b: await make(scope(), channelId, users.memberB?.id as string, textOf("b")),
      other: await make(tenantScope(otherTenantId), otherChannelId, null, textOf("outro")),
    };
  }

  describe("permissão e visibilidade", () => {
    it("sem sessão: 401; sem inbox:reply: 403; com ela: 200", async () => {
      const { queue } = await matrix();
      const path = `/api/inbox/messages/${queue.message.id}/favorite`;

      expect((await put(path, undefined)).status).toBe(401);

      const reader = await favorite("reader", queue.message.id);
      expect(reader.status).toBe(403);
      expect(await bodyOf(reader)).toMatchObject({ code: "PERMISSION_DENIED" });
      expect((await rowOf(queue.message.id))?.isFavorite).toBe(false);

      expect((await favorite("memberA", queue.message.id)).status).toBe(200);
    });

    it("a mensagem de conversa de outra pessoa, de outro tenant ou inexistente responde 404 e não muda nada", async () => {
      const { a, b, other } = await matrix();

      for (const id of [b.message.id, other.message.id, randomUUID()]) {
        const response = await favorite("memberA", id);
        expect(response.status, id).toBe(404);
        expect(await bodyOf(response)).toMatchObject({ code: "NOT_FOUND" });
      }
      expect((await rowOf(b.message.id))?.isFavorite).toBe(false);
      expect((await rowOf(other.message.id))?.isFavorite).toBe(false);

      // O supervisor (owner) alcança a de B; a de outro tenant, nunca.
      expect((await favorite("owner", b.message.id)).status).toBe(200);
      expect((await favorite("owner", other.message.id)).status).toBe(404);
      expect((await favorite("memberA", a.message.id)).status).toBe(200);
    });

    it("corpo inválido: 400, sem gravar", async () => {
      const { queue } = await matrix();
      const path = `/api/inbox/messages/${queue.message.id}/favorite`;

      for (const body of [{}, { favorite: "sim" }, { favorite: null }]) {
        expect((await put(path, as("memberA"), body)).status, JSON.stringify(body)).toBe(400);
      }
      // Id que não é UUID: 404 como em toda rota com `validId`.
      expect((await put("/api/inbox/messages/nao-e-id/favorite", as("memberA"))).status).toBe(404);
      expect((await rowOf(queue.message.id))?.isFavorite).toBe(false);
    });
  });

  describe("os três campos", () => {
    it("favoritar grava is_favorite, favorited_at e favorited_by; desfavoritar zera os três juntos", async () => {
      const { a } = await matrix();

      const on = await favorite("memberA", a.message.id);
      expect(on.status).toBe(200);
      expect(((await bodyOf(on)).message as View).isFavorite).toBe(true);

      const starred = await rowOf(a.message.id);
      expect(starred?.isFavorite).toBe(true);
      expect(starred?.favoritedBy).toBe(users.memberA?.id);
      expect(starred?.favoritedAt).toBeInstanceOf(Date);

      const off = await favorite("memberA", a.message.id, false);
      expect(off.status).toBe(200);
      expect(((await bodyOf(off)).message as View).isFavorite).toBe(false);

      const cleared = await rowOf(a.message.id);
      expect(cleared).toMatchObject({ isFavorite: false, favoritedAt: null, favoritedBy: null });
    });

    it("é idempotente: repetir não troca quem marcou nem a data, e não audita nem avisa de novo", async () => {
      const { queue } = await matrix();
      const id = queue.message.id;

      expect((await favorite("memberA", id)).status).toBe(200);
      const first = await rowOf(id);
      raw.length = 0;

      // Outra pessoa repete o pedido: nada muda.
      expect((await favorite("owner", id)).status).toBe(200);
      const second = await rowOf(id);
      expect(second?.favoritedBy).toBe(users.memberA?.id);
      expect(second?.favoritedAt?.getTime()).toBe(first?.favoritedAt?.getTime());
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(raw).toEqual([]);

      // Desfavoritar duas vezes também.
      expect((await favorite("memberA", id, false)).status).toBe(200);
      expect((await favorite("memberA", id, false)).status).toBe(200);
      expect(await rowOf(id)).toMatchObject({ isFavorite: false, favoritedAt: null, favoritedBy: null });

      const audited = await readAll((tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.tenantId, tenantId))),
      );
      expect(audited.map((row) => row.action).sort()).toEqual([
        "inbox.message_favorited",
        "inbox.message_unfavorited",
      ]);
    });

    it("pedidos simultâneos gravam uma vez só", async () => {
      const { queue } = await matrix();

      const results = await Promise.all(
        ["memberA", "memberB", "owner", "memberA"].map((role) => favorite(role, queue.message.id)),
      );
      expect(results.map((response) => response.status)).toEqual([200, 200, 200, 200]);

      const audited = await readAll((tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, queue.message.id)),
      );
      expect(audited).toHaveLength(1);
      expect((await rowOf(queue.message.id))?.favoritedBy).not.toBeNull();
    });

    it("a estrela é da conversa: quem tem acesso à conversa vê a mesma marca na leitura", async () => {
      const { queue } = await matrix();
      await favorite("memberA", queue.message.id);

      for (const role of ["owner", "memberB", "reader"]) {
        const response = await call("GET", `/api/inbox/conversations/${queue.conversation.id}/messages`, {
          cookie: as(role),
        });
        expect(response.status, role).toBe(200);
        const items = (await bodyOf(response)).items as View[];
        expect(items.find((item) => item.id === queue.message.id)?.isFavorite, role).toBe(true);
      }
    });

    it("o teto de favoritas do escopo não recusa: quem rebaixa é a limpeza", async () => {
      const { queue } = await matrix();
      const second = await seedMessage(scope(), { conversationId: queue.conversation.id, channelId }, { text: "outra" });
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into retention_policy (tenant_id, channel_type, max_favorites) values (${tenantId}, 'whatsapp_cloud', 1)`;
      });

      expect((await favorite("memberA", queue.message.id)).status).toBe(200);
      expect((await favorite("memberA", second.id)).status).toBe(200);
      expect((await rowOf(second.id))?.isFavorite).toBe(true);
    });
  });

  describe("auditoria e aviso", () => {
    it("audita só com ids: nunca o texto da mensagem nem o telefone", async () => {
      const { a } = await matrix();
      await favorite("memberA", a.message.id);
      await favorite("memberA", a.message.id, false);

      const rows = await readAll((tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, a.message.id)),
      );
      expect(rows.map((row) => row.action).sort()).toEqual([
        "inbox.message_favorited",
        "inbox.message_unfavorited",
      ]);
      for (const row of rows) {
        expect(row.targetType).toBe("message");
        expect(row.actorId).toBe(users.memberA?.id);
        expect(row.metadata).toEqual({ conversationId: a.conversation.id });
      }
      expect(JSON.stringify(rows)).not.toContain(a.text);
      expect(JSON.stringify(rows)).not.toContain(a.conversation.phone);
    });

    it("avisa a tela só com ids (s, c, k, m, a), sem texto, telefone nem nome", async () => {
      const { a } = await matrix();
      await favorite("memberA", a.message.id);

      const deadline = Date.now() + 5_000;
      while (!raw.some((payload) => payload.includes(a.conversation.id)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const notice = JSON.parse(raw.find((payload) => payload.includes(a.conversation.id)) as string);

      expect(notice).toMatchObject({
        s: tenantId,
        c: a.conversation.id,
        k: "status",
        m: a.message.id,
        a: users.memberA?.id,
      });
      expect(Object.keys(notice).sort()).toEqual(["a", "c", "k", "m", "s"]);
      for (const payload of raw) {
        expect(payload).not.toContain(a.text);
        expect(payload).not.toContain(a.conversation.phone.slice(-8));
      }
    });
  });

  describe("atendimento da plataforma", () => {
    async function platformMessage() {
      const conversation = await seedConversation(platformScope, platformChannelId);
      platformPhoneKeys.push(conversation.phoneKey);
      const sent = await seedMessage(platformScope, { conversationId: conversation.id, channelId: platformChannelId });
      return { conversation, message: sent };
    }
    const platformFavorite = (role: string, messageId: string, value = true) =>
      put(`/api/admin/inbox/messages/${messageId}/favorite`, as(role), { favorite: value });

    it("proprietário e suporte marcam e desmarcam; a auditoria é da plataforma, sem tenant", async () => {
      const { message: sent } = await platformMessage();

      for (const role of ["platformOwner", "support"]) {
        const on = await platformFavorite(role, sent.id);
        expect(on.status, role).toBe(200);
        expect(((await bodyOf(on)).message as View).isFavorite).toBe(true);
        expect((await rowOf(sent.id))?.favoritedBy).toBe(users[role]?.id);

        expect((await platformFavorite(role, sent.id, false)).status, role).toBe(200);
        expect(await rowOf(sent.id)).toMatchObject({ isFavorite: false, favoritedAt: null, favoritedBy: null });
      }

      const rows = await readAll((tx) => tx.select().from(auditLog).where(eq(auditLog.targetId, sent.id)));
      expect(rows.length).toBe(4);
      expect(rows.every((row) => row.tenantId === null && row.actorType === "platform")).toBe(true);
    });

    it("o isolamento vale nos dois sentidos: 404 entre tenant e plataforma", async () => {
      const { queue } = await matrix();
      const { message: sent } = await platformMessage();

      expect((await platformFavorite("platformOwner", queue.message.id)).status).toBe(404);
      expect((await favorite("owner", sent.id)).status).toBe(404);
      expect((await rowOf(queue.message.id))?.isFavorite).toBe(false);
      expect((await rowOf(sent.id))?.isFavorite).toBe(false);
    });

    it("dono de tenant e membro não alcançam a rota da plataforma (403)", async () => {
      const { message: sent } = await platformMessage();
      for (const role of ["owner", "memberA"]) {
        expect((await platformFavorite(role, sent.id)).status, role).toBe(403);
      }
    });
  });
});
