import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import type { ImportBatchResponse, ImportRowInput } from "@/lib/schemas/customer-import";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { phoneValues } from "@/lib/phone/columns";
import {
  asPlatform,
  cleanUpBilling,
  createPlanRow,
  ensureSubscription,
} from "./billing-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, customerEmail } from "./portal-helpers";
import {
  addMember,
  APP_ORIGIN,
  call,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * Importação de clientes (bloco I, I2): `POST /api/customers/import` e `GET .../quota`. Cada
 * linha passa pelas regras do cadastro; duplicada nunca atualiza; o limite do plano para o lote
 * no meio, mesmo com lotes e cadastros manuais simultâneos.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;

beforeAll(() => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await cleanUpBilling(owner);
  await owner.end();
});

/** Organização com um plano de limites dados; sem `limits`, um plano que não limita nada. */
async function tenantWith(limits: Record<string, number | null> = {}) {
  const boss = await createUser(owner);
  const tenant = await createTenant(boss);
  const plan = await createPlanRow(owner, { isFree: false, limits });
  await ensureSubscription(owner, tenant.id, plan.id);
  return { boss, tenant };
}

const row = (extra: Partial<ImportRowInput> = {}): ImportRowInput => ({
  sourceRow: 2,
  phone: uniquePhone(),
  tags: [],
  ...extra,
});

/** `n` linhas distintas, numeradas a partir da linha 2. */
const rows = (n: number, extra: (i: number) => Partial<ImportRowInput> = () => ({})) =>
  Array.from({ length: n }, (_, i) =>
    row({ sourceRow: i + 2, name: `Cliente ${i}`, email: customerEmail(), ...extra(i) }),
  );

const importRows = (user: TestUser, body: ImportRowInput[]) =>
  call("POST", "/api/customers/import", { cookie: user.cookie, body: { rows: body } });

async function ok(response: Response | Promise<Response>) {
  const res = await response;
  expect(res.status).toBe(200);
  return (await res.json()) as ImportBatchResponse;
}

const statusesOf = (result: ImportBatchResponse) => result.results.map((r) => r.status);

const customersOf = async (tenantId: string) => {
  const [found] = await asPlatform(
    owner,
    (tx) => tx<{ total: number }[]>`select count(*)::int as total from customer where tenant_id = ${tenantId}`,
  );
  return found?.total ?? 0;
};

const customerBy = async (tenantId: string, phone: string) => {
  const [found] = await asPlatform(
    owner,
    (tx) =>
      tx<
        {
          id: string;
          name: string;
          email: string | null;
          status: string;
          user_id: string | null;
          phone_verified_via: string | null;
          phone_verified_at: Date | null;
          notes: string | null;
        }[]
      >`select id, name, email, status, user_id, phone_verified_via, phone_verified_at, notes
        from customer where tenant_id = ${tenantId} and phone_key = ${phoneValues(phone).phoneKey}`,
  );
  return found;
};

const tagNamesOf = async (customerId: string) =>
  (
    await asPlatform(
      owner,
      (tx) =>
        tx<{ name: string }[]>`select t.name from customer_tag ct join tag t on t.id = ct.tag_id
          where ct.customer_id = ${customerId} order by t.name`,
    )
  ).map(({ name }) => name);

async function setUserPhone(user: TestUser, phone: string, verified: boolean) {
  const values = phoneValues(phone);
  await owner`
    update "user" set
      phone = ${values.phone}, phone_normalized = ${values.phoneNormalized}, phone_key = ${values.phoneKey},
      phone_verified_at = ${verified ? new Date() : null},
      phone_verified_via = ${verified ? "manual" : null}
    where id = ${user.id}
  `;
}

describe("permissão e isolamento", () => {
  it("exige customer:create, em quota e em importação; owner e membro passam", async () => {
    const { boss, tenant } = await tenantWith();
    const reader = await createUser(owner);
    await createRole(boss, "Leitor", ["customer:read"]);
    await addMember(owner, tenant.id, reader, "Leitor");
    const member = await createUser(owner);
    await addMember(owner, tenant.id, member, "member");

    for (const user of [reader]) {
      const quota = await call("GET", "/api/customers/import/quota", { cookie: user.cookie });
      expect(quota.status).toBe(403);
      expect((await quota.json()).code).toBe("PERMISSION_DENIED");
      const sent = await importRows(user, [row()]);
      expect(sent.status).toBe(403);
      expect((await sent.json()).code).toBe("PERMISSION_DENIED");
    }
    expect(await customersOf(tenant.id)).toBe(0);

    expect(statusesOf(await ok(importRows(boss, [row()])))).toEqual(["created"]);
    expect(statusesOf(await ok(importRows(member, [row()])))).toEqual(["created"]);
  });

  it("sem sessão, 401; de outra origem, 403", async () => {
    expect((await call("POST", "/api/customers/import", { body: { rows: [row()] } })).status).toBe(401);
    expect((await call("GET", "/api/customers/import/quota")).status).toBe(401);

    const { boss } = await tenantWith();
    const foreign = await call("POST", "/api/customers/import", {
      cookie: boss.cookie,
      body: { rows: [row()] },
      origin: "https://outro-site.example",
    });
    expect(foreign.status).toBe(403);
  });

  it("o mesmo telefone em duas organizações cria as duas fichas; uma nunca vê a outra", async () => {
    const a = await tenantWith();
    const b = await tenantWith();
    const phone = uniquePhone();

    expect(statusesOf(await ok(importRows(a.boss, [row({ phone, name: "Da A" })])))).toEqual(["created"]);
    expect(statusesOf(await ok(importRows(b.boss, [row({ phone, name: "Da B" })])))).toEqual(["created"]);
    // Dentro da A, o número já existe; a ficha da B não conta.
    expect(statusesOf(await ok(importRows(a.boss, [row({ phone })])))).toEqual(["duplicate"]);

    expect((await customerBy(a.tenant.id, phone))?.name).toBe("Da A");
    expect((await customerBy(b.tenant.id, phone))?.name).toBe("Da B");
  });
});

describe("resultado de cada linha", () => {
  it("created, duplicate (base e arquivo), invalid (telefone, e-mail, nome) e o motivo", async () => {
    const { boss, tenant } = await tenantWith();
    const existing = uniquePhone();
    await ok(importRows(boss, [row({ phone: existing, name: "Existente", email: "existente@exemplo.com" })]));

    const fresh = uniquePhone();
    const result = await ok(
      importRows(boss, [
        row({ sourceRow: 2, phone: fresh, name: "Nova" }),
        row({ sourceRow: 3, phone: existing }), // já é de outra ficha
        row({ sourceRow: 4, phone: fresh }), // repete a linha 2 no mesmo lote
        row({ sourceRow: 5, phone: "5510987654321" }), // DDD inexistente
        row({ sourceRow: 6, phone: "" }),
        row({ sourceRow: 7, email: "não-é-email" }),
        row({ sourceRow: 8, name: "A" }),
        row({ sourceRow: 9, email: "existente@exemplo.com" }), // e-mail de outra ficha
      ]),
    );

    expect(result.results.map((r) => [r.sourceRow, r.status])).toEqual([
      [2, "created"],
      [3, "duplicate"],
      [4, "duplicate"],
      [5, "invalid"],
      [6, "invalid"],
      [7, "invalid"],
      [8, "invalid"],
      [9, "invalid"],
    ]);
    expect(result.results[1]?.reason).toBe("Este telefone já está cadastrado.");
    expect(result.results[2]?.reason).toBe("Telefone repetido no arquivo.");
    expect(result.results[3]?.reason).toBe("DDD inexistente.");
    expect(result.results[7]?.reason).toBe("Já existe um cliente com este e-mail.");
    expect(result.counts).toEqual({ created: 1, duplicate: 2, invalid: 5, limit: 0 });
    expect(await customersOf(tenant.id)).toBe(2);
  });

  it("o resultado nunca repete nome, e-mail ou telefone da linha", async () => {
    const { boss } = await tenantWith();
    const result = await ok(
      importRows(boss, [
        row({ name: "Nome-Secreto", email: "email-secreto@x", phone: "5510987654321" }),
        row({ name: "A", email: "dado-pessoal@exemplo.com" }),
      ]),
    );
    const text = JSON.stringify(result);
    for (const secret of ["Nome-Secreto", "email-secreto", "dado-pessoal", "10987654321"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a ficha criada é a do cadastro: lead, telefone confirmado pela equipe, sem link nem pedido", async () => {
    const { boss, tenant } = await tenantWith();
    const phone = uniquePhone();
    const before = await asPlatform(owner, (tx) => tx`select count(*)::int as n from phone_verification`);

    await ok(
      importRows(boss, [
        row({ phone, name: "Maria Souza", email: "Maria@Exemplo.com", document: "123", notes: "Obs" }),
      ]),
    );

    expect(await customerBy(tenant.id, phone)).toMatchObject({
      name: "Maria Souza",
      email: "maria@exemplo.com",
      status: "lead",
      phone_verified_via: "team",
      notes: "Obs",
      user_id: null,
    });
    const after = await asPlatform(owner, (tx) => tx`select count(*)::int as n from phone_verification`);
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(mail.sent.some((message) => message.to === "maria@exemplo.com")).toBe(false);
  });

  it("sem nome, o telefone formatado vira o nome", async () => {
    const { boss, tenant } = await tenantWith();
    await ok(importRows(boss, [row({ phone: "11987654321" })]));
    expect((await customerBy(tenant.id, "11987654321"))?.name).toBe("+55 (11) 98765-4321");
  });

  it("duplicada nunca atualiza a ficha existente (nome, e-mail, observação e etiquetas)", async () => {
    const { boss, tenant } = await tenantWith();
    const phone = uniquePhone();
    await ok(importRows(boss, [row({ phone, name: "Original", email: "original@exemplo.com", notes: "antes", tags: ["a"] })]));
    const before = await customerBy(tenant.id, phone);

    const result = await ok(
      importRows(boss, [
        row({ phone: phone.replace(/^11/, "(11) "), name: "Novo Nome", email: "novo@exemplo.com", notes: "depois", tags: ["b"] }),
      ]),
    );
    expect(statusesOf(result)).toEqual(["duplicate"]);

    const after = await customerBy(tenant.id, phone);
    expect(after).toEqual(before);
    expect(await tagNamesOf(after?.id ?? "")).toEqual(["a"]);
    expect(await customersOf(tenant.id)).toBe(1);
  });

  it("o mesmo número com e sem o 9º dígito é duplicata (phone_key)", async () => {
    const { boss, tenant } = await tenantWith();
    await ok(importRows(boss, [row({ phone: "11987654321" })]));
    const result = await ok(importRows(boss, [row({ phone: "1187654321" })]));
    expect(statusesOf(result)).toEqual(["duplicate"]);
    expect(await customersOf(tenant.id)).toBe(1);
  });

  it("texto com NUL é `invalid` e não derruba o resto do lote", async () => {
    const { boss, tenant } = await tenantWith();
    const result = await ok(
      importRows(boss, [row({ name: "Com\u0000NUL" }), row({ name: "Normal" }), row({ tags: ["a\u0000b"] })]),
    );
    expect(statusesOf(result)).toEqual(["invalid", "created", "invalid"]);
    expect(await customersOf(tenant.id)).toBe(1);
  });

  it("500 linhas num lote, e o 501º recusa o pedido inteiro", async () => {
    const { boss, tenant } = await tenantWith();
    const result = await ok(importRows(boss, rows(500)));
    expect(result.counts.created).toBe(500);
    expect(await customersOf(tenant.id)).toBe(500);

    const tooMany = await importRows(boss, rows(501));
    expect(tooMany.status).toBe(400);
    expect((await call("POST", "/api/customers/import", { cookie: boss.cookie, body: { rows: [] } })).status).toBe(400);
    expect(await customersOf(tenant.id)).toBe(500);
  });

  it("corpo fora do contrato é 400 e não grava nada: campo estranho, texto enorme, tipo errado", async () => {
    const { boss, tenant } = await tenantWith();
    const post = (rowsBody: unknown) =>
      call("POST", "/api/customers/import", { cookie: boss.cookie, body: { rows: rowsBody } });

    expect((await post([{ ...row(), status: "active" }])).status).toBe(400);
    expect((await post([{ ...row(), userId: "x" }])).status).toBe(400);
    expect((await post([row({ notes: "x".repeat(2_001) })])).status).toBe(400);
    expect((await post([{ ...row(), tags: "vip" }])).status).toBe(400);
    expect((await post([{ ...row(), sourceRow: "2" }])).status).toBe(400);
    expect((await call("POST", "/api/customers/import", { cookie: boss.cookie, body: { rows: [row()], extra: 1 } })).status).toBe(400);
    expect(await customersOf(tenant.id)).toBe(0);
  });

  it("corpo acima do teto da rota é 413, e o das outras rotas de cliente segue em 16 KB", async () => {
    const { boss } = await tenantWith();
    const send = (path: string, bytes: number) =>
      api.request(path, {
        method: "POST",
        headers: {
          Origin: APP_ORIGIN,
          Cookie: boss.cookie,
          "Content-Type": "application/json",
          "Content-Length": String(bytes),
          "X-Forwarded-For": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        },
        body: JSON.stringify({ pad: "x".repeat(bytes) }),
      });

    expect((await send("/api/customers/import", 6 * 1024 * 1024)).status).toBe(413);
    // Dentro do teto da importação, passa pelo limite de corpo e cai na validação.
    expect((await send("/api/customers/import", 100 * 1024)).status).toBe(400);
    expect((await send("/api/customers", 100 * 1024)).status).toBe(413);
  });
});

describe("limite do plano", () => {
  it("a quota devolve as vagas, e sem limite devolve null", async () => {
    const limited = await tenantWith({ customers: 5 });
    await ok(importRows(limited.boss, rows(2)));
    const quota = await call("GET", "/api/customers/import/quota", { cookie: limited.boss.cookie });
    expect(await quota.json()).toEqual({ limit: 5, used: 2, available: 3 });

    const free = await tenantWith();
    const unlimited = await call("GET", "/api/customers/import/quota", { cookie: free.boss.cookie });
    expect(await unlimited.json()).toEqual({ limit: null, used: 0, available: null });
  });

  it("para no meio do lote: as primeiras entram, as demais saem `limit`, em ordem", async () => {
    const { boss, tenant } = await tenantWith({ customers: 3 });
    await ok(importRows(boss, rows(1)));

    const result = await ok(importRows(boss, rows(5)));
    expect(statusesOf(result)).toEqual(["created", "created", "limit", "limit", "limit"]);
    expect(result.counts).toEqual({ created: 2, duplicate: 0, invalid: 0, limit: 3 });
    expect(result.results[2]?.reason).toBeUndefined();
    expect(await customersOf(tenant.id)).toBe(3);

    // Plano cheio: tudo o que seria criado sai `limit`; o que já é duplicata ou inválido segue sendo isso.
    const existing = (await asPlatform(owner, (tx) => tx<{ phone: string }[]>`select phone from customer where tenant_id = ${tenant.id} limit 1`))[0]?.phone ?? "";
    const full = await ok(importRows(boss, [row(), row({ phone: existing }), row({ phone: "" }), row()]));
    expect(statusesOf(full)).toEqual(["limit", "duplicate", "invalid", "limit"]);
    expect(await customersOf(tenant.id)).toBe(3);
  });

  it("o limite vale entre lotes seguidos (o segundo já enxerga o primeiro)", async () => {
    const { boss, tenant } = await tenantWith({ customers: 4 });
    expect((await ok(importRows(boss, rows(3)))).counts.created).toBe(3);
    const second = await ok(importRows(boss, rows(3)));
    expect(second.counts).toMatchObject({ created: 1, limit: 2 });
    expect(await customersOf(tenant.id)).toBe(4);
  });

  it("duas importações simultâneas nunca passam do limite", async () => {
    const { boss, tenant } = await tenantWith({ customers: 7 });
    const results = await Promise.all([
      ok(importRows(boss, rows(5))),
      ok(importRows(boss, rows(5))),
      ok(importRows(boss, rows(5))),
    ]);

    const created = results.reduce((sum, r) => sum + r.counts.created, 0);
    expect(created).toBe(7);
    expect(await customersOf(tenant.id)).toBe(7);
    expect(results.reduce((sum, r) => sum + r.counts.limit, 0)).toBe(15 - 7);
  });

  it("lotes e cadastros manuais no meio: o total nunca passa do limite e cada resposta confere", async () => {
    const { boss, tenant } = await tenantWith({ customers: 6 });
    const manual = Array.from({ length: 4 }, () =>
      call("POST", "/api/customers", {
        cookie: boss.cookie,
        body: { name: "Manual", email: customerEmail(), phone: uniquePhone() },
      }),
    );

    const [a, b, ...made] = await Promise.all([
      ok(importRows(boss, rows(4))),
      ok(importRows(boss, rows(4))),
      ...manual,
    ]);

    const manualCreated = made.filter((response) => response.status === 201).length;
    const manualRefused = made.filter((response) => response.status === 403);
    for (const response of manualRefused) {
      expect((await response.json()).code).toBe("PLAN_LIMIT_REACHED");
    }

    const total = await customersOf(tenant.id);
    expect(total).toBe(6);
    expect(a.counts.created + b.counts.created + manualCreated).toBe(6);
    expect(manualCreated + manualRefused.length).toBe(4);
  });

  it("a trava de uma organização não segura a importação de outra", async () => {
    const full = await tenantWith({ customers: 1 });
    const other = await tenantWith({ customers: 100 });
    await ok(importRows(full.boss, rows(1)));

    const [refused, accepted] = await Promise.all([
      ok(importRows(full.boss, rows(3))),
      ok(importRows(other.boss, rows(3))),
    ]);
    expect(refused.counts.limit).toBe(3);
    expect(accepted.counts.created).toBe(3);
  });

  it("modo somente leitura recusa a importação (como o cadastro), mas a quota segue lendo", async () => {
    const { boss, tenant } = await tenantWith();
    await owner`update organization set access_mode = 'read_only' where id = ${tenant.id}`;

    const sent = await importRows(boss, [row()]);
    expect(sent.status).toBe(403);
    expect((await sent.json()).code).toBe("TENANT_READ_ONLY");
    const manual = await call("POST", "/api/customers", {
      cookie: boss.cookie,
      body: { name: "Manual", phone: uniquePhone() },
    });
    expect(manual.status).toBe(403);

    expect((await call("GET", "/api/customers/import/quota", { cookie: boss.cookie })).status).toBe(200);
    expect(await customersOf(tenant.id)).toBe(0);
  });

  it("organização suspensa não importa", async () => {
    const { boss, tenant } = await tenantWith();
    await owner`update organization set status = 'suspended' where id = ${tenant.id}`;
    const response = await importRows(boss, [row()]);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("TENANT_SUSPENDED");
  });
});

describe("etiquetas", () => {
  const tagIdsOf = async (tenantId: string) =>
    (
      await asPlatform(
        owner,
        (tx) => tx<{ name: string }[]>`select name from tag where tenant_id = ${tenantId} order by name`,
      )
    ).map(({ name }) => name);

  it("liga as que existem (sem diferenciar a caixa) e cria as novas para quem gerencia etiquetas", async () => {
    const { boss, tenant } = await tenantWith();
    const created = await call("POST", "/api/tags", { cookie: boss.cookie, body: { name: "VIP" } });
    expect(created.status).toBe(201);

    const phone = uniquePhone();
    const result = await ok(importRows(boss, [row({ phone, tags: ["vip", "Lead", "lead", "  Novo  Cliente "] })]));

    expect(result.tags).toEqual({ created: 2, ignored: 0, ignoredReason: null });
    expect(await tagIdsOf(tenant.id)).toEqual(["Lead", "Novo Cliente", "VIP"]);
    const customerRow = await customerBy(tenant.id, phone);
    expect(await tagNamesOf(customerRow?.id ?? "")).toEqual(["Lead", "Novo Cliente", "VIP"]);
  });

  it("sem tag:manage, as novas são ignoradas com aviso, as existentes ligam e a ficha entra", async () => {
    const { boss, tenant } = await tenantWith();
    await call("POST", "/api/tags", { cookie: boss.cookie, body: { name: "VIP" } });
    const member = await createUser(owner);
    await addMember(owner, tenant.id, member, "member");

    const phone = uniquePhone();
    const result = await ok(importRows(member, [row({ phone, tags: ["VIP", "Inexistente", "Outra"] })]));

    expect(statusesOf(result)).toEqual(["created"]);
    expect(result.tags).toEqual({ created: 0, ignored: 2, ignoredReason: "no_permission" });
    expect(await tagIdsOf(tenant.id)).toEqual(["VIP"]);
    expect(await tagNamesOf((await customerBy(tenant.id, phone))?.id ?? "")).toEqual(["VIP"]);
  });

  it("respeita o teto de 100 etiquetas por organização", async () => {
    const { boss, tenant } = await tenantWith();
    await asPlatform(
      owner,
      (tx) =>
        tx`insert into tag (tenant_id, name) select ${tenant.id}, 'pre-' || g from generate_series(1, 99) g`,
    );

    const phone = uniquePhone();
    const result = await ok(importRows(boss, [row({ phone, tags: ["nova-1", "nova-2", "nova-3"] })]));

    expect(result.tags).toEqual({ created: 1, ignored: 2, ignoredReason: "tag_limit" });
    expect(await tagIdsOf(tenant.id)).toHaveLength(100);
    expect(await tagNamesOf((await customerBy(tenant.id, phone))?.id ?? "")).toEqual(["nova-1"]);
  });

  it("linha com mais de 20 etiquetas, ou etiqueta de mais de 40 caracteres, é inválida e não cria etiqueta", async () => {
    const { boss, tenant } = await tenantWith();
    const result = await ok(
      importRows(boss, [
        row({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
        row({ tags: ["x".repeat(41)] }),
      ]),
    );
    expect(statusesOf(result)).toEqual(["invalid", "invalid"]);
    expect(await tagIdsOf(tenant.id)).toEqual([]);
  });

  it("não cria etiqueta para linha que não entra (plano cheio)", async () => {
    const { boss, tenant } = await tenantWith({ customers: 1 });
    await ok(importRows(boss, rows(1)));
    const result = await ok(importRows(boss, [row({ tags: ["so-para-quem-entra"] })]));
    expect(statusesOf(result)).toEqual(["limit"]);
    expect(await tagIdsOf(tenant.id)).toEqual([]);
  });

  it("etiqueta nunca atravessa organizações", async () => {
    const a = await tenantWith();
    const b = await tenantWith();
    await call("POST", "/api/tags", { cookie: a.boss.cookie, body: { name: "Só da A" } });
    const result = await ok(importRows(b.boss, [row({ tags: ["Só da A"] })]));
    expect(result.tags.created).toBe(1);
    expect(await tagIdsOf(a.tenant.id)).toEqual(["Só da A"]);
    expect(await tagIdsOf(b.tenant.id)).toEqual(["Só da A"]);
  });
});

describe("pessoa da equipe que também é cliente (D-9)", () => {
  it("liga pelo telefone confirmado da pessoa, e o resultado avisa", async () => {
    const { boss, tenant } = await tenantWith();
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    const phone = uniquePhone();
    await setUserPhone(person, phone, true);

    const result = await ok(importRows(boss, [row({ phone, name: "Colega" })]));

    expect(result.results[0]).toMatchObject({ status: "created", teamLinked: true });
    expect(result.teamLinked).toBe(1);
    expect((await customerBy(tenant.id, phone))?.user_id).toBe(person.id);
    const audits = await asPlatform(
      owner,
      (tx) =>
        tx<{ metadata: Record<string, unknown> }[]>`select metadata from audit_log
          where tenant_id = ${tenant.id} and action = 'customer.team_linked'`,
    );
    expect(audits.map((a) => a.metadata)).toEqual([{ userId: person.id, via: "imported" }]);
  });

  it("telefone não confirmado da pessoa não liga; o e-mail nunca liga", async () => {
    const { boss, tenant } = await tenantWith();
    const pending = await createUser(owner);
    await addMember(owner, tenant.id, pending, "member");
    const pendingPhone = uniquePhone();
    await setUserPhone(pending, pendingPhone, false);

    const confirmed = await createUser(owner);
    await addMember(owner, tenant.id, confirmed, "member");
    await setUserPhone(confirmed, uniquePhone(), true);
    const other = uniquePhone();

    const result = await ok(
      importRows(boss, [
        row({ phone: pendingPhone }),
        // O e-mail da pessoa confirmada, com outro telefone: não liga.
        row({ phone: other, email: confirmed.email }),
      ]),
    );

    expect(statusesOf(result)).toEqual(["created", "created"]);
    expect(result.teamLinked).toBe(0);
    expect((await customerBy(tenant.id, pendingPhone))?.user_id).toBeNull();
    expect((await customerBy(tenant.id, other))?.user_id).toBeNull();
  });

  it("quem já tem ficha não ganha outra ligação (a segunda ficha com o mesmo número é duplicata)", async () => {
    const { boss, tenant } = await tenantWith();
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    const phone = uniquePhone();
    await setUserPhone(person, phone, true);

    await ok(importRows(boss, [row({ phone })]));
    const again = await ok(importRows(boss, [row({ phone })]));
    expect(statusesOf(again)).toEqual(["duplicate"]);
    expect(await customersOf(tenant.id)).toBe(1);
  });

  it("pessoa de outra organização com o mesmo telefone não liga", async () => {
    const { boss, tenant } = await tenantWith();
    const stranger = await tenantWith();
    const phone = uniquePhone();
    await setUserPhone(stranger.boss, phone, true);

    const result = await ok(importRows(boss, [row({ phone })]));
    expect(result.teamLinked).toBe(0);
    expect((await customerBy(tenant.id, phone))?.user_id).toBeNull();
  });
});

describe("auditoria e abuso", () => {
  it("customer.imported leva só contagens: nenhum nome, telefone ou e-mail", async () => {
    const { boss, tenant } = await tenantWith({ customers: 3 });
    const phone = uniquePhone();
    await ok(
      importRows(boss, [
        row({ phone, name: "Auditada Silva", email: "auditada@exemplo.com" }),
        ...rows(4),
        row({ phone: "" }),
      ]),
    );

    const events = await asPlatform(
      owner,
      (tx) =>
        tx<{ metadata: Record<string, unknown>; actor_id: string; target_id: string | null; ip_hash: string | null }[]>`
          select metadata, actor_id, target_id, ip_hash from audit_log
          where tenant_id = ${tenant.id} and action = 'customer.imported'`,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({
      rows: 6,
      created: 3,
      duplicate: 0,
      invalid: 1,
      limit: 2,
      teamLinked: 0,
      tagsCreated: 0,
      tagsIgnored: 0,
    });
    expect(events[0]?.actor_id).toBe(boss.id);
    const text = JSON.stringify(events);
    for (const secret of ["Auditada", "auditada@", phone, phoneValues(phone).phoneNormalized]) {
      expect(text).not.toContain(secret);
    }
  });

  it("não audita o pedido em que nada foi criado", async () => {
    const { boss, tenant } = await tenantWith();
    await ok(importRows(boss, [row({ phone: "" })]));
    const [count] = await asPlatform(
      owner,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from audit_log where tenant_id = ${tenant.id} and action = 'customer.imported'`,
    );
    expect(count?.n).toBe(0);
  });

  it("limita os pedidos por pessoa e organização: o 41º em 10 minutos é 429", async () => {
    const { boss } = await tenantWith();
    // Linha inválida: não grava, mas conta no limite.
    const small = [row({ phone: "" })];
    for (let i = 0; i < 40; i++) {
      const response = await importRows(boss, small);
      expect(response.status).toBe(200);
    }
    const blocked = await importRows(boss, small);
    expect(blocked.status).toBe(429);

    // Outra pessoa da mesma organização tem o próprio contador; o limite é só da importação.
    const colleague = await createUser(owner);
    await addMember(owner, (await owner<{ organization_id: string }[]>`select organization_id from member where user_id = ${boss.id} limit 1`)[0]?.organization_id ?? "", colleague, "member");
    expect((await importRows(colleague, small)).status).toBe(200);
    expect((await call("GET", "/api/customers", { cookie: boss.cookie })).status).toBe(200);
  });
});
