import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bodyOf, makePlatformUser } from "./billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "./channels-helpers";
import { seedConversation, seedConversationOnContact } from "./inbox-helpers";
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
 * X1, "Também neste contato": `GET .../conversations/:id/related`, nos dois escopos, com Postgres
 * real. A lista traz as outras conversas do **mesmo contato** (outros números) e só as que a pessoa
 * vê; a que está fora do alcance não aparece, não é contada e nenhum campo a revela.
 */

type Related = {
  id: string;
  status: string;
  channel: { id: string; name: string; type: string };
  lastMessageAt: string | null;
  createdAt: string;
};

const TENANT = "/api/inbox";
const PLATFORM = "/api/admin/inbox";

describe("GET .../conversations/:id/related", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  let cloudId: string;
  let qrId: string;
  let thirdId: string;
  let otherTenantChannelId: string;
  let platformCloudId: string;
  let platformQrId: string;
  const users: Record<string, TestUser> = {};
  const phoneKeys: string[] = [];

  beforeAll(async () => {
    owner = connectOwner();
    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner, "Clínica X1")).id;
    users.stranger = await createUser(owner);
    otherTenantId = (await createTenant(users.stranger, "Outra Clínica X1")).id;
    for (const role of ["memberA", "memberB"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, "member");
      users[role] = user;
    }
    await createRole(users.owner, "sem-leitura", ["customer:read"]);
    users.noRead = await createUser(owner);
    await addMember(owner, tenantId, users.noRead, "sem-leitura");

    cloudId = (await seedCloudChannel(tenantScope(tenantId), { name: "Principal-x1" })).id;
    qrId = (await seedQrChannel(tenantScope(tenantId), { name: "Vendas-x1" })).id;
    thirdId = (await seedQrChannel(tenantScope(tenantId), { name: "Suporte-x1" })).id;
    otherTenantChannelId = (await seedQrChannel(tenantScope(otherTenantId), { name: "Alheio-x1" })).id;
    platformCloudId = (await seedCloudChannel(platformScope, { name: "PlataformaA-chtest" })).id;
    platformQrId = (await seedQrChannel(platformScope, { name: "PlataformaB-chtest" })).id;

    users.platformOwner = await makePlatformUser(owner, "platform_owner");
    users.support = await makePlatformUser(owner, "platform_support");
  });

  afterEach(async () => {
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
    await owner`delete from "user" where id in (${users.platformOwner?.id as string}, ${users.support?.id as string})`;
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);
  const related = (base: string, conversationId: string, role: string) =>
    call("GET", `${base}/conversations/${conversationId}/related`, { cookie: as(role) });
  const itemsOf = async (response: Response) => (await bodyOf(response)).items as Related[];

  describe("tenant", () => {
    it("traz as outras conversas do contato, com número, situação e data, e nunca a própria", async () => {
      const first = await seedConversation(scope(), cloudId, {
        lastMessageAt: new Date("2026-01-10T10:00:00Z"),
      });
      const second = await seedConversationOnContact(scope(), qrId, first.contactId, {
        status: "closed",
        lastMessageAt: new Date("2026-01-12T10:00:00Z"),
      });
      const third = await seedConversationOnContact(scope(), thirdId, first.contactId, {
        status: "pending",
        lastMessageAt: new Date("2026-01-11T10:00:00Z"),
      });
      // Outro contato, no mesmo número: não é "deste contato".
      await seedConversation(scope(), qrId);

      const response = await related(TENANT, first.id, "owner");
      expect(response.status).toBe(200);
      const items = await itemsOf(response);

      // Da mais recente para a mais antiga.
      expect(items.map((item) => item.id)).toEqual([second.id, third.id]);
      expect(items[0]).toMatchObject({
        status: "closed",
        channel: { id: qrId, name: "Vendas-x1", type: "whatsapp_qr" },
      });
      expect(items[1]).toMatchObject({ status: "pending", channel: { id: thirdId } });
      expect(items[0]?.lastMessageAt).toBe("2026-01-12T10:00:00.000Z");

      // A partir de uma das outras, a lista muda: a própria sai e a primeira entra.
      const fromSecond = await itemsOf(await related(TENANT, second.id, "owner"));
      expect(fromSecond.map((item) => item.id)).toEqual([third.id, first.id]);
    });

    it("só devolve o que a seção mostra: nada de dono, prévia, contador, telefone ou nome", async () => {
      const first = await seedConversation(scope(), cloudId, { waName: "Fulana Secreta" });
      await seedConversationOnContact(scope(), qrId, first.contactId, { unreadCount: 5 });

      const body = await bodyOf(await related(TENANT, first.id, "owner"));
      expect(Object.keys(body)).toEqual(["items"]);
      const [item] = body.items as Related[];
      expect(Object.keys(item as object).sort()).toEqual([
        "channel",
        "createdAt",
        "id",
        "lastMessageAt",
        "status",
      ]);
      const text = JSON.stringify(body);
      expect(text).not.toContain("segredo da outra conversa");
      expect(text).not.toContain("Fulana Secreta");
      expect(text).not.toContain(first.phone);
    });

    it("contato sem outras conversas: lista vazia", async () => {
      const only = await seedConversation(scope(), cloudId);
      const response = await related(TENANT, only.id, "owner");
      expect(response.status).toBe(200);
      expect(await itemsOf(response)).toEqual([]);
    });

    it("visibilidade por pessoa: a conversa de outro membro não aparece, não conta e não se revela", async () => {
      // A atual está na fila (qualquer um vê); as outras: sem dono e do membro A.
      const base = await seedConversation(scope(), cloudId);
      const free = await seedConversationOnContact(scope(), qrId, base.contactId);
      const ofA = await seedConversationOnContact(scope(), thirdId, base.contactId, {
        assignedUserId: users.memberA?.id,
      });

      // O membro B não vê a do A: só a sem dono.
      const forB = await itemsOf(await related(TENANT, base.id, "memberB"));
      expect(forB.map((item) => item.id)).toEqual([free.id]);

      // O membro A vê as duas.
      const forA = await itemsOf(await related(TENANT, base.id, "memberA"));
      expect(forA.map((item) => item.id).sort()).toEqual([free.id, ofA.id].sort());

      // Quem vê tudo (owner) também.
      expect(await itemsOf(await related(TENANT, base.id, "owner"))).toHaveLength(2);

      // A partir da conversa que B não vê, 404 igual a id inexistente.
      const hidden = await related(TENANT, ofA.id, "memberB");
      const missing = await related(TENANT, randomUUID(), "memberB");
      expect(hidden.status).toBe(404);
      expect(await hidden.text()).toBe(await missing.text());
    });

    it("quando todas as outras estão fora do alcance, a lista é vazia (a seção some)", async () => {
      const base = await seedConversation(scope(), cloudId);
      await seedConversationOnContact(scope(), qrId, base.contactId, {
        assignedUserId: users.memberA?.id,
      });

      const forB = await related(TENANT, base.id, "memberB");
      expect(forB.status).toBe(200);
      expect(await itemsOf(forB)).toEqual([]);
    });

    it("outra organização e id inexistente respondem 404; sem sessão 401; sem inbox:read 403; id inválido 404", async () => {
      const mine = await seedConversation(scope(), cloudId);
      await seedConversationOnContact(scope(), qrId, mine.contactId);
      const alien = await seedConversation(tenantScope(otherTenantId), otherTenantChannelId);

      expect((await related(TENANT, mine.id, "stranger")).status).toBe(404);
      expect((await related(TENANT, alien.id, "owner")).status).toBe(404);
      expect((await related(TENANT, randomUUID(), "owner")).status).toBe(404);
      expect((await call("GET", `${TENANT}/conversations/${mine.id}/related`)).status).toBe(401);
      expect((await related(TENANT, mine.id, "noRead")).status).toBe(403);
      expect((await related(TENANT, "nao-e-um-id", "owner")).status).toBe(404);
    });

    it("a conversa da plataforma não é alcançada pelo tenant", async () => {
      const own = await seedConversation(platformScope, platformCloudId);
      phoneKeys.push(own.phoneKey);
      expect((await related(TENANT, own.id, "owner")).status).toBe(404);
    });
  });

  describe("plataforma", () => {
    it("lista as outras conversas da plataforma do contato, para o suporte e o proprietário", async () => {
      const first = await seedConversation(platformScope, platformCloudId, {
        lastMessageAt: new Date("2026-02-01T10:00:00Z"),
      });
      phoneKeys.push(first.phoneKey);
      const second = await seedConversationOnContact(platformScope, platformQrId, first.contactId, {
        status: "pending",
        lastMessageAt: new Date("2026-02-02T10:00:00Z"),
      });

      for (const role of ["platformOwner", "support"]) {
        const response = await related(PLATFORM, first.id, role);
        expect(response.status).toBe(200);
        const items = await itemsOf(response);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          id: second.id,
          status: "pending",
          channel: { id: platformQrId, name: "PlataformaB-chtest" },
        });
      }
    });

    it("contato sem outras conversas: lista vazia", async () => {
      const only = await seedConversation(platformScope, platformCloudId);
      phoneKeys.push(only.phoneKey);
      expect(await itemsOf(await related(PLATFORM, only.id, "platformOwner"))).toEqual([]);
    });

    it("isolamento: nada de tenant aparece e a conversa de tenant responde 404", async () => {
      const tenantFirst = await seedConversation(scope(), cloudId);
      await seedConversationOnContact(scope(), qrId, tenantFirst.contactId);
      const own = await seedConversation(platformScope, platformCloudId);
      phoneKeys.push(own.phoneKey);

      expect((await related(PLATFORM, tenantFirst.id, "platformOwner")).status).toBe(404);
      expect(await itemsOf(await related(PLATFORM, own.id, "platformOwner"))).toEqual([]);
    });

    it("exige sessão e papel de plataforma: sem sessão 401; dono e membro de tenant 403; id inexistente 404", async () => {
      const own = await seedConversation(platformScope, platformCloudId);
      phoneKeys.push(own.phoneKey);

      expect((await call("GET", `${PLATFORM}/conversations/${own.id}/related`)).status).toBe(401);
      expect((await related(PLATFORM, own.id, "owner")).status).toBe(403);
      expect((await related(PLATFORM, own.id, "memberA")).status).toBe(403);
      expect((await related(PLATFORM, randomUUID(), "platformOwner")).status).toBe(404);
    });
  });
});
