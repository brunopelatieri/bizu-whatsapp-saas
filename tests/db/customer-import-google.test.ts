import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import {
  type SheetFetchDeps,
  setSheetFetchDepsForTests,
  type TransportRequest,
  type UpstreamResponse,
} from "@/lib/spreadsheet/google-sheets-fetch.server";
import { asPlatform, cleanUpBilling, createPlanRow, ensureSubscription } from "./billing-helpers";
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
 * Importação pelo link do Google Planilhas (bloco I, I3): `POST /api/customers/import/google-sheets`.
 * A rede é falsa (`setSheetFetchDepsForTests`): o teste diz o que o "Google" responde e confere o que
 * o servidor pediu. A guarda em si (lista de hosts, IPs, tetos) tem os testes de
 * `src/lib/spreadsheet/google-sheets-fetch.server.test.ts`; aqui, a rota e a cadeia de guardas.
 */

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const LINK = `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`;
const CSV = "telefone;nome\n11987654321;Maria Fictícia\n";
const PATH = "/api/customers/import/google-sheets";

type Mode = "ok" | "private" | "html";
let mode: Mode = "ok";
const requests: TransportRequest[] = [];

function reply(status: number, headers: Record<string, string>, body = ""): UpstreamResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    header: (name) => lower[name.toLowerCase()],
    body: (async function* () {
      if (body) yield new TextEncoder().encode(body);
    })(),
    close: () => undefined,
  };
}

const deps: SheetFetchDeps = {
  resolve: async () => [{ address: "142.250.219.225", family: 4 }],
  transport: async (request) => {
    requests.push(request);
    if (request.url.hostname === "docs.google.com") {
      if (mode === "private") return reply(302, { Location: "https://accounts.google.com/ServiceLogin?continue=x" });
      return reply(307, {
        Location: `https://doc-08-4o-sheets.googleusercontent.com/export/a/b/1/2/*/${ID}?format=csv&gid=0`,
      });
    }
    if (mode === "html") return reply(200, { "Content-Type": "text/html" }, "<script>alert(1)</script>");
    return reply(200, { "Content-Type": "text/csv; charset=utf-8" }, CSV);
  },
  totalTimeoutMs: 5_000,
  connectTimeoutMs: 1_000,
  maxBytes: 10 * 1024 * 1024,
};

let owner: postgres.Sql;

beforeAll(() => {
  owner = connectOwner();
  setSheetFetchDepsForTests(deps);
});

beforeEach(() => {
  mode = "ok";
  requests.length = 0;
});

afterAll(async () => {
  setSheetFetchDepsForTests(undefined);
  await cleanUp(owner);
  await cleanUpBilling(owner);
  await owner.end();
});

async function tenantWith() {
  const boss = await createUser(owner);
  const tenant = await createTenant(boss);
  const plan = await createPlanRow(owner, { isFree: false, limits: {} });
  await ensureSubscription(owner, tenant.id, plan.id);
  return { boss, tenant };
}

const fetchSheet = (user: TestUser | undefined, url: unknown = LINK, origin?: string) =>
  call("POST", PATH, { cookie: user?.cookie, body: { url }, origin });

const customersOf = async (tenantId: string) => {
  const [found] = await asPlatform(
    owner,
    (tx) => tx<{ total: number }[]>`select count(*)::int as total from customer where tenant_id = ${tenantId}`,
  );
  return found?.total ?? 0;
};

describe("a rota", () => {
  it("devolve o CSV como texto para baixar: tipo de CSV, nosniff, anexo e sem cache", async () => {
    const { boss, tenant } = await tenantWith();
    const response = await fetchSheet(boss);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(CSV);

    // Só baixa: quem cria fichas é `POST /api/customers/import`.
    expect(await customersOf(tenant.id)).toBe(0);
  });

  it("busca o endereço que ela mesma montou, nunca o colado (consulta, conta e chave ficam de fora)", async () => {
    const { boss } = await tenantWith();
    const pasted = `https://docs.google.com/spreadsheets/u/2/d/${ID}/edit?usp=sharing&resourcekey=xyz#gid=5`;
    expect((await fetchSheet(boss, pasted)).status).toBe(200);

    expect(requests[0]?.url.href).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=5`);
    // Nada da sessão vai ao Google: sem cookie, sem autorização, sem origem.
    for (const request of requests) {
      expect(Object.keys(request.headers).map((k) => k.toLowerCase()).sort()).toEqual([
        "accept",
        "accept-encoding",
        "user-agent",
      ]);
    }
  });

  it.each([
    ["host hostil", `https://docs.google.com.evil.com/spreadsheets/d/${ID}/edit`],
    ["credenciais na URL", `https://docs.google.com@evil.com/spreadsheets/d/${ID}/edit`],
    ["metadados da nuvem", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "https://localhost:3000/api/me"],
    ["documento do Google", `https://docs.google.com/document/d/${ID}/edit`],
    ["id com %2f", "https://docs.google.com/spreadsheets/d/abcdefghij%2fklmnopqrstuvwxyz/edit"],
  ])("link recusado (%s): 400 sem nenhuma busca", async (_label, url) => {
    const { boss } = await tenantWith();
    const response = await fetchSheet(boss, url);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("INVALID_SHEET_LINK");
    expect(body.error).not.toContain("evil");
    expect(requests).toHaveLength(0);
  });

  it("corpo fora do contrato: 400 sem busca", async () => {
    const { boss } = await tenantWith();
    for (const body of [{}, { url: 1 }, { url: LINK, extra: true }, { url: "x".repeat(3000) }]) {
      const response = await call("POST", PATH, { cookie: boss.cookie, body });
      expect(response.status).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("o corpo tem o teto de 16 KB das rotas comuns, não os 5 MB do lote", async () => {
    const { boss } = await tenantWith();
    const body = JSON.stringify({ url: `${LINK}${"x".repeat(20 * 1024)}` });
    const response = await api.request(PATH, {
      method: "POST",
      headers: {
        Cookie: boss.cookie,
        Origin: APP_ORIGIN,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        "X-Forwarded-For": "203.0.113.77",
      },
      body,
    });
    expect(response.status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  it("planilha privada: 422 com o que fazer", async () => {
    const { boss } = await tenantWith();
    mode = "private";
    const response = await fetchSheet(boss);

    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("SHEET_NOT_SHARED");
    expect(body.error).toContain("Qualquer pessoa com o link");
    // O redirecionamento para o login nunca é seguido.
    expect(requests).toHaveLength(1);
  });

  it("resposta que não é texto: 422, e o corpo do Google nunca é repassado", async () => {
    const { boss } = await tenantWith();
    mode = "html";
    const response = await fetchSheet(boss);

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    const text = await response.text();
    expect(text).not.toContain("script");
    expect(JSON.parse(text).code).toBe("SHEET_NOT_CSV");
  });
});

describe("permissão, isolamento e modo da organização", () => {
  it("exige customer:create; owner e membro passam", async () => {
    const { boss, tenant } = await tenantWith();
    const reader = await createUser(owner);
    await createRole(boss, "Leitor", ["customer:read"]);
    await addMember(owner, tenant.id, reader, "Leitor");
    const member = await createUser(owner);
    await addMember(owner, tenant.id, member, "member");

    const refused = await fetchSheet(reader);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("PERMISSION_DENIED");
    expect(requests).toHaveLength(0);

    expect((await fetchSheet(boss)).status).toBe(200);
    expect((await fetchSheet(member)).status).toBe(200);
  });

  it("sem sessão, 401; de outra origem, 403; sem organização, 403; nenhum busca", async () => {
    expect((await fetchSheet(undefined)).status).toBe(401);

    const { boss } = await tenantWith();
    expect((await fetchSheet(boss, LINK, "https://outro-site.example")).status).toBe(403);

    const loner = await createUser(owner);
    const alone = await fetchSheet(loner);
    expect(alone.status).toBe(403);
    expect((await alone.json()).code).toBe("TENANT_REQUIRED");

    expect(requests).toHaveLength(0);
  });

  it("modo somente leitura e organização suspensa recusam (como a importação)", async () => {
    const readOnly = await tenantWith();
    await owner`update organization set access_mode = 'read_only' where id = ${readOnly.tenant.id}`;
    const blocked = await fetchSheet(readOnly.boss);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe("TENANT_READ_ONLY");

    const suspended = await tenantWith();
    await owner`update organization set status = 'suspended' where id = ${suspended.tenant.id}`;
    const refused = await fetchSheet(suspended.boss);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("TENANT_SUSPENDED");

    expect(requests).toHaveLength(0);
  });
});

describe("rate limit", () => {
  it("10 buscas em 10 minutos por pessoa e organização; as falhas também contam", async () => {
    const { boss, tenant } = await tenantWith();
    mode = "private";
    for (let i = 0; i < 10; i++) expect((await fetchSheet(boss)).status).toBe(422);

    mode = "ok";
    const blocked = await fetchSheet(boss);
    expect(blocked.status).toBe(429);
    expect(requests).toHaveLength(10);

    // Outra pessoa da mesma organização tem o próprio contador; a importação em si segue aberta.
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "member");
    expect((await fetchSheet(colleague)).status).toBe(200);
    const imported = await call("POST", "/api/customers/import", {
      cookie: boss.cookie,
      body: { rows: [{ sourceRow: 2, phone: "11987654321", tags: [] }] },
    });
    expect(imported.status).toBe(200);
  });
});
