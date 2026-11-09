import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyOf } from "./billing-helpers";
import {
  cleanUpChannels,
  seedCloudChannel,
  seedQrChannel,
  TEST_APP_SECRET,
  TEST_TOKEN,
  tenantScope,
} from "./channels-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/** `/api/channels/*` pela API, com Postgres real. A matriz papel × rota está em `rbac.test.ts`. */

type Listed = { id: string; name: string; isDefault: boolean };

describe("/api/channels", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  const users: Record<string, TestUser> = {};

  beforeAll(async () => {
    owner = connectOwner();

    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;

    const other = await createUser(owner);
    otherTenantId = (await createTenant(other, "Outra Clínica")).id;
    users.other = other;

    for (const role of ["admin", "member"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, role);
      users[role] = user;
    }
  });

  afterAll(async () => {
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner.end();
  });

  const cookie = (role: string) => users[role]?.cookie;

  const listAs = async (role: string) =>
    (await bodyOf(await call("GET", "/api/channels", { cookie: cookie(role) }))).channels as Listed[];

  describe("leitura", () => {
    it("lista os canais do tenant, com módulos e limites, sem segredo nenhum", async () => {
      const mine = await seedCloudChannel(tenantScope(tenantId), { name: "Vendas" });
      const theirs = await seedCloudChannel(tenantScope(otherTenantId), { name: "Alheio" });

      const response = await call("GET", "/api/channels", { cookie: cookie("member") });
      const body = await bodyOf(response);
      const text = JSON.stringify(body);

      expect(response.status).toBe(200);
      const ids = (body.channels as Listed[]).map((item) => item.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect(body.providers).toEqual({
        whatsapp_cloud: { enabled: expect.any(Boolean) },
        whatsapp_qr: { enabled: expect.any(Boolean) },
      });
      expect(body.limits).toHaveProperty("whatsapp_cloud");
      // Nenhum segredo, nem cifrado, nem a chave do webhook.
      expect(text).not.toContain(TEST_TOKEN);
      expect(text).not.toContain(TEST_APP_SECRET);
      expect(text).not.toMatch(/_enc|Enc"|webhookKey|webhook_key|verifyToken/);
      expect(text).not.toContain(mine.webhookKey);
    });

    it("sem sessão: 401", async () => {
      expect((await call("GET", "/api/channels")).status).toBe(401);
    });
  });

  describe("escrita", () => {
    it("membro só lê: 403 em qualquer escrita, sem alterar nada", async () => {
      const row = await seedCloudChannel(tenantScope(tenantId), { name: "Protegido" });
      const writes = [
        ["PATCH", `/api/channels/${row.id}`, { name: "Hack" }],
        ["POST", `/api/channels/${row.id}/default`, undefined],
        ["DELETE", `/api/channels/${row.id}`, { confirm: "Protegido" }],
      ] as const;

      for (const [method, path, body] of writes) {
        const response = await call(method, path, { cookie: cookie("member"), body });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await bodyOf(response)).code).toBe("PERMISSION_DENIED");
      }

      const listed = await listAs("owner");
      expect(listed.find((item) => item.id === row.id)?.name).toBe("Protegido");
    });

    it("admin renomeia, troca o padrão e remove (com o nome digitado)", async () => {
      const one = await seedCloudChannel(tenantScope(tenantId), { name: "Um", isDefault: true });
      const two = await seedCloudChannel(tenantScope(tenantId), { name: "Dois" });

      const rename = await call("PATCH", `/api/channels/${two.id}`, {
        cookie: cookie("admin"),
        body: { name: "  Dois Renomeado  " },
      });
      expect(rename.status).toBe(200);

      const def = await call("POST", `/api/channels/${two.id}/default`, { cookie: cookie("admin") });
      expect(def.status).toBe(200);

      const state = (await listAs("admin")).filter((item) => [one.id, two.id].includes(item.id));
      expect(state.map((item) => [item.name, item.isDefault]).sort()).toEqual(
        [
          ["Dois Renomeado", true],
          ["Um", false],
        ].sort(),
      );

      const wrong = await call("DELETE", `/api/channels/${two.id}`, {
        cookie: cookie("admin"),
        body: { confirm: "dois" },
      });
      expect(wrong.status).toBe(400);
      expect((await bodyOf(wrong)).code).toBe("CONFIRMATION_MISMATCH");

      const noBody = await call("DELETE", `/api/channels/${two.id}`, { cookie: cookie("admin") });
      expect(noBody.status).toBe(400);

      const removed = await call("DELETE", `/api/channels/${two.id}`, {
        cookie: cookie("admin"),
        body: { confirm: "Dois Renomeado" },
      });
      expect(removed.status).toBe(200);
      expect(await bodyOf(removed)).toEqual({ outcome: "deleted" });
    });

    it("validação: nome vazio ou longo e campo desconhecido são 400", async () => {
      const row = await seedQrChannel(tenantScope(tenantId), { name: "Valida" });
      const invalid = [{ name: "" }, { name: "x".repeat(61) }, { name: "ok", type: "whatsapp_cloud" }, {}];

      for (const body of invalid) {
        const response = await call("PATCH", `/api/channels/${row.id}`, { cookie: cookie("owner"), body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("canal de outro tenant: 404 em tudo, igual a inexistente, e nada muda", async () => {
      const theirs = await seedCloudChannel(tenantScope(otherTenantId), { name: "Do Outro" });
      const writes = [
        ["PATCH", `/api/channels/${theirs.id}`, { name: "Hack" }],
        ["POST", `/api/channels/${theirs.id}/default`, undefined],
        ["DELETE", `/api/channels/${theirs.id}`, { confirm: "Do Outro" }],
      ] as const;

      for (const [method, path, body] of writes) {
        const response = await call(method, path, { cookie: cookie("owner"), body });
        expect(response.status, `${method} ${path}`).toBe(404);
      }

      const rows = await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        return tx<{ name: string }[]>`select name from channel where id = ${theirs.id}`;
      });
      expect(rows[0]?.name).toBe("Do Outro");
    });

    it("id que não é uuid: 404", async () => {
      const response = await call("PATCH", "/api/channels/abc", {
        cookie: cookie("owner"),
        body: { name: "x" },
      });

      expect(response.status).toBe(404);
    });

    it("tenant em somente leitura não altera canal, mas continua lendo", async () => {
      const row = await seedCloudChannel(tenantScope(tenantId), { name: "Leitura" });
      const setMode = (mode: string) =>
        owner.begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await tx`update organization set access_mode = ${mode} where id = ${tenantId}`;
        });
      await setMode("read_only");

      try {
        const write = await call("PATCH", `/api/channels/${row.id}`, {
          cookie: cookie("owner"),
          body: { name: "Novo" },
        });
        const read = await call("GET", "/api/channels", { cookie: cookie("owner") });

        expect(write.status).toBe(403);
        expect((await bodyOf(write)).code).toBe("TENANT_READ_ONLY");
        expect(read.status).toBe(200);
      } finally {
        await setMode("full");
      }
    });
  });
});
