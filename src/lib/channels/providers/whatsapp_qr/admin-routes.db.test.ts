import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPlatformScope } from "@/db/rls";
import { channel, channelEvolution } from "@/db/schema";
import { evolutionCredentials } from "@/lib/channels/credentials";
import {
  FIXTURE_TOKEN,
  fakeEvolution,
  GLOBAL_KEY,
  seedFixtureChannel,
} from "@/lib/channels/providers/whatsapp_qr/db-test-support";
import { setProvidersForTests } from "@/lib/channels/registry";
import { bodyOf, makePlatformUser } from "../../../../../tests/db/billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedQrChannel,
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
 * As rotas do canal por QR Code montadas para a plataforma (`/api/admin/channels/*`,
 * `Scope = platform`): o mesmo código de `/api/channels`, com outra autorização. Servidor
 * Evolution simulado; mora na pasta do módulo e roda em `npm run test:db`.
 */

const BASE = "/api/admin/channels";
/** `cleanUpChannels` apaga os canais da plataforma com este sufixo. */
const NAME = "Suporte-chtest";

describe("/api/admin/channels (QR Code)", () => {
  let owner: postgres.Sql;
  let platformOwner: TestUser;
  let support: TestUser;
  let tenantOwner: TestUser;
  let tenantId: string;
  let evolution: ReturnType<typeof fakeEvolution>;

  const writes = (base: string, id: string) =>
    [
      ["POST", `${base}/whatsapp-qr`, { name: "Hack-chtest" }],
      ["POST", `${base}/${id}/qr`, undefined],
      ["POST", `${base}/${id}/pair`, { phone: "5511999990001" }],
      ["POST", `${base}/${id}/disconnect`, undefined],
      ["POST", `${base}/${id}/logout`, undefined],
      ["POST", `${base}/${id}/reconnect`, undefined],
      ["PATCH", `${base}/${id}/advanced-settings`, { advancedSettings: { alwaysOnline: true } }],
    ] as const;

  const platformRows = () =>
    withPlatformScope("teste", (tx) =>
      tx
        .select({ channel, evolution: channelEvolution })
        .from(channel)
        .innerJoin(channelEvolution, eq(channelEvolution.channelId, channel.id)),
    ).then((rows) => rows.filter((row) => row.channel.tenantId === null));

  const channelOf = async (id: string) =>
    (await withPlatformScope("teste", (tx) => tx.select().from(channel).where(eq(channel.id, id))))[0];

  beforeAll(async () => {
    owner = connectOwner();
    platformOwner = await makePlatformUser(owner, "platform_owner");
    support = await makePlatformUser(owner, "platform_support");
    tenantOwner = await createUser(owner);
    tenantId = (await createTenant(tenantOwner, "Clínica QR")).id;
  });

  beforeEach(() => {
    evolution = fakeEvolution();
    setProvidersForTests([evolution.provider]);
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
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

  it("proprietário cria o número da plataforma: sem tenant, sem segredo na resposta, auditado", async () => {
    const response = await call("POST", `${BASE}/whatsapp-qr`, {
      cookie: platformOwner.cookie,
      body: { name: NAME },
    });
    const body = (await bodyOf(response)) as { channel: { id: string; status: string } };
    const text = JSON.stringify(body);
    const [created] = evolution.called("POST", "/instance/create");
    const sent = created?.body as { name: string; token: string };
    const [row] = await platformRows();

    expect(response.status).toBe(201);
    expect(body.channel).toMatchObject({ name: NAME, type: "whatsapp_qr", status: "connecting" });
    expect(row?.channel).toMatchObject({ id: body.channel.id, tenantId: null });
    expect(row?.evolution.tenantId).toBeNull();

    // A instância leva a marca da plataforma no nome, e o token só existe cifrado.
    expect(created?.key).toBe(GLOBAL_KEY);
    expect(sent.name).toMatch(/^bizu_platform_/);
    expect(row && evolutionCredentials(row.evolution).instanceToken).toBe(sent.token);
    expect(text).not.toContain(sent.token);
    expect(text).not.toContain(row ? evolutionCredentials(row.evolution).webhookSecret : "-");
    expect(text).not.toMatch(/_enc|Enc"|instanceToken|webhookSecret|remoteInstance|GLOBAL|apikey/i);

    const audit = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ action: string; actor_type: string; tenant_id: string | null }[]>`
        select action, actor_type, tenant_id from audit_log where target_id = ${body.channel.id}`;
    });
    expect(audit).toEqual([{ action: "channel.created", actor_type: "platform", tenant_id: null }]);

    // O tenant não enxerga o número da plataforma.
    const tenantList = await call("GET", "/api/channels", { cookie: tenantOwner.cookie });
    expect(await tenantList.text()).not.toContain(body.channel.id);
  });

  it("a plataforma não tem limite de plano, mas o teto do servidor vale", async () => {
    for (const name of ["Um-chtest", "Dois-chtest", "Três-chtest"]) {
      const response = await call("POST", `${BASE}/whatsapp-qr`, {
        cookie: platformOwner.cookie,
        body: { name },
      });
      expect(response.status, name).toBe(201);
    }

    const full = fakeEvolution(
      { "GET /instance/all": () => Response.json({ data: [] }) },
      { maxInstancesTotal: 3 },
    );
    setProvidersForTests([full.provider]);
    const refused = await call("POST", `${BASE}/whatsapp-qr`, {
      cookie: platformOwner.cookie,
      body: { name: "Quatro-chtest" },
    });

    expect(refused.status).toBe(409);
    expect((await bodyOf(refused)).code).toBe("SERVER_LIMIT_REACHED");
    expect(full.called("POST", "/instance/create")).toHaveLength(0);
    expect(await platformRows()).toHaveLength(3);
  });

  it("proprietário pareia, consulta o estado e desconecta, com o token da instância", async () => {
    const seeded = await seedFixtureChannel(platformScope, { name: NAME, status: "disconnected" });
    const as = { cookie: platformOwner.cookie };

    const qr = await call("POST", `${BASE}/${seeded.id}/qr`, as);
    expect(qr.status).toBe(200);
    expect(qr.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(qr)).toMatchObject({ expiresInSeconds: 60 });

    const status = await call("GET", `${BASE}/${seeded.id}/status`, as);
    expect(status.status).toBe(200);
    expect(await bodyOf(status)).toMatchObject({ status: "connecting" });

    const disconnected = await call("POST", `${BASE}/${seeded.id}/disconnect`, as);
    expect(disconnected.status).toBe(200);
    expect((await channelOf(seeded.id))?.status).toBe("disconnected");
    expect(evolution.calls.every((item) => item.key === FIXTURE_TOKEN)).toBe(true);
  });

  it("suporte lê o estado, mas recebe 403 em toda escrita, sem chamar o servidor", async () => {
    const seeded = await seedFixtureChannel(platformScope, { name: NAME, status: "connected" });

    for (const [method, path, body] of writes(BASE, seeded.id)) {
      const response = await call(method, path, { cookie: support.cookie, body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    expect(evolution.calls).toHaveLength(0);
    expect((await channelOf(seeded.id))?.status).toBe("connected");
    expect(await platformRows()).toHaveLength(1);
    expect(
      (await call("GET", `${BASE}/${seeded.id}/status`, { cookie: support.cookie })).status,
    ).toBe(200);
  });

  it("dono de tenant e visitante não chegam às rotas da plataforma", async () => {
    const seeded = await seedFixtureChannel(platformScope, { name: NAME, status: "connected" });

    for (const [method, path, body] of writes(BASE, seeded.id)) {
      expect(
        (await call(method, path, { cookie: tenantOwner.cookie, body })).status,
        `${method} ${path}`,
      ).toBe(403);
      expect((await call(method, path, { body })).status, `${method} ${path}`).toBe(401);
    }
    expect(evolution.calls).toHaveLength(0);
  });

  it("escopos não se cruzam: 404 nos dois sentidos, sem chamar o servidor", async () => {
    const platform = await seedFixtureChannel(platformScope, { name: NAME, status: "connected" });
    const tenant = await seedQrChannel(tenantScope(tenantId), { name: "Do tenant" });
    const crossings = [
      [BASE, tenant.id, platformOwner],
      ["/api/channels", platform.id, tenantOwner],
    ] as const;

    for (const [base, id, user] of crossings) {
      const routes = [...writes(base, id).slice(1), ["GET", `${base}/${id}/status`, undefined] as const];

      for (const [method, path, body] of routes) {
        const response = await call(method, path, { cookie: user.cookie, body });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }

    expect(evolution.calls).toHaveLength(0);
    expect((await channelOf(platform.id))?.status).toBe("connected");
    expect((await channelOf(tenant.id))?.status).toBe("connected");
  });
});
