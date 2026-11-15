import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withPlatformScope } from "@/db/rls";
import { message } from "@/db/schema";
import { runRetention } from "@/lib/inbox/retention";
import { retentionConfigFromEnv } from "@/lib/inbox/retention-policy";
import { bodyOf, makePlatformUser } from "./billing-helpers";
import { cleanUpChannels, createTenantRow, seedCloudChannel, tenantScope } from "./channels-helpers";
import { seedConversation, seedMessage } from "./inbox-helpers";
import { call, cleanUp, connectOwner, createTenant, createUser, type TestUser } from "./tenant-helpers";

/**
 * `/api/admin/retention/*` (bloco R, R2): a política por organização e tipo de canal, a prévia e a
 * última execução, para a tela do `/admin` (R3b). Equipe da plataforma lê; só o proprietário grava,
 * com auditoria sem `tenant_id`; a prévia nunca apaga.
 */

const DAY = 86_400_000;
const valid = { maxMessages: 1000, retentionDays: 30, maxFavorites: 0 };

describe("/api/admin/retention", () => {
  let owner: postgres.Sql;
  let platformOwner: TestUser;
  let support: TestUser;
  let tenantOwner: TestUser;
  let tenantId: string;

  const base = () => `/api/admin/retention/tenants/${tenantId}`;
  const put = (user: TestUser | undefined, body: unknown, path = `${base()}/whatsapp_cloud`) =>
    call("PUT", path, { cookie: user?.cookie, body });
  const get = (user: TestUser | undefined, path: string) => call("GET", path, { cookie: user?.cookie });

  const bypass = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return fn(tx);
    }) as Promise<T>;

  beforeAll(async () => {
    owner = connectOwner();
    platformOwner = await makePlatformUser(owner, "platform_owner");
    support = await makePlatformUser(owner, "platform_support");
    tenantOwner = await createUser(owner);
    await createTenant(tenantOwner, "Clínica Retenção");
    tenantId = await createTenantRow(owner, "adm-ret");
  });

  afterEach(async () => {
    await bypass(async (tx) => {
      await tx`delete from chat_contact where tenant_id = ${tenantId}`;
      await tx`delete from channel where tenant_id = ${tenantId}`;
      await tx`delete from retention_policy where tenant_id = ${tenantId}`;
      await tx`delete from message_retention_state where tenant_id = ${tenantId}`;
      await tx`delete from audit_log where action = 'admin.retention_policy_updated' and target_id = ${tenantId}`;
    });
  });

  afterAll(async () => {
    await cleanUpChannels(owner, [tenantId]);
    await cleanUp(owner);
    await owner.end();
  });

  describe("acesso", () => {
    const reads = () => [
      "/api/admin/retention/platform",
      "/api/admin/retention/platform/whatsapp_cloud/preview",
      base(),
      `${base()}/whatsapp_qr/preview`,
    ];

    it("sem sessão: 401 na leitura e na escrita", async () => {
      for (const path of reads()) expect((await get(undefined, path)).status, path).toBe(401);
      expect((await put(undefined, valid)).status).toBe(401);
    });

    it("conta de organização (mesmo owner) não lê nem grava", async () => {
      for (const path of reads()) {
        const response = await get(tenantOwner, path);
        expect(response.status, path).toBe(403);
        expect((await bodyOf(response)).code).toBe("PLATFORM_FORBIDDEN");
      }
      expect((await put(tenantOwner, valid)).status).toBe(403);
    });

    it("o suporte lê tudo e não grava", async () => {
      for (const path of reads()) expect((await get(support, path)).status, path).toBe(200);
      const refused = await put(support, valid);
      expect(refused.status).toBe(403);
      expect((await bodyOf(refused)).code).toBe("PLATFORM_FORBIDDEN");
    });

    it("organização inexistente, id torto ou tipo de canal desconhecido: 404", async () => {
      const ghost = `/api/admin/retention/tenants/${randomUUID()}`;
      expect((await get(support, ghost)).status).toBe(404);
      expect((await get(support, `${ghost}/whatsapp_cloud/preview`)).status).toBe(404);
      expect((await put(platformOwner, valid, `${ghost}/whatsapp_cloud`)).status).toBe(404);
      expect((await get(support, "/api/admin/retention/tenants/nao-e-uuid")).status).toBe(404);
      expect((await get(support, `${base()}/telegram/preview`)).status).toBe(404);
      expect((await put(platformOwner, valid, `${base()}/telegram`)).status).toBe(404);
      expect((await get(support, "/api/admin/retention/platform/telegram/preview")).status).toBe(404);
    });

    it("organização excluída (anonimizada) responde 404", async () => {
      const gone = await createTenantRow(owner, "adm-ret-del");
      await bypass((tx) => tx`update organization set status = 'deleted' where id = ${gone}`);
      try {
        expect((await get(support, `/api/admin/retention/tenants/${gone}`)).status).toBe(404);
        expect((await put(platformOwner, valid, `/api/admin/retention/tenants/${gone}/whatsapp_cloud`)).status).toBe(404);
      } finally {
        await cleanUpChannels(owner, [gone]);
      }
    });
  });

  describe("política", () => {
    it("sem linha: herda tudo e mostra de onde veio cada valor", async () => {
      const response = await get(support, base());
      expect(response.status).toBe(200);
      const { scopes } = (await response.json()) as { scopes: Array<Record<string, unknown>> };

      expect(scopes.map((scope) => scope.channelType)).toEqual(["whatsapp_cloud", "whatsapp_qr"]);
      for (const scope of scopes) {
        expect(scope).toMatchObject({ policy: null, policyUpdatedAt: null, lastRun: null });
        expect(scope).toHaveProperty("effective");
        expect(scope).toHaveProperty("sources");
        expect(scope).toHaveProperty("defaults");
        expect(typeof scope.floorHours).toBe("number");
        expect(typeof scope.enabled).toBe("boolean");
      }
    });

    it("o proprietário grava a linha: `null` herda, `0` é sem limite; audita sem `tenant_id` e só com números", async () => {
      const response = await put(platformOwner, { maxMessages: 100, retentionDays: null, maxFavorites: 0 });
      expect(response.status).toBe(200);
      const { scope } = (await response.json()) as { scope: Record<string, unknown> };

      expect(scope).toMatchObject({
        channelType: "whatsapp_cloud",
        policy: { maxMessages: 100, retentionDays: null, maxFavorites: 0 },
        effective: { maxMessages: 100, maxFavorites: null },
        sources: { maxMessages: "policy", maxFavorites: "policy" },
      });
      expect(["default", "unlimited"]).toContain((scope.sources as Record<string, string>).retentionDays);

      const [row] = await bypass(
        (tx) => tx<{ updated_by: string; max_messages: number }[]>`select updated_by, max_messages from retention_policy where tenant_id = ${tenantId} and channel_type = 'whatsapp_cloud'`,
      );
      expect(row).toEqual({ updated_by: platformOwner.id, max_messages: 100 });

      const audits = await bypass(
        (tx) => tx<{ tenant_id: string | null; actor_type: string; actor_id: string; metadata: Record<string, unknown> }[]>`
          select tenant_id, actor_type, actor_id, metadata from audit_log
          where action = 'admin.retention_policy_updated' and target_id = ${tenantId}`,
      );
      expect(audits).toEqual([
        {
          tenant_id: null,
          actor_type: "platform",
          actor_id: platformOwner.id,
          metadata: { channelType: "whatsapp_cloud", maxMessages: 100, retentionDays: null, maxFavorites: 0 },
        },
      ]);

      // Gravar de novo atualiza a mesma linha (um por organização e tipo).
      expect((await put(platformOwner, valid)).status).toBe(200);
      const rows = await bypass((tx) => tx`select 1 from retention_policy where tenant_id = ${tenantId}`);
      expect(rows).toHaveLength(1);
    });

    it.each([
      ["acima do teto de mensagens", { ...valid, maxMessages: 10_000_001 }],
      ["acima do teto de dias", { ...valid, retentionDays: 3651 }],
      ["acima do teto de favoritas", { ...valid, maxFavorites: 1_000_001 }],
      ["negativo", { ...valid, retentionDays: -1 }],
      ["fracionário", { ...valid, maxMessages: 1.5 }],
      ["texto", { ...valid, maxMessages: "100" }],
      ["campo faltando (herdar é `null` explícito)", { maxMessages: 1, retentionDays: 1 }],
      ["campo a mais", { ...valid, tenantId: randomUUID() }],
    ])("recusa %s com 400", async (_label, body) => {
      const response = await put(platformOwner, body);
      expect(response.status).toBe(400);
      const rows = await bypass((tx) => tx`select 1 from retention_policy where tenant_id = ${tenantId}`);
      expect(rows).toHaveLength(0);
    });

    it("aceita exatamente os tetos", async () => {
      const response = await put(platformOwner, { maxMessages: 10_000_000, retentionDays: 3650, maxFavorites: 1_000_000 });
      expect(response.status).toBe(200);
    });
  });

  describe("prévia e última execução", () => {
    it("a prévia conta pela política efetiva, mesmo com a retenção desligada, e não apaga nada", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantId), { name: `Ret ${randomUUID().slice(0, 6)}-chtest` });
      const conv = await seedConversation(tenantScope(tenantId), ch.id);
      const target = { conversationId: conv.id, channelId: ch.id };
      const ids = [
        (await seedMessage(tenantScope(tenantId), target, { createdAt: new Date(Date.now() - 60 * DAY) })).id,
        (await seedMessage(tenantScope(tenantId), target, { createdAt: new Date(Date.now() - 50 * DAY) })).id,
        (await seedMessage(tenantScope(tenantId), target, { createdAt: new Date(Date.now() - 1 * DAY) })).id,
      ];
      expect((await put(platformOwner, { maxMessages: null, retentionDays: 30, maxFavorites: null })).status).toBe(200);

      const response = await get(support, `${base()}/whatsapp_cloud/preview`);
      expect(response.status).toBe(200);
      const { preview } = (await response.json()) as { preview: Record<string, unknown> };

      expect(preview).toEqual({
        byAge: 2,
        byCount: 0,
        favoritesDemoted: 0,
        filesDeleted: 0,
        messagesTotal: 3,
        favoritesTotal: 0,
        truncated: false,
      });
      const left = await withPlatformScope("teste", (tx) =>
        tx.select({ id: message.id }).from(message).where(inArray(message.id, ids)),
      );
      expect(left).toHaveLength(3);
      const state = await bypass((tx) => tx`select 1 from message_retention_state where tenant_id = ${tenantId}`);
      expect(state).toHaveLength(0);
    });

    it("a última execução aparece na leitura, só com contagens", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantId), { name: `Ret ${randomUUID().slice(0, 6)}-chtest` });
      const conv = await seedConversation(tenantScope(tenantId), ch.id);
      await seedMessage(tenantScope(tenantId), { conversationId: conv.id, channelId: ch.id }, {
        createdAt: new Date(Date.now() - 60 * DAY),
        text: "conteúdo pessoal",
      });
      expect((await put(platformOwner, { maxMessages: null, retentionDays: 30, maxFavorites: null })).status).toBe(200);
      const now = new Date();
      await runRetention(
        { tenantId, channelType: "whatsapp_cloud" },
        { now, config: retentionConfigFromEnv({ MESSAGE_RETENTION_ENABLED: true }) },
      );

      const response = await get(support, base());
      const text = await response.clone().text();
      const { scopes } = (await response.json()) as {
        scopes: Array<{ channelType: string; lastRun: { at: string; result: Record<string, unknown> } | null }>;
      };

      const cloud = scopes.find((scope) => scope.channelType === "whatsapp_cloud");
      expect(cloud?.lastRun).toEqual({
        at: now.toISOString(),
        result: { byAge: 1, byCount: 0, favoritesDemoted: 0, filesDeleted: 0, messagesTotal: 0, favoritesTotal: 0, truncated: false },
      });
      expect(scopes.find((scope) => scope.channelType === "whatsapp_qr")?.lastRun).toBeNull();
      expect(text).not.toContain("conteúdo");
      const [convRow] = await withPlatformScope("teste", (tx) =>
        tx.select({ id: message.id }).from(message).where(eq(message.conversationId, conv.id)),
      );
      expect(convRow).toBeUndefined();
    });
  });
});
