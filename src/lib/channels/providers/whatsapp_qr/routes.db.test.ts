import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPlatformScope } from "@/db/rls";
import { channel, channelEvolution } from "@/db/schema";
import { evolutionCredentials } from "@/lib/channels/credentials";
import { checkChannelsHealth } from "@/lib/channels/health";
import {
  FIXTURE_TOKEN,
  fakeEvolution,
  GLOBAL_KEY,
  seedFixtureChannel,
} from "@/lib/channels/providers/whatsapp_qr/db-test-support";
import { setProvidersForTests } from "@/lib/channels/registry";
import { sendChannelText } from "@/lib/channels/send";
import { jsonResponse } from "@/lib/channels/test-fixtures";
import { TenantRuleError } from "@/lib/tenant/errors";
import {
  bodyOf,
  cleanUpBilling,
  createPlanRow,
  ensureSubscription,
} from "../../../../../tests/db/billing-helpers";
import {
  cleanUpChannels,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "../../../../../tests/db/channels-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "../../../../../tests/db/tenant-helpers";

/**
 * Rotas do canal por QR Code em `/api/channels/*`, pela API, com banco e servidor Evolution
 * simulado (fixtures de `evolution/api/`). Mora na pasta do módulo; roda em `npm run test:db`.
 */

type ViewBody = { channel: { id: string; name: string; status: string; type: string } };

describe("/api/channels (QR Code)", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  let evolution: ReturnType<typeof fakeEvolution>;
  const users: Record<string, TestUser> = {};

  beforeAll(async () => {
    owner = connectOwner();

    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;
    users.other = await createUser(owner);
    otherTenantId = (await createTenant(users.other, "Outra Clínica")).id;

    for (const role of ["admin", "member"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, role);
      users[role] = user;
    }
  });

  beforeEach(async () => {
    evolution = fakeEvolution();
    setProvidersForTests([evolution.provider]);
    await setPlanLimit(5);
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from channel where tenant_id in (${tenantId}, ${otherTenantId})`;
      await tx`delete from audit_log where tenant_id in (${tenantId}, ${otherTenantId})`;
    });
  });

  afterAll(async () => {
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await cleanUpBilling(owner);
    await owner.end();
  });

  async function setPlanLimit(limit: number) {
    const plan = await createPlanRow(owner, {
      isFree: false,
      limits: { channels_whatsapp_qr: limit },
    });
    await ensureSubscription(owner, tenantId, plan.id);
  }

  const as = (role: string) => ({ cookie: users[role]?.cookie });

  const rowsOf = (tenant: string) =>
    withPlatformScope("teste", (tx) =>
      tx
        .select({ channel, evolution: channelEvolution })
        .from(channel)
        .innerJoin(channelEvolution, eq(channelEvolution.channelId, channel.id))
        .where(eq(channel.tenantId, tenant)),
    );

  const channelOf = async (id: string) =>
    (await withPlatformScope("teste", (tx) => tx.select().from(channel).where(eq(channel.id, id))))[0];

  const auditActions = async () =>
    (
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        return tx<{ action: string }[]>`
          select action from audit_log where tenant_id = ${tenantId} and action like 'channel.%'`;
      })
    ).map((row) => row.action);

  describe("criar", () => {
    it("cria em connecting; a resposta não traz token, segredo nem coluna _enc", async () => {
      const response = await call("POST", "/api/channels/whatsapp-qr", {
        ...as("admin"),
        body: { name: "  Vendas  " },
      });
      const body = (await bodyOf(response)) as unknown as ViewBody;
      const text = JSON.stringify(body);
      const [created] = evolution.called("POST", "/instance/create");
      const sent = created?.body as { name: string; token: string };
      const [row] = await rowsOf(tenantId);

      expect(response.status).toBe(201);
      expect(body.channel).toMatchObject({ name: "Vendas", type: "whatsapp_qr", status: "connecting" });

      // A instância nasce com a chave global e um token nosso, que só existe cifrado.
      expect(created?.key).toBe(GLOBAL_KEY);
      expect(sent.name).toMatch(new RegExp(`^bizu_${tenantId.replace(/-/g, "").slice(0, 8)}_vendas_[0-9a-f]{4}$`));
      expect(row?.evolution.instanceTokenEnc).not.toContain(sent.token);
      expect(row && evolutionCredentials(row.evolution).instanceToken).toBe(sent.token);

      const secret = row ? evolutionCredentials(row.evolution).webhookSecret : "";
      expect(text).not.toContain(sent.token);
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/_enc|Enc"|instanceToken|webhookSecret|remoteInstance|GLOBAL|apikey/i);
      expect(await auditActions()).toContain("channel.created");
    });

    it("teto do servidor vem antes do limite do plano", async () => {
      await setPlanLimit(1);
      await seedQrChannel(tenantScope(tenantId), { name: "Ocupa o plano" });

      // Servidor cheio E plano cheio: quem responde é o servidor.
      const full = fakeEvolution({}, { maxInstancesTotal: 2 });
      setProvidersForTests([full.provider]);
      const server = await call("POST", "/api/channels/whatsapp-qr", { ...as("owner"), body: { name: "A" } });

      expect(server.status).toBe(409);
      expect((await bodyOf(server)).code).toBe("SERVER_LIMIT_REACHED");
      expect(full.called("POST", "/instance/create")).toHaveLength(0);

      // Servidor com folga: aí sim o plano responde, e nada é criado no servidor.
      setProvidersForTests([evolution.provider]);
      const plan = await call("POST", "/api/channels/whatsapp-qr", { ...as("owner"), body: { name: "B" } });

      expect(plan.status).toBe(403);
      expect((await bodyOf(plan)).code).toBe("PLAN_LIMIT_REACHED");
      expect(evolution.called("POST", "/instance/create")).toHaveLength(0);
      expect(await rowsOf(tenantId)).toHaveLength(1);
    });

    it("o teto conta também os canais locais de todos os escopos", async () => {
      await seedQrChannel(tenantScope(otherTenantId), { name: "De outro tenant" });
      const empty = fakeEvolution(
        { "GET /instance/all": () => Response.json({ data: [] }) },
        { maxInstancesTotal: 1 },
      );
      setProvidersForTests([empty.provider]);

      const response = await call("POST", "/api/channels/whatsapp-qr", {
        ...as("owner"),
        body: { name: "A" },
      });

      expect(response.status).toBe(409);
      expect((await bodyOf(response)).code).toBe("SERVER_LIMIT_REACHED");
    });

    it("falha na transação apaga a instância criada no servidor", async () => {
      const existing = (await rowsOf(tenantId)).length;
      const taken = await seedQrChannel(tenantScope(otherTenantId), { name: "Dono do nome" });
      const [other] = (await rowsOf(otherTenantId)).filter((row) => row.channel.id === taken.id);
      const remoteId = crypto.randomUUID();
      // O servidor devolve um nome que já existe aqui: a única global derruba a transação.
      const clash = fakeEvolution({
        "POST /instance/create": () =>
          Response.json({ data: { id: remoteId, name: other?.evolution.remoteInstanceName } }),
      });
      clash.provider.pairing = {
        ...(clash.provider.pairing as NonNullable<typeof clash.provider.pairing>),
        createInstance: async () => ({
          remoteInstanceId: remoteId,
          remoteInstanceName: other?.evolution.remoteInstanceName ?? "",
        }),
      };
      setProvidersForTests([clash.provider]);

      const response = await call("POST", "/api/channels/whatsapp-qr", {
        ...as("owner"),
        body: { name: "Colide" },
      });

      expect(response.status).toBe(500);
      expect(clash.called("DELETE", `/instance/delete/${remoteId}`)).toHaveLength(1);
      expect(await rowsOf(tenantId)).toHaveLength(existing);
    });

    it("servidor fora do ar ou módulo desligado: 503 PROVIDER_UNAVAILABLE, sem texto do provedor", async () => {
      const down = fakeEvolution({
        "GET /instance/all": () => new Response("upstream http://10.0.0.5:8080 down", { status: 502 }),
      });
      setProvidersForTests([down.provider]);
      const response = await call("POST", "/api/channels/whatsapp-qr", { ...as("owner"), body: { name: "A" } });

      expect(response.status).toBe(503);
      expect((await bodyOf(response)).code).toBe("PROVIDER_UNAVAILABLE");
      expect(JSON.stringify(await bodyOf(response))).not.toContain("10.0.0.5");

      setProvidersForTests([]);
      const off = await call("POST", "/api/channels/whatsapp-qr", { ...as("owner"), body: { name: "A" } });
      expect(off.status).toBe(503);
      expect((await bodyOf(off)).code).toBe("PROVIDER_UNAVAILABLE");
    });

    it("validação: nome vazio, longo ou campo a mais é 400", async () => {
      for (const body of [{}, { name: "" }, { name: "x".repeat(61) }, { name: "ok", tenantId: otherTenantId }]) {
        const response = await call("POST", "/api/channels/whatsapp-qr", { ...as("owner"), body });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(evolution.calls).toHaveLength(0);
    });
  });

  describe("parear", () => {
    it("QR: registra o webhook, devolve imagem e texto, sem cache; o token nunca é a chave global", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "disconnected" });
      const response = await call("POST", `/api/channels/${seeded.id}/qr`, as("admin"));
      const body = await bodyOf(response);
      const [connect] = evolution.called("POST", "/instance/connect");

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toEqual({
        qrcode: "data:image/png;base64,iVBORw0KGgo=",
        code: "2@fakeqrcode,fake,fake",
        expiresInSeconds: 60,
      });
      expect(evolution.calls.map((item) => item.path)).toEqual(["/instance/connect", "/instance/qr"]);
      expect(evolution.calls.every((item) => item.key === FIXTURE_TOKEN)).toBe(true);
      expect((connect?.body as { webhookUrl: string }).webhookUrl).toBe(
        `https://app.test/api/webhooks/whatsapp/evolution/${seeded.webhookSecret}`,
      );
      expect((await channelOf(seeded.id))?.status).toBe("connecting");
      expect((await rowsOf(tenantId))[0]?.evolution.lastQrAt).toBeInstanceOf(Date);
    });

    it("canal já conectado: alreadyConnected, sem chamar o servidor", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });
      const response = await call("POST", `/api/channels/${seeded.id}/qr`, as("owner"));

      expect(await bodyOf(response)).toEqual({ alreadyConnected: true });
      expect(evolution.calls).toHaveLength(0);
    });

    it("servidor diz 'já pareado': alreadyConnected e o canal passa a conectado", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connecting" });
      const logged = fakeEvolution({
        "GET /instance/qr": () => jsonResponse("evolution/api/qr-already-logged-in", 400),
      });
      setProvidersForTests([logged.provider]);

      const response = await call("POST", `/api/channels/${seeded.id}/qr`, as("owner"));

      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toEqual({ alreadyConnected: true });
      expect((await channelOf(seeded.id))?.status).toBe("connected");
    });

    it("token recusado pelo servidor (401): 503 e o canal vai para error", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connecting" });
      const denied = fakeEvolution({
        "POST /instance/connect": () => jsonResponse("evolution/api/error-unauthorized", 401),
      });
      setProvidersForTests([denied.provider]);

      const response = await call("POST", `/api/channels/${seeded.id}/qr`, as("owner"));

      expect(response.status).toBe(503);
      expect((await bodyOf(response)).code).toBe("PROVIDER_UNAVAILABLE");
      expect(JSON.stringify(await bodyOf(response))).not.toContain("not authorized");
      expect((await channelOf(seeded.id))?.status).toBe("error");
    });

    it("código de pareamento: telefone só com dígitos; resposta sem cache", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connecting" });
      const response = await call("POST", `/api/channels/${seeded.id}/pair`, {
        ...as("owner"),
        body: { phone: "5511999990001" },
      });
      const [pair] = evolution.called("POST", "/instance/pair");

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await bodyOf(response)).toEqual({ pairingCode: "ABCD-1234" });
      expect((pair?.body as { phone: string }).phone).toBe("5511999990001");

      for (const phone of ["+55 11 99999-0001", "123", ""]) {
        const invalid = await call("POST", `/api/channels/${seeded.id}/pair`, {
          ...as("owner"),
          body: { phone },
        });
        expect(invalid.status, phone).toBe(400);
      }
    });

    it("canal da Cloud API não tem QR nem código: 400", async () => {
      const cloud = await seedCloudChannel(tenantScope(tenantId), { name: "Oficial" });
      const response = await call("POST", `/api/channels/${cloud.id}/qr`, as("owner"));

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).code).toBe("UNSUPPORTED_FOR_CHANNEL");
      expect(evolution.calls).toHaveLength(0);
    });
  });

  describe("estado e ciclo de vida", () => {
    it("status: membro lê; em connecting pergunta ao servidor e grava a conexão", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connecting" });

      const waiting = await call("GET", `/api/channels/${seeded.id}/status`, as("member"));
      expect(waiting.status).toBe(200);
      expect(await bodyOf(waiting)).toMatchObject({ status: "connecting", identifier: null });

      const connected = fakeEvolution({
        "GET /instance/status": () => jsonResponse("evolution/api/status-connected"),
      });
      setProvidersForTests([connected.provider]);
      const done = await call("GET", `/api/channels/${seeded.id}/status`, as("member"));

      expect(await bodyOf(done)).toMatchObject({ status: "connected", statusDetail: null });
      expect(Object.keys(await bodyOf(done)).sort()).toEqual([
        "identifier",
        "lastSeenAt",
        "status",
        "statusDetail",
      ]);
      expect(await auditActions()).toContain("channel.connected");

      // Conectado: não consulta mais o servidor a cada leitura.
      const before = connected.calls.length;
      await call("GET", `/api/channels/${seeded.id}/status`, as("member"));
      expect(connected.calls.length).toBe(before);
    });

    it("status com o servidor fora do ar responde o que está gravado", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connecting" });
      const down = fakeEvolution({ "GET /instance/status": () => new Response("", { status: 500 }) });
      setProvidersForTests([down.provider]);

      const response = await call("GET", `/api/channels/${seeded.id}/status`, as("owner"));

      expect(response.status).toBe(200);
      expect((await bodyOf(response)).status).toBe("connecting");
    });

    it("desconectar, reconectar e logout mudam o estado e auditam", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });
      const act = async (action: string) => {
        const response = await call("POST", `/api/channels/${seeded.id}/${action}`, as("admin"));
        const body = (await bodyOf(response)) as unknown as ViewBody;

        expect(response.status, action).toBe(200);
        expect(JSON.stringify(body)).not.toMatch(/_enc|Enc"|instanceToken|webhookSecret/);
        return body.channel.status;
      };

      expect(await act("disconnect")).toBe("disconnected");
      expect(await act("reconnect")).toBe("connecting");
      expect(await act("logout")).toBe("disconnected");

      expect(evolution.calls.map((item) => `${item.method} ${item.path}`)).toEqual([
        "POST /instance/disconnect",
        "POST /instance/reconnect",
        "DELETE /instance/logout",
      ]);
      expect(evolution.calls.every((item) => item.key === FIXTURE_TOKEN)).toBe(true);
      expect((await auditActions()).sort()).toEqual([
        "channel.disconnected",
        "channel.disconnected",
        "channel.updated",
      ]);
    });

    it("falha do servidor na ação: 503 e o estado não muda", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });
      const down = fakeEvolution({ "POST /instance/disconnect": () => new Response("", { status: 500 }) });
      setProvidersForTests([down.provider]);

      const response = await call("POST", `/api/channels/${seeded.id}/disconnect`, as("owner"));

      expect(response.status).toBe(503);
      expect((await channelOf(seeded.id))?.status).toBe("connected");
    });

    it("ajustes avançados: lista fechada, gravados depois de o servidor aceitar", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });
      const path = `/api/channels/${seeded.id}/advanced-settings`;
      const response = await call("PATCH", path, {
        ...as("owner"),
        body: { advancedSettings: { alwaysOnline: true, rejectCall: false } },
      });
      const body = (await bodyOf(response)) as { channel: { advancedSettings: unknown } };

      expect(response.status).toBe(200);
      expect(body.channel.advancedSettings).toEqual({ alwaysOnline: true, rejectCall: false });
      expect(evolution.called("PUT", "/instance/")[0]?.body).toEqual({
        alwaysOnline: true,
        rejectCall: false,
      });

      for (const invalid of [
        { advancedSettings: {} },
        { advancedSettings: { webhookUrl: "https://evil.test" } },
        { advancedSettings: { alwaysOnline: "sim" } },
        { name: "x" },
      ]) {
        const refused = await call("PATCH", path, { ...as("owner"), body: invalid });
        expect(refused.status, JSON.stringify(invalid)).toBe(400);
      }
      expect(evolution.called("PUT", "/instance/")).toHaveLength(1);
    });

    it("remover apaga antes a instância no servidor; se o servidor falha, o canal fica", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { name: "Some" });
      const down = fakeEvolution({ "DELETE /instance/delete": () => new Response("", { status: 500 }) });
      setProvidersForTests([down.provider]);

      const failed = await call("DELETE", `/api/channels/${seeded.id}`, {
        ...as("owner"),
        body: { confirm: "Some" },
      });
      expect(failed.status).toBe(503);
      expect(await channelOf(seeded.id)).toBeDefined();

      setProvidersForTests([evolution.provider]);
      const removed = await call("DELETE", `/api/channels/${seeded.id}`, {
        ...as("owner"),
        body: { confirm: "Some" },
      });
      const [deleted] = evolution.called("DELETE", "/instance/delete/");

      expect(await bodyOf(removed)).toEqual({ outcome: "deleted" });
      expect(deleted?.key).toBe(GLOBAL_KEY);
      expect(await channelOf(seeded.id)).toBeUndefined();
    });
  });

  describe("autorização", () => {
    const writes = (id: string) =>
      [
        ["POST", "/api/channels/whatsapp-qr", { name: "Hack" }],
        ["POST", `/api/channels/${id}/qr`, undefined],
        ["POST", `/api/channels/${id}/pair`, { phone: "5511999990001" }],
        ["POST", `/api/channels/${id}/disconnect`, undefined],
        ["POST", `/api/channels/${id}/logout`, undefined],
        ["POST", `/api/channels/${id}/reconnect`, undefined],
        ["PATCH", `/api/channels/${id}/advanced-settings`, { advancedSettings: { alwaysOnline: true } }],
      ] as const;

    it("membro só lê: 403 em toda escrita, sem chamar o servidor", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });

      for (const [method, path, body] of writes(seeded.id)) {
        const response = await call(method, path, { ...as("member"), body });

        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await bodyOf(response)).code).toBe("PERMISSION_DENIED");
      }
      expect(evolution.calls).toHaveLength(0);
      expect((await channelOf(seeded.id))?.status).toBe("connected");
    });

    it("canal de outro tenant: 404 em tudo, igual a inexistente, sem chamar o servidor", async () => {
      const theirs = await seedFixtureChannel(tenantScope(otherTenantId), { status: "connected" });
      const routes = [
        ...writes(theirs.id).slice(1),
        ["GET", `/api/channels/${theirs.id}/status`, undefined] as const,
      ];

      for (const [method, path, body] of routes) {
        const response = await call(method, path, { ...as("owner"), body });
        const missing = await call(method, path.replace(theirs.id, crypto.randomUUID()), {
          ...as("owner"),
          body,
        });

        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await bodyOf(response)).toEqual(await bodyOf(missing));
      }
      expect(evolution.calls).toHaveLength(0);
      expect((await channelOf(theirs.id))?.status).toBe("connected");
    });

    it("sem sessão: 401", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId));

      for (const [method, path, body] of writes(seeded.id)) {
        expect((await call(method, path, { body })).status, `${method} ${path}`).toBe(401);
      }
      expect((await call("GET", `/api/channels/${seeded.id}/status`)).status).toBe(401);
    });

    it("a lista não traz token, segredo nem coluna _enc do canal QR", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });
      const text = JSON.stringify(await bodyOf(await call("GET", "/api/channels", as("member"))));

      expect(text).toContain(seeded.id);
      expect(text).not.toContain(FIXTURE_TOKEN);
      expect(text).not.toContain(seeded.webhookSecret);
      expect(text).not.toMatch(/_enc|Enc"|instanceToken|webhookSecret|remoteInstance/);
    });
  });

  describe("envio e saúde", () => {
    it("envio por canal não conectado: 409 CHANNEL_NOT_CONNECTED, sem chamar o servidor", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "disconnected" });
      const error = await sendChannelText(tenantScope(tenantId), seeded.id, {
        to: "5511988880001",
        text: "Olá",
      }).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(TenantRuleError);
      expect(error).toMatchObject({ status: 409, code: "CHANNEL_NOT_CONNECTED" });
      expect(evolution.calls).toHaveLength(0);
    });

    it("envio por canal conectado usa o token da instância; de outro tenant, 404", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });
      const sending = fakeEvolution({
        "POST /send/text": () => jsonResponse("evolution/api/send-text-ok"),
      });
      setProvidersForTests([sending.provider]);

      await expect(
        sendChannelText(tenantScope(tenantId), seeded.id, { to: "5511988880001", text: "Olá" }),
      ).resolves.toEqual({ providerMessageId: "3EB0SENT0001" });
      expect(sending.calls[0]?.key).toBe(FIXTURE_TOKEN);

      await expect(
        sendChannelText(tenantScope(otherTenantId), seeded.id, { to: "5511988880001", text: "Olá" }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("channel.health: o probe grava a queda do canal por QR Code", async () => {
      const seeded = await seedFixtureChannel(tenantScope(tenantId), { status: "connected" });
      const dropped = fakeEvolution({
        "GET /instance/status": () => jsonResponse("evolution/api/status-disconnected"),
      });
      setProvidersForTests([dropped.provider]);

      await checkChannelsHealth();

      expect(await channelOf(seeded.id)).toMatchObject({
        status: "disconnected",
        statusDetail: "Desconectado.",
      });
    });
  });
});
