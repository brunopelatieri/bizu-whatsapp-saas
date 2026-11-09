import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryProvider, type MemoryEmailProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { bodyOf } from "./billing-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, createCustomer, customerEmail, inviteAndEnter } from "./portal-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/** Campos adicionais do tenant (`docs/specs/crm-cadastro/spec.md`, fase A3). */

let owner: postgres.Sql;
let mail: MemoryEmailProvider;
let tenantOwner: TestUser;
let otherOwner: TestUser;
let member: TestUser;
let tenantId: string;

type Field = {
  id: string;
  key: string;
  label: string;
  type: string;
  options: Array<{ value: string; label: string }>;
  required: boolean;
  position: number;
  archived: boolean;
  usage: number;
};

type NewField = {
  label: string;
  type: string;
  key?: string;
  options?: Array<{ value?: string; label: string }>;
  required?: boolean;
};

const createField = (user: TestUser, body: NewField) =>
  call("POST", "/api/custom-fields", { cookie: user.cookie, body: { entity: "customer", ...body } });

async function newField(user: TestUser, body: NewField) {
  const response = await createField(user, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { field: Field }).field;
}

async function listFields(user: TestUser, archived = "false") {
  const response = await call("GET", `/api/custom-fields?entity=customer&archived=${archived}`, {
    cookie: user.cookie,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { fields: Field[] }).fields;
}

const patchField = (user: TestUser, id: string, body: unknown) =>
  call("PATCH", `/api/custom-fields/${id}`, { cookie: user.cookie, body });

const removeField = (user: TestUser, id: string, confirm: string) =>
  call("DELETE", `/api/custom-fields/${id}`, { cookie: user.cookie, body: { confirm } });

type CustomerView = { id: string; customFields: Record<string, unknown> };

async function newCustomer(user: TestUser, customFields?: Record<string, unknown>) {
  const response = await call("POST", "/api/customers", {
    cookie: user.cookie,
    body: { name: "Cliente Campos", phone: uniquePhone(), ...(customFields ? { customFields } : {}) },
  });
  return response;
}

async function detail(user: TestUser, id: string) {
  const response = await call("GET", `/api/customers/${id}`, { cookie: user.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { customer: CustomerView }).customer;
}

const patchCustomer = (user: TestUser, id: string, body: unknown) =>
  call("PATCH", `/api/customers/${id}`, { cookie: user.cookie, body });

beforeAll(async () => {
  mail = createMemoryProvider();
  setEmailProviderForTests(mail);
  owner = connectOwner();

  tenantOwner = await createUser(owner);
  tenantId = (await createTenant(tenantOwner, "Campos A")).id;
  otherOwner = await createUser(owner);
  await createTenant(otherOwner, "Campos B");
  member = await createUser(owner);
  await addMember(owner, tenantId, member, "member");
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

/** Um tenant limpo por cenário: o teto de 12 campos não atrapalha os outros testes. */
async function freshTenant(name: string) {
  const user = await createUser(owner);
  const tenant = await createTenant(user, name);
  return { user, tenantId: tenant.id };
}

describe("campos: CRUD", () => {
  it("cria os seis tipos, gera a key do rótulo e lista por posição", async () => {
    const { user } = await freshTenant("Seis tipos");
    const fields = [
      await newField(user, { label: "Observação interna", type: "text" }),
      await newField(user, { label: "Renda mensal", type: "number" }),
      await newField(user, { label: "Data de nascimento", type: "date" }),
      await newField(user, { label: "Aceita novidades?", type: "boolean" }),
      await newField(user, {
        label: "Origem",
        type: "select",
        options: [{ label: "Indicação" }, { label: "Anúncio" }],
      }),
      await newField(user, {
        label: "Interesses",
        type: "multiselect",
        options: [{ label: "Plano A" }, { label: "Plano B" }],
      }),
    ];

    expect(fields.map(({ key }) => key)).toEqual([
      "observacao_interna",
      "renda_mensal",
      "data_de_nascimento",
      "aceita_novidades",
      "origem",
      "interesses",
    ]);
    expect(fields[4]?.options).toEqual([
      { value: "indicacao", label: "Indicação" },
      { value: "anuncio", label: "Anúncio" },
    ]);

    const listed = await listFields(user);
    expect(listed.map(({ id }) => id)).toEqual(fields.map(({ id }) => id));
    expect(listed.map(({ position }) => position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("valida o corpo: lista exige opções, os outros tipos recusam, key e rótulo inválidos", async () => {
    const { user } = await freshTenant("Corpo inválido");

    for (const body of [
      { label: "Sem opções", type: "select" },
      { label: "Opções demais", type: "text", options: [{ label: "x" }] },
      { label: "Repetidas", type: "select", options: [{ label: "A" }, { label: "a" }] },
      { label: "", type: "text" },
      { label: "y".repeat(61), type: "text" },
      { label: "Tipo ruim", type: "image" },
      { label: "Key ruim", type: "text", key: "Com Espaço" },
      { label: "Muitas", type: "select", options: Array.from({ length: 51 }, (_, n) => ({ label: `o${n}` })) },
    ]) {
      expect((await createField(user, body)).status).toBe(400);
    }

    // Rótulo que não gera slug precisa de uma key.
    const noKey = await createField(user, { label: "???", type: "text" });
    expect(noKey.status).toBe(400);
    expect(await bodyOf(noKey)).toMatchObject({ code: "INVALID_KEY" });
    expect((await createField(user, { label: "???", type: "text", key: "interrogacao" })).status).toBe(201);

    // O tenant só tem campos de `customer`.
    const organization = await call("POST", "/api/custom-fields", {
      cookie: user.cookie,
      body: { entity: "organization", label: "Plataforma", type: "text" },
    });
    expect(organization.status).toBe(400);
    expect(await bodyOf(organization)).toMatchObject({ code: "INVALID_ENTITY" });
  });

  it("key repetida é 409 FIELD_KEY_TAKEN (inclusive de campo arquivado); outro tenant pode", async () => {
    const { user } = await freshTenant("Key repetida");
    const field = await newField(user, { label: "Documento extra", type: "text" });

    const clash = await createField(user, { label: "Outro nome", type: "text", key: "documento_extra" });
    expect(clash.status).toBe(409);
    expect(await bodyOf(clash)).toMatchObject({ code: "FIELD_KEY_TAKEN" });

    await patchField(user, field.id, { archived: true });
    expect((await createField(user, { label: "Documento extra", type: "text" })).status).toBe(409);

    expect((await createField(otherOwner, { label: "Documento extra", type: "text" })).status).toBe(201);
  });

  it("type e key não mudam: o PATCH só aceita rótulo, opções, obrigatório e arquivar", async () => {
    const { user } = await freshTenant("Imutáveis");
    const field = await newField(user, { label: "Fixo", type: "text" });

    expect((await patchField(user, field.id, { type: "number", key: "novo" })).status).toBe(400);

    const patched = await patchField(user, field.id, { label: "Fixo renomeado", required: true });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      field: { id: field.id, key: "fixo", type: "text", label: "Fixo renomeado", required: true },
    });

    // Opções em campo que não é de lista.
    const options = await patchField(user, field.id, { options: [{ label: "a" }] });
    expect(options.status).toBe(400);
    expect(await bodyOf(options)).toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("reordena e arquivar tira da lista ativa", async () => {
    const { user } = await freshTenant("Ordem");
    const [a, b, c] = [
      await newField(user, { label: "A", type: "text" }),
      await newField(user, { label: "B", type: "text" }),
      await newField(user, { label: "C", type: "text" }),
    ];

    const order = await call("PUT", "/api/custom-fields/order", {
      cookie: user.cookie,
      body: { entity: "customer", ids: [c.id, a.id, b.id] },
    });
    expect(order.status).toBe(200);
    expect((await listFields(user)).map(({ label }) => label)).toEqual(["C", "A", "B"]);

    expect((await patchField(user, a.id, { archived: true })).status).toBe(200);
    expect((await listFields(user)).map(({ label }) => label)).toEqual(["C", "B"]);
    expect((await listFields(user, "true")).map(({ label }) => label)).toEqual(["A"]);
    expect((await listFields(user, "all")).map(({ label }) => label)).toEqual(["C", "A", "B"]);

    expect((await patchField(user, a.id, { archived: false })).status).toBe(200);
    expect((await listFields(user)).map(({ label }) => label)).toContain("A");
  });

  it("a auditoria leva só ids e a key, nunca o rótulo nem valor", async () => {
    const { user } = await freshTenant("Auditoria campos");
    const field = await newField(user, { label: "Rótulo Sensível Campo", type: "text", key: "sens_key" });
    await patchField(user, field.id, { archived: true });
    await removeField(user, field.id, "sens_key");

    const rows = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ action: string; metadata: unknown }[]>`
        select action, metadata from audit_log
        where target_id = ${field.id} order by created_at
      `;
    });

    expect(rows.map(({ action }) => action)).toEqual([
      "custom_field.created",
      "custom_field.archived",
      "custom_field.deleted",
    ]);
    expect(JSON.stringify(rows.map(({ metadata }) => metadata))).not.toContain("Sensível");
    expect(rows[0]?.metadata).toMatchObject({ key: "sens_key" });
  });
});

describe("campos: teto", () => {
  it("o 13º campo ativo é 409 FIELD_LIMIT; arquivar libera vaga; reativar com a lista cheia, também", async () => {
    const { user } = await freshTenant("Teto de campos");
    const created: Field[] = [];

    for (let n = 1; n <= 12; n += 1) {
      created.push(await newField(user, { label: `Campo ${n}`, type: "text" }));
    }

    const over = await createField(user, { label: "Campo 13", type: "text" });
    expect(over.status).toBe(409);
    expect(await bodyOf(over)).toMatchObject({ code: "FIELD_LIMIT" });

    // Arquivado não conta: a vaga abre.
    const first = created[0] as Field;
    expect((await patchField(user, first.id, { archived: true })).status).toBe(200);
    const thirteenth = await newField(user, { label: "Campo 13", type: "text" });
    expect(thirteenth.label).toBe("Campo 13");

    // Lista cheia de novo: reativar o arquivado estoura o teto.
    const reactivate = await patchField(user, first.id, { archived: false });
    expect(reactivate.status).toBe(409);
    expect(await bodyOf(reactivate)).toMatchObject({ code: "FIELD_LIMIT" });
  });

  it("o teto não é por tenant global: outro tenant tem os seus 12", async () => {
    const { user } = await freshTenant("Outro teto");
    expect((await createField(user, { label: "Primeiro", type: "text" })).status).toBe(201);
  });
});

describe("campos: isolamento", () => {
  it("id de outro tenant é 404 (editar, ordenar, excluir) e não aparece na lista", async () => {
    const foreign = await newField(otherOwner, { label: "Só do B", type: "text" });
    const mine = await newField(tenantOwner, { label: "Só do A", type: "text" });

    expect((await patchField(tenantOwner, foreign.id, { label: "x" })).status).toBe(404);
    expect((await removeField(tenantOwner, foreign.id, foreign.key)).status).toBe(404);
    expect(
      (
        await call("PUT", "/api/custom-fields/order", {
          cookie: tenantOwner.cookie,
          body: { entity: "customer", ids: [mine.id, foreign.id] },
        })
      ).status,
    ).toBe(404);

    expect((await listFields(tenantOwner)).map(({ id }) => id)).not.toContain(foreign.id);
    expect((await listFields(otherOwner)).map(({ id }) => id)).toContain(foreign.id);

    // O campo do outro tenant continua intacto.
    expect((await listFields(otherOwner)).find(({ id }) => id === foreign.id)?.label).toBe("Só do B");
  });

  it("campo de outro tenant num cliente é UNKNOWN_FIELD", async () => {
    const foreign = await newField(otherOwner, { label: "Alheio", type: "text" });
    const response = await newCustomer(tenantOwner, { [foreign.id]: "x" });

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toMatchObject({ code: "UNKNOWN_FIELD" });
  });

  it("campo da plataforma (tenant_id nulo, entity organization) não aparece para o tenant", async () => {
    const key = `plat_${randomUUID().slice(0, 8)}`;
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        insert into custom_field (tenant_id, entity, key, label, type)
        values (null, 'organization', ${key}, 'Plataforma', 'text')
      `;
    });

    expect((await listFields(tenantOwner, "all")).map((field) => field.key)).not.toContain(key);
    // Mesma key no tenant: índices separados.
    expect((await createField(tenantOwner, { label: key, type: "text", key })).status).toBe(201);

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from custom_field where tenant_id is null and key = ${key}`;
    });
  });

  it("o CHECK de escopo barra organization com tenant e customer sem tenant; key duplicada na plataforma", async () => {
    const fail = (run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      owner
        .begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await run(tx);
        })
        .then(() => undefined)
        .catch((caught: unknown) => (caught as { code?: string }).code);

    expect(
      await fail(
        (tx) =>
          tx`insert into custom_field (tenant_id, entity, key, label, type) values (${tenantId}, 'organization', 'x1', 'x', 'text')`,
      ),
    ).toBe("23514");
    expect(
      await fail(
        (tx) =>
          tx`insert into custom_field (tenant_id, entity, key, label, type) values (null, 'customer', 'x2', 'x', 'text')`,
      ),
    ).toBe("23514");
    expect(
      await fail(
        (tx) =>
          tx`insert into custom_field (tenant_id, entity, key, label, type) values (${tenantId}, 'customer', 'x3', 'x', 'video')`,
      ),
    ).toBe("23514");

    const key = `dup_${randomUUID().slice(0, 8)}`;
    expect(
      await fail(async (tx) => {
        await tx`insert into custom_field (tenant_id, entity, key, label, type) values (null, 'organization', ${key}, 'a', 'text')`;
        await tx`insert into custom_field (tenant_id, entity, key, label, type) values (null, 'organization', ${key}, 'b', 'text')`;
      }),
    ).toBe("23505");
  });
});

describe("valores no cliente", () => {
  it("grava os seis tipos no POST e devolve em customFields", async () => {
    const { user } = await freshTenant("Valores seis tipos");
    const text = await newField(user, { label: "Texto", type: "text" });
    const number = await newField(user, { label: "Número", type: "number" });
    const date = await newField(user, { label: "Data", type: "date" });
    const bool = await newField(user, { label: "Sim ou não", type: "boolean" });
    const select = await newField(user, {
      label: "Escolha",
      type: "select",
      options: [{ label: "Um" }, { label: "Dois" }],
    });
    const multi = await newField(user, {
      label: "Várias",
      type: "multiselect",
      options: [{ label: "Um" }, { label: "Dois" }],
    });

    const response = await newCustomer(user, {
      [text.id]: "  olá  ",
      [number.id]: 42.5,
      [date.id]: "2026-02-28",
      [bool.id]: false,
      [select.id]: "dois",
      [multi.id]: ["um", "dois", "um"],
    });
    expect(response.status).toBe(201);
    const { customer } = (await response.json()) as { customer: CustomerView };

    expect(customer.customFields).toEqual({
      [text.id]: "olá",
      [number.id]: 42.5,
      [date.id]: "2026-02-28",
      [bool.id]: false,
      [select.id]: "dois",
      [multi.id]: ["um", "dois"],
    });
    expect((await detail(user, customer.id)).customFields).toEqual(customer.customFields);
  });

  it("recusa valor inválido de cada tipo e id desconhecido ou de campo arquivado", async () => {
    const { user } = await freshTenant("Valores inválidos");
    const number = await newField(user, { label: "Número", type: "number" });
    const date = await newField(user, { label: "Data", type: "date" });
    const select = await newField(user, { label: "Escolha", type: "select", options: [{ label: "Um" }] });
    const old = await newField(user, { label: "Antigo", type: "text" });
    await patchField(user, old.id, { archived: true });

    for (const values of [
      { [number.id]: "12" },
      { [date.id]: "2026-02-31" },
      { [select.id]: "inexistente" },
    ]) {
      const response = await newCustomer(user, values);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ code: "INVALID_FIELD_VALUE" });
    }

    for (const values of [{ [old.id]: "x" }, { [randomUUID()]: "x" }]) {
      const response = await newCustomer(user, values);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ code: "UNKNOWN_FIELD" });
    }

    // Chave que não é uuid é recusada pelo contrato.
    expect((await newCustomer(user, { "nao-e-uuid": "x" })).status).toBe(400);
  });

  it("PATCH é merge por chave: null remove, chave ausente não muda", async () => {
    const { user } = await freshTenant("Merge por chave");
    const a = await newField(user, { label: "A", type: "text" });
    const b = await newField(user, { label: "B", type: "text" });
    const c = await newField(user, { label: "C", type: "number" });

    const created = await newCustomer(user, { [a.id]: "a1", [b.id]: "b1" });
    const { customer } = (await created.json()) as { customer: CustomerView };

    const patched = await patchCustomer(user, customer.id, { customFields: { [a.id]: "a2", [c.id]: 7 } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { customer: CustomerView }).customer.customFields).toEqual({
      [a.id]: "a2",
      [b.id]: "b1",
      [c.id]: 7,
    });

    // `null` e vazio removem.
    await patchCustomer(user, customer.id, { customFields: { [b.id]: null, [c.id]: null } });
    expect((await detail(user, customer.id)).customFields).toEqual({ [a.id]: "a2" });

    // Sem `customFields`, o PATCH não toca nos valores.
    await patchCustomer(user, customer.id, { notes: "só uma nota" });
    expect((await detail(user, customer.id)).customFields).toEqual({ [a.id]: "a2" });
  });

  it("PATCHes concorrentes em chaves diferentes não perdem valor (merge no UPDATE)", async () => {
    const { user } = await freshTenant("Merge concorrente");
    const fields: Field[] = [];
    for (let n = 1; n <= 8; n += 1) {
      fields.push(await newField(user, { label: `Campo ${n}`, type: "text" }));
    }
    const { customer } = (await (await newCustomer(user)).json()) as { customer: CustomerView };

    const responses = await Promise.all(
      fields.map((field, n) =>
        patchCustomer(user, customer.id, { customFields: { [field.id]: `valor ${n}` } }),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual(fields.map(() => 200));

    const values = (await detail(user, customer.id)).customFields;
    expect(Object.keys(values)).toHaveLength(8);
    for (const [n, field] of fields.entries()) expect(values[field.id]).toBe(`valor ${n}`);
  });

  it("required só vale quando o corpo traz customFields", async () => {
    const { user } = await freshTenant("Obrigatório");
    const must = await newField(user, { label: "Obrigatório", type: "text", required: true });
    const optional = await newField(user, { label: "Opcional", type: "text" });

    // Sem o bloco, o cadastro passa (ex.: "Salvar como cliente" do atendimento).
    const bare = await newCustomer(user);
    expect(bare.status).toBe(201);
    const { customer } = (await bare.json()) as { customer: CustomerView };

    // Com o bloco e sem o obrigatório: recusa.
    const missing = await newCustomer(user, { [optional.id]: "x" });
    expect(missing.status).toBe(400);
    expect(await bodyOf(missing)).toMatchObject({ code: "FIELD_REQUIRED" });

    // PATCH sem o bloco não exige; com o bloco, o estado final precisa do obrigatório.
    expect((await patchCustomer(user, customer.id, { notes: "ok" })).status).toBe(200);
    const final = await patchCustomer(user, customer.id, { customFields: { [optional.id]: "y" } });
    expect(final.status).toBe(400);
    expect(await bodyOf(final)).toMatchObject({ code: "FIELD_REQUIRED" });

    expect(
      (await patchCustomer(user, customer.id, { customFields: { [must.id]: "feito", [optional.id]: "y" } }))
        .status,
    ).toBe(200);

    // Depois de preenchido, não dá para apagar o obrigatório pelo PATCH.
    const clear = await patchCustomer(user, customer.id, { customFields: { [must.id]: null } });
    expect(clear.status).toBe(400);
    expect(await bodyOf(clear)).toMatchObject({ code: "FIELD_REQUIRED" });
  });

  it("colaborador preenche (customer:update), mas não gerencia campos", async () => {
    const field = await newField(tenantOwner, { label: "Do colaborador", type: "text" });
    const created = await newCustomer(member, { [field.id]: "feito pelo colaborador" });
    expect(created.status).toBe(201);

    expect((await createField(member, { label: "Proibido", type: "text" })).status).toBe(403);
    expect((await patchField(member, field.id, { label: "x" })).status).toBe(403);
    expect((await removeField(member, field.id, field.key)).status).toBe(403);
    // Ler as definições faz parte de `customer:read`.
    expect((await listFields(member)).map(({ id }) => id)).toContain(field.id);
  });
});

describe("opções de lista", () => {
  it("tirar opção em uso é 409 OPTION_IN_USE; renomear o rótulo e tirar opção sem uso, não", async () => {
    const { user } = await freshTenant("Opção em uso");
    const select = await newField(user, {
      label: "Origem",
      type: "select",
      options: [{ label: "Indicação" }, { label: "Anúncio" }, { label: "Evento" }],
    });
    const multi = await newField(user, {
      label: "Interesses",
      type: "multiselect",
      options: [{ label: "Alfa" }, { label: "Beta" }],
    });
    await newCustomer(user, { [select.id]: "anuncio", [multi.id]: ["alfa", "beta"] });

    const keep = (field: Field, drop: string) =>
      field.options.filter(({ value }) => value !== drop).map((option) => ({ ...option }));

    const inUse = await patchField(user, select.id, { options: keep(select, "anuncio") });
    expect(inUse.status).toBe(409);
    expect(await bodyOf(inUse)).toMatchObject({
      code: "OPTION_IN_USE",
      options: [{ value: "anuncio", count: 1 }],
    });

    const inUseMulti = await patchField(user, multi.id, { options: keep(multi, "beta") });
    expect(inUseMulti.status).toBe(409);
    expect(await bodyOf(inUseMulti)).toMatchObject({ code: "OPTION_IN_USE" });

    // Renomear o rótulo mantém o `value`: o valor guardado continua valendo.
    const renamed = await patchField(user, select.id, {
      options: select.options.map((option) =>
        option.value === "anuncio" ? { ...option, label: "Anúncio pago" } : option,
      ),
    });
    expect(renamed.status).toBe(200);
    const after = ((await renamed.json()) as { field: Field }).field;
    expect(after.options.find(({ value }) => value === "anuncio")?.label).toBe("Anúncio pago");

    // Opção que ninguém usa sai; opção nova ganha `value` gerado.
    const swapped = await patchField(user, select.id, {
      options: [...keep(after, "evento"), { label: "Parceiro" }],
    });
    expect(swapped.status).toBe(200);
    expect(((await swapped.json()) as { field: Field }).field.options.map(({ value }) => value)).toEqual([
      "indicacao",
      "anuncio",
      "parceiro",
    ]);

    // Valor de opção que não existe no campo é 400.
    expect(
      (await patchField(user, select.id, { options: [{ value: "fantasma", label: "Fantasma" }] })).status,
    ).toBe(400);
  });
});

describe("excluir campo", () => {
  it("pede a key digitada e limpa o valor em todos os clientes, só deste tenant", async () => {
    const { user } = await freshTenant("Excluir campo");
    const doomed = await newField(user, { label: "Some", type: "text", key: "some_campo" });
    const stays = await newField(user, { label: "Fica", type: "text" });

    const [c1, c2, c3] = await Promise.all(
      [{ [doomed.id]: "um", [stays.id]: "x" }, { [doomed.id]: "dois" }, { [stays.id]: "y" }].map(
        async (values) =>
          ((await (await newCustomer(user, values)).json()) as { customer: CustomerView }).customer,
      ),
    );

    // Outro tenant, outro campo: não é tocado.
    const foreign = await newField(otherOwner, { label: "Alheio vivo", type: "text" });
    const foreignCustomer = (
      (await (await newCustomer(otherOwner, { [foreign.id]: "intacto" })).json()) as { customer: CustomerView }
    ).customer;

    const wrong = await removeField(user, doomed.id, "errada");
    expect(wrong.status).toBe(400);
    expect(await bodyOf(wrong)).toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect((await listFields(user)).map(({ id }) => id)).toContain(doomed.id);

    // `usage` mostra quantos cadastros têm valor, para a confirmação.
    expect((await listFields(user)).find(({ id }) => id === doomed.id)?.usage).toBe(2);

    const removed = await removeField(user, doomed.id, "some_campo");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, clearedFrom: 2 });

    expect((await listFields(user, "all")).map(({ id }) => id)).not.toContain(doomed.id);
    expect((await detail(user, (c1 as CustomerView).id)).customFields).toEqual({ [stays.id]: "x" });
    expect((await detail(user, (c2 as CustomerView).id)).customFields).toEqual({});
    expect((await detail(user, (c3 as CustomerView).id)).customFields).toEqual({ [stays.id]: "y" });
    expect((await detail(otherOwner, foreignCustomer.id)).customFields).toEqual({ [foreign.id]: "intacto" });

    // A key volta a ficar livre.
    expect((await createField(user, { label: "Some", type: "text", key: "some_campo" })).status).toBe(201);
  });

  it("arquivar preserva o valor, que some do formulário mas volta ao reativar", async () => {
    const { user } = await freshTenant("Arquivar preserva");
    const field = await newField(user, { label: "Guardado", type: "text" });
    const { customer } = (await (await newCustomer(user, { [field.id]: "valor" })).json()) as {
      customer: CustomerView;
    };

    await patchField(user, field.id, { archived: true });
    expect((await detail(user, customer.id)).customFields).toEqual({ [field.id]: "valor" });

    // Arquivado não aceita escrita nova.
    const blocked = await patchCustomer(user, customer.id, { customFields: { [field.id]: "novo" } });
    expect(blocked.status).toBe(400);
    expect(await bodyOf(blocked)).toMatchObject({ code: "UNKNOWN_FIELD" });

    await patchField(user, field.id, { archived: false });
    expect(
      (await patchCustomer(user, customer.id, { customFields: { [field.id]: "novo" } })).status,
    ).toBe(200);
  });
});

describe("portal e LGPD", () => {
  it("o portal não devolve campos adicionais do cliente", async () => {
    const { user } = await freshTenant("Portal sem campos");
    const field = await newField(user, { label: "Interno", type: "text" });
    const email = customerEmail();
    const customer = await createCustomer(user, { email });
    await patchCustomer(user, customer.id, { customFields: { [field.id]: "SEGREDO-INTERNO" } });

    const cookie = await inviteAndEnter(user, mail, customer.id, email);
    const response = await call("GET", "/api/portal/customer", { cookie });
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).not.toContain("SEGREDO-INTERNO");
    expect(text).not.toContain("customFields");
    expect(text).not.toContain("custom_fields");
  });
});
