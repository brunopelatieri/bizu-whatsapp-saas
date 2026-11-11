import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeDeletion } from "@/lib/lgpd/deletion";
import { buildExportFiles } from "@/lib/lgpd/export";
import { stopRealtime } from "@/lib/inbox/realtime";
import { setStorageForTests } from "@/lib/storage";
import { platformScope, seedCloudChannel, tenantScope } from "./channels-helpers";
import { attachMedia, memoryStorage, seedConversation, seedMessage } from "./inbox-helpers";
import { phoneRow } from "./phone-helpers";
import { createCustomer } from "./portal-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  DOMAIN,
  type TestUser,
} from "./tenant-helpers";

/**
 * C7: a LGPD da caixa de entrada. Excluir ou anonimizar o cliente apaga os contatos dele com
 * conversas, mensagens, `file` e objeto; anonimizar a pessoa da equipe tira o autor e o vínculo
 * (e apaga o contato da plataforma); excluir a organização apaga tudo, inclusive os avisos de canal
 * e a mídia `inbound/` deles; a exportação traz as mensagens do titular, sem dado de terceiros; um
 * tenant não apaga nem exporta o que é de outro.
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

/** Contas e organizações anonimizadas escapam do padrão de e-mail de `cleanUp`. */
const userIds: string[] = [];
const tenantIds: string[] = [];
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

/** Conversa com uma mensagem de texto e uma imagem (linha `file` e objeto no armazenamento). */
async function conversationWithMedia(
  scope: Parameters<typeof seedConversation>[0],
  channelId: string,
  seed: Parameters<typeof seedConversation>[2] = {},
) {
  const seeded = await seedConversation(scope, channelId, seed);
  const target = { conversationId: seeded.id, channelId };
  await seedMessage(scope, target, { text: "mensagem do contato" });
  const image = await seedMessage(scope, target, { type: "image", text: null });
  const fileId = await attachMedia(scope, memory, image.id, PNG, "image/png", "foto.png");
  return { ...seeded, fileId, mediaKey: `inbox/test/${image.id}` };
}

async function runDeletion(type: "user" | "portal_user" | "tenant", subjectId: string, requestedBy: string) {
  const [row] = await bypass(
    (tx) => tx<{ id: string }[]>`
      insert into deletion_request (subject_type, subject_id, tenant_id, requested_by, scheduled_for, origin)
      values (${type}, ${subjectId}, ${type === "tenant" ? subjectId : null}, ${requestedBy}, now() - interval '1 minute', 'platform')
      returning id
    `,
  );
  if (!row) throw new Error("pedido não criado");
  return executeDeletion(row.id);
}

async function portalPerson() {
  const id = randomUUID();
  const phone = phoneRow();
  await owner`
    insert into portal_user (id, name, email, phone, phone_normalized, phone_key)
    values (${id}, ${"Pessoa do Portal"}, ${`portal-${id}@${DOMAIN}`}, ${phone.phone},
      ${phone.phoneNormalized}, ${phone.phoneKey})
  `;
  portalIds.push(id);
  return id;
}

beforeAll(async () => {
  owner = connectOwner();
  ownerA = await createUser(owner);
  ownerB = await createUser(owner);
  tenantA = (await createTenant(ownerA, "Clínica LGPD A")).id;
  tenantB = (await createTenant(ownerB, "Clínica LGPD B")).id;
  channelA = (await seedCloudChannel(tenantScope(tenantA))).id;
  channelB = (await seedCloudChannel(tenantScope(tenantB))).id;
  platformChannel = (await seedCloudChannel(platformScope, { name: "LGPD-chtest" })).id;
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
    if (tenantIds.length > 0) {
      await tx`delete from audit_log where tenant_id = any(${tenantIds})`;
      await tx`delete from deletion_request where tenant_id = any(${tenantIds})`;
      await tx`delete from organization where id = any(${tenantIds})`;
    }
    const people = [...userIds, ...portalIds];
    if (people.length > 0) {
      await tx`delete from audit_log where actor_id = any(${people}) or target_id = any(${people})`;
      await tx`delete from deletion_request where subject_id = any(${people})`;
    }
    if (userIds.length > 0) await tx`delete from "user" where id = any(${userIds})`;
    if (portalIds.length > 0) {
      await tx`delete from customer where portal_user_id = any(${portalIds})`;
      await tx`delete from portal_user where id = any(${portalIds})`;
    }
    await tx`delete from audit_log where target_type = 'customer' and tenant_id in (${tenantA}, ${tenantB})`;
  });
  await cleanUp(owner);
  await owner.end();
});

describe("excluir o cliente (DELETE /api/customers/:id)", () => {
  it("apaga os contatos vinculados com conversas, mensagens, file e objeto; o resto fica", async () => {
    const record = await createCustomer(ownerA, { name: "Cliente que sai" });
    const linked = await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: record.id });
    const other = await conversationWithMedia(tenantScope(tenantA), channelA);
    // Outro tenant com o mesmo número: não é o mesmo contato.
    const sameNumberB = await conversationWithMedia(tenantScope(tenantB), channelB, { phone: linked.phone });

    expect(memory.objects.has(linked.mediaKey)).toBe(true);

    const response = await call("DELETE", `/api/customers/${record.id}`, { cookie: ownerA.cookie });
    expect(response.status).toBe(200);

    expect(await count("chat_contact where id = $1", linked.contactId)).toBe(0);
    expect(await count("conversation where id = $1", linked.id)).toBe(0);
    expect(await count("message where conversation_id = $1", linked.id)).toBe(0);
    expect(await count("file where id = $1", linked.fileId)).toBe(0);
    expect(memory.objects.has(linked.mediaKey)).toBe(false);

    for (const kept of [other, sameNumberB]) {
      expect(await count("conversation where id = $1", kept.id)).toBe(1);
      expect(await count("file where id = $1", kept.fileId)).toBe(1);
      expect(memory.objects.has(kept.mediaKey)).toBe(true);
    }
  });

  it("um tenant não apaga o cliente (nem as conversas) de outro", async () => {
    const recordB = await createCustomer(ownerB, { name: "Cliente de B" });
    const linkedB = await conversationWithMedia(tenantScope(tenantB), channelB, { customerId: recordB.id });

    const response = await call("DELETE", `/api/customers/${recordB.id}`, { cookie: ownerA.cookie });
    expect(response.status).toBe(404);

    expect(await count("customer where id = $1", recordB.id)).toBe(1);
    expect(await count("conversation where id = $1", linkedB.id)).toBe(1);
    expect(memory.objects.has(linkedB.mediaKey)).toBe(true);
  });
});

describe("anonimizar a pessoa do portal (lgpd.delete)", () => {
  it("os cadastros dela viram anônimos e os contatos vinculados saem com a mídia", async () => {
    const personId = await portalPerson();
    const record = await createCustomer(ownerA, { name: "Cliente do Portal" });
    await bypass((tx) => tx`update customer set portal_user_id = ${personId} where id = ${record.id}`);
    const linked = await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: record.id });
    const unrelated = await conversationWithMedia(tenantScope(tenantA), channelA);

    expect(await runDeletion("portal_user", personId, ownerA.id)).toBe("executed");

    expect(await count("customer where id = $1 and name = 'Cliente removido'", record.id)).toBe(1);
    expect(await count("chat_contact where id = $1", linked.contactId)).toBe(0);
    expect(await count("message where conversation_id = $1", linked.id)).toBe(0);
    expect(await count("file where id = $1", linked.fileId)).toBe(0);
    expect(memory.objects.has(linked.mediaKey)).toBe(false);
    expect(await count("conversation where id = $1", unrelated.id)).toBe(1);
  });
});

describe("anonimizar a pessoa da equipe (lgpd.delete)", () => {
  it("tira o autor e o vínculo no tenant e apaga o contato dela na plataforma", async () => {
    const person = await createUser(owner);
    userIds.push(person.id);
    await addMember(owner, tenantA, person, "member");

    // Como atendente: mensagem enviada e conversa encerrada por ela.
    const attended = await seedConversation(tenantScope(tenantA), channelA, { assignedUserId: person.id });
    const sent = await seedMessage(
      tenantScope(tenantA),
      { conversationId: attended.id, channelId: channelA },
      { direction: "out", senderUserId: person.id },
    );
    await bypass((tx) => tx`update conversation set closed_by = ${person.id} where id = ${attended.id}`);

    // Como contato: no tenant (vínculo de membro) e na plataforma.
    const asMember = await conversationWithMedia(tenantScope(tenantA), channelA, { userId: person.id });
    const withPlatform = await conversationWithMedia(platformScope, platformChannel, { userId: person.id });
    // Anexo que ela enviou como atendente (o `file` guarda quem subiu).
    await bypass((tx) => tx`update file set created_by = ${person.id} where id = ${asMember.fileId}`);

    expect(await runDeletion("user", person.id, person.id)).toBe("executed");

    expect(await count("message where id = $1 and sender_user_id is null", sent.id)).toBe(1);
    expect(
      await count(
        "conversation where id = $1 and closed_by is null and assigned_user_id is null",
        attended.id,
      ),
    ).toBe(1);

    expect(await count("chat_contact where id = $1 and user_id is null", asMember.contactId)).toBe(1);
    expect(await count("conversation where id = $1", asMember.id)).toBe(1);
    expect(memory.objects.has(asMember.mediaKey)).toBe(true);
    expect(await count("file where id = $1 and created_by is null", asMember.fileId)).toBe(1);

    expect(await count("chat_contact where id = $1", withPlatform.contactId)).toBe(0);
    expect(await count("conversation where id = $1", withPlatform.id)).toBe(0);
    expect(await count("file where id = $1", withPlatform.fileId)).toBe(0);
    expect(memory.objects.has(withPlatform.mediaKey)).toBe(false);
  });
});

describe("excluir a organização (lgpd.delete)", () => {
  it("apaga contatos, conversas, mensagens, arquivos, avisos de canal e os objetos; outro tenant fica", async () => {
    const doomedOwner = await createUser(owner);
    userIds.push(doomedOwner.id);
    const doomed = (await createTenant(doomedOwner, "Clínica que sai")).id;
    tenantIds.push(doomed);
    const doomedChannel = (await seedCloudChannel(tenantScope(doomed))).id;

    const record = await createCustomer(doomedOwner, { name: "Cliente da que sai" });
    const linked = await conversationWithMedia(tenantScope(doomed), doomedChannel, { customerId: record.id });
    const loose = await conversationWithMedia(tenantScope(doomed), doomedChannel);

    // Anexo de saída (C5): `file` do tenant com o mesmo dono `message`.
    const outbound = await seedMessage(
      tenantScope(doomed),
      { conversationId: loose.id, channelId: doomedChannel },
      { direction: "out", type: "document", text: null },
    );
    await attachMedia(tenantScope(doomed), memory, outbound.id, Buffer.from("%PDF-1.4"), "application/pdf");

    // Aviso de canal ainda pendente com mídia `inbound/` que nunca virou `file`.
    const inboundKey = `inbound/test-${randomUUID()}`;
    await memory.storage.put(inboundKey, PNG);
    await bypass(
      (tx) => tx`
        insert into channel_event (tenant_id, channel_id, provider, dedupe_key, kind, raw)
        values (${doomed}, ${doomedChannel}, 'whatsapp_cloud', ${randomUUID()}, 'message',
          ${tx.json({ telefone: "5511999990000", media: { storageKey: inboundKey, mime: "image/png", size: 72 } })})
      `,
    );

    const survivor = await conversationWithMedia(tenantScope(tenantB), channelB);

    expect(await runDeletion("tenant", doomed, doomedOwner.id)).toBe("executed");

    expect(await count("chat_contact where tenant_id = $1", doomed)).toBe(0);
    expect(await count("conversation where tenant_id = $1", doomed)).toBe(0);
    expect(await count("message where tenant_id = $1", doomed)).toBe(0);
    expect(await count("file where tenant_id = $1", doomed)).toBe(0);
    expect(await count("channel_event where tenant_id = $1", doomed)).toBe(0);
    expect(memory.objects.has(linked.mediaKey)).toBe(false);
    expect(memory.objects.has(loose.mediaKey)).toBe(false);
    expect(memory.objects.has(`inbox/test/${outbound.id}`)).toBe(false);
    expect(memory.objects.has(inboundKey)).toBe(false);

    expect(await count("conversation where id = $1", survivor.id)).toBe(1);
    expect(memory.objects.has(survivor.mediaKey)).toBe(true);
  });
});

describe("exportação (lgpd.export)", () => {
  const conversationsOf = async (subject: Parameters<typeof buildExportFiles>[0]) => {
    const files = await buildExportFiles(subject);
    const entry = files.find(({ name }) => name === "conversas-whatsapp.json");
    if (!entry) throw new Error("sem conversas-whatsapp.json");
    return JSON.parse(entry.data.toString()) as {
      truncated: boolean;
      conversations: {
        organizacao: string | null;
        telefone: string;
        mensagens: { direcao: string; texto: string | null; anexo: unknown }[];
      }[];
    };
  };

  it("o cliente recebe as mensagens trocadas, com a mídia por nome; nada de outro tenant nem de quem atendeu", async () => {
    const personId = await portalPerson();
    const record = await createCustomer(ownerA, { name: "Cliente que exporta" });
    await bypass((tx) => tx`update customer set portal_user_id = ${personId} where id = ${record.id}`);
    const linked = await conversationWithMedia(tenantScope(tenantA), channelA, { customerId: record.id });
    await seedMessage(
      tenantScope(tenantA),
      { conversationId: linked.id, channelId: channelA },
      { direction: "out", text: "resposta da equipe", senderUserId: ownerA.id },
    );
    // Mesmo número em outro tenant, sem vínculo com o cadastro: não entra.
    await conversationWithMedia(tenantScope(tenantB), channelB, { phone: linked.phone });

    const result = await conversationsOf({ type: "portal_user", id: personId });

    expect(result.truncated).toBe(false);
    expect(result.conversations).toHaveLength(1);
    const [only] = result.conversations;
    expect(only).toMatchObject({ organizacao: "Clínica LGPD A", telefone: linked.phone });
    expect(only?.mensagens.map(({ direcao }) => direcao)).toEqual(["recebida", "recebida", "enviada"]);
    expect(only?.mensagens[1]?.anexo).toEqual({ nome: "foto.png", tipo: "image/png", tamanho: PNG.byteLength });

    const raw = JSON.stringify(result);
    expect(raw).not.toContain(ownerA.id);
    expect(raw).not.toContain(ownerA.email);
    expect(raw).not.toContain("Clínica LGPD B");
  });

  it("o cadastro ligado só pelo e-mail entra na exportação, como entra na anonimização", async () => {
    const personId = await portalPerson();
    const record = await createCustomer(ownerB, { name: "Cadastro pelo e-mail", email: `portal-${personId}@${DOMAIN}` });
    await conversationWithMedia(tenantScope(tenantB), channelB, { customerId: record.id });

    const result = await conversationsOf({ type: "portal_user", id: personId });

    expect(result.conversations.map(({ organizacao }) => organizacao)).toEqual(["Clínica LGPD B"]);
  });

  it("a pessoa da equipe recebe as conversas em que é o contato (plataforma e organização)", async () => {
    const person = await createUser(owner);
    await addMember(owner, tenantA, person, "member");
    await conversationWithMedia(platformScope, platformChannel, { userId: person.id });
    await conversationWithMedia(tenantScope(tenantA), channelA, { userId: person.id });

    const result = await conversationsOf({ type: "user", id: person.id });

    expect(result.conversations.map(({ organizacao }) => organizacao).sort()).toEqual(
      ["Clínica LGPD A", null].sort(),
    );
  });
});

describe("editar papel personalizado tirando inbox:reply", () => {
  it("devolve à fila as conversas de quem tem o papel", async () => {
    const support = await createUser(owner);
    const roleName = `atende${randomUUID().slice(0, 6).replace(/[^a-z]/g, "x")}`;
    const role = await createRole(ownerA, roleName, ["inbox:read", "inbox:reply"]);
    await addMember(owner, tenantA, support, roleName);
    const mine = await seedConversation(tenantScope(tenantA), channelA, { assignedUserId: support.id });

    const response = await call("PATCH", `/api/roles/${role.id}`, {
      cookie: ownerA.cookie,
      body: { permissions: ["inbox:read"] },
    });
    expect(response.status).toBe(200);

    expect(await count("conversation where id = $1 and assigned_user_id is null", mine.id)).toBe(1);
  });
});
