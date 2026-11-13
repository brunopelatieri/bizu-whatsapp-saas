import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setInboxEventTimingForTests } from "@/api/inbox-events";
import { withPlatformData, withScope } from "@/db/rls";
import { auditLog, conversation, customer, message, messageTemplate } from "@/db/schema";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { setProvidersForTests } from "@/lib/channels/registry";
import type {
  ChannelProvider,
  SendMedia,
  SendResult,
  SendTemplate,
  SendText,
} from "@/lib/channels/types";
import { selectConversationRows } from "@/lib/inbox/views";
import { phoneValues } from "@/lib/phone/columns";
import { stopRealtime } from "@/lib/inbox/realtime";
import { setStorageForTests } from "@/lib/storage";
import { bodyOf, makePlatformUser } from "./billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "./channels-helpers";
import { attachMedia, memoryStorage, readAll, seedConversation, seedMessage } from "./inbox-helpers";
import { uniquePhone } from "./phone-helpers";
import { applyCookies } from "./security-helpers";
import {
  addMember,
  call,
  callForm,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * C6: o atendimento da plataforma (`/api/admin/inbox/*`), com Postgres real e o provedor simulado.
 * Foco no isolamento (nenhuma conversa de tenant na plataforma e vice-versa, no SSE também), em quem
 * responde (proprietário e suporte; nunca canal, etiqueta e campo), na ausência de clientes dos
 * owners (`customerId` é 400, nenhuma consulta a `customer`) e na personificação.
 */

const BASE = "/api/admin/inbox";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 7),
]);

type Item = {
  id: string;
  status: string;
  assignedTo: unknown;
  contact: { id: string; displayName: string | null; phone: string; identified: boolean };
  unreadCount: number;
  tags: unknown[];
};
type View = {
  id: string;
  status: string | null;
  text: string | null;
  sender: { id: string } | null;
  template: { name: string } | null;
  media: { url: string; status: string } | null;
};

type Sse = {
  status: number;
  events: Record<string, unknown>[];
  ready: () => boolean;
  close: () => Promise<void>;
};

const openStreams: Sse[] = [];

/** Abre um SSE e acumula os eventos `inbox` (só ids) e se já recebeu o `ready`. */
async function openEvents(path: string, cookie?: string): Promise<Sse> {
  const response = await call("GET", path, { cookie });
  const events: Record<string, unknown>[] = [];
  let ready = false;

  if (response.status !== 200 || !response.body) {
    return { status: response.status, events, ready: () => false, close: async () => {} };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (block.includes("event: ready")) ready = true;
          const data = block.split("\n").find((line) => line.startsWith("data: "));
          if (block.includes("event: inbox") && data) events.push(JSON.parse(data.slice(6)));
          cut = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Cancelado pelo teste.
    }
  })();

  const stream: Sse = {
    status: 200,
    events,
    ready: () => ready,
    close: async () => {
      await reader.cancel().catch(() => {});
      await reading;
    },
  };
  openStreams.push(stream);
  return stream;
}

async function until(condition: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condição não atingida");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const pause = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe("/api/admin/inbox: atendimento da plataforma", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  const memory = memoryStorage();
  const users: Record<string, TestUser> = {};
  const phoneKeys: string[] = [];
  const createdUsers: string[] = [];
  const sentText: SendText[] = [];
  const sentMedia: SendMedia[] = [];
  const sentTemplates: SendTemplate[] = [];
  const WABA = `waba-${randomUUID().slice(0, 8)}`;
  let cloudId: string;
  let qrId: string;
  let tenantChannelId: string;

  const fake = (type: "whatsapp_cloud" | "whatsapp_qr") =>
    ({
      type,
      sendText: async (_ctx: unknown, input: SendText): Promise<SendResult> => {
        sentText.push(input);
        return { providerMessageId: `wamid.${randomUUID()}` };
      },
      sendMedia: async (_ctx: unknown, input: SendMedia): Promise<SendResult> => {
        sentMedia.push(input);
        return { providerMessageId: `wamid.${randomUUID()}` };
      },
      sendTemplate: async (_ctx: unknown, input: SendTemplate): Promise<SendResult> => {
        sentTemplates.push(input);
        return { providerMessageId: `wamid.${randomUUID()}` };
      },
    }) as unknown as ChannelProvider;

  /** Contato e conversa da plataforma; a chave do telefone entra na limpeza. */
  async function platformConversation(options: Parameters<typeof seedConversation>[2] = {}, channelId = cloudId) {
    const seeded = await seedConversation(platformScope, channelId, options);
    phoneKeys.push(seeded.phoneKey);
    return seeded;
  }

  /**
   * Usuário (da plataforma ou de tenant) com um telefone conhecido, para vincular e iniciar
   * conversa. Confirmado por padrão; `verified: false` é o número só declarado no cadastro.
   */
  async function userWithPhone(phone = uniquePhone(), verified = true) {
    const user = await createUser(owner);
    const values = phoneValues(phone);
    await owner`update "user" set phone = ${values.phone}, phone_normalized = ${values.phoneNormalized}, phone_key = ${values.phoneKey}, phone_verified_at = ${verified ? new Date() : null}, phone_verified_via = ${verified ? "manual" : null} where id = ${user.id}`;
    createdUsers.push(user.id);
    phoneKeys.push(values.phoneKey);
    return { user, ...values, normalized: values.phoneNormalized };
  }

  beforeAll(async () => {
    owner = connectOwner();
    users.platformOwner = await makePlatformUser(owner, "platform_owner");
    users.support = await makePlatformUser(owner, "platform_support");
    users.tenantOwner = await createUser(owner);
    tenantId = (await createTenant(users.tenantOwner, "Clínica C6")).id;
    users.member = await createUser(owner);
    await addMember(owner, tenantId, users.member, "member");

    cloudId = (await seedCloudChannel(platformScope, { name: "Plataforma-chtest", wabaId: WABA })).id;
    qrId = (await seedQrChannel(platformScope, { name: "PlataformaQR-chtest" })).id;
    tenantChannelId = (await seedCloudChannel(tenantScope(tenantId))).id;

    await withPlatformData((tx) =>
      tx.insert(messageTemplate).values({
        tenantId: null,
        wabaId: WABA,
        name: "aviso_plataforma",
        language: "pt_BR",
        status: "APPROVED",
        components: [{ type: "BODY", text: "Olá {{1}}, aviso da plataforma." }],
      }),
    );
  });

  beforeEach(() => {
    setStorageForTests(memory.storage);
    setProvidersForTests([fake("whatsapp_cloud"), fake("whatsapp_qr")]);
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    setInboxEventTimingForTests(undefined);
    sentText.length = 0;
    sentMedia.length = 0;
    sentTemplates.length = 0;
    await waitForBackgroundTasks();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id is null and phone_key = any(${phoneKeys})`;
      await tx`delete from chat_contact where tenant_id = ${tenantId}`;
      await tx`delete from customer where tenant_id = ${tenantId}`;
      await tx`delete from audit_log where tenant_id is null and action like 'inbox.%' and actor_id in (${users.platformOwner?.id as string}, ${users.support?.id as string})`;
    });
    phoneKeys.length = 0;
  });

  afterAll(async () => {
    await stopRealtime();
    await withPlatformData((tx) => tx.delete(messageTemplate).where(eq(messageTemplate.wabaId, WABA)));
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    if (createdUsers.length) await owner`delete from "user" where id = any(${createdUsers})`;
    await owner`delete from "user" where id in (${users.platformOwner?.id as string}, ${users.support?.id as string})`;
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const id = () => `c-${randomUUID()}`;
  const send = (role: string, conversationId: string, body: Record<string, unknown>) =>
    call("POST", `${BASE}/conversations/${conversationId}/messages`, {
      cookie: as(role),
      body: { type: "text", clientId: id(), ...body },
    });
  const messagesOf = (conversationId: string) =>
    readAll((tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)));

  // -------------------------------------------------------------------------
  describe("acesso", () => {
    const routes = (conversationId: string, messageId: string, contactId: string) =>
      [
        ["GET", `${BASE}/conversations`],
        ["GET", `${BASE}/conversations/${conversationId}`],
        ["GET", `${BASE}/conversations/${conversationId}/messages`],
        ["GET", `${BASE}/conversations/${conversationId}/templates`],
        ["GET", `${BASE}/unread`],
        ["GET", `${BASE}/events`],
        ["GET", `${BASE}/messages/${messageId}/media`],
        ["POST", `${BASE}/conversations/${conversationId}/status`, { status: "closed" }],
        ["POST", `${BASE}/conversations/${conversationId}/read`],
        ["POST", `${BASE}/conversations/${conversationId}/messages`, { type: "text", text: "oi", clientId: "abcdefgh1" }],
        ["POST", `${BASE}/messages/${messageId}/retry`],
        ["POST", `${BASE}/messages/${messageId}/media/retry`],
        ["POST", `${BASE}/conversations`, { channelId: cloudId, phone: "11987654321" }],
        ["PATCH", `${BASE}/contacts/${contactId}`, { name: "X" }],
        ["POST", `${BASE}/contacts/${contactId}/link`, { userId: null }],
      ] as const;

    it("sem sessão: 401; dono de tenant e membro: 403, na leitura e na escrita", async () => {
      const thread = await platformConversation();
      const sent = await seedMessage(platformScope, { conversationId: thread.id, channelId: cloudId }, { direction: "out" });

      for (const [method, path, body] of routes(thread.id, sent.id, thread.contactId)) {
        expect((await call(method, path, { body })).status, `anônimo ${method} ${path}`).toBe(401);
        for (const role of ["tenantOwner", "member"]) {
          const response = await call(method, path, { cookie: as(role), body });
          expect(response.status, `${role} ${method} ${path}`).toBe(403);
          expect((await bodyOf(response)).code).toBe("PLATFORM_FORBIDDEN");
        }
      }
    });

    it("rotas que não existem na plataforma respondem 404: claim, assign, assignees, candidates e customer", async () => {
      const thread = await platformConversation();
      const missing = [
        ["POST", `${BASE}/conversations/${thread.id}/claim`, undefined],
        ["POST", `${BASE}/conversations/${thread.id}/assign`, { userId: null }],
        ["GET", `${BASE}/assignees`, undefined],
        ["GET", `${BASE}/contacts/${thread.contactId}/candidates`, undefined],
        ["POST", `${BASE}/contacts/${thread.contactId}/customer`, { name: "Cliente" }],
      ] as const;

      for (const role of ["platformOwner", "support"]) {
        for (const [method, path, body] of missing) {
          expect((await call(method, path, { cookie: as(role), body })).status, `${role} ${method} ${path}`).toBe(404);
        }
      }
    });

    it("suporte e proprietário leem, e a lista é só a lista (a aba e o filtro de dono não existem)", async () => {
      await platformConversation({ assignedUserId: null, unreadCount: 2 });
      await platformConversation({ status: "closed" });

      for (const role of ["platformOwner", "support"]) {
        const response = await call("GET", `${BASE}/conversations?tab=queue&assignedTo=${randomUUID()}&tagIds=${randomUUID()}`, {
          cookie: as(role),
        });
        expect(response.status).toBe(200);
        const { items } = (await bodyOf(response)) as { items: Item[] };
        // Sem aba: a encerrada também aparece.
        expect(items.length).toBeGreaterThanOrEqual(2);
        expect(items.every((item) => item.assignedTo === null)).toBe(true);
      }
    });

    it("o suporte responde, mas não mexe em canal, etiqueta nem campo; o proprietário, sim", async () => {
      const writes = [
        ["PATCH", `/api/admin/channels/${cloudId}`, { name: "Hack" }],
        ["POST", `/api/admin/channels/${cloudId}/default`, undefined],
        ["DELETE", `/api/admin/channels/${cloudId}`, { confirm: "x" }],
        ["POST", "/api/admin/crm/tags", { name: "x" }],
        ["POST", "/api/admin/crm/custom-fields", { entity: "organization", label: "x", type: "text" }],
        ["PUT", `/api/admin/tenants/${tenantId}/profile`, { tagIds: [] }],
      ] as const;

      for (const [method, path, body] of writes) {
        const response = await call(method, path, { cookie: as("support"), body });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await bodyOf(response)).code).toBe("PLATFORM_FORBIDDEN");
      }

      const thread = await platformConversation();
      expect((await send("support", thread.id, { text: "Resposta do suporte" })).status).toBe(201);
      expect((await send("platformOwner", thread.id, { text: "Resposta do proprietário" })).status).toBe(201);
    });
  });

  // -------------------------------------------------------------------------
  describe("isolamento entre plataforma e tenants", () => {
    it("nenhuma conversa de tenant aparece na plataforma, nem se alcança por id, e vice-versa", async () => {
      const own = await platformConversation({ waName: "Contato da plataforma" });
      const tenantThread = await seedConversation(tenantScope(tenantId), tenantChannelId, { waName: "Contato do tenant" });
      const tenantMessage = await seedMessage(tenantScope(tenantId), { conversationId: tenantThread.id, channelId: tenantChannelId });

      const listed = (await bodyOf(await call("GET", `${BASE}/conversations?limit=50`, { cookie: as("platformOwner") }))) as { items: Item[] };
      expect(listed.items.map((item) => item.id)).toContain(own.id);
      expect(listed.items.map((item) => item.id)).not.toContain(tenantThread.id);
      expect(listed.items.some((item) => item.contact.displayName === "Contato do tenant")).toBe(false);

      // A plataforma não alcança o id do tenant em nenhuma rota (404 igual a inexistente).
      const probes = [
        ["GET", `${BASE}/conversations/${tenantThread.id}`],
        ["GET", `${BASE}/conversations/${tenantThread.id}/messages`],
        ["GET", `${BASE}/messages/${tenantMessage.id}/media`],
        ["POST", `${BASE}/conversations/${tenantThread.id}/status`, { status: "closed" }],
        ["POST", `${BASE}/conversations/${tenantThread.id}/read`],
        ["POST", `${BASE}/conversations/${tenantThread.id}/messages`, { type: "text", text: "oi", clientId: id() }],
        ["PATCH", `${BASE}/contacts/${tenantThread.contactId}`, { name: "X" }],
        ["POST", `${BASE}/contacts/${tenantThread.contactId}/link`, { userId: null }],
      ] as const;
      for (const [method, path, body] of probes) {
        expect((await call(method, path, { cookie: as("platformOwner"), body })).status, `${method} ${path}`).toBe(404);
      }
      expect(sentText).toEqual([]);

      // E o tenant não vê a da plataforma.
      const tenantList = (await bodyOf(await call("GET", "/api/inbox/conversations?tab=all", { cookie: as("tenantOwner") }))) as { items: Item[] };
      expect(tenantList.items.map((item) => item.id)).not.toContain(own.id);
      expect((await call("GET", `/api/inbox/conversations/${own.id}`, { cookie: as("tenantOwner") })).status).toBe(404);
      expect((await call("GET", `/api/inbox/conversations/${own.id}/messages`, { cookie: as("tenantOwner") })).status).toBe(404);
      expect((await call("POST", `/api/inbox/conversations/${own.id}/status`, { cookie: as("tenantOwner"), body: { status: "closed" } })).status).toBe(404);

      // O contador de não lidas também é por escopo.
      await platformConversation({ unreadCount: 3 });
      const platformUnread = (await bodyOf(await call("GET", `${BASE}/unread`, { cookie: as("support") }))) as { queue: number };
      expect(platformUnread.queue).toBeGreaterThanOrEqual(1);
    });

    it("a mídia é da plataforma: sai pela rota de /admin e o tenant não a baixa", async () => {
      const thread = await platformConversation();
      const incoming = await seedMessage(platformScope, { conversationId: thread.id, channelId: cloudId }, { type: "image", text: null });
      await attachMedia(platformScope, memory, incoming.id, PNG, "image/png", "foto.png");

      const response = await call("GET", `${BASE}/messages/${incoming.id}/media`, { cookie: as("support") });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");

      expect((await call("GET", `/api/inbox/messages/${incoming.id}/media`, { cookie: as("tenantOwner") })).status).toBe(404);

      const thread2 = (await bodyOf(await call("GET", `${BASE}/conversations/${thread.id}/messages`, { cookie: as("support") }))) as { items: View[] };
      expect(thread2.items[0]?.media?.url).toBe(`${BASE}/messages/${incoming.id}/media`);
    });
  });

  // -------------------------------------------------------------------------
  describe("envio", () => {
    it("texto: grava com tenant nulo, sem dono, com o autor, e o suporte também responde", async () => {
      const thread = await platformConversation({ unreadCount: 4 });

      for (const role of ["support", "platformOwner"]) {
        const response = await send(role, thread.id, { text: `Olá de ${role}` });
        expect(response.status).toBe(201);
        const view = (await bodyOf(response)).message as View;
        expect(view).toMatchObject({ status: "sent", text: `Olá de ${role}`, sender: { id: users[role]?.id } });
      }

      expect(sentText.map((item) => item.to)).toEqual([thread.phone, thread.phone]);
      const rows = await messagesOf(thread.id);
      expect(rows.every((row) => row.tenantId === null)).toBe(true);
      const [row] = await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, thread.id)));
      expect(row).toMatchObject({ tenantId: null, assignedUserId: null, unreadCount: 0 });
    });

    it("anexo (multipart) e modelo: a plataforma envia o que o tenant envia", async () => {
      const thread = await platformConversation();

      const form = new FormData();
      form.set("file", new Blob([PNG], { type: "image/png" }), "logo.png");
      form.set("caption", "Nossa marca");
      form.set("clientId", id());
      const media = await callForm("POST", `${BASE}/conversations/${thread.id}/messages`, { cookie: as("support"), form });
      expect(media.status).toBe(201);
      const mediaView = (await bodyOf(media)).message as View;
      expect(mediaView.media?.url).toBe(`${BASE}/messages/${mediaView.id}/media`);
      expect(sentMedia).toHaveLength(1);
      const [stored] = await readAll((tx) => tx.select().from(message).where(eq(message.id, mediaView.id)));
      expect(stored?.tenantId).toBeNull();

      // Fechada a janela, só o modelo sai.
      const closed = await platformConversation({ lastInboundAt: null });
      expect((await send("support", closed.id, { text: "oi" })).status).toBe(409);

      const templates = (await bodyOf(await call("GET", `${BASE}/conversations/${closed.id}/templates`, { cookie: as("support") }))) as {
        templates: { id: string; name: string }[];
      };
      const approved = templates.templates.find((template) => template.name === "aviso_plataforma");
      expect(approved).toBeDefined();

      const sentTemplate = await call("POST", `${BASE}/conversations/${closed.id}/messages`, {
        cookie: as("platformOwner"),
        body: { type: "template", templateId: approved?.id, variables: ["Ana"], clientId: id() },
      });
      expect(sentTemplate.status).toBe(201);
      expect(((await bodyOf(sentTemplate)).message as View).template?.name).toBe("aviso_plataforma");
      expect(sentTemplates).toHaveLength(1);
    });

    it("situação: encerrar e reabrir à mão; a auditoria sai sem tenant e sem texto", async () => {
      const thread = await platformConversation();

      const closed = await call("POST", `${BASE}/conversations/${thread.id}/status`, { cookie: as("support"), body: { status: "closed" } });
      expect(closed.status).toBe(200);
      expect(((await bodyOf(closed)).conversation as Item).status).toBe("closed");
      await call("POST", `${BASE}/conversations/${thread.id}/status`, { cookie: as("platformOwner"), body: { status: "open" } });

      const audit = await readAll((tx) => tx.select().from(auditLog).where(eq(auditLog.targetId, thread.id)));
      expect(audit.map((row) => row.action).sort()).toEqual(["inbox.conversation_closed", "inbox.conversation_reopened"]);
      expect(audit.every((row) => row.tenantId === null && row.actorType === "platform")).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(thread.phone);
    });

    it("canal desconectado (a conversa existe): 409", async () => {
      const down = (await seedCloudChannel(platformScope, { name: "Fora-chtest", status: "disconnected" })).id;
      const thread = await platformConversation({}, down);
      const response = await send("support", thread.id, { text: "oi" });
      expect(response.status).toBe(409);
      expect((await bodyOf(response)).code).toBe("CHANNEL_NOT_CONNECTED");
    });
  });

  // -------------------------------------------------------------------------
  describe("iniciar conversa e vincular", () => {
    it("por usuário (com telefone) ou por telefone; customerId é 400; sem telefone, 400", async () => {
      const { user, normalized } = await userWithPhone();

      const byUser = await call("POST", `${BASE}/conversations`, { cookie: as("support"), body: { channelId: cloudId, userId: user.id } });
      expect(byUser.status).toBe(201);
      const created = (await bodyOf(byUser)).conversation as Item;
      expect(created).toMatchObject({ status: "open", assignedTo: null });
      expect(created.contact.identified).toBe(true);
      expect(created.contact.phone).toBe(normalized);

      // Repetido: acha a mesma, 200.
      const again = await call("POST", `${BASE}/conversations`, { cookie: as("platformOwner"), body: { channelId: cloudId, userId: user.id } });
      expect(again.status).toBe(200);
      expect(((await bodyOf(again)).conversation as Item).id).toBe(created.id);

      // Usuário com o telefone só declarado no cadastro: a conversa abre, sem vínculo.
      const declared = await userWithPhone(uniquePhone(), false);
      const pending = await call("POST", `${BASE}/conversations`, { cookie: as("support"), body: { channelId: qrId, userId: declared.user.id } });
      expect(pending.status).toBe(201);
      expect(((await bodyOf(pending)).conversation as Item).contact.identified).toBe(false);

      const typed = uniquePhone();
      phoneKeys.push(phoneValues(typed).phoneKey);
      const byPhone = await call("POST", `${BASE}/conversations`, { cookie: as("support"), body: { channelId: qrId, phone: typed } });
      expect(byPhone.status).toBe(201);
      expect(((await bodyOf(byPhone)).conversation as Item).contact.identified).toBe(false);

      for (const body of [
        { channelId: cloudId, customerId: randomUUID() },
        { channelId: cloudId, userId: user.id, customerId: randomUUID() },
        { channelId: cloudId, phone: typed, customerId: randomUUID() },
        { channelId: cloudId },
        { channelId: cloudId, userId: user.id, phone: typed },
      ]) {
        const response = await call("POST", `${BASE}/conversations`, { cookie: as("support"), body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      // Canal de tenant não é alcançável pela plataforma.
      const foreign = await call("POST", `${BASE}/conversations`, { cookie: as("support"), body: { channelId: tenantChannelId, phone: typed } });
      expect(foreign.status).toBe(404);
    });

    it("telefone avulso que pertence a um cliente de owner fica 'não identificado'", async () => {
      const phone = uniquePhone();
      const values = phoneValues(phone);
      phoneKeys.push(values.phoneKey);
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into customer (tenant_id, name, phone, phone_normalized, phone_key) values (${tenantId}, 'Cliente do owner', ${values.phone}, ${values.phoneNormalized}, ${values.phoneKey})`;
      });

      const response = await call("POST", `${BASE}/conversations`, { cookie: as("support"), body: { channelId: cloudId, phone } });
      expect(response.status).toBe(201);
      const item = (await bodyOf(response)).conversation as Item;
      expect(item.contact).toMatchObject({ identified: false, displayName: null });

      const detail = (await bodyOf(await call("GET", `${BASE}/conversations/${item.id}`, { cookie: as("support") }))) as {
        link: { kind: string; candidates?: unknown };
        contact: { identified: boolean };
      };
      expect(detail.link).toEqual({ kind: "none" });
      expect(JSON.stringify(detail)).not.toContain("Cliente do owner");
    });

    it("vínculo com usuário: organizações com papel, etiquetas e campos; sem correspondência, 'none'", async () => {
      const { user, normalized } = await userWithPhone();
      const thread = await platformConversation({ phone: normalized });

      // Sem vínculo e sem candidatos (a rota não existe).
      const before = (await bodyOf(await call("GET", `${BASE}/conversations/${thread.id}`, { cookie: as("support") }))) as { link: unknown };
      expect(before.link).toEqual({ kind: "none" });

      // O usuário é membro de uma organização anotada pela plataforma.
      const orgId = tenantId;
      await addMember(owner, orgId, { ...user }, "admin");
      const [tag] = await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        const rows = await tx<{ id: string }[]>`insert into tag (tenant_id, name, color) values (null, ${`VIP ${randomUUID().slice(0, 6)}`}, '#16a34a') returning id`;
        await tx`insert into organization_tag (organization_id, tag_id) values (${orgId}, ${rows[0]?.id})`;
        await tx`insert into organization_profile (organization_id, custom_fields) values (${orgId}, ${tx.json({ campo: "valor" })}) on conflict (organization_id) do update set custom_fields = excluded.custom_fields`;
        return rows;
      });

      const linked = await call("POST", `${BASE}/contacts/${thread.contactId}/link`, { cookie: as("support"), body: { userId: user.id } });
      expect(linked.status).toBe(200);
      const body = (await bodyOf(linked)) as {
        contact: { identified: boolean };
        link: {
          kind: string;
          user: { id: string };
          organizations: { id: string; name: string; role: string; tags: { id: string }[]; customFields: Record<string, unknown> }[];
        };
      };
      expect(body.contact.identified).toBe(true);
      expect(body.link).toMatchObject({ kind: "user", user: { id: user.id } });
      expect(body.link.organizations).toEqual([
        expect.objectContaining({ id: orgId, name: "Clínica C6", role: "admin", customFields: { campo: "valor" } }),
      ]);
      expect(body.link.organizations[0]?.tags.map((entry) => entry.id)).toEqual([tag?.id]);

      // O painel (GET) mostra o mesmo, e a lista marca o contato como identificado.
      const detail = (await bodyOf(await call("GET", `${BASE}/conversations/${thread.id}`, { cookie: as("platformOwner") }))) as { link: { kind: string } };
      expect(detail.link.kind).toBe("user");

      // Desvincular.
      const cleared = await call("POST", `${BASE}/contacts/${thread.contactId}/link`, { cookie: as("support"), body: { userId: null } });
      expect(cleared.status).toBe(200);
      expect(((await bodyOf(cleared)).link as { kind: string }).kind).toBe("none");

      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`delete from organization_profile where organization_id = ${orgId}`;
        await tx`delete from organization_tag where organization_id = ${orgId}`;
        await tx`delete from tag where id = ${tag?.id}`;
      });
    });

    it("vincular recusa cliente, corpo extra, usuário inexistente e contato de tenant", async () => {
      const thread = await platformConversation();
      const link = (body: unknown, contactId = thread.contactId) =>
        call("POST", `${BASE}/contacts/${contactId}/link`, { cookie: as("support"), body });

      expect((await link({ customerId: randomUUID() })).status).toBe(400);
      expect((await link({ userId: randomUUID(), customerId: null })).status).toBe(400);
      expect((await link({ customerId: null, userId: null })).status).toBe(400);
      const ghost = await link({ userId: randomUUID() });
      expect(ghost.status).toBe(400);
      expect((await bodyOf(ghost)).code).toBe("INVALID_LINK");

      const tenantThread = await seedConversation(tenantScope(tenantId), tenantChannelId);
      expect((await link({ userId: null }, tenantThread.contactId)).status).toBe(404);
    });

    it("renomear o contato", async () => {
      const thread = await platformConversation();
      const response = await call("PATCH", `${BASE}/contacts/${thread.contactId}`, { cookie: as("support"), body: { name: "Fulana" } });
      expect(response.status).toBe(200);
      expect(((await bodyOf(response)).contact as { displayName: string }).displayName).toBe("Fulana");
    });
  });

  // -------------------------------------------------------------------------
  describe("sem acesso a clientes dos owners", () => {
    it("cliente de tenant com o mesmo telefone não aparece, nem como vínculo, nome ou etiqueta", async () => {
      const phone = uniquePhone();
      const values = phoneValues(phone);
      phoneKeys.push(values.phoneKey);
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into customer (tenant_id, name, phone, phone_normalized, phone_key) values (${tenantId}, 'Sigilo do Owner', ${values.phone}, ${values.phoneNormalized}, ${values.phoneKey})`;
      });
      const thread = await platformConversation({ phone: values.phoneNormalized, waName: null });

      const list = await call("GET", `${BASE}/conversations?q=Sigilo`, { cookie: as("platformOwner") });
      expect(((await bodyOf(list)) as { items: Item[] }).items).toEqual([]);

      const everything = [
        await call("GET", `${BASE}/conversations?limit=50`, { cookie: as("platformOwner") }),
        await call("GET", `${BASE}/conversations/${thread.id}`, { cookie: as("platformOwner") }),
      ];
      for (const response of everything) {
        expect(JSON.stringify(await bodyOf(response))).not.toContain("Sigilo do Owner");
      }

      const detail = (await bodyOf(await call("GET", `${BASE}/conversations/${thread.id}`, { cookie: as("support") }))) as {
        contact: { identified: boolean; displayName: string | null };
        link: unknown;
      };
      expect(detail.contact).toMatchObject({ identified: false, displayName: null });
      expect(detail.link).toEqual({ kind: "none" });
    });

    it("em withPlatformData o banco não mostra customer de tenant, e a consulta da lista nem o menciona", async () => {
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into customer (tenant_id, name, phone, phone_normalized, phone_key) values (${tenantId}, 'Outro cliente', '11987650001', '5511987650001', '551187650001')`;
      });

      expect(await withPlatformData((tx) => tx.select().from(customer))).toEqual([]);

      const sql = await withScope(platformScope, async (tx) => selectConversationRows(tx, platformScope).toSQL().sql);
      expect(sql).not.toMatch(/"customer"/);
      const tenantSql = await withScope(tenantScope(tenantId), async (tx) => selectConversationRows(tx, tenantScope(tenantId)).toSQL().sql);
      expect(tenantSql).toMatch(/"customer"/);
    });
  });

  // -------------------------------------------------------------------------
  describe("tempo real (SSE)", () => {
    afterEach(async () => {
      await Promise.all(openStreams.splice(0).map((stream) => stream.close()));
    });

    it("exige sessão e papel de plataforma", async () => {
      expect((await openEvents(`${BASE}/events`)).status).toBe(401);
      expect((await openEvents(`${BASE}/events`, as("tenantOwner"))).status).toBe(403);
      expect((await openEvents(`${BASE}/events`, as("member"))).status).toBe(403);
      // E a plataforma não abre o fluxo do tenant (precisa de organização ativa).
      expect((await openEvents("/api/inbox/events", as("support"))).status).not.toBe(200);
    });

    it("só entrega eventos do escopo da plataforma; o tenant não recebe os dela", async () => {
      const own = await platformConversation({ status: "open" });
      const tenantThread = await seedConversation(tenantScope(tenantId), tenantChannelId, {});

      const platformStream = await openEvents(`${BASE}/events`, as("support"));
      const tenantStream = await openEvents("/api/inbox/events", as("tenantOwner"));
      expect(platformStream.status).toBe(200);
      expect(tenantStream.status).toBe(200);
      await until(() => platformStream.ready() && tenantStream.ready());

      // Evento da plataforma: só o fluxo dela o recebe.
      await call("POST", `${BASE}/conversations/${own.id}/status`, { cookie: as("platformOwner"), body: { status: "pending" } });
      await until(() => platformStream.events.some((event) => event.c === own.id));
      await pause();
      expect(tenantStream.events.some((event) => event.c === own.id)).toBe(false);

      // Evento do tenant: só o fluxo dele.
      await call("POST", `/api/inbox/conversations/${tenantThread.id}/status`, { cookie: as("tenantOwner"), body: { status: "pending" } });
      await until(() => tenantStream.events.some((event) => event.c === tenantThread.id));
      await pause();
      expect(platformStream.events.some((event) => event.c === tenantThread.id)).toBe(false);

      // A carga leva só ids: nada de texto, telefone ou nome.
      expect(JSON.stringify(platformStream.events)).not.toContain(own.phone);
      for (const event of platformStream.events) {
        expect(Object.keys(event).every((key) => ["c", "k", "m", "a", "p", "u"].includes(key))).toBe(true);
      }
    });

    it("o quarto fluxo da mesma pessoa recebe 429", async () => {
      const opened: Sse[] = [];
      for (let index = 0; index < 3; index += 1) opened.push(await openEvents(`${BASE}/events`, as("platformOwner")));
      expect(opened.map((stream) => stream.status)).toEqual([200, 200, 200]);
      expect((await openEvents(`${BASE}/events`, as("platformOwner"))).status).toBe(429);
    });
  });

  // -------------------------------------------------------------------------
  describe("personificação", () => {
    it("sessão personificada (o suporte dentro do tenant) não lê nem envia no atendimento da plataforma", async () => {
      const granted = await call("POST", "/api/tenant/support-grant", { cookie: as("tenantOwner"), body: { hours: 1 } });
      expect(granted.status).toBe(201);
      const entered = await call("POST", "/api/admin/impersonate", {
        cookie: as("support"),
        body: { userId: users.tenantOwner?.id, tenantId },
      });
      expect(entered.status).toBe(200);
      const cookie = applyCookies(as("support"), entered);

      const thread = await platformConversation();
      const attempts = [
        ["GET", `${BASE}/conversations`, undefined],
        ["POST", `${BASE}/conversations/${thread.id}/messages`, { type: "text", text: "oi", clientId: id() }],
        ["POST", `${BASE}/conversations/${thread.id}/status`, { status: "closed" }],
        ["POST", `${BASE}/conversations`, { channelId: cloudId, phone: "11987654321" }],
      ] as const;
      for (const [method, path, body] of attempts) {
        expect((await call(method, path, { cookie, body })).status, `${method} ${path}`).toBe(403);
      }
      expect(sentText).toEqual([]);
    });
  });
});
