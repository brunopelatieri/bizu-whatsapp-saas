import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { auditLog, chatContact, conversation, customer } from "@/db/schema";
import { bodyOf, cleanUpBilling, createPlanRow, ensureSubscription } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, seedQrChannel, tenantScope } from "./channels-helpers";
import { randomMobile, readAll, seedConversation } from "./inbox-helpers";
import { phoneValues } from "@/lib/phone/columns";
import { uniquePhone } from "./phone-helpers";
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
 * Contato no painel e início de conversa (SPEC, passo 5): vincular e desvincular, candidatos,
 * salvar como cliente (limite do plano, `PHONE_IN_USE`, telefone como o WhatsApp entregou) e
 * iniciar conversa (`canWhatsApp`, `PHONE_NOT_WHATSAPP`, contato que já escreveu).
 */

/** O telefone que `createUser` grava em toda conta de teste (`tenant-helpers.ts`). */
const TEST_USER_PHONE = "5511987654321";

describe("/api/inbox: contato e início de conversa", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  let channelId: string;
  let qrChannelId: string;
  let otherChannelId: string;
  let disabledChannelId: string;
  const users: Record<string, TestUser> = {};

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
    // Atende, mas não mexe no cadastro de clientes.
    await createRole(users.owner, "atendente", ["inbox:read", "inbox:reply"]);
    users.agent = await createUser(owner);
    await addMember(owner, tenantId, users.agent, "atendente");

    channelId = (await seedCloudChannel(tenantScope(tenantId))).id;
    qrChannelId = (await seedQrChannel(tenantScope(tenantId))).id;
    disabledChannelId = (await seedCloudChannel(tenantScope(tenantId), { status: "disabled" })).id;
    otherChannelId = (await seedCloudChannel(tenantScope(otherTenantId))).id;
  });

  afterEach(async () => {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id in (${tenantId}, ${otherTenantId})`;
      await tx`delete from customer where tenant_id in (${tenantId}, ${otherTenantId})`;
    });
  });

  afterAll(async () => {
    await cleanUpBilling(owner);
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);

  async function createCustomer(phone = uniquePhone(), name = "Cliente Teste") {
    const response = await call("POST", "/api/customers", {
      cookie: as("owner"),
      body: { name, phone },
    });
    expect(response.status).toBe(201);
    return (await bodyOf(response)).customer as { id: string; name: string };
  }

  const customerRow = async (id: string) =>
    (await readAll((tx) => tx.select().from(customer).where(eq(customer.id, id))))[0];

  /** O telefone da conta, gravado direto: `createUser` usa o mesmo número, pendente, em todas. */
  async function setUserPhone(userId: string, phone: string, verified: boolean) {
    const values = phoneValues(phone);
    await owner`
      update "user" set phone = ${values.phone}, phone_normalized = ${values.phoneNormalized},
        phone_key = ${values.phoneKey}, phone_verified_at = ${verified ? new Date() : null},
        phone_verified_via = ${verified ? "manual" : null}
      where id = ${userId}
    `;
  }

  const contactRow = async (id: string) =>
    (await readAll((tx) => tx.select().from(chatContact).where(eq(chatContact.id, id))))[0];

  describe("vínculo", () => {
    it("vincula a um cliente, troca por um membro e desfaz; audita só ids", async () => {
      const q = await seedConversation(scope(), channelId);
      const client = await createCustomer();

      const toCustomer = await call("POST", `/api/inbox/contacts/${q.contactId}/link`, {
        cookie: as("memberA"),
        body: { customerId: client.id },
      });
      expect(toCustomer.status).toBe(200);
      expect((await bodyOf(toCustomer)).link).toMatchObject({ kind: "customer", customer: { id: client.id } });

      const toMember = await call("POST", `/api/inbox/contacts/${q.contactId}/link`, {
        cookie: as("memberA"),
        body: { userId: users.memberB?.id },
      });
      expect((await bodyOf(toMember)).link).toMatchObject({ kind: "member", user: { id: users.memberB?.id } });
      expect(await contactRow(q.contactId)).toMatchObject({ customerId: null, userId: users.memberB?.id });

      const unlinked = await call("POST", `/api/inbox/contacts/${q.contactId}/link`, {
        cookie: as("memberA"),
        body: { customerId: null, userId: null },
      });
      expect((await bodyOf(unlinked)).link).toMatchObject({ kind: "none" });

      const audits = await readAll((tx) => tx.select().from(auditLog).where(eq(auditLog.targetId, q.contactId)));
      expect(audits.filter((row) => row.action === "inbox.contact_linked")).toHaveLength(3);
      expect(JSON.stringify(audits)).not.toContain(q.phone);
    });

    it("cliente pede customer:update; membro de fora é 400; cliente de outro tenant é 404", async () => {
      const q = await seedConversation(scope(), channelId);
      const client = await createCustomer();

      const noUpdate = await call("POST", `/api/inbox/contacts/${q.contactId}/link`, {
        cookie: as("agent"),
        body: { customerId: client.id },
      });
      expect(noUpdate.status).toBe(403);

      const outsider = await call("POST", `/api/inbox/contacts/${q.contactId}/link`, {
        cookie: as("memberA"),
        body: { userId: users.stranger?.id },
      });
      expect(outsider.status).toBe(400);
      expect(await bodyOf(outsider)).toMatchObject({ code: "INVALID_LINK" });

      const foreign = await call("POST", "/api/customers", {
        cookie: as("stranger"),
        body: { name: "Alheio", phone: uniquePhone() },
      });
      const foreignId = ((await bodyOf(foreign)).customer as { id: string }).id;
      const crossTenant = await call("POST", `/api/inbox/contacts/${q.contactId}/link`, {
        cookie: as("memberA"),
        body: { customerId: foreignId },
      });
      expect(crossTenant.status).toBe(404);

      const both = await call("POST", `/api/inbox/contacts/${q.contactId}/link`, {
        cookie: as("memberA"),
        body: { customerId: client.id, userId: users.memberB?.id },
      });
      expect(both.status).toBe(400);
    });

    it("o contato de uma conversa de outro membro é 404 em todas as rotas", async () => {
      const b = await seedConversation(scope(), channelId, { assignedUserId: users.memberB?.id });

      expect((await call("PATCH", `/api/inbox/contacts/${b.contactId}`, { cookie: as("memberA"), body: { name: "x" } })).status).toBe(404);
      expect((await call("GET", `/api/inbox/contacts/${b.contactId}/candidates`, { cookie: as("memberA") })).status).toBe(404);
      expect(
        (await call("POST", `/api/inbox/contacts/${b.contactId}/link`, { cookie: as("memberA"), body: { customerId: null, userId: null } }))
          .status,
      ).toBe(404);
      expect(
        (await call("POST", `/api/inbox/contacts/${b.contactId}/customer`, { cookie: as("memberA"), body: { name: "Fulano" } })).status,
      ).toBe(404);

      expect((await call("PATCH", `/api/inbox/contacts/${b.contactId}`, { cookie: as("admin"), body: { name: "Nome dado" } })).status).toBe(200);
      expect((await contactRow(b.contactId))?.name).toBe("Nome dado");
    });

    it("candidatos com a mesma phone_key: membros sempre; clientes só para quem lê clientes", async () => {
      const q = await seedConversation(scope(), channelId, { phone: TEST_USER_PHONE });
      await createCustomer(TEST_USER_PHONE.slice(2));

      const full = await bodyOf(await call("GET", `/api/inbox/contacts/${q.contactId}/candidates`, { cookie: as("memberA") }));
      expect((full.users as { id: string }[]).map((user) => user.id)).toEqual(
        expect.arrayContaining([users.memberA?.id, users.memberB?.id]),
      );
      expect((full.users as { id: string }[]).map((user) => user.id)).not.toContain(users.stranger?.id);
      expect(full.customers).toHaveLength(1);

      const agent = await bodyOf(await call("GET", `/api/inbox/contacts/${q.contactId}/candidates`, { cookie: as("agent") }));
      expect(agent.customers).toEqual([]);
    });
  });

  describe("salvar como cliente", () => {
    it("cria o cliente com o número como o WhatsApp entregou e vincula", async () => {
      // Celular do Brasil sem o 9º dígito, como os provedores entregam: para o cadastro é
      // `mobile_legacy`, que não inicia conversa sozinho.
      const q = await seedConversation(scope(), channelId, { phone: "551197651234" });

      const response = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("memberA"),
        body: { name: "Joana Lima", email: "" },
      });
      expect(response.status).toBe(201);
      const created = (await bodyOf(response)).customer as { id: string; phone: string; phoneNormalized: string };
      expect(created.phoneNormalized).toBe("551197651234");
      expect((await contactRow(q.contactId))?.customerId).toBe(created.id);
      // O número é o de quem escreveu pelo WhatsApp: nasce confirmado como `inbound`.
      expect((await customerRow(created.id))?.phoneVerifiedVia).toBe("inbound");

      const audits = await readAll((tx) => tx.select().from(auditLog).where(eq(auditLog.targetId, q.contactId)));
      expect(audits.find((row) => row.action === "inbox.contact_saved_as_customer")?.metadata).toEqual({
        customerId: created.id,
      });

      // Já vinculado: 409.
      const again = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("memberA"),
        body: { name: "Joana Lima" },
      });
      expect(again.status).toBe(409);
      expect(await bodyOf(again)).toMatchObject({ code: "CONTACT_ALREADY_LINKED" });

      // O cliente `mobile_legacy` conversa, porque o contato existe (sem PHONE_NOT_WHATSAPP).
      const start = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId: qrChannelId, customerId: created.id },
      });
      expect(start.status).toBe(201);
      expect(((await bodyOf(start)).conversation as { contact: { id: string } }).contact.id).toBe(q.contactId);
    });

    it("telefone já usado por outro cliente: 409 PHONE_IN_USE com o cliente; nada criado nem vinculado", async () => {
      const phone = randomMobile();
      const existing = await createCustomer(phone.slice(2));
      const q = await seedConversation(scope(), channelId, { phone });

      const response = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("memberA"),
        body: { name: "Duplicado" },
      });
      expect(response.status).toBe(409);
      expect(await bodyOf(response)).toMatchObject({
        code: "PHONE_IN_USE",
        customerId: existing.id,
        name: existing.name,
      });
      expect((await contactRow(q.contactId))?.customerId).toBeNull();
    });

    it("número do WhatsApp que o cadastro recusa: o atendente corrige o telefone; o contato guarda o do provedor", async () => {
      // 11 dígitos com DDI 55: a regra do cadastro não aceita (faltam dígitos do celular).
      const q = await seedConversation(scope(), channelId, { phone: "55119123456" });

      const refused = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("memberA"),
        body: { name: "Número curto" },
      });
      expect(refused.status).toBe(400);
      expect(await bodyOf(refused)).toMatchObject({ code: "INVALID_PHONE" });

      const stillBad = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("memberA"),
        body: { name: "Número curto", phone: "123" },
      });
      expect(stillBad.status).toBe(400);
      expect((await contactRow(q.contactId))?.customerId).toBeNull();

      const fixed = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("memberA"),
        body: { name: "Número corrigido", phone: "(11) 91234-5678" },
      });
      expect(fixed.status).toBe(201);
      const created = (await bodyOf(fixed)).customer as { id: string; phoneNormalized: string };
      expect(created.phoneNormalized).toBe("5511912345678");

      // O contato continua com o número como o provedor entregou e agora está vinculado.
      const contact = await contactRow(q.contactId);
      expect(contact).toMatchObject({ phone: "55119123456", customerId: created.id });
    });

    it("o telefone corrigido que já é de outro cliente: 409 PHONE_IN_USE", async () => {
      const phone = randomMobile();
      const existing = await createCustomer(phone.slice(2));
      const q = await seedConversation(scope(), channelId);

      const response = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("memberA"),
        body: { name: "Duplicado", phone: `+${phone}` },
      });

      expect(response.status).toBe(409);
      expect(await bodyOf(response)).toMatchObject({ code: "PHONE_IN_USE", customerId: existing.id });
      expect((await contactRow(q.contactId))?.customerId).toBeNull();
    });

    it("plano no limite: 403 PLAN_LIMIT_REACHED e a conversa continua", async () => {
      const plan = await createPlanRow(owner, { isFree: false, limits: { customers: 0 } });
      await ensureSubscription(owner, tenantId, plan.id);
      const q = await seedConversation(scope(), channelId);

      try {
        const response = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
          cookie: as("memberA"),
          body: { name: "Sem espaço" },
        });
        expect(response.status).toBe(403);
        expect(await bodyOf(response)).toMatchObject({ code: "PLAN_LIMIT_REACHED" });
        expect((await call("GET", `/api/inbox/conversations/${q.id}`, { cookie: as("memberA") })).status).toBe(200);
      } finally {
        await owner.begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await tx`delete from subscription where tenant_id = ${tenantId}`;
        });
      }
    });

    it("sem customer:create: 403", async () => {
      const q = await seedConversation(scope(), channelId);
      const response = await call("POST", `/api/inbox/contacts/${q.contactId}/customer`, {
        cookie: as("agent"),
        body: { name: "Não pode" },
      });
      expect(response.status).toBe(403);
    });
  });

  describe("iniciar conversa", () => {
    it("pelo telefone: cria contato e conversa com quem iniciou como dono; repetir acha a mesma", async () => {
      const phone = `+${randomMobile()}`;

      const first = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId, phone },
      });
      expect(first.status).toBe(201);
      const created = (await bodyOf(first)).conversation as { id: string; assignedTo: { id: string } };
      expect(created.assignedTo.id).toBe(users.memberA?.id);

      const second = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId, phone },
      });
      expect(second.status).toBe(200);
      expect(((await bodyOf(second)).conversation as { id: string }).id).toBe(created.id);

      // Cloud: a conversa nasce com a janela fechada (a tela oferece o modelo).
      const detail = await bodyOf(await call("GET", `/api/inbox/conversations/${created.id}`, { cookie: as("memberA") }));
      expect(detail.window).toMatchObject({ applies: true, open: false });
      const [row] = await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, created.id)));
      expect(row?.lastInboundAt).toBeNull();
    });

    it("conversa que já é de outro atendente: 409 para o membro, 200 para quem supervisiona", async () => {
      const phone = randomMobile();
      await seedConversation(scope(), channelId, { phone, assignedUserId: users.memberB?.id });

      const member = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId, phone: `+${phone}` },
      });
      expect(member.status).toBe(409);
      expect(await bodyOf(member)).toMatchObject({ code: "ALREADY_ASSIGNED" });

      const admin = await call("POST", "/api/inbox/conversations", {
        cookie: as("admin"),
        body: { channelId, phone: `+${phone}` },
      });
      expect(admin.status).toBe(200);
    });

    it("fixo e celular antigo sem contato: 400 PHONE_NOT_WHATSAPP; telefone inválido: 400", async () => {
      // Fixo e celular de 8 dígitos começando em 9 (`mobile_legacy`), sem contato que já escreveu.
      for (const phone of ["+551133334444", "+551197654000"]) {
        const response = await call("POST", "/api/inbox/conversations", {
          cookie: as("memberA"),
          body: { channelId, phone },
        });
        expect(response.status).toBe(400);
        expect(await bodyOf(response)).toMatchObject({ code: "PHONE_NOT_WHATSAPP" });
      }

      const invalid = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId, phone: "123" },
      });
      expect(await bodyOf(invalid)).toMatchObject({ code: "INVALID_PHONE" });
    });

    it("com um membro de telefone confirmado: contato vinculado a ele; membro de fora é 404", async () => {
      await setUserPhone(users.memberB?.id as string, uniquePhone(), true);

      const response = await call("POST", "/api/inbox/conversations", {
        cookie: as("admin"),
        body: { channelId: qrChannelId, userId: users.memberB?.id },
      });
      expect(response.status).toBe(201);
      const item = (await bodyOf(response)).conversation as { contact: { id: string; identified: boolean } };
      expect(item.contact.identified).toBe(true);
      expect((await contactRow(item.contact.id))?.userId).toBe(users.memberB?.id);

      const outsider = await call("POST", "/api/inbox/conversations", {
        cookie: as("admin"),
        body: { channelId: qrChannelId, userId: users.stranger?.id },
      });
      expect(outsider.status).toBe(404);
    });

    it("telefone só declarado: a conversa abre, mas o contato não é ligado ao cadastro", async () => {
      // O cliente trocou o próprio número no portal (pendente) e pediu "me chamem no WhatsApp".
      const declared = uniquePhone();
      const record = await createCustomer(declared);
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update customer set phone_verified_at = null, phone_verified_via = null where id = ${record.id}`;
      });

      const byCustomer = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId: qrChannelId, customerId: record.id },
      });
      expect(byCustomer.status).toBe(201);
      const started = (await bodyOf(byCustomer)).conversation as { contact: { id: string } };
      expect(await contactRow(started.contact.id)).toMatchObject({ customerId: null, userId: null });

      // O mesmo com um membro cujo telefone ainda é só o do cadastro.
      await setUserPhone(users.memberA?.id as string, uniquePhone(), false);
      const byMember = await call("POST", "/api/inbox/conversations", {
        cookie: as("admin"),
        body: { channelId: qrChannelId, userId: users.memberA?.id },
      });
      expect(byMember.status).toBe(201);
      const withMember = (await bodyOf(byMember)).conversation as { contact: { id: string } };
      expect(await contactRow(withMember.contact.id)).toMatchObject({ customerId: null, userId: null });
    });

    it("telefone só declarado não leva o histórico de quem já escreveu por aquele número", async () => {
      // A vítima já conversa com a organização; o contato dela não tem cadastro.
      const victim = uniquePhone();
      const existing = await seedConversation(scope(), channelId, {
        phone: phoneValues(victim).phoneNormalized,
      });
      // Outro cadastro declara o número dela (em produção, pelo portal; aqui, direto no banco).
      const record = await createCustomer(uniquePhone());
      const values = phoneValues(victim);
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`
          update customer set phone = ${values.phone}, phone_normalized = ${values.phoneNormalized},
            phone_key = ${values.phoneKey}, phone_verified_at = null, phone_verified_via = null
          where id = ${record.id}
        `;
      });

      const response = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId, customerId: record.id },
      });

      expect([200, 201]).toContain(response.status);
      expect(await contactRow(existing.contactId)).toMatchObject({ customerId: null, userId: null });
    });

    it("número de outro tenant é 404, desativado é 409, dois destinos é 400", async () => {
      const phone = `+${randomMobile()}`;
      expect(
        (await call("POST", "/api/inbox/conversations", { cookie: as("memberA"), body: { channelId: otherChannelId, phone } })).status,
      ).toBe(404);

      const disabled = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId: disabledChannelId, phone },
      });
      expect(disabled.status).toBe(409);
      expect(await bodyOf(disabled)).toMatchObject({ code: "CHANNEL_DISABLED" });

      const two = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId, phone, userId: users.memberB?.id },
      });
      expect(two.status).toBe(400);

      const unknownCustomer = await call("POST", "/api/inbox/conversations", {
        cookie: as("memberA"),
        body: { channelId, customerId: randomUUID() },
      });
      expect(unknownCustomer.status).toBe(404);

      // Pelo cliente, só quem lê clientes: a conversa mostraria o telefone dele.
      const client = await createCustomer();
      const agent = await call("POST", "/api/inbox/conversations", {
        cookie: as("agent"),
        body: { channelId, customerId: client.id },
      });
      expect(agent.status).toBe(403);
    });
  });
});
