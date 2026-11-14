import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeDeletion } from "@/lib/lgpd/deletion";
import { stopRealtime } from "@/lib/inbox/realtime";
import { phoneValues } from "@/lib/phone/columns";
import { setStorageForTests } from "@/lib/storage";
import { makePlatformUser } from "./billing-helpers";
import { platformScope, seedCloudChannel, tenantScope } from "./channels-helpers";
import { attachMedia, memoryStorage, seedConversation, seedMessage } from "./inbox-helpers";
import { uniquePhone } from "./phone-helpers";
import { createCustomer } from "./portal-helpers";
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
 * Bloco E da pré-produção (D-11): a ficha de cliente de quem é da equipe sai com a pessoa, nos dois
 * caminhos (remover o membro: só naquela organização; excluir a conta: em todas), e **só** ela: as
 * fichas de outros clientes, os contatos de outros números e as conversas deles ficam. A equipe
 * mantém a ficha desfazendo a ligação antes (`DELETE /api/customers/:id/team-link`).
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 3),
]);

let owner: postgres.Sql;
const memory = memoryStorage();
let ownerA: TestUser;
let ownerB: TestUser;
let tenantA: string;
let tenantB: string;
let channelA: string;
let channelB: string;
let platformChannel: string;

const userIds: string[] = [];
const portalIds: string[] = [];

const bypass = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;

const count = async (sqlText: string, value: string) => {
  const [row] = await bypass(
    (tx) => tx.unsafe(`select count(*)::int as total from ${sqlText}`, [value]) as Promise<{ total: number }[]>,
  );
  return row?.total ?? 0;
};

/** Grava o telefone da conta direto (`createUser` usa o mesmo número para todas). */
async function setUserPhone(user: TestUser, phone: string, verified = true) {
  const values = phoneValues(phone);

  await owner`
    update "user" set
      phone = ${values.phone},
      phone_normalized = ${values.phoneNormalized},
      phone_key = ${values.phoneKey},
      phone_verified_at = ${verified ? new Date() : null},
      phone_verified_via = ${verified ? "manual" : null}
    where id = ${user.id}
  `;

  return values;
}

type Seeded = Awaited<ReturnType<typeof seedConversation>> & { fileId: string; mediaKey: string };

/** Conversa com texto e uma imagem (linha `file` e objeto no armazenamento). */
async function conversationWithMedia(
  scope: Parameters<typeof seedConversation>[0],
  channelId: string,
  seed: Parameters<typeof seedConversation>[2] = {},
): Promise<Seeded> {
  const seeded = await seedConversation(scope, channelId, seed);
  const target = { conversationId: seeded.id, channelId };
  await seedMessage(scope, target, { text: "mensagem do contato" });
  const image = await seedMessage(scope, target, { type: "image", text: null });
  const fileId = await attachMedia(scope, memory, image.id, PNG, "image/png", "foto.png");
  return { ...seeded, fileId, mediaKey: `inbox/test/${image.id}` };
}

/** Uma pessoa da equipe das duas organizações, com telefone confirmado e a ficha ligada em cada uma. */
async function teamPersonWithRecords(options: { verified?: boolean } = {}) {
  const person = await createUser(owner);
  userIds.push(person.id);
  const phone = await setUserPhone(person, uniquePhone(), options.verified ?? true);
  await addMember(owner, tenantA, person, "member");
  await addMember(owner, tenantB, person, "member");

  const recordA = await createCustomer(ownerA, { name: "Pessoa cliente A", phone: phone.phone });
  const recordB = await createCustomer(ownerB, { name: "Pessoa cliente B", phone: phone.phone });

  return { person, phone, recordA, recordB };
}

const linkedTo = async (customerId: string) => {
  const [row] = await bypass(
    (tx) => tx<{ user_id: string | null }[]>`select user_id from customer where id = ${customerId}`,
  );
  return row?.user_id ?? null;
};

const membershipOf = async (user: TestUser, tenantId: string) => {
  const [row] = await owner<{ id: string }[]>`
    select id from member where user_id = ${user.id} and organization_id = ${tenantId}
  `;
  if (!row) throw new Error("membro não encontrado");
  return row.id;
};

async function runUserDeletion(userId: string) {
  const [row] = await bypass(
    (tx) => tx<{ id: string }[]>`
      insert into deletion_request (subject_type, subject_id, tenant_id, requested_by, scheduled_for, origin)
      values ('user', ${userId}, null, ${ownerA.id}, now() - interval '1 minute', 'platform')
      returning id
    `,
  );
  if (!row) throw new Error("pedido não criado");
  return executeDeletion(row.id);
}

const auditActions = (tenantId: string, targetId: string) =>
  bypass(
    (tx) => tx<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from audit_log where tenant_id = ${tenantId} and target_id = ${targetId}
      order by created_at
    `,
  );

beforeAll(async () => {
  owner = connectOwner();
  ownerA = await createUser(owner);
  ownerB = await createUser(owner);
  tenantA = (await createTenant(ownerA, "Clínica E A")).id;
  tenantB = (await createTenant(ownerB, "Clínica E B")).id;
  channelA = (await seedCloudChannel(tenantScope(tenantA))).id;
  channelB = (await seedCloudChannel(tenantScope(tenantB))).id;
  platformChannel = (await seedCloudChannel(platformScope, { name: "E-chtest" })).id;
});

beforeEach(() => {
  setStorageForTests(memory.storage);
});

afterAll(async () => {
  setStorageForTests(undefined);
  await stopRealtime();
  await bypass(async (tx) => {
    await tx`delete from chat_contact where tenant_id is null and id in (
      select contact_id from conversation where channel_id = ${platformChannel})`;
    await tx`delete from channel where id = ${platformChannel}`;
    if (userIds.length > 0) {
      await tx`delete from audit_log where actor_id = any(${userIds}) or target_id = any(${userIds})`;
      await tx`delete from deletion_request where subject_id = any(${userIds})`;
    }
    await tx`delete from audit_log where tenant_id in (${tenantA}, ${tenantB})`;
    await tx`delete from organization where id in (${tenantA}, ${tenantB})`;
    if (userIds.length > 0) await tx`delete from "user" where id = any(${userIds})`;
    if (portalIds.length > 0) await tx`delete from portal_user where id = any(${portalIds})`;
  });
  await cleanUp(owner);
  await owner.end();
});

describe("remover o membro (DELETE /api/team/members/:id)", () => {
  it("apaga a ficha ligada a ela naquela organização, com o conteúdo, e mantém todo o resto", async () => {
    const { person, phone, recordA, recordB } = await teamPersonWithRecords();
    expect(await linkedTo(recordA.id)).toBe(person.id);

    // O contato do número da pessoa, ligado à ficha, com mídia; um contato do mesmo número na
    // outra organização; outro cliente de A com conversa; e uma conversa sem cliente.
    const own = await conversationWithMedia(tenantScope(tenantA), channelA, {
      customerId: recordA.id,
      phone: phone.phoneNormalized,
    });
    const ownB = await conversationWithMedia(tenantScope(tenantB), channelB, {
      customerId: recordB.id,
      phone: phone.phoneNormalized,
    });
    const otherRecord = await createCustomer(ownerA, { name: "Outro cliente de A" });
    const other = await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: otherRecord.id });
    const stranger = await conversationWithMedia(tenantScope(tenantA), channelA);
    expect(memory.objects.has(own.mediaKey)).toBe(true);

    const membership = await membershipOf(person, tenantA);
    const response = await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie });
    expect(response.status).toBe(200);

    // A ficha da pessoa em A e tudo o que estava ligado ao número dela.
    expect(await count("customer where id = $1", recordA.id)).toBe(0);
    expect(await count("chat_contact where id = $1", own.contactId)).toBe(0);
    expect(await count("conversation where id = $1", own.id)).toBe(0);
    expect(await count("message where conversation_id = $1", own.id)).toBe(0);
    expect(await count("file where id = $1", own.fileId)).toBe(0);
    expect(memory.objects.has(own.mediaKey)).toBe(false);

    // Nada mais: a ficha da pessoa em B (ela segue na equipe de B), o outro cliente, o contato sem cliente.
    expect(await count("customer where id = $1", recordB.id)).toBe(1);
    expect(await linkedTo(recordB.id)).toBe(person.id);
    expect(await count("customer where id = $1", otherRecord.id)).toBe(1);
    for (const kept of [ownB, other, stranger]) {
      expect(await count("chat_contact where id = $1", kept.contactId)).toBe(1);
      expect(await count("conversation where id = $1", kept.id)).toBe(1);
      expect(await count("message where conversation_id = $1", kept.id)).toBe(2);
      expect(await count("file where id = $1", kept.fileId)).toBe(1);
      expect(memory.objects.has(kept.mediaKey)).toBe(true);
    }

    // A conta da pessoa continua, e a exclusão fica na auditoria da organização.
    expect(await count(`"user" where id = $1`, person.id)).toBe(1);
    const audits = await auditActions(tenantA, recordA.id);
    expect(audits.find(({ action }) => action === "customer.deleted")?.metadata).toEqual({
      userId: person.id,
      via: "member_removed",
    });
  });

  it("o contato de outro número ligado à ficha só perde o vínculo; a conversa fica (restrição b)", async () => {
    const { person, phone, recordA } = await teamPersonWithRecords();
    const own = await conversationWithMedia(tenantScope(tenantA), channelA, {
      customerId: recordA.id,
      phone: phone.phoneNormalized,
    });
    // Quem tem `customer:update` liga à mão o contato de outra pessoa à ficha.
    const foreign = await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: recordA.id });

    const membership = await membershipOf(person, tenantA);
    expect((await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie })).status).toBe(200);

    expect(await count("customer where id = $1", recordA.id)).toBe(0);
    expect(await count("chat_contact where id = $1", own.contactId)).toBe(0);

    expect(await count("chat_contact where id = $1 and customer_id is null", foreign.contactId)).toBe(1);
    expect(await count("conversation where id = $1", foreign.id)).toBe(1);
    expect(await count("message where conversation_id = $1", foreign.id)).toBe(2);
    expect(await count("file where id = $1", foreign.fileId)).toBe(1);
    expect(memory.objects.has(foreign.mediaKey)).toBe(true);
  });

  it("sem telefone confirmado, a ficha sai mas nenhum contato é apagado", async () => {
    const { person, phone, recordA } = await teamPersonWithRecords({ verified: false });
    // Telefone só declarado não liga a ficha sozinho: a ligação vem da equipe, à mão.
    await bypass((tx) => tx`update customer set user_id = ${person.id} where id = ${recordA.id}`);
    const same = await conversationWithMedia(tenantScope(tenantA), channelA, {
      customerId: recordA.id,
      phone: phone.phoneNormalized,
    });

    const membership = await membershipOf(person, tenantA);
    expect((await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie })).status).toBe(200);

    expect(await count("customer where id = $1", recordA.id)).toBe(0);
    expect(await count("chat_contact where id = $1 and customer_id is null", same.contactId)).toBe(1);
    expect(await count("conversation where id = $1", same.id)).toBe(1);
    expect(memory.objects.has(same.mediaKey)).toBe(true);
  });

  it("desfeita a ligação antes, a remoção não apaga a ficha nem as conversas", async () => {
    const { person, phone, recordA } = await teamPersonWithRecords();
    const own = await conversationWithMedia(tenantScope(tenantA), channelA, {
      customerId: recordA.id,
      phone: phone.phoneNormalized,
    });

    const unlink = await call("DELETE", `/api/customers/${recordA.id}/team-link`, { cookie: ownerA.cookie });
    expect(unlink.status).toBe(204);
    expect(await linkedTo(recordA.id)).toBeNull();

    const membership = await membershipOf(person, tenantA);
    expect((await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie })).status).toBe(200);

    expect(await count("customer where id = $1", recordA.id)).toBe(1);
    const [contact] = await bypass(
      (tx) => tx<{ customer_id: string | null }[]>`select customer_id from chat_contact where id = ${own.contactId}`,
    );
    expect(contact?.customer_id).toBe(recordA.id);
    expect(await count("conversation where id = $1", own.id)).toBe(1);
    expect(await count("file where id = $1", own.fileId)).toBe(1);
    expect(memory.objects.has(own.mediaKey)).toBe(true);

    const actions = (await auditActions(tenantA, recordA.id)).map(({ action }) => action);
    expect(actions).toContain("customer.team_unlinked");
    expect(actions).not.toContain("customer.deleted");
  });

  it("trocar o papel da pessoa não apaga nada", async () => {
    const { person, recordA } = await teamPersonWithRecords();
    const membership = await membershipOf(person, tenantA);

    const changed = await call("PATCH", `/api/team/members/${membership}`, {
      cookie: ownerA.cookie,
      body: { role: "admin" },
    });
    expect(changed.status).toBe(200);

    expect(await count("customer where id = $1", recordA.id)).toBe(1);
    expect(await linkedTo(recordA.id)).toBe(person.id);
  });

  it("fichas de outros clientes e de outras pessoas da equipe não são tocadas", async () => {
    const { person, recordA } = await teamPersonWithRecords();
    // Outra pessoa da equipe (sem ficha) e um cliente comum.
    const colleague = await createUser(owner);
    userIds.push(colleague.id);
    await addMember(owner, tenantA, colleague, "member");
    const common = await createCustomer(ownerA, { name: "Cliente comum" });
    const commonChat = await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: common.id });

    const membership = await membershipOf(person, tenantA);
    await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie });

    expect(await count("customer where id = $1", recordA.id)).toBe(0);
    expect(await count("customer where id = $1", common.id)).toBe(1);
    expect(await count("conversation where id = $1", commonChat.id)).toBe(1);
  });
});

describe("excluir a conta (lgpd.delete, anonymizeUser)", () => {
  it("apaga as fichas ligadas em todas as organizações e o conteúdo delas; mantém o resto", async () => {
    const { person, phone, recordA, recordB } = await teamPersonWithRecords();
    const ownA = await conversationWithMedia(tenantScope(tenantA), channelA, {
      customerId: recordA.id,
      phone: phone.phoneNormalized,
    });
    const ownB = await conversationWithMedia(tenantScope(tenantB), channelB, {
      customerId: recordB.id,
      phone: phone.phoneNormalized,
    });
    const foreignA = await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: recordA.id });
    const otherRecord = await createCustomer(ownerB, { name: "Outro cliente de B" });
    const otherB = await conversationWithMedia(tenantScope(tenantB), channelB, { customerId: otherRecord.id });
    const strangerA = await conversationWithMedia(tenantScope(tenantA), channelA);

    // Autoria da pessoa numa conversa que não é dela (atendeu e encerrou).
    const attended = await conversationWithMedia(tenantScope(tenantA), channelA);
    await seedMessage(
      tenantScope(tenantA),
      { conversationId: attended.id, channelId: channelA },
      { direction: "out", text: "respondido pela pessoa", senderUserId: person.id },
    );
    await bypass((tx) => tx`update conversation set closed_by = ${person.id} where id = ${attended.id}`);

    expect(await runUserDeletion(person.id)).toBe("executed");

    for (const gone of [ownA, ownB]) {
      expect(await count("chat_contact where id = $1", gone.contactId)).toBe(0);
      expect(await count("conversation where id = $1", gone.id)).toBe(0);
      expect(await count("message where conversation_id = $1", gone.id)).toBe(0);
      expect(await count("file where id = $1", gone.fileId)).toBe(0);
      expect(memory.objects.has(gone.mediaKey)).toBe(false);
    }
    expect(await count("customer where id = $1", recordA.id)).toBe(0);
    expect(await count("customer where id = $1", recordB.id)).toBe(0);

    // Contato de outro número que estava ligado à ficha: só o vínculo cai.
    expect(await count("chat_contact where id = $1 and customer_id is null", foreignA.contactId)).toBe(1);
    expect(await count("conversation where id = $1", foreignA.id)).toBe(1);
    expect(memory.objects.has(foreignA.mediaKey)).toBe(true);

    // Todos os outros clientes, contatos, conversas, mensagens e arquivos ficam.
    expect(await count("customer where id = $1", otherRecord.id)).toBe(1);
    for (const kept of [otherB, strangerA, attended]) {
      expect(await count("conversation where id = $1", kept.id)).toBe(1);
      expect(await count("message where conversation_id = $1", kept.id)).toBeGreaterThanOrEqual(2);
      expect(await count("file where id = $1", kept.fileId)).toBe(1);
      expect(memory.objects.has(kept.mediaKey)).toBe(true);
    }

    // Campos de autoria nulos: a pessoa deixou de aparecer como autora.
    expect(await count("message where conversation_id = $1 and sender_user_id is null", attended.id)).toBe(3);
    expect(await count("conversation where id = $1 and closed_by is null", attended.id)).toBe(1);
  });

  it("ficha desligada antes (ou de outro cliente) não é apagada com a conta", async () => {
    const { person, recordA, recordB } = await teamPersonWithRecords();
    expect(
      (await call("DELETE", `/api/customers/${recordA.id}/team-link`, { cookie: ownerA.cookie })).status,
    ).toBe(204);

    expect(await runUserDeletion(person.id)).toBe("executed");

    expect(await count("customer where id = $1", recordA.id)).toBe(1);
    expect(await count("customer where id = $1", recordB.id)).toBe(0);
  });
});

describe("ficha com conta no portal", () => {
  /** A ficha da pessoa com uma identidade de portal que só existe por causa dela. */
  async function withPortalAccount(recordId: string) {
    const id = randomUUID();
    const phone = phoneValues(uniquePhone());
    await owner`
      insert into portal_user (id, name, email, phone, phone_normalized, phone_key)
      values (${id}, ${"Conta do portal"}, ${`portal-${id}@tenant-test.bizu.local`}, ${phone.phone},
        ${phone.phoneNormalized}, ${phone.phoneKey})
    `;
    portalIds.push(id);
    await bypass((tx) => tx`update customer set portal_user_id = ${id} where id = ${recordId}`);
    return id;
  }

  it("a identidade do portal que ficou sem ficha cai com a remoção do membro e com a exclusão da conta", async () => {
    const removed = await teamPersonWithRecords();
    const portalA = await withPortalAccount(removed.recordA.id);
    const membership = await membershipOf(removed.person, tenantA);
    expect((await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie })).status).toBe(200);
    expect(await count("customer where id = $1", removed.recordA.id)).toBe(0);
    expect(await count("portal_user where id = $1", portalA)).toBe(0);

    const closed = await teamPersonWithRecords();
    const portalB = await withPortalAccount(closed.recordB.id);
    expect(await runUserDeletion(closed.person.id)).toBe("executed");
    expect(await count("customer where id = $1", closed.recordB.id)).toBe(0);
    expect(await count("portal_user where id = $1", portalB)).toBe(0);
  });
});

describe("DELETE /api/customers/:id/team-link", () => {
  it("exige customer:update, responde 404 para ficha de outra organização e é idempotente", async () => {
    const { person, recordA } = await teamPersonWithRecords();
    const reader = await createUser(owner);
    userIds.push(reader.id);
    await createRole(ownerA, "so-le-clientes", ["customer:read"]);
    await addMember(owner, tenantA, reader, "so-le-clientes");

    const denied = await call("DELETE", `/api/customers/${recordA.id}/team-link`, { cookie: reader.cookie });
    expect(denied.status).toBe(403);
    expect(await linkedTo(recordA.id)).toBe(person.id);

    // O dono de outra organização não enxerga a ficha.
    const foreign = await call("DELETE", `/api/customers/${recordA.id}/team-link`, { cookie: ownerB.cookie });
    expect(foreign.status).toBe(404);
    expect(await linkedTo(recordA.id)).toBe(person.id);

    expect((await call("DELETE", `/api/customers/${recordA.id}/team-link`, { cookie: ownerA.cookie })).status).toBe(204);
    expect((await call("DELETE", `/api/customers/${recordA.id}/team-link`, { cookie: ownerA.cookie })).status).toBe(204);
    expect(await linkedTo(recordA.id)).toBeNull();

    const unlinked = (await auditActions(tenantA, recordA.id)).filter(({ action }) => action === "customer.team_unlinked");
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]?.metadata).toEqual({ userId: person.id });

    // Id que não existe, e malformado.
    expect((await call("DELETE", `/api/customers/${randomUUID()}/team-link`, { cookie: ownerA.cookie })).status).toBe(404);
    expect((await call("DELETE", "/api/customers/nao-e-id/team-link", { cookie: ownerA.cookie })).status).toBe(404);
  });
});

describe("os avisos dos diálogos", () => {
  it("o /admin avisa as fichas ligadas ao excluir o usuário", async () => {
    const { person, phone, recordA } = await teamPersonWithRecords();
    await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: recordA.id, phone: phone.phoneNormalized });
    const platform = await makePlatformUser(owner, "platform_owner");
    userIds.push(platform.id);

    const response = await call("GET", `/api/admin/users/${person.id}`, { cookie: platform.cookie });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { customerRecords: unknown }).customerRecords).toEqual({
      customers: 2,
      conversationCount: 1,
    });
  });

  it("GET /api/customers/:id devolve conversationCount, igual ao banco", async () => {
    const record = await createCustomer(ownerA, { name: "Cliente com conversas" });
    await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: record.id });
    await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: record.id });
    await conversationWithMedia(tenantScope(tenantA), channelA);

    const response = await call("GET", `/api/customers/${record.id}`, { cookie: ownerA.cookie });
    expect(response.status).toBe(200);
    const { customer } = (await response.json()) as { customer: { conversationCount: number } };

    expect(customer.conversationCount).toBe(
      await count(
        "conversation c join chat_contact k on k.id = c.contact_id where k.customer_id = $1",
        record.id,
      ),
    );
    expect(customer.conversationCount).toBe(2);

    const empty = await createCustomer(ownerA, { name: "Cliente sem conversas" });
    const emptyDetail = await call("GET", `/api/customers/${empty.id}`, { cookie: ownerA.cookie });
    expect(((await emptyDetail.json()) as { customer: { conversationCount: number } }).customer.conversationCount).toBe(0);
  });

  it("a remoção avisa só quem pode remover, com a contagem das conversas que seriam apagadas", async () => {
    const { person, phone, recordA } = await teamPersonWithRecords();
    await conversationWithMedia(tenantScope(tenantA), channelA, {
      customerId: recordA.id,
      phone: phone.phoneNormalized,
    });
    // Contato de outro número ligado à ficha: não será apagado, então não entra na conta.
    await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: recordA.id });

    const list = await call("GET", "/api/team", { cookie: ownerA.cookie });
    const { members } = (await list.json()) as {
      members: { userId: string; customerRecord?: { conversationCount: number } | null }[];
    };
    expect(members.find(({ userId }) => userId === person.id)?.customerRecord).toEqual({ conversationCount: 1 });
    expect(members.find(({ userId }) => userId === ownerA.id)?.customerRecord).toBeNull();

    // Quem não remove membros não recebe o campo.
    const viewer = await createUser(owner);
    userIds.push(viewer.id);
    await createRole(ownerA, "sem-remocao", ["customer:read"]);
    await addMember(owner, tenantA, viewer, "sem-remocao");
    const asViewer = await call("GET", "/api/team", { cookie: viewer.cookie });
    expect(asViewer.status).toBe(200);
    const seen = (await asViewer.json()) as { members: Record<string, unknown>[] };
    expect(seen.members.every((row) => !("customerRecord" in row))).toBe(true);
  });

  it("a exclusão da conta avisa quantas fichas e conversas serão apagadas, em todas as organizações", async () => {
    const { person, phone, recordA, recordB } = await teamPersonWithRecords();
    await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: recordA.id, phone: phone.phoneNormalized });
    await conversationWithMedia(tenantScope(tenantB), channelB, { customerId: recordB.id, phone: phone.phoneNormalized });

    const response = await call("GET", "/api/me/deletion", { cookie: person.cookie });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { customerRecords: unknown }).customerRecords).toEqual({
      customers: 2,
      conversationCount: 2,
    });

    // Quem não tem ficha ligada: zero.
    const plain = await call("GET", "/api/me/deletion", { cookie: ownerB.cookie });
    expect(((await plain.json()) as { customerRecords: unknown }).customerRecords).toEqual({
      customers: 0,
      conversationCount: 0,
    });
  });
});
