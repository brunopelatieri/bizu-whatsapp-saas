import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { bodyOf } from "./billing-helpers";
import { cleanUpPortal, createCustomer } from "./portal-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/** Etiquetas do tenant (`docs/specs/crm-cadastro/spec.md`, fase A2). */

let owner: postgres.Sql;
let tenantOwner: TestUser;
let otherOwner: TestUser;
let member: TestUser;
let tenantId: string;
let otherTenantId: string;

type Tag = { id: string; name: string; color: string; usage: number };

const createTag = (user: TestUser, body: unknown) =>
  call("POST", "/api/tags", { cookie: user.cookie, body });

async function newTag(user: TestUser, name: string, color?: string) {
  const response = await createTag(user, { name, ...(color ? { color } : {}) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { tag: Tag }).tag;
}

async function listTags(user: TestUser) {
  const response = await call("GET", "/api/tags", { cookie: user.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { tags: Tag[] }).tags;
}

async function customerWith(user: TestUser) {
  return (await createCustomer(user)) as { id: string; email: string };
}

const apply = (user: TestUser, customerId: string, tagId: string) =>
  call("PUT", `/api/customers/${customerId}/tags/${tagId}`, { cookie: user.cookie });

const detail = async (user: TestUser, customerId: string) => {
  const response = await call("GET", `/api/customers/${customerId}`, { cookie: user.cookie });
  return ((await response.json()) as {
    customer: { tags: Array<{ id: string; name: string; color: string }> };
  }).customer;
};

beforeAll(async () => {
  setEmailProviderForTests(createMemoryProvider());
  owner = connectOwner();

  tenantOwner = await createUser(owner);
  tenantId = (await createTenant(tenantOwner, "Etiquetas A")).id;
  otherOwner = await createUser(owner);
  otherTenantId = (await createTenant(otherOwner, "Etiquetas B")).id;
  member = await createUser(owner);
  await addMember(owner, tenantId, member, "member");
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("etiquetas: CRUD", () => {
  it("cria com a cor padrão, normaliza a cor e lista por nome", async () => {
    const plain = await newTag(tenantOwner, "  Cliente   VIP  ");
    expect(plain).toMatchObject({ name: "Cliente VIP", color: "#3b82f6", usage: 0 });

    expect((await newTag(tenantOwner, "Curta", "#ABC")).color).toBe("#aabbcc");
    expect((await newTag(tenantOwner, "Sem hash", "FF0000")).color).toBe("#ff0000");

    const names = (await listTags(tenantOwner)).map((tag) => tag.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "pt", { sensitivity: "base" })));
    expect(names).toContain("Cliente VIP");
  });

  it("recusa cor inválida e nome vazio ou longo", async () => {
    for (const body of [
      { name: "Cor ruim", color: "azul" },
      { name: "Cor ruim", color: "#12345" },
      { name: "   " },
      { name: "x".repeat(41) },
    ]) {
      expect((await createTag(tenantOwner, body)).status).toBe(400);
    }
  });

  it("nome repetido no tenant é 409, sem diferenciar maiúsculas; em outro tenant, não", async () => {
    await newTag(tenantOwner, "Retorno");

    const repeated = await createTag(tenantOwner, { name: "RETORNO" });
    expect(repeated.status).toBe(409);
    expect(await bodyOf(repeated)).toMatchObject({ code: "TAG_NAME_TAKEN" });

    expect((await createTag(otherOwner, { name: "retorno" })).status).toBe(201);
  });

  it("renomeia, troca a cor e recusa o nome de outra etiqueta", async () => {
    const tag = await newTag(tenantOwner, "Antes");
    const other = await newTag(tenantOwner, "Ocupado");

    const patched = await call("PATCH", `/api/tags/${tag.id}`, {
      cookie: tenantOwner.cookie,
      body: { name: "Depois", color: "#10b981" },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ tag: { id: tag.id, name: "Depois", color: "#10b981" } });

    const clash = await call("PATCH", `/api/tags/${tag.id}`, {
      cookie: tenantOwner.cookie,
      body: { name: other.name.toLowerCase() },
    });
    expect(clash.status).toBe(409);
    expect(await bodyOf(clash)).toMatchObject({ code: "TAG_NAME_TAKEN" });

    expect(
      (await call("PATCH", `/api/tags/${tag.id}`, { cookie: tenantOwner.cookie, body: {} })).status,
    ).toBe(400);
  });

  it("a auditoria leva só ids, nunca o nome", async () => {
    const tag = await newTag(tenantOwner, "Nome Sensível Etiqueta");

    const rows = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ metadata: unknown }[]>`
        select metadata from audit_log where action = 'tag.created' and target_id = ${tag.id}
      `;
    });

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.metadata ?? {})).not.toContain("Sensível");
  });
});

describe("etiquetas: isolamento", () => {
  it("id de outro tenant é 404 (renomear, apagar e aplicar)", async () => {
    const foreign = await newTag(otherOwner, "Só do B");
    const customer = await customerWith(tenantOwner);

    expect(
      (await call("PATCH", `/api/tags/${foreign.id}`, { cookie: tenantOwner.cookie, body: { name: "x" } }))
        .status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/tags/${foreign.id}`, { cookie: tenantOwner.cookie })).status,
    ).toBe(404);
    expect((await apply(tenantOwner, customer.id, foreign.id)).status).toBe(404);

    const created = await call("POST", "/api/customers", {
      cookie: tenantOwner.cookie,
      body: { name: "Com etiqueta alheia", phone: "11 98877-1111", tagIds: [foreign.id] },
    });
    expect(created.status).toBe(404);

    expect((await listTags(tenantOwner)).map(({ id }) => id)).not.toContain(foreign.id);
    expect((await listTags(otherOwner)).map(({ id }) => id)).toContain(foreign.id);
  });

  it("etiqueta da plataforma (tenant_id nulo) não aparece para o tenant", async () => {
    const name = `Plat ${randomUUID().slice(0, 8)}`;
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`insert into tag (tenant_id, name) values (null, ${name})`;
    });

    expect((await listTags(tenantOwner)).map((tag) => tag.name)).not.toContain(name);
    expect((await listTags(otherOwner)).map((tag) => tag.name)).not.toContain(name);

    // O nome da plataforma não bloqueia o mesmo nome no tenant (índices separados).
    expect((await createTag(tenantOwner, { name })).status).toBe(201);

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from tag where tenant_id is null and name = ${name}`;
    });
  });

  it("dois nomes iguais (sem diferenciar maiúsculas) na plataforma são barrados pelo índice", async () => {
    const name = `Dup ${randomUUID().slice(0, 8)}`;
    const error = await owner
      .begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into tag (tenant_id, name) values (null, ${name})`;
        await tx`insert into tag (tenant_id, name) values (null, ${name.toUpperCase()})`;
      })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe("23505");
  });

  it("o CHECK barra cor fora de #rrggbb direto no banco", async () => {
    const error = await owner
      .begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into tag (tenant_id, name, color) values (${tenantId}, 'Cor torta', '#AABBCC')`;
      })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe("23514");
  });
});

describe("etiquetas: teto", () => {
  it("a 101ª etiqueta do escopo é 409 TAG_LIMIT", async () => {
    const user = await createUser(owner);
    const id = (await createTenant(user, "Teto de etiquetas")).id;

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        insert into tag (tenant_id, name)
        select ${id}, 'tag ' || n from generate_series(1, 100) as n
      `;
    });

    const over = await createTag(user, { name: "Centésima primeira" });
    expect(over.status).toBe(409);
    expect(await bodyOf(over)).toMatchObject({ code: "TAG_LIMIT" });

    // Apagar uma abre a vaga.
    const [first] = await listTags(user);
    expect(
      (await call("DELETE", `/api/tags/${first?.id}`, { cookie: user.cookie })).status,
    ).toBe(200);
    expect((await createTag(user, { name: "Agora cabe" })).status).toBe(201);
  });
});

describe("etiquetas no cliente", () => {
  it("aplicar e tirar são idempotentes e aparecem no detalhe", async () => {
    const tag = await newTag(tenantOwner, "Aplicada");
    const customer = await customerWith(tenantOwner);

    expect((await apply(tenantOwner, customer.id, tag.id)).status).toBe(200);
    expect((await apply(tenantOwner, customer.id, tag.id)).status).toBe(200);
    expect((await detail(tenantOwner, customer.id)).tags).toEqual([
      { id: tag.id, name: "Aplicada", color: "#3b82f6" },
    ]);
    expect((await listTags(tenantOwner)).find(({ id }) => id === tag.id)?.usage).toBe(1);

    const remove = () =>
      call("DELETE", `/api/customers/${customer.id}/tags/${tag.id}`, { cookie: tenantOwner.cookie });
    expect((await remove()).status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect((await detail(tenantOwner, customer.id)).tags).toEqual([]);
  });

  it("tagIds substitui o conjunto, no POST e no PATCH", async () => {
    const [a, b, c] = [
      await newTag(tenantOwner, "Conjunto A"),
      await newTag(tenantOwner, "Conjunto B"),
      await newTag(tenantOwner, "Conjunto C"),
    ];

    const created = await call("POST", "/api/customers", {
      cookie: tenantOwner.cookie,
      body: { name: "Com etiquetas", phone: "11 98877-2222", tagIds: [a.id, b.id, a.id] },
    });
    expect(created.status).toBe(201);
    const { customer } = (await created.json()) as { customer: { id: string; tags: Tag[] } };
    expect(customer.tags.map(({ name }) => name)).toEqual(["Conjunto A", "Conjunto B"]);

    const patched = await call("PATCH", `/api/customers/${customer.id}`, {
      cookie: tenantOwner.cookie,
      body: { tagIds: [c.id] },
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { customer: { tags: Tag[] } }).customer.tags.map(({ name }) => name)).toEqual([
      "Conjunto C",
    ]);

    // Sem `tagIds`, o PATCH não mexe nas etiquetas.
    await call("PATCH", `/api/customers/${customer.id}`, {
      cookie: tenantOwner.cookie,
      body: { notes: "só uma nota" },
    });
    expect((await detail(tenantOwner, customer.id)).tags).toHaveLength(1);
  });

  it("o 21º vínculo é 409 CUSTOMER_TAG_LIMIT", async () => {
    const user = await createUser(owner);
    const id = (await createTenant(user, "Teto por cliente")).id;
    const customer = await customerWith(user);

    const ids = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ id: string }[]>`
        insert into tag (tenant_id, name)
        select ${id}, 'vinculo ' || n from generate_series(1, 21) as n
        returning id
      `;
    });

    for (const { id: tagId } of ids.slice(0, 20)) {
      expect((await apply(user, customer.id, tagId)).status).toBe(200);
    }

    const over = await apply(user, customer.id, ids[20]?.id ?? "");
    expect(over.status).toBe(409);
    expect(await bodyOf(over)).toMatchObject({ code: "CUSTOMER_TAG_LIMIT" });

    // O que já está aplicado continua idempotente no teto.
    expect((await apply(user, customer.id, ids[0]?.id ?? "")).status).toBe(200);
  });

  it("filtro por etiqueta: qualquer uma das pedidas; excluir limpa os vínculos", async () => {
    const [vip, risco] = [await newTag(tenantOwner, "Filtro VIP"), await newTag(tenantOwner, "Filtro Risco")];
    const [c1, c2, c3] = [
      await customerWith(tenantOwner),
      await customerWith(tenantOwner),
      await customerWith(tenantOwner),
    ];
    await apply(tenantOwner, c1.id, vip.id);
    await apply(tenantOwner, c2.id, risco.id);

    const list = async (query: string) => {
      const response = await call("GET", `/api/customers?${query}`, { cookie: tenantOwner.cookie });
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: Array<{ id: string; tags: Tag[] }> }).items;
    };

    expect((await list(`tags=${vip.id}`)).map(({ id }) => id)).toEqual([c1.id]);
    const either = (await list(`tags=${vip.id},${risco.id}`)).map(({ id }) => id).sort();
    expect(either).toEqual([c1.id, c2.id].sort());
    expect((await list(`tags=${vip.id}`))[0]?.tags[0]?.name).toBe("Filtro VIP");
    // Id malformado no filtro é entrada inválida, não banco.
    expect((await call("GET", "/api/customers?tags=nao-e-uuid", { cookie: tenantOwner.cookie })).status).toBe(400);
    expect((await list(`tags=${vip.id}`)).map(({ id }) => id)).not.toContain(c3.id);

    const removed = await call("DELETE", `/api/tags/${vip.id}`, { cookie: tenantOwner.cookie });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, removedFrom: 1 });
    expect((await detail(tenantOwner, c1.id)).tags).toEqual([]);
  });

  it("colaborador aplica etiqueta (customer:update), mas não cria nem apaga", async () => {
    const tag = await newTag(tenantOwner, "Do colaborador");
    const customer = await customerWith(tenantOwner);

    expect((await apply(member, customer.id, tag.id)).status).toBe(200);
    expect((await createTag(member, { name: "Proibida" })).status).toBe(403);
    expect((await call("DELETE", `/api/tags/${tag.id}`, { cookie: member.cookie })).status).toBe(403);
    expect((await listTags(member)).length).toBeGreaterThan(0);
  });

  it("apagar o cliente leva os vínculos; o outro tenant não vê o cliente nem o filtro", async () => {
    const tag = await newTag(tenantOwner, "Some com o cliente");
    const customer = await customerWith(tenantOwner);
    await apply(tenantOwner, customer.id, tag.id);

    const outsider = await call("GET", `/api/customers?tags=${tag.id}`, { cookie: otherOwner.cookie });
    expect(outsider.status).toBe(200);
    expect(((await outsider.json()) as { items: unknown[] }).items).toHaveLength(0);

    await call("DELETE", `/api/customers/${customer.id}`, { cookie: tenantOwner.cookie });
    const rows = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx`select 1 from customer_tag where tag_id = ${tag.id}`;
    });
    expect(rows).toHaveLength(0);
    expect(otherTenantId).toBeTruthy();
  });
});
