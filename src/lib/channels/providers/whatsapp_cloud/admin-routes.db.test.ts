import { createHmac, randomInt } from "node:crypto";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/app";
import { setChannelQueueForTests } from "@/lib/channels/events";
import { createCloudProvider } from "@/lib/channels/providers/whatsapp_cloud";
import { setProvidersForTests } from "@/lib/channels/registry";
import { fixtureText, jsonResponse } from "@/lib/channels/test-fixtures";
import { bodyOf, makePlatformUser } from "../../../../../tests/db/billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedCloudChannel,
  TEST_APP_SECRET,
  TEST_TOKEN,
  tenantScope,
} from "../../../../../tests/db/channels-helpers";
import {
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "../../../../../tests/db/tenant-helpers";

/**
 * As rotas do WhatsApp Cloud montadas para a plataforma (`/api/admin/channels/*`,
 * `Scope = platform`): o mesmo código de `/api/channels`, com outra autorização. Meta simulada
 * pelas fixtures; mora na pasta do módulo e roda em `npm run test:db`.
 */

const BASE = "/api/admin/channels";
const PHONE = "200000000000077";
const WABA = "100000000000001";
const NEW_SECRET = "segredo-do-aplicativo-da-plataforma";
const NEW_TOKEN = "EAAB-token-da-plataforma-4321";
/** `cleanUpChannels` apaga os canais da plataforma com este sufixo. */
const NAME = "Oficial-chtest";

const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

/** `fetch` da Graph API, roteado pelo caminho. Guarda as chamadas para conferir. */
function stubMeta() {
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (url.pathname.endsWith("/subscribed_apps")) {
        return method === "POST" ? ok() : jsonResponse("cloud/api/subscribed-apps");
      }
      if (url.pathname.endsWith("/message_templates")) return jsonResponse("cloud/api/templates-page2");
      if (url.pathname.endsWith("/register")) return ok();
      return jsonResponse("cloud/api/phone-info");
    }),
  );

  return calls;
}

describe("/api/admin/channels (WhatsApp Cloud)", () => {
  let owner: postgres.Sql;
  let platformOwner: TestUser;
  let support: TestUser;
  let tenantOwner: TestUser;
  let tenantId: string;

  const sql = <T extends object>(run: (tx: postgres.TransactionSql) => Promise<T[]>) =>
    owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return run(tx);
    }) as Promise<T[]>;

  const cloudRow = async (channelId: string) =>
    (
      await sql<Record<string, string | null>>(
        (tx) => tx`select * from channel_whatsapp_cloud where channel_id = ${channelId}`,
      )
    )[0];

  const newChannelBody = () => ({
    name: NAME,
    phoneNumberId: PHONE,
    wabaId: WABA,
    accessToken: NEW_TOKEN,
    appSecret: NEW_SECRET,
  });

  const routes = (base: string, id: string) =>
    [
      ["POST", `${base}/whatsapp-cloud`, newChannelBody()],
      ["PATCH", `${base}/${id}`, { appSecret: NEW_SECRET }],
      ["GET", `${base}/${id}/webhook`, undefined],
      ["POST", `${base}/${id}/webhook/rotate`, undefined],
      ["POST", `${base}/${id}/test`, undefined],
      ["POST", `${base}/${id}/templates/sync`, undefined],
    ] as const;

  beforeAll(async () => {
    owner = connectOwner();
    platformOwner = await makePlatformUser(owner, "platform_owner");
    support = await makePlatformUser(owner, "platform_support");
    tenantOwner = await createUser(owner);
    tenantId = (await createTenant(tenantOwner, "Clínica Cloud")).id;
  });

  beforeEach(() => {
    setProvidersForTests([createCloudProvider()]);
    setChannelQueueForTests(async () => undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setProvidersForTests(undefined);
    setChannelQueueForTests(undefined);
    await sql(async (tx) => {
      await tx`delete from message_template where tenant_id is null`;
      return tx`delete from channel where tenant_id = ${tenantId}`;
    });
    await cleanUpChannels(owner, []);
  });

  afterAll(async () => {
    await cleanUp(owner);
    await owner.end();
  });

  it("proprietário salva o número da plataforma: sem tenant, sem segredo, e o webhook funciona", async () => {
    stubMeta();
    const response = await call("POST", `${BASE}/whatsapp-cloud`, {
      cookie: platformOwner.cookie,
      body: newChannelBody(),
    });
    const body = await bodyOf(response);
    const text = JSON.stringify(body);
    const created = body.channel as { id: string };
    const webhook = body.webhook as { url: string; verifyToken: string };

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.channel).toMatchObject({ type: "whatsapp_cloud", name: NAME, status: "connected" });
    expect(text).not.toContain(NEW_TOKEN);
    expect(text).not.toContain(NEW_SECRET);
    expect(text).not.toMatch(/_enc|Enc"/);

    const row = await cloudRow(created.id);
    expect(row?.tenant_id).toBeNull();
    expect(row?.access_token_enc).not.toContain(NEW_TOKEN);

    const audit = await sql<{ action: string; actor_type: string; tenant_id: string | null }>(
      (tx) => tx`select action, actor_type, tenant_id from audit_log where target_id = ${created.id}`,
    );
    expect(audit).toEqual([{ action: "channel.created", actor_type: "platform", tenant_id: null }]);

    // O aviso assinado com o segredo da plataforma entra pela chave devolvida.
    const event = fixtureText("cloud/message-text");
    const signed = await api.request(`/api/webhooks/whatsapp/cloud/${webhook.url.split("/").at(-1)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", NEW_SECRET).update(event).digest("hex")}`,
      },
      body: event,
    });
    expect(signed.status).toBe(200);

    // O tenant não enxerga o número da plataforma.
    const tenantList = await call("GET", "/api/channels", { cookie: tenantOwner.cookie });
    expect(await tenantList.text()).not.toContain(created.id);
  });

  it("proprietário lê o endereço, gera outro, diagnostica e sincroniza modelos", async () => {
    const seeded = await seedCloudChannel(platformScope, { name: NAME });
    const as = { cookie: platformOwner.cookie };
    stubMeta();

    const shown = await call("GET", `${BASE}/${seeded.id}/webhook`, as);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(((await bodyOf(shown)) as { url: string }).url).toContain(seeded.webhookKey);

    const rotated = await call("POST", `${BASE}/${seeded.id}/webhook/rotate`, as);
    expect(rotated.status).toBe(200);
    expect(((await bodyOf(rotated)) as { url: string }).url).not.toContain(seeded.webhookKey);

    for (const path of ["test", "templates/sync"]) {
      const response = await call("POST", `${BASE}/${seeded.id}/${path}`, as);
      const text = await response.text();

      expect(response.status, path).toBe(200);
      expect(text).not.toContain(TEST_TOKEN);
      expect(text).not.toContain(TEST_APP_SECRET);
      expect(text).not.toMatch(/_enc|Enc"|webhookKey|webhook_key/);
    }

    expect((await call("GET", `${BASE}/${seeded.id}/templates`, as)).status).toBe(200);
  });

  it("suporte lê os modelos, mas recebe 403 em tudo que gerencia, sem chamar a Meta", async () => {
    const seeded = await seedCloudChannel(platformScope, { name: NAME });
    const before = await cloudRow(seeded.id);
    const calls = stubMeta();

    for (const [method, path, body] of routes(BASE, seeded.id)) {
      const response = await call(method, path, { cookie: support.cookie, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      // O endereço e o token de verificação nunca chegam ao suporte.
      expect(await response.text()).not.toContain(seeded.webhookKey);
    }

    expect(calls).toHaveLength(0);
    expect(await cloudRow(seeded.id)).toEqual(before);
    expect(
      (await call("GET", `${BASE}/${seeded.id}/templates`, { cookie: support.cookie })).status,
    ).toBe(200);
  });

  it("dono de tenant e visitante não chegam às rotas da plataforma", async () => {
    const seeded = await seedCloudChannel(platformScope, { name: NAME });
    const calls = stubMeta();

    for (const [method, path, body] of routes(BASE, seeded.id)) {
      expect(
        (await call(method, path, { cookie: tenantOwner.cookie, body })).status,
        `${method} ${path}`,
      ).toBe(403);
      expect((await call(method, path, { body })).status, `${method} ${path}`).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("escopos não se cruzam: 404 nos dois sentidos, e nada muda", async () => {
    const platform = await seedCloudChannel(platformScope, { name: NAME });
    const tenant = await seedCloudChannel(tenantScope(tenantId), { name: "Do tenant" });
    const before = [await cloudRow(platform.id), await cloudRow(tenant.id)];
    const calls = stubMeta();
    const crossings = [
      [BASE, tenant.id, platformOwner],
      ["/api/channels", platform.id, tenantOwner],
    ] as const;

    for (const [base, id, user] of crossings) {
      const perId = [...routes(base, id).slice(1), ["GET", `${base}/${id}/templates`, undefined] as const];

      for (const [method, path, body] of perId) {
        const response = await call(method, path, { cookie: user.cookie, body });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }

    expect(calls).toHaveLength(0);
    expect([await cloudRow(platform.id), await cloudRow(tenant.id)]).toEqual(before);
  });
});
