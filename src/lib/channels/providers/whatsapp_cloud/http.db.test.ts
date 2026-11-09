import { createHmac, randomInt } from "node:crypto";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/app";
import {
  processChannelEvent,
  setChannelQueueForTests,
  setInboxHandlers,
} from "@/lib/channels/events";
import { createCloudProvider } from "@/lib/channels/providers/whatsapp_cloud";
import { setProvidersForTests } from "@/lib/channels/registry";
import { fixture, fixtureText, jsonResponse } from "@/lib/channels/test-fixtures";
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
  TEST_APP_SECRET,
  TEST_TOKEN,
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
 * Webhook e rotas do WhatsApp Cloud pela API, com Postgres real e a Meta simulada pelas
 * fixtures (`tests/fixtures/channels/cloud/`). Mora na pasta do módulo para sumir com ela.
 */

const PHONE_A = "200000000000001";
const PHONE_B = "200000000000002";
const WABA = "100000000000001";
const VERIFY_TOKEN = "token-de-verificacao";
const NEW_SECRET = "outro-segredo-do-aplicativo";

const sign = (body: string, secret = TEST_APP_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const ip = () => `10.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`;

function postWebhook(key: string, body: string, headers: Record<string, string> = {}) {
  return api.request(`/api/webhooks/whatsapp/cloud/${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip(), ...headers },
    body,
  });
}

function getWebhook(key: string, query: Record<string, string>, from = ip()) {
  return api.request(`/api/webhooks/whatsapp/cloud/${key}?${new URLSearchParams(query)}`, {
    headers: { "X-Forwarded-For": from },
  });
}

type MetaStub = {
  phone?: () => Response;
  subscribe?: () => Response;
  subscribedApps?: () => Response;
  register?: () => Response;
  templates?: (after: string | null) => Response;
};

const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });

/** `fetch` da Graph API, roteado pelo caminho. Guarda as chamadas para conferir. */
function stubMeta(stub: MetaStub = {}) {
  const calls: Array<{ method: string; path: string; auth: string | null }> = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ method, path: url.pathname, auth });

      if (url.pathname.endsWith("/register")) return (stub.register ?? ok)();
      if (url.pathname.endsWith("/subscribed_apps")) {
        return method === "POST"
          ? (stub.subscribe ?? ok)()
          : (stub.subscribedApps ?? (() => jsonResponse("cloud/api/subscribed-apps")))();
      }
      if (url.pathname.endsWith("/message_templates")) {
        return (stub.templates ?? (() => jsonResponse("cloud/api/templates-page2")))(
          url.searchParams.get("after"),
        );
      }
      return (stub.phone ?? (() => jsonResponse("cloud/api/phone-info")))();
    }),
  );

  return calls;
}

const invalidToken = () => jsonResponse("cloud/api/error-invalid-token", 401);

describe("WhatsApp Cloud pela API", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  const users: Record<string, TestUser> = {};
  const queued: string[] = [];

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

  const eventsOf = (channelId: string) =>
    sql<{ id: string; status: string; kind: string }>(
      (tx) => tx`select id, status, kind from channel_event where channel_id = ${channelId}`,
    );

  const cookie = (role: string) => users[role]?.cookie;

  const newChannelBody = (overrides: Record<string, unknown> = {}) => ({
    name: "Atendimento",
    phoneNumberId: PHONE_A,
    wabaId: WABA,
    accessToken: "EAAB-token-novo-de-teste-9876",
    appSecret: NEW_SECRET,
    ...overrides,
  });

  beforeAll(async () => {
    owner = connectOwner();

    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;
    users.other = await createUser(owner);
    otherTenantId = (await createTenant(users.other, "Outra Clínica")).id;

    // Os limites de taxa são por usuário: os testes com muitas chamadas usam admins próprios.
    for (const [key, role] of [
      ["admin", "admin"],
      ["admin2", "admin"],
      ["admin3", "admin"],
      ["member", "member"],
    ] as const) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, role);
      users[key] = user;
    }

    // Folga no plano: o limite tem teste próprio.
    const plan = await createPlanRow(owner, { isFree: false, limits: {} });
    await ensureSubscription(owner, tenantId, plan.id);
    await ensureSubscription(owner, otherTenantId, plan.id);
  });

  beforeEach(() => {
    queued.length = 0;
    setProvidersForTests([createCloudProvider()]);
    setChannelQueueForTests(async (id) => {
      queued.push(id);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setProvidersForTests(undefined);
    setChannelQueueForTests(undefined);
    setInboxHandlers({});
    await sql(async (tx) => {
      await tx`delete from message_template where tenant_id in (${tenantId}, ${otherTenantId})`;
      return tx`delete from channel where tenant_id in (${tenantId}, ${otherTenantId})`;
    });
  });

  afterAll(async () => {
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await cleanUpBilling(owner);
    await owner.end();
  });

  // -------------------------------------------------------------------------
  describe("webhook", () => {
    it("GET: token certo devolve o desafio em texto e marca webhook_verified_at", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));

      const response = await getWebhook(seeded.webhookKey, {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "desafio-123",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("desafio-123");
      expect((await cloudRow(seeded.id))?.webhook_verified_at).not.toBeNull();
    });

    it("GET: token errado e chave desconhecida respondem igual (403) e nada é marcado", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const query = { "hub.mode": "subscribe", "hub.verify_token": "errado", "hub.challenge": "x" };

      const wrongToken = await getWebhook(seeded.webhookKey, query);
      const unknownKey = await getWebhook("0".repeat(32), { ...query, "hub.verify_token": VERIFY_TOKEN });
      const wrongMode = await getWebhook(seeded.webhookKey, {
        ...query,
        "hub.mode": "unsubscribe",
        "hub.verify_token": VERIFY_TOKEN,
      });

      expect([wrongToken.status, unknownKey.status, wrongMode.status]).toEqual([403, 403, 403]);
      expect(await wrongToken.text()).toBe(await unknownKey.text());
      expect((await cloudRow(seeded.id))?.webhook_verified_at).toBeNull();
    });

    it("POST assinado grava o aviso pending e enfileira o job", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: PHONE_A });
      const body = fixtureText("cloud/message-text");

      const response = await postWebhook(seeded.webhookKey, body, {
        "X-Hub-Signature-256": sign(body),
      });

      expect(response.status).toBe(200);
      expect(await bodyOf(response)).toEqual({ received: true });

      const events = await eventsOf(seeded.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: "pending", kind: "message" });
      expect(queued).toEqual([events[0]?.id]);
    });

    it("assinatura adulterada, ausente ou de outro segredo: 401 e nada é gravado", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const body = fixtureText("cloud/message-text");
      const tampered = body.replace("wamid", "wamiD");

      const responses = await Promise.all([
        postWebhook(seeded.webhookKey, tampered, { "X-Hub-Signature-256": sign(body) }),
        postWebhook(seeded.webhookKey, body),
        postWebhook(seeded.webhookKey, body, { "X-Hub-Signature-256": sign(body, "outro-segredo") }),
        postWebhook(seeded.webhookKey, body, { "X-Hub-Signature-256": "sha256=00" }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
      expect(queued).toEqual([]);
    });

    it("chave desconhecida responde igual a assinatura errada", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const body = fixtureText("cloud/message-text");

      const unknown = await postWebhook("f".repeat(32), body, { "X-Hub-Signature-256": sign(body) });
      const wrong = await postWebhook(seeded.webhookKey, body, { "X-Hub-Signature-256": "sha256=00" });

      expect(unknown.status).toBe(401);
      expect(await unknown.text()).toBe(await wrong.text());
    });

    it("corpo que não é JSON só é recusado depois da assinatura (400), sem gravar", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const body = "isto não é json";

      const unsigned = await postWebhook(seeded.webhookKey, body);
      const signed = await postWebhook(seeded.webhookKey, body, { "X-Hub-Signature-256": sign(body) });

      expect([unsigned.status, signed.status]).toEqual([401, 400]);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
    });

    it("aviso repetido não duplica; depois de tratado, não volta à fila", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: PHONE_A });
      const body = fixtureText("cloud/message-text");
      const send = () => postWebhook(seeded.webhookKey, body, { "X-Hub-Signature-256": sign(body) });

      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);

      const events = await eventsOf(seeded.id);
      expect(events).toHaveLength(1);
      // Ainda `pending`: o reenvio só reenfileira o mesmo aviso.
      expect(queued).toEqual([events[0]?.id, events[0]?.id]);

      await processChannelEvent(events[0]?.id ?? "");
      queued.length = 0;

      expect((await send()).status).toBe(200);
      expect(await eventsOf(seeded.id)).toHaveLength(1);
      expect(queued).toEqual([]);
    });

    it("acima de 3 MB: 413", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const body = JSON.stringify({ filler: "x".repeat(3 * 1024 * 1024 + 10) });

      const response = await postWebhook(seeded.webhookKey, body, {
        "X-Hub-Signature-256": sign(body),
        "Content-Length": String(Buffer.byteLength(body)),
      });

      expect(response.status).toBe(413);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
    });

    it("canal desativado responde 200 e descarta", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { status: "disabled" });
      const body = fixtureText("cloud/message-text");

      const response = await postWebhook(seeded.webhookKey, body);

      expect(response.status).toBe(200);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
      expect(queued).toEqual([]);
    });

    it("aviso assinado pelo tenant A citando número do tenant B não toca em B", async () => {
      const a = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: PHONE_A });
      const b = await seedCloudChannel(tenantScope(otherTenantId), { phoneNumberId: PHONE_B });
      const targets: string[] = [];
      setInboxHandlers({
        message: async (_tx, _scope, target) => {
          targets.push(target.id);
          return true;
        },
      });
      const body = fixtureText("cloud/two-numbers-same-waba");

      const response = await postWebhook(a.webhookKey, body, { "X-Hub-Signature-256": sign(body) });
      expect(response.status).toBe(200);
      await processChannelEvent(queued[0] ?? "");

      expect(targets).toEqual([a.id]);
      expect(await eventsOf(b.id)).toHaveLength(0);
    });

    it("muitas assinaturas inválidas do mesmo IP: 429, mesmo com a assinatura certa depois", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const body = fixtureText("cloud/message-text");
      const from = { "X-Forwarded-For": ip() };

      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await postWebhook(seeded.webhookKey, body, from);
        expect(response.status).toBe(401);
      }

      const blocked = await postWebhook(seeded.webhookKey, body, {
        ...from,
        "X-Hub-Signature-256": sign(body),
      });
      expect(blocked.status).toBe(429);
      expect(await eventsOf(seeded.id)).toHaveLength(0);
    });

    it("módulo desligado: o webhook responde 503 e as rotas da Cloud, 404", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      setProvidersForTests([]);
      const body = fixtureText("cloud/message-text");

      const hook = await postWebhook(seeded.webhookKey, body, { "X-Hub-Signature-256": sign(body) });
      const route = await call("GET", `/api/channels/${seeded.id}/webhook`, { cookie: cookie("owner") });

      expect(hook.status).toBe(503);
      expect(route.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("salvar um número", () => {
    const create = (body: unknown, role = "owner") =>
      call("POST", "/api/channels/whatsapp-cloud", { cookie: cookie(role), body });

    it("verifica na Meta, assina o WABA e grava tudo cifrado; a resposta não traz segredo", async () => {
      const calls = stubMeta();
      const input = newChannelBody({ appId: "500000000000001" });

      const response = await create(input);
      const body = await bodyOf(response);
      const text = JSON.stringify(body);

      expect(response.status).toBe(201);
      expect(body.channel).toMatchObject({
        type: "whatsapp_cloud",
        name: "Atendimento",
        status: "connected",
        isDefault: true,
        identifier: "+55 11 99999-0001",
        phoneNumberId: PHONE_A,
        wabaId: WABA,
        verifiedName: "Empresa Exemplo",
        qualityRating: "GREEN",
      });
      const webhook = body.webhook as { url: string; verifyToken: string };
      expect(webhook.url).toMatch(
        /^http:\/\/localhost:5173\/api\/webhooks\/whatsapp\/cloud\/[0-9a-f]{32}$/,
      );
      expect(webhook.verifyToken).toMatch(/^[0-9a-f]{48}$/);
      expect(text).not.toContain(input.accessToken);
      expect(text).not.toContain(input.appSecret);
      expect(text).not.toMatch(/_enc|Enc"/);

      // Ordem: confere o número, depois assina o WABA; sempre com o token informado.
      expect(calls.map((item) => `${item.method} ${item.path.split("/").slice(2).join("/")}`)).toEqual([
        `GET ${PHONE_A}`,
        `POST ${WABA}/subscribed_apps`,
      ]);
      expect(calls.every((item) => item.auth === `Bearer ${input.accessToken}`)).toBe(true);

      const id = (body.channel as { id: string }).id;
      const row = await cloudRow(id);
      expect(row?.access_token_enc).not.toContain(input.accessToken);
      expect(row?.app_secret_enc).not.toContain(input.appSecret);
      expect(row?.verify_token_enc).not.toContain(webhook.verifyToken);
      expect(row?.subscribed_at).not.toBeNull();

      const audit = await sql<{ action: string; metadata: unknown }>(
        (tx) => tx`select action, metadata from audit_log where target_id = ${id}`,
      );
      expect(audit.map((item) => item.action)).toEqual(["channel.created"]);
      expect(JSON.stringify(audit)).not.toContain(input.accessToken);

      // O endereço e o token devolvidos funcionam de ponta a ponta.
      const key = webhook.url.split("/").at(-1) ?? "";
      const verified = await getWebhook(key, {
        "hub.mode": "subscribe",
        "hub.verify_token": webhook.verifyToken,
        "hub.challenge": "ok",
      });
      expect(verified.status).toBe(200);

      const event = fixtureText("cloud/message-text");
      const signed = await postWebhook(key, event, { "X-Hub-Signature-256": sign(event, NEW_SECRET) });
      expect(signed.status).toBe(200);
    });

    it("recusa da Meta vira 400 META_REJECTED com a mensagem dela, e nada é gravado", async () => {
      stubMeta({ phone: invalidToken });

      const response = await create(newChannelBody());
      const body = await bodyOf(response);

      expect(response.status).toBe(400);
      expect(body.code).toBe("META_REJECTED");
      expect(body.error).toMatch(/^\(#190\)/);
      expect(await sql((tx) => tx`select id from channel where tenant_id = ${tenantId}`)).toHaveLength(0);
    });

    it("Meta fora do ar: 503 PROVIDER_UNAVAILABLE, nada gravado", async () => {
      stubMeta({ phone: () => new Response("down", { status: 503 }) });

      const response = await create(newChannelBody());

      expect(response.status).toBe(503);
      expect((await bodyOf(response)).code).toBe("PROVIDER_UNAVAILABLE");
      expect(await sql((tx) => tx`select id from channel where tenant_id = ${tenantId}`)).toHaveLength(0);
    });

    it("falha ao assinar o WABA: nada é gravado", async () => {
      stubMeta({ subscribe: () => jsonResponse("cloud/api/error-user-msg", 400) });

      const response = await create(newChannelBody());

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).code).toBe("META_REJECTED");
      expect(await sql((tx) => tx`select id from channel where tenant_id = ${tenantId}`)).toHaveLength(0);
    });

    it("número já usado em outro tenant: 409 PHONE_NUMBER_IN_USE, sem dizer por quem", async () => {
      const theirs = await seedCloudChannel(tenantScope(otherTenantId), {
        phoneNumberId: PHONE_A,
        name: "Segredo Alheio",
      });
      stubMeta();

      const response = await create(newChannelBody());
      const text = JSON.stringify(await bodyOf(response));

      expect(response.status).toBe(409);
      expect(text).toContain("PHONE_NUMBER_IN_USE");
      expect(text).not.toContain(theirs.id);
      expect(text).not.toContain(otherTenantId);
      expect(text).not.toContain("Segredo Alheio");
    });

    it("número já ativo no próprio tenant também é 409", async () => {
      await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: PHONE_A });
      stubMeta();

      expect((await create(newChannelBody())).status).toBe(409);
    });

    it("token inválido não revela que o número já está em uso", async () => {
      await seedCloudChannel(tenantScope(otherTenantId), { phoneNumberId: PHONE_A });
      stubMeta({ phone: invalidToken });

      const response = await create(newChannelBody());

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).code).toBe("META_REJECTED");
    });

    it("readota o canal desativado do mesmo número, com o mesmo id e endereço novo", async () => {
      const old = await seedCloudChannel(tenantScope(tenantId), {
        phoneNumberId: PHONE_A,
        status: "disabled",
        name: "Antigo",
      });
      await sql(
        (tx) => tx`
          update channel_whatsapp_cloud
          set access_token_enc = null, app_secret_enc = null, verify_token_enc = null
          where channel_id = ${old.id}`,
      );
      stubMeta();

      const response = await create(newChannelBody({ name: "De Volta" }));
      const body = await bodyOf(response);

      expect(response.status).toBe(201);
      expect(body.channel).toMatchObject({ id: old.id, name: "De Volta", status: "connected", isDefault: true });
      expect((body.webhook as { url: string }).url).not.toContain(old.webhookKey);

      const event = fixtureText("cloud/message-text");
      const oldKey = await postWebhook(old.webhookKey, event, {
        "X-Hub-Signature-256": sign(event, NEW_SECRET),
      });
      expect(oldKey.status).toBe(401);
    });

    it("no limite do plano: 403 PLAN_LIMIT_REACHED antes de chamar a Meta", async () => {
      const limited = await createUser(owner);
      const limitedTenant = (await createTenant(limited, "Limitada")).id;
      const plan = await createPlanRow(owner, { isFree: false, limits: { channels_whatsapp_cloud: 1 } });
      await ensureSubscription(owner, limitedTenant, plan.id);
      await seedCloudChannel(tenantScope(limitedTenant));
      const calls = stubMeta();

      try {
        const response = await call("POST", "/api/channels/whatsapp-cloud", {
          cookie: limited.cookie,
          body: newChannelBody(),
        });

        expect(response.status).toBe(403);
        expect((await bodyOf(response)).code).toBe("PLAN_LIMIT_REACHED");
        expect(calls).toHaveLength(0);
      } finally {
        await sql((tx) => tx`delete from channel where tenant_id = ${limitedTenant}`);
      }
    });

    it("PIN informado registra o número antes de assinar", async () => {
      const calls = stubMeta();

      const response = await create(newChannelBody({ pin: "123456" }));

      expect(response.status).toBe(201);
      expect(calls.map((item) => item.path.split("/").slice(2).join("/"))).toEqual([
        PHONE_A,
        `${PHONE_A}/register`,
        `${WABA}/subscribed_apps`,
      ]);
      const id = ((await bodyOf(response)).channel as { id: string }).id;
      expect((await cloudRow(id))?.registered_at).not.toBeNull();
    });

    it("validação: segredo do aplicativo é obrigatório; ids só com números; campo extra recusado", async () => {
      const calls = stubMeta();
      const invalid = [
        newChannelBody({ appSecret: undefined }),
        newChannelBody({ appSecret: "" }),
        newChannelBody({ accessToken: "" }),
        newChannelBody({ phoneNumberId: "123/../456" }),
        newChannelBody({ wabaId: "abc" }),
        newChannelBody({ name: "" }),
        newChannelBody({ tenantId: otherTenantId }),
        newChannelBody({ pin: "12" }),
      ];

      for (const body of invalid) {
        expect((await create(body, "admin")).status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("editar", () => {
    const patch = (id: string, body: unknown, role = "owner") =>
      call("PATCH", `/api/channels/${id}`, { cookie: cookie(role), body });

    it("app_secret e token ausentes ou vazios mantêm o gravado, sem chamar a Meta", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { name: "Antes" });
      const before = await cloudRow(seeded.id);
      const calls = stubMeta();

      const response = await patch(seeded.id, {
        name: "Depois",
        appId: "500000000000001",
        accessToken: "",
        appSecret: "   ",
        pin: "",
      });

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(0);

      const after = await cloudRow(seeded.id);
      expect(after?.app_secret_enc).toBe(before?.app_secret_enc);
      expect(after?.access_token_enc).toBe(before?.access_token_enc);
      expect(after?.verify_token_enc).toBe(before?.verify_token_enc);
      expect(after?.webhook_key).toBe(before?.webhook_key);
      expect(after?.app_id).toBe("500000000000001");

      // O segredo antigo segue valendo no webhook.
      const event = fixtureText("cloud/message-text");
      const signed = await postWebhook(seeded.webhookKey, event, { "X-Hub-Signature-256": sign(event) });
      expect(signed.status).toBe(200);

      const listed = (await bodyOf(await call("GET", "/api/channels", { cookie: cookie("owner") })))
        .channels as Array<{ id: string; name: string }>;
      expect(listed.find((item) => item.id === seeded.id)?.name).toBe("Depois");
    });

    it("segredo do aplicativo novo passa a valer; o antigo deixa de assinar", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      stubMeta();

      const response = await patch(seeded.id, { appSecret: NEW_SECRET });
      expect(response.status).toBe(200);
      expect(JSON.stringify(await bodyOf(response))).not.toContain(NEW_SECRET);

      const event = fixtureText("cloud/message-text");
      const oldSecret = await postWebhook(seeded.webhookKey, event, { "X-Hub-Signature-256": sign(event) });
      const newSecret = await postWebhook(seeded.webhookKey, event, {
        "X-Hub-Signature-256": sign(event, NEW_SECRET),
      });
      expect([oldSecret.status, newSecret.status]).toEqual([401, 200]);
    });

    it("token novo é conferido na Meta antes de gravar; recusado não muda nada", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { phoneNumberId: PHONE_A });
      const before = await cloudRow(seeded.id);

      stubMeta({ phone: invalidToken });
      const rejected = await patch(seeded.id, { accessToken: "EAAB-token-recusado-000" });
      expect(rejected.status).toBe(400);
      expect((await bodyOf(rejected)).code).toBe("META_REJECTED");
      expect((await cloudRow(seeded.id))?.access_token_enc).toBe(before?.access_token_enc);

      const calls = stubMeta();
      const accepted = await patch(seeded.id, { accessToken: "EAAB-token-aceito-111" });
      expect(accepted.status).toBe(200);
      expect(calls[0]).toMatchObject({ auth: "Bearer EAAB-token-aceito-111" });
      expect((await cloudRow(seeded.id))?.access_token_enc).not.toBe(before?.access_token_enc);
    });

    it("campo do QR Code em canal oficial e canal desativado são recusados", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const disabled = await seedCloudChannel(tenantScope(tenantId), { status: "disabled" });

      const wrongField = await patch(seeded.id, { advancedSettings: { rejectCall: true } });
      const onDisabled = await patch(disabled.id, { appSecret: NEW_SECRET });

      expect(wrongField.status).toBe(400);
      expect(onDisabled.status).toBe(409);
      expect((await bodyOf(onDisabled)).code).toBe("CHANNEL_DISABLED");
    });

    it("campo de Cloud em canal de QR Code sem editor do módulo: 400", async () => {
      const qr = await seedQrChannel(tenantScope(tenantId));

      const response = await patch(qr.id, { appSecret: NEW_SECRET });

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  describe("endereço de webhook", () => {
    it("mostra o endereço e o token; gerar novo invalida o antigo", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      await getWebhook(seeded.webhookKey, {
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "x",
      });

      const shown = await call("GET", `/api/channels/${seeded.id}/webhook`, { cookie: cookie("admin") });
      expect(shown.status).toBe(200);
      expect(shown.headers.get("cache-control")).toBe("no-store");
      expect(await bodyOf(shown)).toEqual({
        url: `http://localhost:5173/api/webhooks/whatsapp/cloud/${seeded.webhookKey}`,
        verifyToken: VERIFY_TOKEN,
      });

      const rotated = await call("POST", `/api/channels/${seeded.id}/webhook/rotate`, {
        cookie: cookie("admin"),
      });
      const next = (await bodyOf(rotated)) as { url: string; verifyToken: string };
      expect(rotated.status).toBe(200);
      expect(next.url).not.toContain(seeded.webhookKey);
      expect(next.verifyToken).not.toBe(VERIFY_TOKEN);
      expect((await cloudRow(seeded.id))?.webhook_verified_at).toBeNull();

      const event = fixtureText("cloud/message-text");
      const headers = { "X-Hub-Signature-256": sign(event) };
      const oldKey = await postWebhook(seeded.webhookKey, event, headers);
      const newKey = await postWebhook(next.url.split("/").at(-1) ?? "", event, headers);
      expect([oldKey.status, newKey.status]).toEqual([401, 200]);

      const audit = await sql<{ action: string }>(
        (tx) => tx`select action from audit_log where target_id = ${seeded.id}`,
      );
      expect(audit.map((item) => item.action)).toContain("channel.webhook_rotated");
    });
  });

  // -------------------------------------------------------------------------
  describe("diagnóstico", () => {
    const test = (id: string) => call("POST", `/api/channels/${id}/test`, { cookie: cookie("owner") });
    const statusOf = async (id: string) =>
      (await sql<{ status: string }>((tx) => tx`select status from channel where id = ${id}`))[0]?.status;

    it("tudo certo: cada conferência ok e o canal em erro volta a connected", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { status: "error" });
      stubMeta();

      const response = await test(seeded.id);
      const body = (await bodyOf(response)) as {
        status: string;
        checks: Array<{ id: string; ok: boolean; detail?: string }>;
      };

      expect(response.status).toBe(200);
      expect(body.status).toBe("connected");
      expect(Object.fromEntries(body.checks.map((check) => [check.id, check.ok]))).toEqual({
        credentials_readable: true,
        token_valid: true,
        phone_reachable: true,
        waba_subscribed: true,
        webhook_verified: false,
        last_event_at: false,
      });
      expect(await statusOf(seeded.id)).toBe("connected");
    });

    it("recusa da Meta marca o canal error; indisponibilidade não muda o estado", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));

      stubMeta({ phone: () => new Response("down", { status: 503 }) });
      const transient = (await bodyOf(await test(seeded.id))) as { status: string };
      expect(transient.status).toBe("connected");
      expect(await statusOf(seeded.id)).toBe("connected");

      stubMeta({ phone: invalidToken });
      const rejected = (await bodyOf(await test(seeded.id))) as {
        status: string;
        checks: Array<{ id: string; ok: boolean; detail?: string }>;
      };
      expect(rejected.status).toBe("error");
      expect(rejected.checks.find((check) => check.id === "token_valid")).toMatchObject({
        ok: false,
        detail: expect.stringMatching(/^\(#190\)/),
      });
      expect(await statusOf(seeded.id)).toBe("error");
    });
  });

  // -------------------------------------------------------------------------
  describe("modelos", () => {
    const sync = (id: string, role = "owner") =>
      call("POST", `/api/channels/${id}/templates/sync`, { cookie: cookie(role) });
    const list = (id: string, query = "", role = "member") =>
      call("GET", `/api/channels/${id}/templates${query}`, { cookie: cookie(role) });

    it("sincroniza todas as páginas, atualiza e apaga o que sumiu na Meta", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { wabaId: WABA });
      stubMeta({
        templates: (after) =>
          jsonResponse(after ? "cloud/api/templates-page2" : "cloud/api/templates-page1"),
      });

      const first = await sync(seeded.id);
      expect(first.status).toBe(200);
      expect(await bodyOf(first)).toEqual({ synced: 2, removed: 0 });

      const listed = (await bodyOf(await list(seeded.id))) as {
        templates: Array<{ name: string; status: string }>;
        syncedAt: string | null;
      };
      expect(listed.templates.map((item) => [item.name, item.status])).toEqual([
        ["boas_vindas", "APPROVED"],
        ["promo", "REJECTED"],
      ]);
      expect(listed.syncedAt).not.toBeNull();

      const filtered = (await bodyOf(await list(seeded.id, "?status=approved"))) as {
        templates: Array<{ name: string }>;
      };
      expect(filtered.templates.map((item) => item.name)).toEqual(["boas_vindas"]);

      // Agora a Meta só tem `promo`: `boas_vindas` sai daqui.
      stubMeta();
      const second = await sync(seeded.id);
      expect(await bodyOf(second)).toEqual({ synced: 1, removed: 1 });
    });

    it("modelos são do escopo: o outro tenant, com o mesmo WABA, não os vê nem os perde", async () => {
      const mine = await seedCloudChannel(tenantScope(tenantId), { wabaId: WABA });
      const theirs = await seedCloudChannel(tenantScope(otherTenantId), { wabaId: WABA });
      stubMeta({
        templates: (after) =>
          jsonResponse(after ? "cloud/api/templates-page2" : "cloud/api/templates-page1"),
      });
      await call("POST", `/api/channels/${theirs.id}/templates/sync`, { cookie: cookie("other") });

      stubMeta();
      expect(await bodyOf(await sync(mine.id))).toEqual({ synced: 1, removed: 0 });

      const rows = await sql<{ tenant_id: string }>(
        (tx) => tx`select tenant_id from message_template where waba_id = ${WABA}`,
      );
      expect(rows.filter((row) => row.tenant_id === otherTenantId)).toHaveLength(2);
      expect(rows.filter((row) => row.tenant_id === tenantId)).toHaveLength(1);
    });

    it("status do modelo por aviso atualiza o modelo sincronizado", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId), { wabaId: WABA, phoneNumberId: PHONE_A });
      stubMeta({ templates: () => jsonResponse("cloud/api/templates-page2") });
      await sync(seeded.id);
      await sql(
        (tx) => tx`
          update message_template set status = 'PENDING', provider_template_id = '400000000000001', name = 'boas_vindas'
          where tenant_id = ${tenantId}`,
      );
      const event = JSON.stringify(fixture("cloud/template-status-approved"));

      const response = await postWebhook(seeded.webhookKey, event, { "X-Hub-Signature-256": sign(event) });
      expect(response.status).toBe(200);
      await expect(processChannelEvent(queued[0] ?? "")).resolves.toBe("processed");

      const listed = (await bodyOf(await list(seeded.id))) as { templates: Array<{ status: string }> };
      expect(listed.templates.map((item) => item.status)).toEqual(["APPROVED"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("autorização", () => {
    const routes = (id: string) =>
      [
        ["POST", "/api/channels/whatsapp-cloud", newChannelBody()],
        ["PATCH", `/api/channels/${id}`, { appSecret: NEW_SECRET }],
        ["GET", `/api/channels/${id}/webhook`, undefined],
        ["POST", `/api/channels/${id}/webhook/rotate`, undefined],
        ["POST", `/api/channels/${id}/test`, undefined],
        ["POST", `/api/channels/${id}/templates/sync`, undefined],
      ] as const;

    it("membro (só channel:read): 403 em tudo que gerencia, e lê os modelos", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      const before = await cloudRow(seeded.id);
      const calls = stubMeta();

      for (const [method, path, body] of routes(seeded.id)) {
        const response = await call(method, path, { cookie: cookie("member"), body });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await bodyOf(response)).code).toBe("PERMISSION_DENIED");
      }

      expect(calls).toHaveLength(0);
      expect(await cloudRow(seeded.id)).toEqual(before);
      expect(
        (await call("GET", `/api/channels/${seeded.id}/templates`, { cookie: cookie("member") })).status,
      ).toBe(200);
    });

    it("sem sessão: 401", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));

      for (const [method, path, body] of routes(seeded.id)) {
        expect((await call(method, path, { body })).status, `${method} ${path}`).toBe(401);
      }
    });

    it("canal de outro tenant: 404 em tudo, igual a inexistente, e nada muda", async () => {
      const theirs = await seedCloudChannel(tenantScope(otherTenantId));
      const before = await cloudRow(theirs.id);
      const calls = stubMeta();
      const missing = "00000000-0000-4000-8000-000000000000";

      for (const id of [theirs.id, missing]) {
        const perId = [...routes(id).slice(1), ["GET", `/api/channels/${id}/templates`, undefined] as const];

        for (const [method, path, body] of perId) {
          const response = await call(method, path, { cookie: cookie("admin2"), body });
          expect(response.status, `${method} ${path}`).toBe(404);
        }
      }

      expect(calls).toHaveLength(0);
      expect(await cloudRow(theirs.id)).toEqual(before);
    });

    it("canal de QR Code não tem endereço, diagnóstico nem modelos da Cloud: 404", async () => {
      const qr = await seedQrChannel(tenantScope(tenantId));

      for (const [method, path] of routes(qr.id).slice(2)) {
        expect((await call(method, path, { cookie: cookie("admin3") })).status, `${method} ${path}`).toBe(404);
      }
    });

    it("nenhuma resposta traz segredo, cifrado ou não", async () => {
      const seeded = await seedCloudChannel(tenantScope(tenantId));
      stubMeta();
      const responses = [
        await call("GET", "/api/channels", { cookie: cookie("admin3") }),
        await call("PATCH", `/api/channels/${seeded.id}`, { cookie: cookie("admin3"), body: { name: "Novo" } }),
        await call("POST", `/api/channels/${seeded.id}/test`, { cookie: cookie("admin3") }),
        await call("POST", `/api/channels/${seeded.id}/templates/sync`, { cookie: cookie("admin3") }),
        await call("GET", `/api/channels/${seeded.id}/templates`, { cookie: cookie("admin3") }),
      ];

      for (const response of responses) {
        const text = await response.text();

        expect(response.status).toBe(200);
        expect(text).not.toContain(TEST_TOKEN);
        expect(text).not.toContain(TEST_APP_SECRET);
        expect(text).not.toMatch(/_enc|Enc"|webhookKey|webhook_key/);
      }
    });
  });
});
