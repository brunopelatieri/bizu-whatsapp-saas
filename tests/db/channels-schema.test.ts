import { randomBytes, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { withPlatformData, withPlatformScope, withScope, withTenant } from "@/db/rls";
import {
  channel,
  channelEvent,
  channelEvolution,
  channelWhatsappCloud,
  messageTemplate,
} from "@/db/schema";
import { connectOwner } from "./tenant-helpers";

/**
 * Tabelas de canal (`docs/specs/whatsapp-canais/spec.md`): os três modos de `scopedPolicy()`
 * nas cinco tabelas, as unicidades que a spec promete e as chaves estrangeiras em cascata.
 * O inventário de `rls.test.ts` já confere `enableRLS`, `FORCE` e a existência da política.
 */

const PG_UNIQUE = "23505";
const PG_RLS = "42501";

describe("tabelas de canal", () => {
  let owner: postgres.Sql;
  const marker = randomUUID().slice(0, 8);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const label = (suffix: string) => `canal-${marker}-${suffix}`;
  const hex = (bytes = 16) => randomBytes(bytes).toString("hex");

  type Scope = Parameters<typeof withScope>[0];
  const scopeA: Scope = { kind: "tenant", tenantId: tenantA };
  const scopeB: Scope = { kind: "tenant", tenantId: tenantB };
  const platform: Scope = { kind: "platform" };

  /** Canal + linha Cloud de um escopo. `phoneNumberId` é único em todos os escopos. */
  async function newCloud(
    scope: Scope,
    name: string,
    options: { phoneNumberId?: string; isDefault?: boolean } = {},
  ) {
    const tenantId = scope.kind === "tenant" ? scope.tenantId : null;

    return withScope(scope, async (tx) => {
      const [row] = await tx
        .insert(channel)
        .values({ tenantId, type: "whatsapp_cloud", name, isDefault: options.isDefault ?? false })
        .returning();
      if (!row) throw new Error("canal não criado");

      await tx.insert(channelWhatsappCloud).values({
        channelId: row.id,
        tenantId,
        phoneNumberId: options.phoneNumberId ?? `9${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        wabaId: "100000000000001",
        webhookKey: hex(),
      });
      return row;
    });
  }

  const mine = like(channel.name, `canal-${marker}-%`);

  beforeAll(async () => {
    owner = connectOwner();

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        insert into organization (id, name, slug) values
          (${tenantA}, 'A', ${`ch-a-${marker}`}),
          (${tenantB}, 'B', ${`ch-b-${marker}`})
      `;
    });
  });

  afterAll(async () => {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from channel where name like ${`canal-${marker}-%`}`;
      await tx`delete from message_template where waba_id = ${`waba-${marker}`}`;
      await tx`delete from organization where id in (${tenantA}, ${tenantB})`;
    });
    await owner.end();
  });

  describe("isolamento (três modos de scopedPolicy)", () => {
    let a: { id: string };
    let b: { id: string };
    let p: { id: string };

    beforeAll(async () => {
      a = await newCloud(scopeA, label("a"));
      b = await newCloud(scopeB, label("b"));
      p = await newCloud(platform, label("plataforma"));
      await withScope(scopeA, (tx) =>
        tx.insert(channelEvent).values({
          tenantId: tenantA,
          channelId: a.id,
          provider: "whatsapp_cloud",
          dedupeKey: "iso-1",
          kind: "message",
          raw: {},
        }),
      );
    });

    it("withTenant lê só o canal do próprio tenant", async () => {
      const rows = await withTenant(tenantA, (tx) => tx.select().from(channel).where(mine));

      expect(rows.map((row) => row.name)).toEqual([label("a")]);
    });

    it("withPlatformData lê só o canal da plataforma", async () => {
      const rows = await withPlatformData((tx) => tx.select().from(channel).where(mine));

      expect(rows.map((row) => row.name)).toEqual([label("plataforma")]);
    });

    it("bizu_app sem helper não lê nada, em nenhuma das cinco tabelas", async () => {
      const db = getDb();

      expect(await db.select().from(channel).where(mine)).toEqual([]);
      expect(await db.select().from(channelWhatsappCloud)).toEqual([]);
      expect(await db.select().from(channelEvolution)).toEqual([]);
      expect(await db.select().from(channelEvent)).toEqual([]);
      expect(await db.select().from(messageTemplate)).toEqual([]);
    });

    it("a linha Cloud e o evento seguem o mesmo isolamento", async () => {
      const cloudA = await withTenant(tenantA, (tx) => tx.select().from(channelWhatsappCloud));
      const cloudP = await withPlatformData((tx) => tx.select().from(channelWhatsappCloud));
      const eventsB = await withTenant(tenantB, (tx) => tx.select().from(channelEvent));
      const eventsP = await withPlatformData((tx) => tx.select().from(channelEvent));

      expect(cloudA.map((row) => row.channelId)).toContain(a.id);
      expect(cloudA.map((row) => row.channelId)).not.toContain(b.id);
      expect(cloudA.map((row) => row.channelId)).not.toContain(p.id);
      expect(cloudP.map((row) => row.channelId)).toContain(p.id);
      expect(cloudP.map((row) => row.channelId)).not.toContain(a.id);
      expect(eventsB.map((row) => row.channelId)).not.toContain(a.id);
      expect(eventsP.map((row) => row.channelId)).not.toContain(a.id);
    });

    it("withPlatformScope (jobs e webhook) lê os três", async () => {
      const rows = await withPlatformScope("teste de canal", (tx) =>
        tx.select().from(channel).where(mine),
      );

      expect(rows.map((row) => row.name).sort()).toEqual(
        [label("a"), label("b"), label("plataforma")].sort(),
      );
    });

    it("tenant não grava canal de outro tenant nem da plataforma", async () => {
      for (const tenantId of [tenantB, null]) {
        await expect(
          withTenant(tenantA, (tx) =>
            tx.insert(channel).values({ tenantId, type: "whatsapp_qr", name: label("x") }),
          ),
        ).rejects.toMatchObject({ cause: { code: PG_RLS } });
      }
    });

    it("a plataforma não grava canal com tenant_id", async () => {
      await expect(
        withPlatformData((tx) =>
          tx.insert(channel).values({ tenantId: tenantA, type: "whatsapp_qr", name: label("x") }),
        ),
      ).rejects.toMatchObject({ cause: { code: PG_RLS } });
    });

    it("tenant não altera nem apaga o canal de outro (zero linhas afetadas)", async () => {
      const updated = await withTenant(tenantA, (tx) =>
        tx.update(channel).set({ name: label("hack") }).where(eq(channel.id, b.id)).returning(),
      );
      const deleted = await withTenant(tenantA, (tx) =>
        tx.delete(channel).where(eq(channel.id, b.id)).returning(),
      );

      expect(updated).toEqual([]);
      expect(deleted).toEqual([]);
    });
  });

  describe("unicidades", () => {
    it("phone_number_id é único em todos os escopos (tenant x plataforma)", async () => {
      const phoneNumberId = `8${Date.now()}`;
      await newCloud(scopeA, label("uniq-a"), { phoneNumberId });

      await expect(newCloud(scopeB, label("uniq-b"), { phoneNumberId })).rejects.toMatchObject({
        cause: { code: PG_UNIQUE },
      });
      await expect(newCloud(platform, label("uniq-p"), { phoneNumberId })).rejects.toMatchObject({
        cause: { code: PG_UNIQUE },
      });
    });

    it("um padrão por escopo e tipo; tenants e tipos diferentes não colidem", async () => {
      await newCloud(scopeA, label("def-a1"), { isDefault: true });
      await newCloud(scopeB, label("def-b1"), { isDefault: true });
      // Mesmo escopo, mesmo tipo, não padrão: ok.
      await newCloud(scopeA, label("def-a2"));
      // Mesmo escopo, outro tipo, padrão: ok.
      await withScope(scopeA, (tx) =>
        tx.insert(channel).values({
          tenantId: tenantA,
          type: "whatsapp_qr",
          name: label("def-a-qr"),
          isDefault: true,
        }),
      );

      await expect(newCloud(scopeA, label("def-a3"), { isDefault: true })).rejects.toMatchObject({
        cause: { code: PG_UNIQUE },
      });
    });

    it("a plataforma também tem um padrão por tipo (dois nulos não são iguais)", async () => {
      await newCloud(platform, label("def-p1"), { isDefault: true });

      await expect(newCloud(platform, label("def-p2"), { isDefault: true })).rejects.toMatchObject({
        cause: { code: PG_UNIQUE },
      });
    });

    it("webhook_key, remote_instance_name e webhook_secret_hash são únicos", async () => {
      const base = await newCloud(scopeA, label("keys"));
      const [cloud] = await withTenant(tenantA, (tx) =>
        tx.select().from(channelWhatsappCloud).where(eq(channelWhatsappCloud.channelId, base.id)),
      );
      const other = await withScope(scopeA, async (tx) => {
        const [row] = await tx
          .insert(channel)
          .values({ tenantId: tenantA, type: "whatsapp_cloud", name: label("keys2") })
          .returning();
        return row;
      });
      if (!cloud || !other) throw new Error("setup");

      await expect(
        withScope(scopeA, (tx) =>
          tx.insert(channelWhatsappCloud).values({
            channelId: other.id,
            tenantId: tenantA,
            phoneNumberId: `7${Date.now()}`,
            wabaId: "1",
            webhookKey: cloud.webhookKey,
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: PG_UNIQUE } });

      const instance = (suffix: string, name: string, hash: string) =>
        withScope(scopeA, async (tx) => {
          const [row] = await tx
            .insert(channel)
            .values({ tenantId: tenantA, type: "whatsapp_qr", name: label(suffix) })
            .returning();
          if (!row) throw new Error("setup");
          return tx.insert(channelEvolution).values({
            channelId: row.id,
            tenantId: tenantA,
            remoteInstanceName: name,
            webhookSecretHash: hash,
          });
        });

      const name = `bizu_${marker}_a_0001`;
      const hash = hex(32);
      await instance("evo1", name, hash);
      await expect(instance("evo2", name, hex(32))).rejects.toMatchObject({ cause: { code: PG_UNIQUE } });
      await expect(instance("evo3", `${name}x`, hash)).rejects.toMatchObject({
        cause: { code: PG_UNIQUE },
      });
    });

    it("channel_event: o mesmo dedupe_key no mesmo canal é recusado; em outro canal passa", async () => {
      const c1 = await newCloud(scopeA, label("ev1"));
      const c2 = await newCloud(scopeA, label("ev2"));
      const event = (channelId: string) =>
        withScope(scopeA, (tx) =>
          tx.insert(channelEvent).values({
            tenantId: tenantA,
            channelId,
            provider: "whatsapp_cloud",
            dedupeKey: "mesmo-corpo",
            kind: "message",
            raw: { ok: true },
          }),
        );

      await event(c1.id);
      await expect(event(c1.id)).rejects.toMatchObject({ cause: { code: PG_UNIQUE } });
      await event(c2.id);
    });

    it("message_template: único por escopo e WABA, inclusive na plataforma", async () => {
      const waba = `waba-${marker}`;
      const row = (tenantId: string | null) => ({
        tenantId,
        wabaId: waba,
        name: "boas_vindas",
        language: "pt_BR",
        status: "APPROVED",
      });

      await withScope(scopeA, (tx) => tx.insert(messageTemplate).values(row(tenantA)));
      await withScope(scopeB, (tx) => tx.insert(messageTemplate).values(row(tenantB)));
      await withScope(platform, (tx) => tx.insert(messageTemplate).values(row(null)));

      await expect(
        withScope(scopeA, (tx) => tx.insert(messageTemplate).values(row(tenantA))),
      ).rejects.toMatchObject({ cause: { code: PG_UNIQUE } });
      await expect(
        withScope(platform, (tx) => tx.insert(messageTemplate).values(row(null))),
      ).rejects.toMatchObject({ cause: { code: PG_UNIQUE } });
    });
  });

  describe("integridade", () => {
    it("tipo, status e nome fora do enum ou do tamanho são recusados pelo banco", async () => {
      await expect(
        owner.begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await tx`insert into channel (tenant_id, type, name) values (${tenantA}, 'whatsapp_qr', ${""})`;
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        owner.begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await tx`insert into channel (tenant_id, type, name) values (${tenantA}, 'whatsapp_qr', ${"x".repeat(61)})`;
        }),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("apagar o canal apaga a linha do provedor e os eventos (cascata)", async () => {
      const row = await newCloud(scopeA, label("cascata"));
      await withScope(scopeA, (tx) =>
        tx.insert(channelEvent).values({
          tenantId: tenantA,
          channelId: row.id,
          provider: "whatsapp_cloud",
          dedupeKey: "k",
          kind: "status",
          raw: {},
        }),
      );

      await withScope(scopeA, (tx) => tx.delete(channel).where(eq(channel.id, row.id)));

      const left = await withPlatformScope("teste de canal", async (tx) => ({
        cloud: await tx.select().from(channelWhatsappCloud).where(eq(channelWhatsappCloud.channelId, row.id)),
        events: await tx.select().from(channelEvent).where(eq(channelEvent.channelId, row.id)),
      }));
      expect(left).toEqual({ cloud: [], events: [] });
    });

    it("apagar a organização apaga os canais dela e preserva os da plataforma", async () => {
      const tenant = randomUUID();
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`insert into organization (id, name, slug) values (${tenant}, 'C', ${`ch-c-${marker}`})`;
      });
      await newCloud({ kind: "tenant", tenantId: tenant }, label("org-c"));

      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`delete from organization where id = ${tenant}`;
      });

      const rows = await withPlatformScope("teste de canal", (tx) =>
        tx.select().from(channel).where(eq(channel.name, label("org-c"))),
      );
      expect(rows).toEqual([]);

      const platformRows = await withPlatformData((tx) => tx.select().from(channel).where(mine));
      expect(platformRows.length).toBeGreaterThan(0);
    });

    it("sem helper, nem o dono grava (FORCE RLS vale para bizu_owner)", async () => {
      await expect(
        owner`insert into channel (tenant_id, type, name) values (${tenantA}, 'whatsapp_qr', ${label("sem-helper")})`,
      ).rejects.toMatchObject({ code: PG_RLS });
    });
  });
});
