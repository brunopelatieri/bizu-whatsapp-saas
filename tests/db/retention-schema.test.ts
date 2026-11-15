import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { withPlatformData, withPlatformScope, withTenant } from "@/db/rls";
import { messageRetentionState, retentionPolicy } from "@/db/schema";
import { cleanUpChannels, createTenantRow, seedCloudChannel, tenantScope } from "./channels-helpers";
import { seedConversation, seedMessage } from "./inbox-helpers";
import { cleanUp, connectOwner, createUser } from "./tenant-helpers";

/**
 * Bloco R, R1 (`docs/specs/pre-producao/spec.md`): o schema da retenção. Valores padrão e carimbo da
 * favorita em `message`, os `CHECK` e a unicidade de `retention_policy` e de `message_retention_state`,
 * os índices, o `set null` de quem favoritou e o isolamento: o tenant não lê nem grava a política
 * nem a última execução.
 */

let owner: postgres.Sql;
let tenantA: string;
let tenantB: string;
let channelA: string;

const bypass = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;

async function newUser() {
  return (await createUser(owner)).id;
}

/** Código do erro do Postgres por trás da exceção do driver. */
async function pgCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; code?: string }).cause;
    return cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

beforeAll(async () => {
  owner = connectOwner();
  tenantA = await createTenantRow(owner, "retencao-a");
  tenantB = await createTenantRow(owner, "retencao-b");
  channelA = (await seedCloudChannel(tenantScope(tenantA))).id;
});

afterAll(async () => {
  await bypass((tx) => tx`delete from message_retention_state where tenant_id is null`);
  await cleanUpChannels(owner, [tenantA, tenantB]);
  await cleanUp(owner);
  await owner.end();
});

describe("message: favorita", () => {
  it("nasce sem estrela e sem carimbo", async () => {
    const conversation = await seedConversation(tenantScope(tenantA), channelA);
    const row = await seedMessage(tenantScope(tenantA), {
      conversationId: conversation.id,
      channelId: channelA,
    });

    expect(row.isFavorite).toBe(false);
    expect(row.favoritedAt).toBeNull();
    expect(row.favoritedBy).toBeNull();
  });

  it("o carimbo só existe com a estrela (CHECK)", async () => {
    const conversation = await seedConversation(tenantScope(tenantA), channelA);
    const row = await seedMessage(tenantScope(tenantA), {
      conversationId: conversation.id,
      channelId: channelA,
    });
    const person = await newUser();

    const withoutStar = bypass(
      (tx) => tx`update message set favorited_at = now() where id = ${row.id}`,
    );
    const authorWithoutStar = bypass(
      (tx) => tx`update message set favorited_by = ${person} where id = ${row.id}`,
    );

    await expect(withoutStar).rejects.toMatchObject({ code: "23514" });
    await expect(authorWithoutStar).rejects.toMatchObject({ code: "23514" });
    await bypass(
      (tx) => tx`update message set is_favorite = true, favorited_at = now(), favorited_by = ${person} where id = ${row.id}`,
    );
    await bypass(
      (tx) => tx`update message set is_favorite = false, favorited_at = null, favorited_by = null where id = ${row.id}`,
    );
  });

  it("apagar a conta que favoritou zera só o autor: a estrela fica", async () => {
    const conversation = await seedConversation(tenantScope(tenantA), channelA);
    const row = await seedMessage(tenantScope(tenantA), {
      conversationId: conversation.id,
      channelId: channelA,
    });
    const person = await newUser();
    await bypass(
      (tx) => tx`update message set is_favorite = true, favorited_at = now(), favorited_by = ${person} where id = ${row.id}`,
    );

    await bypass((tx) => tx`delete from "user" where id = ${person}`);

    const [after] = await bypass(
      (tx) => tx<{ is_favorite: boolean; favorited_by: string | null; favorited_at: Date | null }[]>`
        select is_favorite, favorited_by, favorited_at from message where id = ${row.id}
      `,
    );
    expect(after?.is_favorite).toBe(true);
    expect(after?.favorited_by).toBeNull();
    expect(after?.favorited_at).toBeInstanceOf(Date);
  });

  it("os índices da limpeza existem, e o das favoritas é parcial", async () => {
    const indexes = await owner<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'message'
    `;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

    expect(byName.get("message_favorite_idx")).toMatch(/\(conversation_id, created_at\) WHERE is_favorite/);
    expect(byName.get("message_tenant_created_idx")).toMatch(/\(tenant_id, created_at\)/);
    // O de `(conversation_id, created_at)` já existia, em ordem decrescente: a R1 não o duplica.
    expect(byName.get("message_conversation_created_idx")).toMatch(/\(conversation_id, created_at DESC/);
    expect(byName.get("message_favorited_by_idx")).toMatch(/WHERE \(favorited_by IS NOT NULL\)/);
  });
});

describe("retention_policy", () => {
  it("aceita NULL (herda), 0 (sem limite) e positivos; as três colunas nascem nulas", async () => {
    await bypass(async (tx) => {
      await tx`insert into retention_policy (tenant_id, channel_type) values (${tenantA}, 'whatsapp_cloud')`;
      await tx`
        insert into retention_policy (tenant_id, channel_type, max_messages, retention_days, max_favorites)
        values (${tenantA}, 'whatsapp_qr', 0, 0, 0)
      `;
    });

    const rows = await bypass(
      (tx) => tx<
        { channel_type: string; max_messages: number | null; retention_days: number | null; max_favorites: number | null }[]
      >`select channel_type, max_messages, retention_days, max_favorites from retention_policy
        where tenant_id = ${tenantA} order by channel_type`,
    );

    expect(rows).toEqual([
      { channel_type: "whatsapp_cloud", max_messages: null, retention_days: null, max_favorites: null },
      { channel_type: "whatsapp_qr", max_messages: 0, retention_days: 0, max_favorites: 0 },
    ]);
  });

  it.each([["max_messages"], ["retention_days"], ["max_favorites"]])(
    "%s negativo é recusado (CHECK)",
    async (column) => {
      const result = bypass(
        (tx) => tx.unsafe(
          `insert into retention_policy (tenant_id, channel_type, ${column}) values ($1, 'whatsapp_cloud', -1)`,
          [tenantB],
        ),
      );

      await expect(result).rejects.toMatchObject({ code: "23514" });
    },
  );

  it("uma linha por organização e tipo de canal", async () => {
    await bypass(
      (tx) => tx`insert into retention_policy (tenant_id, channel_type, max_messages) values (${tenantB}, 'whatsapp_cloud', 10)`,
    );

    const again = bypass(
      (tx) => tx`insert into retention_policy (tenant_id, channel_type, max_messages) values (${tenantB}, 'whatsapp_cloud', 20)`,
    );
    const otherType = bypass(
      (tx) => tx`insert into retention_policy (tenant_id, channel_type) values (${tenantB}, 'whatsapp_qr')`,
    );

    await expect(again).rejects.toMatchObject({ code: "23505" });
    await expect(otherType).resolves.toBeDefined();
  });

  it("a plataforma lê e grava; o tenant não lê, não grava e não altera", async () => {
    const asPlatform = await withPlatformData((tx) =>
      tx.select().from(retentionPolicy).where(eq(retentionPolicy.tenantId, tenantA)),
    );
    expect(asPlatform).toHaveLength(2);

    expect(
      await withTenant(tenantA, (tx) =>
        tx.select().from(retentionPolicy).where(eq(retentionPolicy.tenantId, tenantA)),
      ),
    ).toEqual([]);
    // Fora de qualquer escopo (o `bizu_app` cru) também não vê nada.
    expect(
      await getDb().select().from(retentionPolicy).where(eq(retentionPolicy.tenantId, tenantA)),
    ).toEqual([]);

    const insert = withTenant(tenantA, (tx) =>
      tx.insert(retentionPolicy).values({ tenantId: tenantA, channelType: "whatsapp_cloud" }),
    );
    expect(await pgCode(insert)).toBe("42501");

    const updated = await withTenant(tenantA, (tx) =>
      tx
        .update(retentionPolicy)
        .set({ maxMessages: 1 })
        .where(eq(retentionPolicy.tenantId, tenantA))
        .returning(),
    );
    const deleted = await withTenant(tenantA, (tx) =>
      tx.delete(retentionPolicy).where(eq(retentionPolicy.tenantId, tenantA)).returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);

    const [kept] = await bypass(
      (tx) => tx<{ max_messages: number | null }[]>`
        select max_messages from retention_policy where tenant_id = ${tenantA} and channel_type = 'whatsapp_qr'
      `,
    );
    expect(kept?.max_messages).toBe(0);
  });

  it("um tenant com a política de outro também não a vê", async () => {
    const seenByB = await withTenant(tenantB, (tx) => tx.select().from(retentionPolicy));

    expect(seenByB).toEqual([]);
  });

  it("apagar a organização leva a política junto (cascade)", async () => {
    const doomed = await createTenantRow(owner, "retencao-cascata");
    await bypass(
      (tx) => tx`insert into retention_policy (tenant_id, channel_type, max_messages) values (${doomed}, 'whatsapp_cloud', 1)`,
    );
    await bypass(
      (tx) => tx`insert into message_retention_state (tenant_id, channel_type) values (${doomed}, 'whatsapp_cloud')`,
    );

    await cleanUpChannels(owner, [doomed]);

    const [policies] = await bypass(
      (tx) => tx<{ total: number }[]>`select count(*)::int as total from retention_policy where tenant_id = ${doomed}`,
    );
    const [states] = await bypass(
      (tx) => tx<{ total: number }[]>`select count(*)::int as total from message_retention_state where tenant_id = ${doomed}`,
    );
    expect(policies?.total).toBe(0);
    expect(states?.total).toBe(0);
  });

  it("quem atualizou a política some ao apagar a conta (set null)", async () => {
    const person = await newUser();
    await bypass(
      (tx) => tx`update retention_policy set updated_by = ${person} where tenant_id = ${tenantB} and channel_type = 'whatsapp_cloud'`,
    );

    await bypass((tx) => tx`delete from "user" where id = ${person}`);

    const [row] = await bypass(
      (tx) => tx<{ updated_by: string | null }[]>`
        select updated_by from retention_policy where tenant_id = ${tenantB} and channel_type = 'whatsapp_cloud'
      `,
    );
    expect(row?.updated_by).toBeNull();
  });
});

describe("message_retention_state", () => {
  it("nasce com resultado vazio e sem execução", async () => {
    await withPlatformScope("teste: retenção", (tx) =>
      tx.insert(messageRetentionState).values({ tenantId: tenantA, channelType: "whatsapp_cloud" }),
    );

    const [row] = await withPlatformData((tx) =>
      tx.select().from(messageRetentionState).where(eq(messageRetentionState.tenantId, tenantA)),
    );

    expect(row?.lastRunAt).toBeNull();
    expect(row?.lastResult).toEqual({});
  });

  it("uma linha por escopo e tipo, inclusive o da plataforma (tenant nulo)", async () => {
    await bypass((tx) => tx`delete from message_retention_state where tenant_id is null`);
    await withPlatformData((tx) =>
      tx.insert(messageRetentionState).values({ tenantId: null, channelType: "whatsapp_qr" }),
    );

    const platformTwice = withPlatformData((tx) =>
      tx.insert(messageRetentionState).values({ tenantId: null, channelType: "whatsapp_qr" }),
    );
    const tenantTwice = withPlatformData((tx) =>
      tx.insert(messageRetentionState).values({ tenantId: tenantA, channelType: "whatsapp_cloud" }),
    );

    expect(await pgCode(platformTwice)).toBe("23505");
    expect(await pgCode(tenantTwice)).toBe("23505");
  });

  it("o resultado precisa ser um objeto (CHECK)", async () => {
    const result = bypass(
      (tx) => tx`update message_retention_state set last_result = '[]'::jsonb where tenant_id = ${tenantA}`,
    );

    await expect(result).rejects.toMatchObject({ code: "23514" });
  });

  it("o tenant não lê, não grava e não altera", async () => {
    expect(await withTenant(tenantA, (tx) => tx.select().from(messageRetentionState))).toEqual([]);
    expect(await getDb().select().from(messageRetentionState)).toEqual([]);

    const insert = withTenant(tenantA, (tx) =>
      tx.insert(messageRetentionState).values({ tenantId: tenantA, channelType: "whatsapp_qr" }),
    );
    expect(await pgCode(insert)).toBe("42501");

    const updated = await withTenant(tenantA, (tx) =>
      tx
        .update(messageRetentionState)
        .set({ lastResult: { byAge: 99 } })
        .returning(),
    );
    expect(updated).toEqual([]);
  });

  it("o escopo da plataforma grava a última execução", async () => {
    const at = new Date("2026-11-14T03:00:00Z");

    await withPlatformData((tx) =>
      tx
        .update(messageRetentionState)
        .set({ lastRunAt: at, lastResult: { byAge: 3, truncated: false } })
        .where(eq(messageRetentionState.tenantId, tenantA)),
    );

    const [row] = await withPlatformData((tx) =>
      tx.select().from(messageRetentionState).where(eq(messageRetentionState.tenantId, tenantA)),
    );
    expect(row?.lastRunAt).toEqual(at);
    expect(row?.lastResult).toEqual({ byAge: 3, truncated: false });
  });
});
