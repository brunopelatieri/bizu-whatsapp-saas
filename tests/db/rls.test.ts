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
import { eq, inArray, isTable, like, sql } from "drizzle-orm";
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

/**
 * `organization_tag` e `organization_profile` (crm-cadastro A4): sem `tenant_id`, só a
 * plataforma lê e grava. As tabelas reais, nos mesmos modos das provas acima; `tag` e
 * `custom_field` (escopo anulável) provam que o tenant nunca vê a linha da plataforma.
 */
describe("RLS do CRM da plataforma (tabelas reais)", () => {
  const { organizationTag, organizationProfile, tag, customField } = schema;
  let owner: postgres.Sql;
  const marker = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  let platformTagId: string;
  let tenantTagId: string;
  let platformFieldId: string;

  const platformOnlyTables = tables
    .map((table) => getTableConfig(table))
    .filter(({ policies }) => policies.some(({ name }) => name === "platform_only"))
    .map(({ name }) => name)
    .sort();

  beforeAll(async () => {
    owner = connectOwner();

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        insert into organization (id, name, slug) values
          (${orgId}, 'CRM A', ${`crm-a-${marker}`}),
          (${otherOrgId}, 'CRM B', ${`crm-b-${marker}`})
      `;
      const [platformTag] = await tx<{ id: string }[]>`
        insert into tag (tenant_id, name) values (null, ${`plat-${marker}`}) returning id
      `;
      const [tenantTag] = await tx<{ id: string }[]>`
        insert into tag (tenant_id, name) values (${orgId}, ${`tenant-${marker}`}) returning id
      `;
      const [field] = await tx<{ id: string }[]>`
        insert into custom_field (tenant_id, entity, key, label, type)
        values (null, 'organization', ${`k_${marker}`}, 'Campo', 'text') returning id
      `;
      if (!platformTag || !tenantTag || !field) throw new Error("linhas não criadas");
      platformTagId = platformTag.id;
      tenantTagId = tenantTag.id;
      platformFieldId = field.id;

      await tx`insert into organization_tag (organization_id, tag_id) values (${orgId}, ${platformTagId})`;
      await tx`
        insert into organization_profile (organization_id, custom_fields)
        values (${orgId}, ${tx.json({ [platformFieldId]: "x" })})
      `;
    });
  });

  afterAll(async () => {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from custom_field where tenant_id is null and key = ${`k_${marker}`}`;
      await tx`delete from tag where name in (${`plat-${marker}`}, ${`tenant-${marker}`})`;
      await tx`delete from organization where id in (${orgId}, ${otherOrgId})`;
    });
    await owner.end();
  });

  it("só as tabelas da plataforma usam platformOnlyPolicy, com RLS forçado", async () => {
    expect(platformOnlyTables).toEqual([
      "message_retention_state",
      "organization_profile",
      "organization_tag",
      "retention_policy",
    ]);

    for (const name of platformOnlyTables) {
      const [row] = await owner<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class where oid = ${`public.${name}`}::regclass
      `;
      expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  it("withTenant (inclusive o tenant etiquetado) não lê nem grava as tabelas da plataforma", async () => {
    const [tags, profiles] = await withTenant(orgId, async (tx) => [
      await tx.select().from(organizationTag),
      await tx.select().from(organizationProfile),
    ]);
    expect(tags).toEqual([]);
    expect(profiles).toEqual([]);

    await expect(
      withTenant(otherOrgId, (tx) =>
        tx.insert(organizationTag).values({ organizationId: otherOrgId, tagId: platformTagId }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(otherOrgId, (tx) => tx.insert(organizationProfile).values({ organizationId: otherOrgId })),
    ).rejects.toThrow();
  });

  it("bizu_app cru (sem helper) não lê as tabelas da plataforma", async () => {
    expect(await getDb().select().from(organizationTag)).toEqual([]);
    expect(await getDb().select().from(organizationProfile)).toEqual([]);
  });

  it("withPlatformData lê e grava as duas tabelas", async () => {
    const [tags, profiles] = await withPlatformData(async (tx) => [
      await tx.select().from(organizationTag).where(eq(organizationTag.organizationId, orgId)),
      await tx.select().from(organizationProfile).where(eq(organizationProfile.organizationId, orgId)),
    ]);
    expect(tags).toHaveLength(1);
    expect(profiles).toHaveLength(1);

    await withPlatformData(async (tx) => {
      await tx.insert(organizationProfile).values({ organizationId: otherOrgId });
      await tx.delete(organizationProfile).where(eq(organizationProfile.organizationId, otherOrgId));
    });
  });

  it("bizu_owner sem bypass nem escopo não lê as tabelas da plataforma", async () => {
    expect(await owner`select 1 from organization_tag where organization_id = ${orgId}`).toHaveLength(0);
    expect(await owner`select 1 from organization_profile where organization_id = ${orgId}`).toHaveLength(0);
  });

  it("tag e custom_field: o tenant não vê a linha da plataforma, e a plataforma não vê a do tenant", async () => {
    const fromTenant = await withTenant(orgId, async (tx) => ({
      tags: await tx.select({ id: tag.id }).from(tag).where(like(tag.name, `%${marker}`)),
      fields: await tx.select({ id: customField.id }).from(customField),
    }));
    expect(fromTenant.tags.map(({ id }) => id)).toEqual([tenantTagId]);
    expect(fromTenant.fields.map(({ id }) => id)).not.toContain(platformFieldId);

    const fromPlatform = await withPlatformData(async (tx) => ({
      tags: await tx.select({ id: tag.id }).from(tag).where(like(tag.name, `%${marker}`)),
      fields: await tx.select({ id: customField.id }).from(customField).where(eq(customField.id, platformFieldId)),
    }));
    expect(fromPlatform.tags.map(({ id }) => id)).toEqual([platformTagId]);
    expect(fromPlatform.fields).toHaveLength(1);
  });

  it("apagar a organização leva organization_tag e organization_profile por cascade", async () => {
    const doomed = randomUUID();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`insert into organization (id, name, slug) values (${doomed}, 'CRM C', ${`crm-c-${marker}`})`;
      await tx`insert into organization_tag (organization_id, tag_id) values (${doomed}, ${platformTagId})`;
      await tx`insert into organization_profile (organization_id) values (${doomed})`;
      await tx`delete from organization where id = ${doomed}`;

      expect(await tx`select 1 from organization_tag where organization_id = ${doomed}`).toHaveLength(0);
      expect(await tx`select 1 from organization_profile where organization_id = ${doomed}`).toHaveLength(0);
    });
  });
});

/**
 * Caixa de entrada (`docs/specs/caixa-de-entrada/spec.md`, passo 1): `chat_contact`,
 * `chat_contact_identity`, `conversation`, `message` e `file` (agora com `tenant_id` anulável)
 * nos três modos de `scopedPolicy()`, com as tabelas reais.
 */
describe("RLS da caixa de entrada (tabelas reais)", () => {
  const { chatContact, chatContactIdentity, conversation, message, file } = schema;
  let owner: postgres.Sql;
  const marker = randomUUID().slice(0, 8);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const rowIds = () => ({
    channel: randomUUID(),
    contact: randomUUID(),
    identity: randomUUID(),
    conversation: randomUUID(),
    message: randomUUID(),
    file: randomUUID(),
  });
  /** Uma linha de cada tabela por escopo: A, B e plataforma. */
  const ids = { A: rowIds(), B: rowIds(), P: rowIds() };
  const scopes = [
    ["A", () => tenantA],
    ["B", () => tenantB],
    ["P", () => null],
  ] as const;

  const inboxTables = [
    ["chat_contact", chatContact, "contact"],
    ["chat_contact_identity", chatContactIdentity, "identity"],
    ["conversation", conversation, "conversation"],
    ["message", message, "message"],
    ["file", file, "file"],
  ] as const;

  type Key = (typeof inboxTables)[number][2];
  const allIds = (key: Key) => [ids.A[key], ids.B[key], ids.P[key]];

  /** Ids da tabela que a conexão enxerga, entre as linhas deste teste. */
  async function visible(tx: Pick<Tx, "select">, key: Key) {
    const entry = inboxTables.find(([, , name]) => name === key);
    if (!entry) throw new Error(key);
    const table = entry[1];
    const rows = await tx
      .select({ id: table.id })
      .from(table)
      .where(inArray(table.id, allIds(key)));
    return rows.map(({ id }) => id).sort();
  }

  beforeAll(async () => {
    owner = connectOwner();

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        insert into organization (id, name, slug) values
          (${tenantA}, 'Inbox A', ${`inbox-a-${marker}`}),
          (${tenantB}, 'Inbox B', ${`inbox-b-${marker}`})
      `;
      for (const [name, tenantOf] of scopes) {
        const row = ids[name];
        const tenantId = tenantOf();
        await tx`insert into channel (id, tenant_id, type, name) values (${row.channel}, ${tenantId}, 'whatsapp_qr', ${`inbox-${name}-${marker}`})`;
        await tx`insert into chat_contact (id, tenant_id, phone, phone_key, created_via) values (${row.contact}, ${tenantId}, '5511988880001', '551188880001', 'inbound')`;
        await tx`insert into chat_contact_identity (id, tenant_id, contact_id, kind, value) values (${row.identity}, ${tenantId}, ${row.contact}, 'lid', ${`${marker}@lid`})`;
        await tx`insert into conversation (id, tenant_id, channel_id, contact_id) values (${row.conversation}, ${tenantId}, ${row.channel}, ${row.contact})`;
        await tx`insert into file (id, tenant_id, owner_type, owner_id, key, name, size, mime, provider) values (${row.file}, ${tenantId}, 'message', ${row.message}, ${`inbound/${marker}-${name}`}, 'foto.jpg', 10, 'image/jpeg', 'memory')`;
        await tx`insert into message (id, tenant_id, conversation_id, channel_id, direction, sender_type, type, text, file_id, media_status, provider_message_id) values (${row.message}, ${tenantId}, ${row.conversation}, ${row.channel}, 'in', 'contact', 'image', 'oi', ${row.file}, 'ready', ${`wamid.${marker}`})`;
      }
    });
  });

  afterAll(async () => {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where id = any(${allIds("contact")}::uuid[])`;
      await tx`delete from file where id = any(${allIds("file")}::uuid[])`;
      await tx`delete from channel where id = ${ids.P.channel}`;
      await tx`delete from organization where id in (${tenantA}, ${tenantB})`;
    });
    await owner.end();
  });

  it.each(inboxTables.map(([name, , key]) => [name, key] as const))(
    "%s: withTenant lê só o próprio tenant, withPlatformData só a plataforma, bypass tudo, cru nada",
    async (_name, key) => {
      expect(await withTenant(tenantA, (tx) => visible(tx, key))).toEqual([ids.A[key]]);
      expect(await withTenant(tenantB, (tx) => visible(tx, key))).toEqual([ids.B[key]]);
      expect(await withPlatformData((tx) => visible(tx, key))).toEqual([ids.P[key]]);
      expect(await withPlatformScope("teste", (tx) => visible(tx, key))).toEqual(allIds(key).sort());
      expect(await visible(getDb(), key)).toEqual([]);
    },
  );

  const contactValues = (tenantId: string | null) => ({
    tenantId,
    phone: "5511977770001",
    phoneKey: "551177770001",
    createdVia: "inbound" as const,
  });

  it("withTenant não grava linha da plataforma nem de outro tenant", async () => {
    for (const tenantId of [null, tenantB]) {
      await expect(
        withTenant(tenantA, (tx) => tx.insert(chatContact).values(contactValues(tenantId))),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    }
  });

  it("withPlatformData não grava linha com tenant_id; bizu_app cru não grava nada", async () => {
    await expect(
      withPlatformData((tx) => tx.insert(chatContact).values(contactValues(tenantA))),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(getDb().insert(chatContact).values(contactValues(null))).rejects.toMatchObject({
      cause: { code: "42501" },
    });
  });

  it("tenant não lê nem apaga arquivo da plataforma", async () => {
    const result = await withTenant(tenantA, async (tx) => ({
      read: await tx.select().from(file).where(eq(file.id, ids.P.file)),
      deleted: await tx.delete(file).where(eq(file.id, ids.P.file)).returning(),
    }));

    expect(result).toEqual({ read: [], deleted: [] });
    expect(await withPlatformData((tx) => visible(tx, "file"))).toEqual([ids.P.file]);
  });

  it("conversation.channel_id é imutável, inclusive com bypass", async () => {
    const move = (tx: Tx) =>
      tx
        .update(conversation)
        .set({ channelId: ids.B.channel })
        .where(eq(conversation.id, ids.A.conversation));

    await expect(withTenant(tenantA, move)).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(withPlatformScope("teste", move)).rejects.toMatchObject({
      cause: { code: "23514" },
    });

    // Os demais campos seguem editáveis, e repetir o mesmo canal não é troca.
    const [row] = await withTenant(tenantA, (tx) =>
      tx
        .update(conversation)
        .set({ status: "pending", channelId: ids.A.channel })
        .where(eq(conversation.id, ids.A.conversation))
        .returning(),
    );
    expect(row).toMatchObject({ status: "pending", channelId: ids.A.channel });
  });

  it("canal com conversa não é apagado (restrict); apagar a organização leva tudo por cascade", async () => {
    await expect(
      withTenant(tenantB, (tx) =>
        tx.delete(schema.channel).where(eq(schema.channel.id, ids.B.channel)),
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    const doomed = randomUUID();
    const row = rowIds();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`insert into organization (id, name, slug) values (${doomed}, 'Inbox C', ${`inbox-c-${marker}`})`;
      await tx`insert into channel (id, tenant_id, type, name) values (${row.channel}, ${doomed}, 'whatsapp_qr', 'c')`;
      await tx`insert into chat_contact (id, tenant_id, phone, phone_key, created_via) values (${row.contact}, ${doomed}, '5511988880001', '551188880001', 'inbound')`;
      await tx`insert into conversation (id, tenant_id, channel_id, contact_id) values (${row.conversation}, ${doomed}, ${row.channel}, ${row.contact})`;
      await tx`insert into file (id, tenant_id, owner_type, owner_id, key, name, size, mime, provider) values (${row.file}, ${doomed}, 'message', ${row.message}, ${`inbound/${marker}-c`}, 'a.jpg', 1, 'image/jpeg', 'memory')`;
      await tx`insert into message (id, tenant_id, conversation_id, channel_id, direction, sender_type, type, file_id) values (${row.message}, ${doomed}, ${row.conversation}, ${row.channel}, 'in', 'contact', 'image', ${row.file})`;
      await tx`delete from organization where id = ${doomed}`;

      const left = await tx`
        select (select count(*) from channel where id = ${row.channel})
             + (select count(*) from chat_contact where id = ${row.contact})
             + (select count(*) from conversation where id = ${row.conversation})
             + (select count(*) from message where id = ${row.message})
             + (select count(*) from file where id = ${row.file}) as total
      `;
      expect(Number(left[0]?.total)).toBe(0);
    });
  });
});
