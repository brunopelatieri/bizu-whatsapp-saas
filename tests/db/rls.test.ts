import { randomUUID } from "node:crypto";
import {
  getTableConfig,
  PgDialect,
  type PgPolicy,
  type PgTable,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { eq, isTable, like, sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  scopeTenantId,
  type Tx,
  withPlatformData,
  withPlatformScope,
  withScope,
  withTenant,
} from "@/db/rls";
import { platformOnlyPolicy, scopedPolicy } from "@/db/tenant-policy";
import * as schema from "@/db/schema";
import { connectOwner } from "./tenant-helpers";

/**
 * Isolamento na camada do banco (`spec-tenant-rbac.md`). `audit_log` prova as regras, e o
 * inventário cobre as tabelas novas. Os passos com `customer` estão em
 * `portal-isolation.test.ts`.
 */

const { auditLog } = schema;

const tables = (Object.values(schema) as unknown[]).filter(
  (value): value is PgTable => isTable(value),
);

const tenantTables = tables
  .map((table) => getTableConfig(table))
  .filter(({ columns }) => columns.some(({ name }) => name === "tenant_id"));

describe("RLS", () => {
  let owner: postgres.Sql;
  const marker = randomUUID();
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  const onlyMine = eq(auditLog.action, marker);

  beforeAll(async () => {
    owner = connectOwner();

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        insert into organization (id, name, slug) values
          (${tenantA}, 'A', ${`rls-a-${marker}`}),
          (${tenantB}, 'B', ${`rls-b-${marker}`})
      `;
      await tx`
        insert into audit_log (tenant_id, actor_type, action) values
          (${tenantA}, 'system', ${marker}),
          (${tenantB}, 'system', ${marker})
      `;
    });
  });

  afterAll(async () => {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from audit_log where action = ${marker}`;
      await tx`delete from organization where id in (${tenantA}, ${tenantB})`;
    });
    await owner.end();
  });

  describe("inventário", () => {
    it("acha as tabelas de tenant no schema", () => {
      expect(tenantTables.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "audit_log",
          "impersonation_grant",
          "tenant_payment_credential",
        ]),
      );
    });

    it.each(tenantTables.map(({ name, ...config }) => [name, config] as const))(
      "%s declara enableRLS e policy",
      (_name, config) => {
        expect(config.enableRLS).toBe(true);
        expect(config.policies.length).toBeGreaterThan(0);
      },
    );

    it.each(tenantTables.map(({ name }) => [name]))(
      "%s tem RLS forçado e policy no banco",
      async (name) => {
        const [row] = await owner<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >`
          select relrowsecurity, relforcerowsecurity
          from pg_class where oid = ${`public.${name}`}::regclass
        `;
        const policies = await owner`
          select 1 from pg_policies
          where schemaname = 'public' and tablename = ${name}
        `;

        expect(row).toEqual({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
        expect(policies.length).toBeGreaterThan(0);
      },
    );
  });

  it("bizu_app fora de withTenant não lê nada", async () => {
    const rows = await getDb().select().from(auditLog).where(onlyMine);

    expect(rows).toEqual([]);
  });

  it("bizu_app fora de withTenant não grava", async () => {
    await expect(
      getDb()
        .insert(auditLog)
        .values({ tenantId: tenantA, actorType: "system", action: marker }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("dentro de withTenant(A) não lê B", async () => {
    const rows = await withTenant(tenantA, (tx) =>
      tx.select().from(auditLog).where(onlyMine),
    );

    expect(rows.map(({ tenantId }) => tenantId)).toEqual([tenantA]);
  });

  it("dentro de withTenant(A) não grava em B", async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx
          .insert(auditLog)
          .values({ tenantId: tenantB, actorType: "system", action: marker }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("dentro de withTenant(A) não altera linhas de B", async () => {
    const updated = await withTenant(tenantA, (tx) =>
      tx
        .update(auditLog)
        .set({ targetType: "alterado" })
        .where(eq(auditLog.tenantId, tenantB))
        .returning(),
    );

    expect(updated).toEqual([]);
  });

  it("evento sem tenant só aparece com withPlatformScope", async () => {
    const [row] = await withPlatformScope("teste", (tx) =>
      tx
        .insert(auditLog)
        .values({ actorType: "system", action: marker })
        .returning(),
    );
    if (!row) throw new Error("linha não criada");

    const fromTenant = await withTenant(tenantA, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.id, row.id)),
    );

    expect(fromTenant).toEqual([]);
  });

  it("o escopo não sobrevive à transação", async () => {
    // O pool tem várias conexões: repetir aumenta a chance de reusar a mesma.
    for (let i = 0; i < 20; i += 1) {
      await withTenant(tenantA, (tx) => tx.select().from(auditLog).limit(1));
      await withPlatformScope("teste", (tx) =>
        tx.select().from(auditLog).limit(1),
      );

      const rows = await getDb().select().from(auditLog).where(onlyMine);
      expect(rows).toEqual([]);
    }
  });

  it("withPlatformScope lê todos os tenants", async () => {
    const rows = await withPlatformScope("teste", (tx) =>
      tx.select().from(auditLog).where(onlyMine),
    );

    expect(rows.map(({ tenantId }) => tenantId)).toEqual(
      expect.arrayContaining([tenantA, tenantB]),
    );
  });

  it("bizu_owner também obedece: sem bypass não lê, com bypass lê tudo", async () => {
    const without = await owner`
      select 1 from audit_log where action = ${marker}
    `;
    const withBypass = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx`select tenant_id from audit_log where action = ${marker}`;
    });

    expect(without.length).toBe(0);
    expect(withBypass.map(({ tenant_id }) => tenant_id)).toEqual(
      expect.arrayContaining([tenantA, tenantB]),
    );
  });
});

/**
 * Escopo de plataforma do WhatsApp CRM (`docs/specs/whatsapp-crm/plano.md`, fase F0).
 * As tabelas de prova recebem o SQL exato de `scopedPolicy()` e `platformOnlyPolicy()`,
 * renderizado pelo Drizzle: o teste quebra se a política mudar sem cobertura.
 */
describe("scopedPolicy e platformOnlyPolicy", () => {
  let owner: postgres.Sql;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const marker = randomUUID();

  const scoped = pgTable("rls_scope_probe", {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id"),
    label: text("label").notNull(),
  });
  const platformOnly = pgTable("rls_platform_probe", {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
  });

  const dialect = new PgDialect();
  const render = (policy: PgPolicy) => {
    if (!policy.using || !policy.withCheck) throw new Error("política incompleta");
    const using = dialect.sqlToQuery(policy.using);
    const check = dialect.sqlToQuery(policy.withCheck);
    // A política é SQL fixo, sem parâmetro: pode ir direto para o DDL.
    expect(using.params).toEqual([]);
    expect(check.params).toEqual([]);
    return { using: using.sql, check: check.sql };
  };

  const label = (suffix: string) => `${marker}-${suffix}`;
  const scopedRows = (tx: Pick<Tx, "select">) =>
    tx.select().from(scoped).where(like(scoped.label, `${marker}%`));

  beforeAll(async () => {
    owner = connectOwner();
    const scope = render(scopedPolicy());
    const platform = render(platformOnlyPolicy());

    await owner.begin(async (tx) => {
      await tx.unsafe(`
        drop table if exists rls_scope_probe;
        drop table if exists rls_platform_probe;
        create table rls_scope_probe (
          id uuid primary key default gen_random_uuid(),
          tenant_id uuid,
          label text not null
        );
        create table rls_platform_probe (
          id uuid primary key default gen_random_uuid(),
          label text not null
        );
        alter table rls_scope_probe enable row level security;
        alter table rls_scope_probe force row level security;
        alter table rls_platform_probe enable row level security;
        alter table rls_platform_probe force row level security;
        create policy scope_isolation on rls_scope_probe as permissive for all
          to bizu_app, bizu_owner using (${scope.using}) with check (${scope.check});
        create policy platform_only on rls_platform_probe as permissive for all
          to bizu_app, bizu_owner using (${platform.using}) with check (${platform.check});
        grant select, insert, update, delete on rls_scope_probe, rls_platform_probe
          to bizu_app;
      `);
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        insert into rls_scope_probe (tenant_id, label) values
          (${tenantA}, ${label("a")}),
          (${tenantB}, ${label("b")}),
          (null, ${label("plataforma")})
      `;
      await tx`insert into rls_platform_probe (label) values (${label("plataforma")})`;
    });
  });

  afterAll(async () => {
    await owner.unsafe(`
      drop table if exists rls_scope_probe;
      drop table if exists rls_platform_probe;
    `);
    await owner.end();
  });

  describe("withTenant", () => {
    it("lê só a linha do próprio tenant", async () => {
      const rows = await withTenant(tenantA, scopedRows);

      expect(rows.map((row) => row.label)).toEqual([label("a")]);
    });

    it("grava linha do próprio tenant", async () => {
      const [row] = await withTenant(tenantA, (tx) =>
        tx
          .insert(scoped)
          .values({ tenantId: tenantA, label: label("a-nova") })
          .returning(),
      );

      expect(row?.tenantId).toBe(tenantA);
    });

    it("não grava linha de outro tenant", async () => {
      await expect(
        withTenant(tenantA, (tx) =>
          tx.insert(scoped).values({ tenantId: tenantB, label: label("x") }),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("não grava linha da plataforma (tenant_id nulo)", async () => {
      await expect(
        withTenant(tenantA, (tx) =>
          tx.insert(scoped).values({ tenantId: null, label: label("x") }),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("não move a própria linha para a plataforma", async () => {
      await expect(
        withTenant(tenantA, (tx) =>
          tx
            .update(scoped)
            .set({ tenantId: null })
            .where(eq(scoped.label, label("a"))),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("withScope(tenant) equivale a withTenant", async () => {
      const rows = await withScope(
        { kind: "tenant", tenantId: tenantB },
        scopedRows,
      );

      expect(rows.map((row) => row.label)).toEqual([label("b")]);
    });
  });

  describe("withPlatformData", () => {
    it("lê só as linhas da plataforma", async () => {
      const rows = await withPlatformData(scopedRows);

      expect(rows.map((row) => row.label)).toContain(label("plataforma"));
      expect(rows.every(({ tenantId }) => tenantId === null)).toBe(true);
    });

    it("grava linha da plataforma", async () => {
      const [row] = await withPlatformData((tx) =>
        tx
          .insert(scoped)
          .values({ tenantId: null, label: label("plataforma-nova") })
          .returning(),
      );

      expect(row?.tenantId).toBeNull();
    });

    it("não grava linha com tenant_id preenchido", async () => {
      await expect(
        withPlatformData((tx) =>
          tx.insert(scoped).values({ tenantId: tenantA, label: label("x") }),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("não altera nem apaga linha de tenant", async () => {
      const result = await withPlatformData(async (tx) => {
        const updated = await tx
          .update(scoped)
          .set({ label: label("alterado") })
          .where(eq(scoped.tenantId, tenantA))
          .returning();
        const deleted = await tx
          .delete(scoped)
          .where(eq(scoped.tenantId, tenantB))
          .returning();
        return { updated, deleted };
      });

      expect(result).toEqual({ updated: [], deleted: [] });
    });

    it("não define app.tenant_id", async () => {
      const [row] = await withPlatformData((tx) =>
        tx.execute<{ tenant: string | null }>(
          sql`select nullif(current_setting('app.tenant_id', true), '') as tenant`,
        ),
      );

      expect(row?.tenant ?? null).toBeNull();
    });

    it("withScope(platform) equivale a withPlatformData", async () => {
      const rows = await withScope({ kind: "platform" }, scopedRows);

      expect(rows.map((row) => row.label)).toContain(label("plataforma"));
      expect(rows.every(({ tenantId }) => tenantId === null)).toBe(true);
    });
  });

  describe("sem helper", () => {
    it("bizu_app cru não lê nenhuma linha", async () => {
      const rows = await scopedRows(getDb());
      const platformRows = await getDb().select().from(platformOnly);

      expect(rows).toEqual([]);
      expect(platformRows).toEqual([]);
    });

    it("bizu_app cru não grava", async () => {
      await expect(
        getDb().insert(scoped).values({ tenantId: null, label: label("x") }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(
        getDb().insert(scoped).values({ tenantId: tenantA, label: label("x") }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(
        getDb().insert(platformOnly).values({ label: label("x") }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("o modo plataforma não sobrevive à transação", async () => {
      // O pool tem várias conexões: repetir aumenta a chance de reusar a mesma.
      for (let i = 0; i < 20; i += 1) {
        await withPlatformData((tx) => tx.select().from(scoped).limit(1));

        const rows = await scopedRows(getDb());
        expect(rows).toEqual([]);
      }
    });
  });

  it("withPlatformScope lê tudo", async () => {
    const rows = await withPlatformScope("teste", scopedRows);

    expect(rows.map(({ tenantId }) => tenantId)).toEqual(
      expect.arrayContaining([tenantA, tenantB, null]),
    );
  });

  describe("platformOnlyPolicy", () => {
    it("withTenant não lê nem grava", async () => {
      const rows = await withTenant(tenantA, (tx) =>
        tx.select().from(platformOnly),
      );

      expect(rows).toEqual([]);
      await expect(
        withTenant(tenantA, (tx) =>
          tx.insert(platformOnly).values({ label: label("x") }),
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("withPlatformData lê e grava", async () => {
      const [inserted] = await withPlatformData((tx) =>
        tx.insert(platformOnly).values({ label: label("nova") }).returning(),
      );
      const rows = await withPlatformData((tx) =>
        tx
          .select()
          .from(platformOnly)
          .where(like(platformOnly.label, `${marker}%`)),
      );

      expect(inserted).toBeDefined();
      expect(rows.map((row) => row.label)).toEqual(
        expect.arrayContaining([label("plataforma"), label("nova")]),
      );
    });

    it("withPlatformScope (bypass) lê e grava", async () => {
      const rows = await withPlatformScope("teste", async (tx) => {
        await tx.insert(platformOnly).values({ label: label("bypass") });
        return tx
          .select()
          .from(platformOnly)
          .where(like(platformOnly.label, `${marker}%`));
      });

      expect(rows.map((row) => row.label)).toContain(label("bypass"));
    });
  });

  it("bizu_owner sem bypass não lê nem grava; com bypass lê tudo", async () => {
    const without = await owner`
      select 1 from rls_scope_probe where label like ${`${marker}%`}
      union all
      select 1 from rls_platform_probe where label like ${`${marker}%`}
    `;
    await expect(
      owner`insert into rls_platform_probe (label) values (${label("x")})`,
    ).rejects.toMatchObject({ code: "42501" });
    const withBypass = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx`select tenant_id from rls_scope_probe where label like ${`${marker}%`}`;
    });

    expect(without.length).toBe(0);
    expect(withBypass.map(({ tenant_id }) => tenant_id)).toEqual(
      expect.arrayContaining([tenantA, tenantB, null]),
    );
  });

  it("scopeTenantId preenche tenant_id a partir do escopo", () => {
    expect(scopeTenantId({ kind: "tenant", tenantId: tenantA })).toBe(tenantA);
    expect(scopeTenantId({ kind: "platform" })).toBeNull();
  });
});
