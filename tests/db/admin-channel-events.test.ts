import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Scope, withPlatformScope } from "@/db/rls";
import { channelEvent } from "@/db/schema";
import { receiveChannelEvent, setChannelQueueForTests } from "@/lib/channels/events";
import type { ChannelEventStatus } from "@/lib/channels/types";
import { bodyOf, makePlatformUser } from "./billing-helpers";
import {
  cleanUpChannels,
  createTenantRow,
  platformScope,
  seedCloudChannel,
  tenantScope,
} from "./channels-helpers";
import {
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * `/api/admin/channel-events`: a caixa de avisos dos canais vista pela plataforma. Suporte lê,
 * só o proprietário reprocessa, e o `raw` (telefone, corpo da mensagem) nunca sai.
 */

const SECRET_PHONE = "5511987650000";
const SECRET_BODY = "texto-pessoal-que-nao-pode-sair";

type Listing = {
  items: Array<Record<string, unknown> & { id: string; status: string }>;
  total: number;
  pageSize: number;
};

describe("/api/admin/channel-events", () => {
  let owner: postgres.Sql;
  let platformOwner: TestUser;
  let support: TestUser;
  let regular: TestUser;
  let tenantOwner: TestUser;
  let tenantId: string;
  const enqueued: string[] = [];

  const get = (user: TestUser | undefined, path: string) =>
    call("GET", path, { cookie: user?.cookie });
  const reprocess = (user: TestUser | undefined, id: string) =>
    call("POST", `/api/admin/channel-events/${id}/reprocess`, { cookie: user?.cookie });

  async function seedEvent(scope: Scope, status: ChannelEventStatus) {
    const target = await seedCloudChannel(scope, {
      name: `Avisos ${randomUUID().slice(0, 6)}-chtest`,
    });
    const { id } = await receiveChannelEvent({
      scope,
      channelId: target.id,
      provider: "whatsapp_cloud",
      dedupeKey: randomUUID(),
      kind: "message",
      raw: { from: SECRET_PHONE, text: { body: SECRET_BODY } },
    });

    if (status !== "pending") {
      await withPlatformScope("teste: estado do aviso", (tx) =>
        tx
          .update(channelEvent)
          .set({
            status,
            attempts: 3,
            error: status === "failed" ? "falha de teste" : null,
            processedAt: new Date(),
          })
          .where(eq(channelEvent.id, id)),
      );
    }

    return id;
  }

  const stateOf = (id: string) =>
    withPlatformScope("teste: lê aviso", async (tx) => {
      const [row] = await tx
        .select({
          status: channelEvent.status,
          attempts: channelEvent.attempts,
          error: channelEvent.error,
          processedAt: channelEvent.processedAt,
        })
        .from(channelEvent)
        .where(eq(channelEvent.id, id));
      return row;
    });

  const auditCount = (id: string) =>
    owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      const [row] = await tx<{ total: number }[]>`
        select count(*)::int as total from audit_log
        where action = 'admin.channel_event_reprocessed' and target_id = ${id}
      `;
      return row?.total ?? 0;
    });

  beforeAll(async () => {
    owner = connectOwner();
    platformOwner = await makePlatformUser(owner, "platform_owner");
    support = await makePlatformUser(owner, "platform_support");
    regular = await createUser(owner);
    tenantOwner = await createUser(owner);
    await createTenant(tenantOwner, "Clínica Avisos");
    tenantId = await createTenantRow(owner, "adm-evt");
    setChannelQueueForTests(async (id) => {
      enqueued.push(id);
    });
  });

  afterEach(() => {
    enqueued.length = 0;
  });

  afterAll(async () => {
    setChannelQueueForTests(undefined);
    await cleanUpChannels(owner, [tenantId]);
    await cleanUp(owner);
    await owner.end();
  });

  describe("acesso", () => {
    it("sem sessão: 401 na leitura e na escrita", async () => {
      expect((await get(undefined, "/api/admin/channel-events")).status).toBe(401);
      expect((await reprocess(undefined, randomUUID())).status).toBe(401);
    });

    it("usuário de tenant não lê nem reprocessa", async () => {
      const id = await seedEvent(tenantScope(tenantId), "failed");

      for (const user of [regular, tenantOwner]) {
        const list = await get(user, "/api/admin/channel-events");
        expect(list.status).toBe(403);
        expect(await list.text()).not.toContain(id);

        expect((await reprocess(user, id)).status).toBe(403);
      }

      expect((await stateOf(id))?.status).toBe("failed");
      expect(enqueued).toEqual([]);
    });

    it("suporte lê, mas recebe 403 ao reprocessar", async () => {
      const id = await seedEvent(tenantScope(tenantId), "failed");

      expect((await get(support, "/api/admin/channel-events")).status).toBe(200);

      const response = await reprocess(support, id);
      expect(response.status).toBe(403);
      expect((await bodyOf(response)).code).toBe("PLATFORM_FORBIDDEN");
      expect((await stateOf(id))?.status).toBe("failed");
      expect(enqueued).toEqual([]);
      expect(await auditCount(id)).toBe(0);
    });

    it("origem de outro site é recusada", async () => {
      const id = await seedEvent(tenantScope(tenantId), "failed");
      const response = await call("POST", `/api/admin/channel-events/${id}/reprocess`, {
        cookie: platformOwner.cookie,
        origin: "https://outro-site.example",
      });

      expect(response.status).toBe(403);
      expect((await stateOf(id))?.status).toBe("failed");
    });
  });

  describe("listagem", () => {
    it("traz avisos de tenant e da plataforma, sem `raw`", async () => {
      const ofTenant = await seedEvent(tenantScope(tenantId), "failed");
      const ofPlatform = await seedEvent(platformScope, "failed");

      const response = await get(support, "/api/admin/channel-events?status=failed");
      expect(response.status).toBe(200);

      const text = await response.text();
      expect(text).not.toContain(SECRET_PHONE);
      expect(text).not.toContain(SECRET_BODY);

      const body = JSON.parse(text) as Listing;
      const mine = body.items.filter((item) => [ofTenant, ofPlatform].includes(item.id));
      expect(mine).toHaveLength(2);
      for (const item of body.items) {
        expect(item).not.toHaveProperty("raw");
        expect(item).not.toHaveProperty("dedupeKey");
        expect(item.status).toBe("failed");
      }
      expect(mine.find((item) => item.id === ofTenant)?.tenantId).toBe(tenantId);
      expect(mine.find((item) => item.id === ofPlatform)?.tenantId).toBeNull();
      expect(body.pageSize).toBeGreaterThan(0);
      expect(body.total).toBeGreaterThanOrEqual(2);
    });

    it("filtra por estado e recusa estado ou página inválidos", async () => {
      const pending = await seedEvent(tenantScope(tenantId), "pending");

      const failed = (await bodyOf(
        await get(support, "/api/admin/channel-events?status=failed"),
      )) as Listing;
      expect(failed.items.map((item) => item.id)).not.toContain(pending);

      const queued = (await bodyOf(
        await get(support, "/api/admin/channel-events?status=pending"),
      )) as Listing;
      expect(queued.items.map((item) => item.id)).toContain(pending);

      expect((await get(support, "/api/admin/channel-events?status=nope")).status).toBe(400);
      expect((await get(support, "/api/admin/channel-events?page=0")).status).toBe(400);
    });
  });

  describe("reprocessar", () => {
    it.each(["failed", "ignored"] as const)(
      "%s volta a `pending`, enfileira e audita",
      async (status) => {
        const id = await seedEvent(tenantScope(tenantId), status);

        const response = await reprocess(platformOwner, id);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain(SECRET_PHONE);

        expect(await stateOf(id)).toEqual({
          status: "pending",
          attempts: 0,
          error: null,
          processedAt: null,
        });
        expect(enqueued).toEqual([id]);
        expect(await auditCount(id)).toBe(1);
      },
    );

    it("aviso da plataforma também reprocessa", async () => {
      const id = await seedEvent(platformScope, "failed");

      expect((await reprocess(platformOwner, id)).status).toBe(200);
      expect((await stateOf(id))?.status).toBe("pending");
      expect(enqueued).toEqual([id]);
    });

    it.each(["processed", "pending"] as const)("%s responde 409 e não enfileira", async (status) => {
      const id = await seedEvent(tenantScope(tenantId), status);

      const response = await reprocess(platformOwner, id);
      expect(response.status).toBe(409);
      expect((await bodyOf(response)).code).toBe("NOT_REPROCESSABLE");
      expect((await stateOf(id))?.status).toBe(status);
      expect(enqueued).toEqual([]);
      expect(await auditCount(id)).toBe(0);
    });

    it("id inexistente ou malformado responde 404", async () => {
      expect((await reprocess(platformOwner, randomUUID())).status).toBe(404);
      expect((await reprocess(platformOwner, "nao-e-uuid")).status).toBe(404);
      expect(enqueued).toEqual([]);
    });
  });
});
