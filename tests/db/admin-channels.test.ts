import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bodyOf, makePlatformUser } from "./billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  TEST_APP_SECRET,
  TEST_TOKEN,
  tenantScope,
} from "./channels-helpers";
import { applyCookies } from "./security-helpers";
import {
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * `/api/admin/channels/*`: os números de WhatsApp da plataforma (`tenant_id` nulo), pelas mesmas
 * rotas de `/api/channels`. Suporte só lê, o proprietário escreve, e nenhum escopo enxerga o
 * outro. As rotas de cada tipo (Cloud, QR Code) são testadas na pasta do módulo.
 */

type Listed = { id: string; name: string; isDefault: boolean; status: string };

const BASE = "/api/admin/channels";
/** `cleanUpChannels` apaga os canais da plataforma com este sufixo. */
const tag = (name: string) => `${name} ${randomUUID().slice(0, 6)}-chtest`;

describe("/api/admin/channels", () => {
  let owner: postgres.Sql;
  let platformOwner: TestUser;
  let support: TestUser;
  let regular: TestUser;
  let tenantOwner: TestUser;
  let tenantId: string;

  const rowOf = async (id: string) =>
    (
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        return tx<{ name: string; is_default: boolean; tenant_id: string | null }[]>`
          select name, is_default, tenant_id from channel where id = ${id}`;
      })
    )[0];

  const listed = async (user: TestUser, base = BASE) =>
    (await bodyOf(await call("GET", base, { cookie: user.cookie }))).channels as Listed[];

  const writesOn = (base: string, id: string, name: string) =>
    [
      ["PATCH", `${base}/${id}`, { name: "Hack" }],
      ["POST", `${base}/${id}/default`, undefined],
      ["DELETE", `${base}/${id}`, { confirm: name }],
    ] as const;

  beforeAll(async () => {
    owner = connectOwner();
    platformOwner = await makePlatformUser(owner, "platform_owner");
    support = await makePlatformUser(owner, "platform_support");
    regular = await createUser(owner);
    tenantOwner = await createUser(owner);
    tenantId = (await createTenant(tenantOwner, "Clínica Canais")).id;
  });

  afterEach(async () => {
    await cleanUpChannels(owner, []);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from channel where tenant_id = ${tenantId}`;
    });
  });

  afterAll(async () => {
    await cleanUp(owner);
    await owner.end();
  });

  describe("acesso", () => {
    it("sem sessão: 401 na leitura e na escrita", async () => {
      expect((await call("GET", BASE)).status).toBe(401);

      for (const [method, path, body] of writesOn(BASE, randomUUID(), "x")) {
        expect((await call(method, path, { body })).status, `${method} ${path}`).toBe(401);
      }
    });

    it("usuário comum e dono de tenant não leem nem escrevem", async () => {
      const name = tag("Plataforma");
      const row = await seedCloudChannel(platformScope, { name });

      for (const user of [regular, tenantOwner]) {
        const list = await call("GET", BASE, { cookie: user.cookie });
        expect(list.status).toBe(403);
        expect(await list.text()).not.toContain(row.id);

        for (const [method, path, body] of writesOn(BASE, row.id, name)) {
          const response = await call(method, path, { cookie: user.cookie, body });
          expect(response.status, `${method} ${path}`).toBe(403);
        }
      }

      expect((await rowOf(row.id))?.name).toBe(name);
    });

    it("suporte lê, mas recebe 403 em toda escrita e nada muda", async () => {
      const name = tag("Protegido");
      const row = await seedCloudChannel(platformScope, { name });

      expect((await listed(support)).map((item) => item.id)).toContain(row.id);

      for (const [method, path, body] of writesOn(BASE, row.id, name)) {
        const response = await call(method, path, { cookie: support.cookie, body });
        expect(response.status, `${method} ${path}`).toBe(403);
      }

      expect(await rowOf(row.id)).toMatchObject({ name, is_default: false });
    });

    it("sessão personificada não lê nem escreve os números da plataforma", async () => {
      const name = tag("Personificado");
      const row = await seedCloudChannel(platformScope, { name });
      const grant = await call("POST", "/api/tenant/support-grant", {
        cookie: tenantOwner.cookie,
        body: { hours: 1 },
      });
      expect(grant.status).toBe(201);

      const entered = await call("POST", "/api/admin/impersonate", {
        cookie: platformOwner.cookie,
        body: { userId: tenantOwner.id, tenantId },
      });
      expect(entered.status).toBe(200);
      const cookie = applyCookies(platformOwner.cookie, entered);

      try {
        expect((await call("GET", BASE, { cookie })).status).toBe(403);
        for (const [method, path, body] of writesOn(BASE, row.id, name)) {
          expect((await call(method, path, { cookie, body })).status, `${method} ${path}`).toBe(403);
        }
        expect((await rowOf(row.id))?.name).toBe(name);
      } finally {
        await call("POST", "/api/admin/stop-impersonating", { cookie, body: {} });
      }
    });
  });

  describe("isolamento entre escopos", () => {
    it("a plataforma só lista os próprios números; o tenant nunca vê os dela", async () => {
      const mine = await seedCloudChannel(platformScope, { name: tag("Da plataforma") });
      const qr = await seedQrChannel(platformScope, { name: tag("QR da plataforma") });
      const theirs = await seedCloudChannel(tenantScope(tenantId), { name: "Do tenant" });

      const platformIds = (await listed(platformOwner)).map((item) => item.id);
      expect(platformIds).toEqual(expect.arrayContaining([mine.id, qr.id]));
      expect(platformIds).not.toContain(theirs.id);

      const tenantIds = (await listed(tenantOwner, "/api/channels")).map((item) => item.id);
      expect(tenantIds).toContain(theirs.id);
      expect(tenantIds).not.toContain(mine.id);
      expect(tenantIds).not.toContain(qr.id);
    });

    it("número de tenant pela rota da plataforma: 404 em tudo, e nada muda", async () => {
      const theirs = await seedCloudChannel(tenantScope(tenantId), { name: "Do tenant" });

      for (const [method, path, body] of writesOn(BASE, theirs.id, "Do tenant")) {
        const response = await call(method, path, { cookie: platformOwner.cookie, body });
        expect(response.status, `${method} ${path}`).toBe(404);
      }

      expect(await rowOf(theirs.id)).toMatchObject({ name: "Do tenant", tenant_id: tenantId });
    });

    it("número da plataforma pela rota do tenant: 404 em tudo, e nada muda", async () => {
      const name = tag("Inalcançável");
      const mine = await seedCloudChannel(platformScope, { name });

      for (const [method, path, body] of writesOn("/api/channels", mine.id, name)) {
        const response = await call(method, path, { cookie: tenantOwner.cookie, body });
        expect(response.status, `${method} ${path}`).toBe(404);
      }

      expect(await rowOf(mine.id)).toMatchObject({ name, tenant_id: null });
    });
  });

  describe("leitura", () => {
    it("lista sem segredo, sem limite de plano e com as variáveis que faltam (só o nome)", async () => {
      const row = await seedCloudChannel(platformScope, { name: tag("Leitura") });
      const qr = await seedQrChannel(platformScope, { name: tag("Leitura QR") });

      for (const user of [platformOwner, support]) {
        const response = await call("GET", BASE, { cookie: user.cookie });
        const body = await bodyOf(response);
        const text = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.providers).toEqual({
          whatsapp_cloud: { enabled: expect.any(Boolean), missing: expect.any(Array) },
          whatsapp_qr: { enabled: expect.any(Boolean), missing: expect.any(Array) },
        });
        // Só nomes de variável: nenhum valor do `.env` sai na resposta.
        const providers = body.providers as Record<string, { missing: string[] }>;
        for (const { missing } of Object.values(providers)) {
          for (const name of missing) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
        expect(body.limits).toMatchObject({
          whatsapp_cloud: { limit: null, allowed: true },
          whatsapp_qr: { limit: null, allowed: true },
        });

        expect(text).not.toContain(TEST_TOKEN);
        expect(text).not.toContain(TEST_APP_SECRET);
        expect(text).not.toContain(row.webhookKey);
        expect(text).not.toContain(qr.webhookSecret);
        expect(text).not.toContain("token-da-instancia-de-teste");
        expect(text).not.toMatch(
          /_enc|Enc"|webhookKey|webhook_key|verifyToken|instanceToken|webhookSecret|remoteInstance/,
        );
      }
    });

    it("a rota do tenant continua sem `missing`", async () => {
      const body = await bodyOf(await call("GET", "/api/channels", { cookie: tenantOwner.cookie }));

      expect(JSON.stringify(body.providers)).not.toContain("missing");
    });
  });

  describe("escrita do proprietário", () => {
    it("renomeia, troca o padrão e remove; a auditoria é da plataforma, sem tenant", async () => {
      const first = tag("Um");
      const second = tag("Dois");
      const renamed = tag("Dois renomeado");
      const one = await seedCloudChannel(platformScope, { name: first, isDefault: true });
      const two = await seedCloudChannel(platformScope, { name: second });
      const as = { cookie: platformOwner.cookie };

      expect((await call("PATCH", `${BASE}/${two.id}`, { ...as, body: { name: renamed } })).status).toBe(200);
      expect((await call("POST", `${BASE}/${two.id}/default`, as)).status).toBe(200);
      expect(await rowOf(two.id)).toMatchObject({ name: renamed, is_default: true });
      expect((await rowOf(one.id))?.is_default).toBe(false);

      const wrong = await call("DELETE", `${BASE}/${two.id}`, { ...as, body: { confirm: second } });
      expect(wrong.status).toBe(400);
      expect((await bodyOf(wrong)).code).toBe("CONFIRMATION_MISMATCH");

      const removed = await call("DELETE", `${BASE}/${two.id}`, { ...as, body: { confirm: renamed } });
      expect(removed.status).toBe(200);
      expect(await bodyOf(removed)).toEqual({ outcome: "deleted" });
      expect(await rowOf(two.id)).toBeUndefined();

      const audit = await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        return tx<
          { action: string; actor_type: string; actor_id: string; tenant_id: string | null }[]
        >`select action, actor_type, actor_id, tenant_id from audit_log
          where target_id = ${two.id} order by created_at`;
      });

      expect(audit.map((item) => item.action)).toEqual([
        "channel.updated",
        "channel.default_changed",
        "channel.deleted",
      ]);
      for (const entry of audit) {
        expect(entry).toMatchObject({
          actor_type: "platform",
          actor_id: platformOwner.id,
          tenant_id: null,
        });
      }
    });

    it("validação e id inválido valem como no tenant", async () => {
      const row = await seedCloudChannel(platformScope, { name: tag("Valida") });
      const as = { cookie: platformOwner.cookie };

      for (const body of [{ name: "" }, { name: "x".repeat(61) }, { name: "ok", tenantId }, {}]) {
        const response = await call("PATCH", `${BASE}/${row.id}`, { ...as, body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      expect((await call("PATCH", `${BASE}/abc`, { ...as, body: { name: "x" } })).status).toBe(404);
      expect(
        (await call("PATCH", `${BASE}/${randomUUID()}`, { ...as, body: { name: "x" } })).status,
      ).toBe(404);
    });
  });
});
