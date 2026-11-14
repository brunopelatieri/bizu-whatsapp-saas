import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeDeletion } from "@/lib/lgpd/deletion";
import { stopRealtime } from "@/lib/inbox/realtime";
import { phoneValues } from "@/lib/phone/columns";
import { setStorageForTests } from "@/lib/storage";
import { seedCloudChannel, tenantScope } from "./channels-helpers";
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
 * Ligação da ficha de cliente com a pessoa da equipe feita à mão (D-9, `PUT
 * /api/customers/:id/team-link`). A ligação decide o que a remoção futura apaga (D-11): a ficha sai
 * com a pessoa e, dela, só os contatos do telefone **confirmado** da pessoa, como na ligação
 * automática.
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

let owner: postgres.Sql;
const memory = memoryStorage();
let ownerA: TestUser;
let ownerB: TestUser;
let tenantA: string;
let tenantB: string;
let channelA: string;

const userIds: string[] = [];

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

async function setUserPhone(user: TestUser, phone: string, verified: boolean) {
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

/** Pessoa da equipe de A (membro comum), com telefone próprio, confirmado ou não. */
async function teamPerson(options: { verified?: boolean; role?: string; tenantId?: string } = {}) {
  const person = await createUser(owner);
  userIds.push(person.id);
  const phone = await setUserPhone(person, uniquePhone(), options.verified ?? true);
  await addMember(owner, options.tenantId ?? tenantA, person, options.role ?? "member");
  return { person, phone };
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

const linkAudits = (tenantId: string, customerId: string) =>
  bypass(
    (tx) => tx<{ actor_id: string | null; metadata: Record<string, unknown> }[]>`
      select actor_id, metadata from audit_log
      where tenant_id = ${tenantId} and target_id = ${customerId} and action = 'customer.team_linked'
      order by created_at
    `,
  );

const link = (actor: TestUser, customerId: string, userId: string) =>
  call("PUT", `/api/customers/${customerId}/team-link`, { cookie: actor.cookie, body: { userId } });

/** Conversa com texto e uma imagem, para conferir mensagens, `file` e o objeto. */
async function conversationWithMedia(customerId: string, phone?: string) {
  const scope = tenantScope(tenantA);
  const seeded = await seedConversation(scope, channelA, { customerId, ...(phone ? { phone } : {}) });
  const target = { conversationId: seeded.id, channelId: channelA };
  await seedMessage(scope, target, { text: "mensagem" });
  const image = await seedMessage(scope, target, { type: "image", text: null });
  const fileId = await attachMedia(scope, memory, image.id, PNG, "image/png", "foto.png");
  return { ...seeded, fileId, mediaKey: `inbox/test/${image.id}` };
}

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

beforeAll(async () => {
  owner = connectOwner();
  ownerA = await createUser(owner);
  ownerB = await createUser(owner);
  tenantA = (await createTenant(ownerA, "Clínica Ligação A")).id;
  // O owner também pode ser ligado, se tem o telefone confirmado (TL-1).
  await setUserPhone(ownerA, uniquePhone(), true);
  tenantB = (await createTenant(ownerB, "Clínica Ligação B")).id;
  channelA = (await seedCloudChannel(tenantScope(tenantA))).id;
});

beforeEach(() => {
  setStorageForTests(memory.storage);
});

afterAll(async () => {
  setStorageForTests(undefined);
  await stopRealtime();
  await bypass(async (tx) => {
    if (userIds.length > 0) {
      await tx`delete from audit_log where actor_id = any(${userIds}) or target_id = any(${userIds})`;
      await tx`delete from deletion_request where subject_id = any(${userIds})`;
    }
    await tx`delete from audit_log where tenant_id in (${tenantA}, ${tenantB})`;
    await tx`delete from organization where id in (${tenantA}, ${tenantB})`;
    if (userIds.length > 0) await tx`delete from "user" where id = any(${userIds})`;
  });
  await cleanUp(owner);
  await owner.end();
});

describe("PUT /api/customers/:id/team-link", () => {
  it("liga a ficha à pessoa, mostra o selo e audita com via manual", async () => {
    // Ficha de outro número (o e-mail seria o motivo): a ligação automática não acontece, a manual sim.
    const { person } = await teamPerson({ role: "admin" });
    const record = await createCustomer(ownerA, { name: "Ficha por e-mail" });
    expect(await linkedTo(record.id)).toBeNull();

    const response = await link(ownerA, record.id, person.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ team: { userId: person.id, role: "admin" } });
    expect(await linkedTo(record.id)).toBe(person.id);

    const detail = await call("GET", `/api/customers/${record.id}`, { cookie: ownerA.cookie });
    const { customer } = (await detail.json()) as { customer: { team: unknown } };
    expect(customer.team).toEqual({ userId: person.id, role: "admin" });

    const audits = await linkAudits(tenantA, record.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: ownerA.id, metadata: { userId: person.id, via: "manual" } });

    // A mesma ligação de novo não muda nada nem audita outra vez.
    expect((await link(ownerA, record.id, person.id)).status).toBe(200);
    expect(await linkAudits(tenantA, record.id)).toHaveLength(1);
  });

  it("vale para o owner e para quem tem só customer:update (um colaborador liga outra pessoa)", async () => {
    const colaborador = (await teamPerson()).person;
    const record = await createCustomer(ownerA, { name: "Ficha do owner" });

    const response = await link(colaborador, record.id, ownerA.id);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { team: { role: string } }).team.role).toBe("owner");
  });

  it("só liga quem tem o telefone confirmado no sistema (TL-1); a lista também só traz essas pessoas", async () => {
    const { person } = await teamPerson({ verified: false });
    const record = await createCustomer(ownerA, { name: "Para quem não confirmou" });

    const response = await link(ownerA, record.id, person.id);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("TEAM_MEMBER_NOT_LINKABLE");
    expect(await linkedTo(record.id)).toBeNull();
    expect(await linkAudits(tenantA, record.id)).toHaveLength(0);

    const list = await call("GET", `/api/customers/${record.id}/team-candidates`, { cookie: ownerA.cookie });
    const { candidates } = (await list.json()) as { candidates: { userId: string }[] };
    expect(candidates.some(({ userId }) => userId === person.id)).toBe(false);
    expect(candidates.some(({ userId }) => userId === ownerA.id)).toBe(true);
  });

  it("exige customer:update", async () => {
    const { person } = await teamPerson();
    const reader = await createUser(owner);
    userIds.push(reader.id);
    await createRole(ownerA, "le-clientes-ligacao", ["customer:read"]);
    await addMember(owner, tenantA, reader, "le-clientes-ligacao");
    const record = await createCustomer(ownerA, { name: "Sem permissão" });

    const denied = await link(reader, record.id, person.id);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("PERMISSION_DENIED");
    expect(await linkedTo(record.id)).toBeNull();
  });

  it("quem liga não liga a si mesmo", async () => {
    const { person } = await teamPerson();
    const record = await createCustomer(ownerA, { name: "Ficha de si" });

    const response = await link(person, record.id, person.id);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("SELF_LINK");
    expect(await linkedTo(record.id)).toBeNull();
    expect(await linkAudits(tenantA, record.id)).toHaveLength(0);
  });

  it("404 para ficha de outra organização e para pessoa que não é desta equipe", async () => {
    const { person } = await teamPerson();
    const outsider = (await teamPerson({ tenantId: tenantB })).person;
    const record = await createCustomer(ownerA, { name: "Ficha de A" });
    const recordB = await createCustomer(ownerB, { name: "Ficha de B" });

    // O owner de B não enxerga a ficha de A, nem com uma pessoa de B.
    expect((await link(ownerB, record.id, outsider.id)).status).toBe(404);
    // A não liga a ficha à pessoa que só é de B, nem a ficha de B à pessoa de A.
    expect((await link(ownerA, record.id, outsider.id)).status).toBe(404);
    expect((await link(ownerA, recordB.id, person.id)).status).toBe(404);
    // Ids que não existem, e malformado.
    expect((await link(ownerA, record.id, randomUUID())).status).toBe(404);
    expect((await link(ownerA, randomUUID(), person.id)).status).toBe(404);
    expect((await call("PUT", "/api/customers/nao-e-id/team-link", { cookie: ownerA.cookie, body: { userId: person.id } })).status).toBe(404);
    // Corpo inválido.
    expect((await call("PUT", `/api/customers/${record.id}/team-link`, { cookie: ownerA.cookie, body: { userId: "x" } })).status).toBe(400);
    expect((await call("PUT", `/api/customers/${record.id}/team-link`, { cookie: ownerA.cookie, body: { userId: person.id, extra: 1 } })).status).toBe(400);

    expect(await linkedTo(record.id)).toBeNull();
    expect(await linkedTo(recordB.id)).toBeNull();
  });

  it("uma ficha por pessoa e uma pessoa por ficha", async () => {
    const { person } = await teamPerson();
    const other = (await teamPerson()).person;
    const first = await createCustomer(ownerA, { name: "Primeira" });
    const second = await createCustomer(ownerA, { name: "Segunda" });

    expect((await link(ownerA, first.id, person.id)).status).toBe(200);

    const twice = await link(ownerA, second.id, person.id);
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { code: string }).code).toBe("TEAM_MEMBER_HAS_CUSTOMER");

    const taken = await link(ownerA, first.id, other.id);
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe("CUSTOMER_ALREADY_LINKED");
    expect(await linkedTo(first.id)).toBe(person.id);
    expect(await linkedTo(second.id)).toBeNull();

    // Desfeita a ligação, a pessoa pode ser ligada a outra ficha.
    expect((await call("DELETE", `/api/customers/${first.id}/team-link`, { cookie: ownerA.cookie })).status).toBe(204);
    expect((await link(ownerA, second.id, person.id)).status).toBe(200);
  });

  it("a ligação manual não é desfeita nem duplicada pela automática", async () => {
    // Telefone confirmado: o cadastro de uma ficha com esse número ligaria sozinho, se a pessoa
    // ainda não tivesse ficha.
    const { person, phone } = await teamPerson();
    const manual = await createCustomer(ownerA, { name: "Ligada à mão" });
    expect((await link(ownerA, manual.id, person.id)).status).toBe(200);

    const byPhone = await createCustomer(ownerA, { name: "Mesmo telefone", phone: phone.phone });
    expect(await linkedTo(byPhone.id)).toBeNull();
    expect(await linkedTo(manual.id)).toBe(person.id);
  });
});

describe("GET /api/customers/:id/team-candidates", () => {
  it("lista a equipe com id, nome, papel e se já tem ficha, sem e-mail nem telefone", async () => {
    const { person } = await teamPerson();
    const free = (await teamPerson({ role: "admin" })).person;
    const record = await createCustomer(ownerA, { name: "Candidatos" });
    const linked = await createCustomer(ownerA, { name: "Já ligada" });
    expect((await link(ownerA, linked.id, person.id)).status).toBe(200);

    const response = await call("GET", `/api/customers/${record.id}/team-candidates`, { cookie: ownerA.cookie });
    expect(response.status).toBe(200);
    const { candidates } = (await response.json()) as { candidates: Record<string, unknown>[] };

    expect(candidates.find((row) => row.userId === person.id)).toEqual({
      userId: person.id,
      name: expect.any(String),
      role: "member",
      hasCustomer: true,
    });
    expect(candidates.find((row) => row.userId === free.id)).toMatchObject({ role: "admin", hasCustomer: false });
    expect(candidates.find((row) => row.userId === ownerA.id)).toMatchObject({ role: "owner" });
    expect(candidates.every((row) => Object.keys(row).sort().join() === "hasCustomer,name,role,userId")).toBe(true);
    // Só a equipe desta organização.
    expect(candidates.some((row) => row.userId === ownerB.id)).toBe(false);
  });

  it("exige ler e editar clientes, e 404 para ficha de outra organização", async () => {
    const record = await createCustomer(ownerA, { name: "Candidatos sem permissão" });
    const reader = await createUser(owner);
    userIds.push(reader.id);
    await createRole(ownerA, "le-clientes-candidatos", ["customer:read"]);
    await addMember(owner, tenantA, reader, "le-clientes-candidatos");
    const editor = await createUser(owner);
    userIds.push(editor.id);
    await createRole(ownerA, "edita-sem-ler", ["customer:update"]);
    await addMember(owner, tenantA, editor, "edita-sem-ler");

    const path = `/api/customers/${record.id}/team-candidates`;
    expect((await call("GET", path, { cookie: reader.cookie })).status).toBe(403);
    expect((await call("GET", path, { cookie: editor.cookie })).status).toBe(403);
    expect((await call("GET", path, { cookie: ownerB.cookie })).status).toBe(404);
  });
});

describe("D-11 com a ligação manual", () => {
  /**
   * Ficha de outro número (o do cliente), ligada à mão à pessoa. Dois contatos ligados à ficha: o do
   * telefone confirmado da pessoa e o do número da ficha.
   */
  async function manualRecord() {
    const { person, phone } = await teamPerson();
    const record = await createCustomer(ownerA, { name: "Ficha ligada à mão" });
    expect((await link(ownerA, record.id, person.id)).status).toBe(200);

    const own = await conversationWithMedia(record.id, phone.phoneNormalized);
    const foreign = await conversationWithMedia(record.id);
    const otherRecord = await createCustomer(ownerA, { name: "Outro cliente" });
    const other = await conversationWithMedia(otherRecord.id);

    return { person, record, own, foreign, otherRecord, other };
  }

  async function expectOnlyOwnContactGone(seeded: Awaited<ReturnType<typeof manualRecord>>) {
    const { record, own, foreign, otherRecord, other } = seeded;
    expect(await count("customer where id = $1", record.id)).toBe(0);

    // O contato do telefone confirmado da pessoa sai, com conversas, mensagens, arquivo e objeto.
    expect(await count("chat_contact where id = $1", own.contactId)).toBe(0);
    expect(await count("conversation where id = $1", own.id)).toBe(0);
    expect(await count("message where conversation_id = $1", own.id)).toBe(0);
    expect(await count("file where id = $1", own.fileId)).toBe(0);
    expect(memory.objects.has(own.mediaKey)).toBe(false);

    // O contato do número da ficha (de outra pessoa) só perde o vínculo; a conversa fica.
    expect(await count("chat_contact where id = $1 and customer_id is null", foreign.contactId)).toBe(1);
    expect(await count("conversation where id = $1", foreign.id)).toBe(1);
    expect(await count("message where conversation_id = $1", foreign.id)).toBe(2);
    expect(await count("file where id = $1", foreign.fileId)).toBe(1);
    expect(memory.objects.has(foreign.mediaKey)).toBe(true);

    // Outros clientes não são tocados.
    expect(await count("customer where id = $1", otherRecord.id)).toBe(1);
    expect(await count("conversation where id = $1", other.id)).toBe(1);
    expect(memory.objects.has(other.mediaKey)).toBe(true);
  }

  it("remover a pessoa da equipe apaga a ficha e só os contatos do telefone confirmado dela", async () => {
    const seeded = await manualRecord();
    const membership = await membershipOf(seeded.person, tenantA);
    expect((await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie })).status).toBe(200);
    await expectOnlyOwnContactGone(seeded);
  });

  it("excluir a conta apaga a ficha e só os contatos do telefone confirmado dela", async () => {
    const seeded = await manualRecord();
    expect(await runUserDeletion(seeded.person.id)).toBe("executed");
    await expectOnlyOwnContactGone(seeded);
  });

  it("a pessoa que perde a confirmação depois de ligada: a ficha sai e nenhum contato é apagado", async () => {
    const { person, phone } = await teamPerson();
    const record = await createCustomer(ownerA, { name: "Ligada, telefone que caiu" });
    expect((await link(ownerA, record.id, person.id)).status).toBe(200);
    // Outra conta provou o número depois (a confirmação cai).
    await owner`update "user" set phone_verified_at = null, phone_verified_via = null where id = ${person.id}`;
    const same = await conversationWithMedia(record.id, phone.phoneNormalized);

    const membership = await membershipOf(person, tenantA);
    expect((await call("DELETE", `/api/team/members/${membership}`, { cookie: ownerA.cookie })).status).toBe(200);

    expect(await count("customer where id = $1", record.id)).toBe(0);
    expect(await count("chat_contact where id = $1 and customer_id is null", same.contactId)).toBe(1);
    expect(await count("conversation where id = $1", same.id)).toBe(1);
  });

  it("o aviso da remoção conta só as conversas que seriam apagadas", async () => {
    const seeded = await manualRecord();
    const list = await call("GET", "/api/team", { cookie: ownerA.cookie });
    const { members } = (await list.json()) as {
      members: { userId: string; customerRecord?: { conversationCount: number } | null }[];
    };
    expect(members.find(({ userId }) => userId === seeded.person.id)?.customerRecord).toEqual({
      conversationCount: 1,
    });
  });
});
