import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { makePlatformUser } from "./billing-helpers";
import { cleanUpPortal, createCustomer } from "./portal-helpers";
import {
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * Etiquetas e campos da plataforma (`docs/specs/crm-cadastro/spec.md`, fase A4): catálogo em
 * `/api/admin/crm/*`, anotação em `PUT /api/admin/tenants/:id/profile` e, sobretudo, a regra de
 * que nenhuma rota de tenant devolve dado da plataforma.
 */

let owner: postgres.Sql;
let platformOwner: TestUser;
let support: TestUser;
let regular: TestUser;
let tenantOwner: TestUser;
let otherOwner: TestUser;
let tenantId: string;
let otherTenantId: string;

const marker = randomUUID().slice(0, 8);
const name = (label: string) => `${label} ${marker}`;

const send = (user: TestUser, method: string, path: string, body?: unknown) =>
  call(method, path, { cookie: user.cookie, body });
const json = async <T>(response: Response) => (await response.json()) as T;

type Tag = { id: string; name: string; color: string; usage: number };
type Field = {
  id: string;
  key: string;
  label: string;
  type: string;
  entity: string;
  required: boolean;
  usage: number;
  archived: boolean;
  options: Array<{ value: string; label: string }>;
};
type Annotation = {
  tags: Array<{ id: string; name: string; color: string }>;
  customFields: Record<string, unknown>;
};

async function newTag(label: string, color?: string) {
  const response = await send(platformOwner, "POST", "/api/admin/crm/tags", {
    name: name(label),
    ...(color ? { color } : {}),
  });
  expect(response.status).toBe(201);
  return (await json<{ tag: Tag }>(response)).tag;
}

async function newField(label: string, extra: Record<string, unknown> = {}) {
  const response = await send(platformOwner, "POST", "/api/admin/crm/custom-fields", {
    entity: "organization",
    label: `${label} ${marker}`,
    type: "text",
    ...extra,
  });
  expect(response.status).toBe(201);
  return (await json<{ field: Field }>(response)).field;
}

const annotate = (id: string, body: unknown, user = platformOwner) =>
  send(user, "PUT", `/api/admin/tenants/${id}/profile`, body);

/**
 * O catálogo da plataforma é compartilhado (12 campos ativos, 100 etiquetas): cada caso começa sem
 * o que os anteriores deste arquivo criaram, e sem anotação nas duas organizações.
 */
async function resetCatalog() {
  await owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    await tx`delete from organization_profile where organization_id in (${tenantId}, ${otherTenantId})`;
    await tx`delete from tag where tenant_id is null and name like ${`% ${marker}`}`;
    await tx`delete from custom_field where tenant_id is null and label like ${`% ${marker}`}`;
  });
}

beforeAll(async () => {
  setEmailProviderForTests(createMemoryProvider());
  owner = connectOwner();

  platformOwner = await makePlatformUser(owner, "platform_owner");
  support = await makePlatformUser(owner, "platform_support");
  regular = await createUser(owner);
  tenantOwner = await createUser(owner);
  tenantId = (await createTenant(tenantOwner, "CRM Plataforma A")).id;
  otherOwner = await createUser(owner);
  otherTenantId = (await createTenant(otherOwner, "CRM Plataforma B")).id;
});

afterAll(async () => {
  setEmailProviderForTests(undefined);

  // Catálogo da plataforma (`tenant_id` nulo) não cai com o usuário: sai aqui, com o bypass.
  await owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    await tx`delete from tag where tenant_id is null and name like ${`% ${marker}`}`;
    await tx`delete from custom_field where tenant_id is null and label like ${`% ${marker}`}`;
    await tx`delete from audit_log where tenant_id is null and actor_id in (${platformOwner.id}, ${support.id})`;
  });
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner`delete from "user" where id in (${platformOwner.id}, ${support.id})`;
  await owner.end();
});

beforeEach(resetCatalog);

describe("acesso", () => {
  const writes: Array<[string, string, unknown]> = [
    ["POST", "/api/admin/crm/tags", { name: "x" }],
    ["PATCH", `/api/admin/crm/tags/${randomUUID()}`, { name: "x" }],
    ["DELETE", `/api/admin/crm/tags/${randomUUID()}`, undefined],
    ["POST", "/api/admin/crm/custom-fields", { entity: "organization", label: "x", type: "text" }],
    ["PUT", "/api/admin/crm/custom-fields/order", { entity: "organization", ids: [] }],
    ["PATCH", `/api/admin/crm/custom-fields/${randomUUID()}`, { label: "x" }],
    ["DELETE", `/api/admin/crm/custom-fields/${randomUUID()}`, { confirm: "x" }],
    ["PUT", `/api/admin/tenants/${randomUUID()}/profile`, { tagIds: [] }],
  ];
  const reads = ["/api/admin/crm/tags", "/api/admin/crm/custom-fields"];

  it("o suporte lê o catálogo e recebe 403 em toda escrita (antes de validar o corpo)", async () => {
    for (const path of reads) {
      expect((await send(support, "GET", path)).status).toBe(200);
    }

    for (const [method, path, body] of writes) {
      const response = await send(support, method, path, body ?? {});
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("quem não é da plataforma recebe 403 e quem não entrou, 401, em tudo", async () => {
    for (const path of reads) {
      expect((await send(regular, "GET", path)).status).toBe(403);
      expect((await send(tenantOwner, "GET", path)).status).toBe(403);
      expect((await call("GET", path)).status).toBe(401);
    }

    for (const [method, path, body] of writes) {
      expect((await send(tenantOwner, method, path, body ?? {})).status, `${method} ${path}`).toBe(403);
      expect((await call(method, path, { body: body ?? {} })).status, `${method} ${path}`).toBe(401);
    }
  });

  it("o suporte lê a anotação no detalhe e na lista", async () => {
    const tag = await newTag("Leitura");
    expect((await annotate(tenantId, { tagIds: [tag.id] })).status).toBe(200);

    const detail = await json<Annotation>(await send(support, "GET", `/api/admin/tenants/${tenantId}`));
    expect(detail.tags.map(({ id }) => id)).toEqual([tag.id]);

    const list = await json<{ items: Array<{ id: string; tags: Array<{ id: string }> }> }>(
      await send(support, "GET", "/api/admin/tenants?page=1"),
    );
    expect(list.items.find(({ id }) => id === tenantId)?.tags.map(({ id }) => id)).toEqual([tag.id]);

    // Limpa para não interferir nos demais casos.
    await annotate(tenantId, { tagIds: [] });
  });
});

describe("etiquetas da plataforma", () => {
  it("cria, lista por nome, renomeia e recusa nome repetido sem diferenciar maiúsculas", async () => {
    const tag = await newTag("Prioridade", "#ABC");
    expect(tag).toMatchObject({ color: "#aabbcc", usage: 0 });

    const duplicate = await send(platformOwner, "POST", "/api/admin/crm/tags", {
      name: name("PRIORIDADE"),
    });
    expect(duplicate.status).toBe(409);
    expect((await json<{ code: string }>(duplicate)).code).toBe("TAG_NAME_TAKEN");

    const renamed = await send(platformOwner, "PATCH", `/api/admin/crm/tags/${tag.id}`, {
      name: name("Prioridade alta"),
      color: "#ff0000",
    });
    expect(renamed.status).toBe(200);

    const { tags } = await json<{ tags: Tag[] }>(await send(support, "GET", "/api/admin/crm/tags"));
    expect(tags.find(({ id }) => id === tag.id)).toMatchObject({
      name: name("Prioridade alta"),
      color: "#ff0000",
    });
  });

  it("a mesma etiqueta pode existir na plataforma e no tenant (unicidade com tenant_id nulo)", async () => {
    const label = name("Dupla");
    const mine = await send(tenantOwner, "POST", "/api/tags", { name: label });
    expect(mine.status).toBe(201);

    expect(
      (await send(platformOwner, "POST", "/api/admin/crm/tags", { name: label })).status,
    ).toBe(201);
    // E dentro da plataforma segue única, mesmo com tenant_id nulo.
    expect(
      (await send(platformOwner, "POST", "/api/admin/crm/tags", { name: label.toUpperCase() })).status,
    ).toBe(409);
  });

  it("id de outro escopo é 404, nos dois sentidos", async () => {
    const mine = await json<{ tag: Tag }>(
      await send(tenantOwner, "POST", "/api/tags", { name: name("So do tenant") }),
    );
    const platform = await newTag("So da plataforma");

    expect((await send(platformOwner, "PATCH", `/api/admin/crm/tags/${mine.tag.id}`, { name: "x" })).status).toBe(404);
    expect((await send(platformOwner, "DELETE", `/api/admin/crm/tags/${mine.tag.id}`)).status).toBe(404);
    expect((await send(tenantOwner, "PATCH", `/api/tags/${platform.id}`, { name: "x" })).status).toBe(404);
    expect((await send(tenantOwner, "DELETE", `/api/tags/${platform.id}`)).status).toBe(404);
  });

  it("usage conta organization_tag e o DELETE devolve o removedFrom real", async () => {
    const tag = await newTag("Contada");
    expect((await annotate(tenantId, { tagIds: [tag.id] })).status).toBe(200);
    expect((await annotate(otherTenantId, { tagIds: [tag.id] })).status).toBe(200);

    const { tags } = await json<{ tags: Tag[] }>(await send(platformOwner, "GET", "/api/admin/crm/tags"));
    expect(tags.find(({ id }) => id === tag.id)?.usage).toBe(2);

    const removed = await send(platformOwner, "DELETE", `/api/admin/crm/tags/${tag.id}`);
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({ ok: true, removedFrom: 2 });

    const detail = await json<Annotation>(await send(platformOwner, "GET", `/api/admin/tenants/${tenantId}`));
    expect(detail.tags.map(({ id }) => id)).not.toContain(tag.id);
  });

  it("audita com prefixo admin., actor_type platform, sem tenant_id e sem nome nem cor", async () => {
    const tag = await newTag("Auditada", "#123456");
    await send(platformOwner, "PATCH", `/api/admin/crm/tags/${tag.id}`, { name: name("Auditada 2") });
    await send(platformOwner, "DELETE", `/api/admin/crm/tags/${tag.id}`);

    const rows = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ action: string; actor_type: string; tenant_id: string | null; metadata: unknown }[]>`
        select action, actor_type, tenant_id, metadata from audit_log
        where target_id = ${tag.id} order by created_at
      `;
    });

    expect(rows.map(({ action }) => action)).toEqual([
      "admin.tag_created",
      "admin.tag_updated",
      "admin.tag_deleted",
    ]);
    for (const row of rows) {
      expect(row.actor_type).toBe("platform");
      expect(row.tenant_id).toBeNull();
      expect(JSON.stringify(row.metadata)).not.toContain(marker);
      expect(JSON.stringify(row.metadata)).not.toContain("123456");
    }
  });
});

describe("campos da plataforma", () => {
  it("só a entidade organization: customer é 400 na plataforma e organization é 400 no tenant", async () => {
    const asCustomer = await send(platformOwner, "POST", "/api/admin/crm/custom-fields", {
      entity: "customer",
      label: "x",
      type: "text",
    });
    expect(asCustomer.status).toBe(400);
    expect((await json<{ code: string }>(asCustomer)).code).toBe("INVALID_ENTITY");

    const asOrganization = await send(tenantOwner, "POST", "/api/custom-fields", {
      entity: "organization",
      label: "x",
      type: "text",
    });
    expect(asOrganization.status).toBe(400);
    expect((await json<{ code: string }>(asOrganization)).code).toBe("INVALID_ENTITY");

    // O tenant nem enxerga a lista da entidade da plataforma.
    expect((await send(tenantOwner, "GET", "/api/custom-fields?entity=organization")).status).toBe(400);
  });

  it("cria, lista (padrão organization), ordena, arquiva e a key repetida é 409", async () => {
    const first = await newField("Segmento", { type: "select", options: [{ label: "SaaS" }, { label: "Varejo" }] });
    const second = await newField("Observação");
    expect(first.key).toMatch(/^segmento_/);

    const repeated = await send(platformOwner, "POST", "/api/admin/crm/custom-fields", {
      entity: "organization",
      label: "Outro",
      key: first.key,
      type: "text",
    });
    expect(repeated.status).toBe(409);
    expect((await json<{ code: string }>(repeated)).code).toBe("FIELD_KEY_TAKEN");

    const reorder = await send(platformOwner, "PUT", "/api/admin/crm/custom-fields/order", {
      entity: "organization",
      ids: [second.id, first.id],
    });
    expect(reorder.status).toBe(200);

    const listed = await json<{ fields: Field[] }>(await send(support, "GET", "/api/admin/crm/custom-fields"));
    const mine = listed.fields.filter(({ id }) => [first.id, second.id].includes(id));
    expect(mine.map(({ id }) => id)).toEqual([second.id, first.id]);
    expect(mine.every(({ entity }) => entity === "organization")).toBe(true);

    const archived = await send(platformOwner, "PATCH", `/api/admin/crm/custom-fields/${second.id}`, {
      archived: true,
    });
    expect(archived.status).toBe(200);
    const active = await json<{ fields: Field[] }>(await send(support, "GET", "/api/admin/crm/custom-fields"));
    expect(active.fields.map(({ id }) => id)).not.toContain(second.id);
  });

  it("o tenant não lista o campo da plataforma: id de campo da plataforma é 404 no tenant e vice-versa", async () => {
    const platformField = await newField("Interno");
    const tenantField = await json<{ field: Field }>(
      await send(tenantOwner, "POST", "/api/custom-fields", {
        entity: "customer",
        label: name("Do cliente"),
        type: "text",
      }),
    );

    expect((await send(tenantOwner, "PATCH", `/api/custom-fields/${platformField.id}`, { label: "x" })).status).toBe(404);
    expect(
      (await send(tenantOwner, "DELETE", `/api/custom-fields/${platformField.id}`, { confirm: platformField.key })).status,
    ).toBe(404);
    expect(
      (await send(platformOwner, "PATCH", `/api/admin/crm/custom-fields/${tenantField.field.id}`, { label: "x" })).status,
    ).toBe(404);
    expect(
      (
        await send(platformOwner, "DELETE", `/api/admin/crm/custom-fields/${tenantField.field.id}`, {
          confirm: tenantField.field.key,
        })
      ).status,
    ).toBe(404);

    const mine = await json<{ fields: Field[] }>(await send(tenantOwner, "GET", "/api/custom-fields?archived=all"));
    expect(mine.fields.map(({ id }) => id)).not.toContain(platformField.id);
  });

  it("excluir pede a key, limpa o valor em todas as organizações e devolve o clearedFrom real", async () => {
    const field = await newField("Limpavel");
    for (const id of [tenantId, otherTenantId]) {
      expect((await annotate(id, { customFields: { [field.id]: "valor" } })).status).toBe(200);
    }

    const list = await json<{ fields: Field[] }>(
      await send(platformOwner, "GET", "/api/admin/crm/custom-fields?usage=true"),
    );
    expect(list.fields.find(({ id }) => id === field.id)?.usage).toBe(2);

    const wrong = await send(platformOwner, "DELETE", `/api/admin/crm/custom-fields/${field.id}`, {
      confirm: "errada",
    });
    expect(wrong.status).toBe(400);
    expect((await json<{ code: string }>(wrong)).code).toBe("CONFIRMATION_MISMATCH");

    const removed = await send(platformOwner, "DELETE", `/api/admin/crm/custom-fields/${field.id}`, {
      confirm: field.key,
    });
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({ ok: true, clearedFrom: 2 });

    const detail = await json<Annotation>(await send(platformOwner, "GET", `/api/admin/tenants/${tenantId}`));
    expect(detail.customFields[field.id]).toBeUndefined();
  });

  it("tirar opção em uso é 409 OPTION_IN_USE (a contagem vem de organization_profile)", async () => {
    const field = await newField("Lista", { type: "select", options: [{ label: "A" }, { label: "B" }] });
    const [a, b] = field.options;
    if (!a || !b) throw new Error("opções não criadas");

    expect((await annotate(tenantId, { customFields: { [field.id]: a.value } })).status).toBe(200);

    const drop = await send(platformOwner, "PATCH", `/api/admin/crm/custom-fields/${field.id}`, {
      options: [{ value: b.value, label: b.label }],
    });
    expect(drop.status).toBe(409);
    expect((await json<{ code: string }>(drop)).code).toBe("OPTION_IN_USE");

    const ok = await send(platformOwner, "PATCH", `/api/admin/crm/custom-fields/${field.id}`, {
      options: [{ value: a.value, label: "A renomeada" }, { value: b.value, label: b.label }],
    });
    expect(ok.status).toBe(200);
  });
});

describe("anotação da organização (PUT /api/admin/tenants/:id/profile)", () => {
  it("grava etiquetas e campos, devolve a anotação e o filtro tags= acha a organização", async () => {
    const tag = await newTag("Cliente ouro");
    const other = await newTag("Outra");
    const text = await newField("Contato comercial");
    const date = await newField("Renovacao", { type: "date" });

    const saved = await annotate(tenantId, {
      tagIds: [tag.id],
      customFields: { [text.id]: "Fulana", [date.id]: "2026-12-31" },
    });
    expect(saved.status).toBe(200);
    const annotation = await json<Annotation>(saved);
    expect(annotation.tags.map(({ id }) => id)).toEqual([tag.id]);
    expect(annotation.customFields).toEqual({ [text.id]: "Fulana", [date.id]: "2026-12-31" });

    const detail = await json<Annotation & { tenant: { id: string } }>(
      await send(support, "GET", `/api/admin/tenants/${tenantId}`),
    );
    expect(detail.tags.map(({ id }) => id)).toEqual([tag.id]);
    expect(detail.customFields[text.id]).toBe("Fulana");

    const filter = async (ids: string[]) =>
      (
        await json<{ items: Array<{ id: string }>; total: number }>(
          await send(platformOwner, "GET", `/api/admin/tenants?tags=${ids.join(",")}`),
        )
      ).items.map(({ id }) => id);

    expect(await filter([tag.id])).toEqual([tenantId]);
    expect(await filter([other.id, tag.id])).toEqual([tenantId]);
    expect(await filter([other.id])).toEqual([]);

    const bad = await send(platformOwner, "GET", "/api/admin/tenants?tags=nao-e-uuid");
    expect(bad.status).toBe(400);
  });

  it("campos fazem merge por chave (null remove, ausente não muda) e etiquetas substituem o conjunto", async () => {
    const a = await newField("Campo A");
    const b = await newField("Campo B");
    const t1 = await newTag("T1");
    const t2 = await newTag("T2");

    await annotate(otherTenantId, { tagIds: [t1.id], customFields: { [a.id]: "um", [b.id]: "dois" } });
    const merged = await json<Annotation>(
      await annotate(otherTenantId, { tagIds: [t2.id], customFields: { [a.id]: null } }),
    );

    expect(merged.customFields).toEqual({ [b.id]: "dois" });
    expect(merged.tags.map(({ id }) => id)).toEqual([t2.id]);

    // Só campos: não mexe nas etiquetas. Só etiquetas: não mexe nos campos.
    const onlyFields = await json<Annotation>(await annotate(otherTenantId, { customFields: { [a.id]: "tres" } }));
    expect(onlyFields.tags.map(({ id }) => id)).toEqual([t2.id]);
    const onlyTags = await json<Annotation>(await annotate(otherTenantId, { tagIds: [] }));
    expect(onlyTags.tags).toEqual([]);
    expect(onlyTags.customFields).toEqual({ [a.id]: "tres", [b.id]: "dois" });
  });

  it("valida: corpo vazio, valor inválido, campo desconhecido ou arquivado, obrigatório", async () => {
    const number = await newField("Numero", { type: "number" });
    const archivedField = await newField("Arquivado");
    await send(platformOwner, "PATCH", `/api/admin/crm/custom-fields/${archivedField.id}`, { archived: true });

    expect((await annotate(tenantId, {})).status).toBe(400);

    const invalid = await annotate(tenantId, { customFields: { [number.id]: "abc" } });
    expect(invalid.status).toBe(400);
    expect((await json<{ code: string }>(invalid)).code).toBe("INVALID_FIELD_VALUE");

    for (const id of [randomUUID(), archivedField.id]) {
      const unknown = await annotate(tenantId, { customFields: { [id]: "x" } });
      expect(unknown.status).toBe(400);
      expect((await json<{ code: string }>(unknown)).code).toBe("UNKNOWN_FIELD");
    }

    const mandatory = await newField("Obrigatorio", { required: true });
    const missing = await annotate(tenantId, { customFields: { [number.id]: 1 } });
    expect(missing.status).toBe(400);
    expect((await json<{ code: string }>(missing)).code).toBe("FIELD_REQUIRED");
    expect((await annotate(tenantId, { customFields: { [number.id]: 1, [mandatory.id]: "ok" } })).status).toBe(200);
    // Esvaziar o obrigatório de novo é recusado (o estado final vale).
    expect((await annotate(tenantId, { customFields: { [mandatory.id]: null } })).status).toBe(400);
    // Fica opcional para os demais casos.
    await send(platformOwner, "PATCH", `/api/admin/crm/custom-fields/${mandatory.id}`, { required: false });
  });

  it("etiqueta de tenant, etiqueta inexistente e organização inexistente ou em exclusão são 404", async () => {
    const mine = await json<{ tag: Tag }>(
      await send(tenantOwner, "POST", "/api/tags", { name: name("Do tenant A") }),
    );
    const platform = await newTag("Valida");

    const wrongScope = await annotate(tenantId, { tagIds: [mine.tag.id] });
    expect(wrongScope.status).toBe(404);
    const ghostTag = await annotate(tenantId, { tagIds: [randomUUID()] });
    expect(ghostTag.status).toBe(404);
    // Mesma resposta para os dois: não diz qual.
    expect(await json(wrongScope)).toEqual(await json(ghostTag));

    const ghostOrg = await annotate(randomUUID(), { tagIds: [platform.id] });
    expect(ghostOrg.status).toBe(404);

    await owner`update organization set status = 'deleting' where id = ${otherTenantId}`;
    try {
      const deleting = await annotate(otherTenantId, { tagIds: [platform.id] });
      expect(deleting.status).toBe(404);
      expect(await json(deleting)).toEqual(await json(ghostOrg));
    } finally {
      await owner`update organization set status = 'active' where id = ${otherTenantId}`;
    }
  });

  it("limite de 20 etiquetas por organização e id repetido vira um só", async () => {
    const tag = await newTag("Repetida");
    const response = await annotate(tenantId, { tagIds: [tag.id, tag.id] });
    expect(response.status).toBe(200);
    expect((await json<Annotation>(response)).tags).toHaveLength(1);

    const many = Array.from({ length: 21 }, () => randomUUID());
    expect((await annotate(tenantId, { tagIds: many })).status).toBe(400);
  });

  it("audita admin.tenant_profile_updated sem tenant_id e sem nome, rótulo nem valor", async () => {
    const tag = await newTag("Para auditoria");
    const field = await newField("Valor secreto");
    await annotate(tenantId, { tagIds: [tag.id], customFields: { [field.id]: "SEGREDO-DO-VALOR" } });

    const rows = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ tenant_id: string | null; actor_type: string; target_id: string; metadata: unknown }[]>`
        select tenant_id, actor_type, target_id, metadata from audit_log
        where action = 'admin.tenant_profile_updated' and target_id = ${tenantId}
        order by created_at desc limit 1
      `;
    });

    const [row] = rows;
    expect(row).toMatchObject({ tenant_id: null, actor_type: "platform", target_id: tenantId });
    const text = JSON.stringify(row?.metadata);
    expect(text).not.toContain("SEGREDO-DO-VALOR");
    expect(text).not.toContain(marker);
    expect(text).toContain(field.id);
  });

  it("a exclusão da organização leva a anotação junto", async () => {
    const tag = await newTag("Some junto");
    const field = await newField("Some junto 2");
    const doomedOwner = await createUser(owner);
    const doomed = (await createTenant(doomedOwner, "CRM Excluida")).id;
    await annotate(doomed, { tagIds: [tag.id], customFields: { [field.id]: "x" } });

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from organization where id = ${doomed}`;
      expect(await tx`select 1 from organization_tag where organization_id = ${doomed}`).toHaveLength(0);
      expect(await tx`select 1 from organization_profile where organization_id = ${doomed}`).toHaveLength(0);
    });
  });
});

describe("nenhuma rota de tenant devolve dado da plataforma", () => {
  it("acme.owner não vê etiqueta, campo nem valor que a plataforma anotou sobre a organização", async () => {
    const tag = await newTag("Inadimplente em potencial");
    const field = await newField("Nota interna");
    const secret = `SEGREDO-${marker}`;
    expect(
      (await annotate(tenantId, { tagIds: [tag.id], customFields: { [field.id]: secret } })).status,
    ).toBe(200);

    // Um cliente do tenant, para a listagem de clientes também entrar na prova.
    await createCustomer(tenantOwner);

    const paths = [
      "/api/tenant",
      "/api/me",
      "/api/tags",
      "/api/custom-fields",
      "/api/custom-fields?archived=all&usage=true",
      "/api/customers",
      "/api/audit",
      "/api/team",
      "/api/roles",
    ];
    const forbidden = [tag.id, tag.name, field.id, field.key, field.label, secret, "organization_tag", "organizationTag", "organization_profile"];

    for (const path of paths) {
      const response = await send(tenantOwner, "GET", path);
      expect([200, 403], `${path}`).toContain(response.status);
      const text = await response.text();
      for (const value of forbidden) {
        expect(text, `${path} vazou ${value}`).not.toContain(value);
      }
    }

    // O catálogo do tenant só tem o que o tenant criou; a etiqueta da plataforma não está lá.
    const mine = await json<{ tags: Tag[] }>(await send(tenantOwner, "GET", "/api/tags"));
    expect(mine.tags.map(({ id }) => id)).not.toContain(tag.id);
  });

  it("o tenant não escreve nas rotas da plataforma, nem pelo caminho do tenant", async () => {
    const tag = await newTag("Intocavel");
    expect((await send(tenantOwner, "PUT", `/api/admin/tenants/${tenantId}/profile`, { tagIds: [] })).status).toBe(403);
    // Aplicar etiqueta da plataforma em cliente do tenant: 404, sem dizer que ela existe.
    const customer = (await createCustomer(tenantOwner)) as { id: string };
    expect((await send(tenantOwner, "PUT", `/api/customers/${customer.id}/tags/${tag.id}`)).status).toBe(404);
    const viaBody = await send(tenantOwner, "PATCH", `/api/customers/${customer.id}`, { tagIds: [tag.id] });
    expect(viaBody.status).toBe(404);
  });
});
