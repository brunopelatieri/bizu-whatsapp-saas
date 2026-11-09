import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import {
  asPlatform,
  bodyOf,
  cleanUpBilling,
  createPlanRow,
  ensureSubscription,
  hideFreePlans,
  makePlatformUser,
  restoreSettings,
  saveSettings,
  type SavedSettings,
  setSettings,
} from "./billing-helpers";
import {
  cleanUpPortal,
  createCustomer,
  customerEmail,
  lastLink,
  sessionCookies,
  verify,
} from "./portal-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";
import { phoneRow } from "./phone-helpers";

/**
 * SPEC `admin-crud`, trilha A: nome da organização nas listagens, excluir plano e preço,
 * editar organização. Cada bloco cobre uma etapa.
 */

let owner: postgres.Sql;
let saved: SavedSettings;
let platformOwner: TestUser;
let support: TestUser;
let tag: string;
const mail = createMemoryProvider();

const get = (user: TestUser, path: string) => call("GET", path, { cookie: user.cookie });
const send = (user: TestUser, method: string, path: string, body?: unknown) =>
  call(method, path, { cookie: user.cookie, body });

type Org = { id: string; name: string; role?: string; status?: string };
type Row = { id: string; organizations: Org[]; more: number };

beforeAll(async () => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
  saved = await saveSettings(owner);
  platformOwner = await makePlatformUser(owner, "platform_owner");
  support = await makePlatformUser(owner, "platform_support");
  tag = randomUUID().slice(0, 6);
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUpPortal(owner);
  await cleanUpBilling(owner);
  await restoreSettings(owner, saved);
  await cleanUp(owner);
  await owner.end();
});

/** Quatro organizações com donos próprios; nomes em ordem alfabética: A, B, C, D. */
async function createOrganizations() {
  const created: { id: string; name: string; owner: TestUser }[] = [];

  for (const letter of ["A", "B", "C", "D"]) {
    const user = await createUser(owner);
    const name = `Org ${tag} ${letter}`;
    created.push({ id: (await createTenant(user, name)).id, name, owner: user });
  }

  return created;
}

describe("etapa 1: nome da organização nas listagens", () => {
  let orgs: Awaited<ReturnType<typeof createOrganizations>>;

  beforeAll(async () => {
    orgs = await createOrganizations();
  });

  it("equipe: as 3 primeiras organizações por nome, com o papel, e o resto em `more`", async () => {
    const member = await createUser(owner);
    for (const org of orgs) await addMember(owner, org.id, member, "user");

    const body = await bodyOf(
      await get(support, `/api/admin/users?q=${member.email}`),
    );
    const [row] = body.items as Row[];

    expect(row?.organizations).toEqual([
      { id: orgs[0]?.id, name: orgs[0]?.name, role: "user" },
      { id: orgs[1]?.id, name: orgs[1]?.name, role: "user" },
      { id: orgs[2]?.id, name: orgs[2]?.name, role: "user" },
    ]);
    expect(row?.more).toBe(1);
    expect(row).not.toHaveProperty("tenants");
  });

  it("equipe: dono de uma organização vem com ela e sem `more`; sem organização, vazio", async () => {
    const [first] = orgs;
    const alone = await createUser(owner);
    const body = await bodyOf(
      await get(support, `/api/admin/users?q=${first?.owner.email}`),
    );

    expect((body.items as Row[])[0]).toMatchObject({
      organizations: [{ id: first?.id, name: first?.name, role: "owner" }],
      more: 0,
    });

    const empty = await bodyOf(await get(support, `/api/admin/users?q=${alone.email}`));
    expect((empty.items as Row[])[0]).toMatchObject({ organizations: [], more: 0 });
  });

  it("equipe: busca por nome de organização não casa, e a página respeita o limite de 3", async () => {
    // Forma da resposta para vários usuários de uma vez: cada um só vê as próprias organizações.
    const body = await bodyOf(await get(support, `/api/admin/users?q=${tag}`));
    const items = body.items as Array<Row & { email: string }>;

    // Nenhum usuário com `Org <tag>` no e-mail: a busca é por nome/e-mail, não por organização.
    expect(items).toEqual([]);

    const page = await bodyOf(await get(support, "/api/admin/users"));
    for (const item of page.items as Row[]) {
      expect(item.organizations.length).toBeLessThanOrEqual(3);
      expect(item.more).toBeGreaterThanOrEqual(0);
    }
  });

  it("portal: nomes das organizações com o status do vínculo", async () => {
    const email = customerEmail();
    const ph = phoneRow();
    const [person] = await owner<{ id: string }[]>`
      insert into portal_user (name, email, phone, phone_normalized, phone_key)
      values ('Cliente', ${email}, ${ph.phone}, ${ph.phoneNormalized}, ${ph.phoneKey}) returning id
    `;
    await asPlatform(owner, async (tx) => {
      for (const [index, org] of orgs.entries()) {
        await tx`
          insert into customer (tenant_id, portal_user_id, name, email, status,
                                phone, phone_normalized, phone_key)
          values (${org.id}, ${person?.id ?? ""}, 'Cliente', ${email},
                  ${index === 1 ? "active" : "lead"},
                  ${ph.phone}, ${ph.phoneNormalized}, ${ph.phoneKey})
        `;
      }
    });

    const body = await bodyOf(
      await get(support, `/api/admin/users?scope=portal&q=${email}`),
    );
    const [row] = body.items as Row[];

    expect(row?.organizations).toEqual([
      { id: orgs[0]?.id, name: orgs[0]?.name, status: "lead" },
      { id: orgs[1]?.id, name: orgs[1]?.name, status: "active" },
      { id: orgs[2]?.id, name: orgs[2]?.name, status: "lead" },
    ]);
    expect(row?.more).toBe(1);
  });

  it("planos: nomes das organizações, `more` e filtro `plan` em /admin/tenants", async () => {
    const plan = await createPlanRow(owner, { isFree: false });
    for (const org of orgs) await ensureSubscription(owner, org.id, plan.id);

    const list = await bodyOf(await get(support, "/api/admin/plans"));
    const row = (list.plans as Array<Row & { tenants: number }>).find(
      ({ id }) => id === plan.id,
    );

    expect(row?.tenants).toBe(4);
    expect(row?.organizations.map(({ name }) => name)).toEqual([
      orgs[0]?.name,
      orgs[1]?.name,
      orgs[2]?.name,
    ]);
    expect(row?.more).toBe(1);

    const tenants = await bodyOf(
      await get(support, `/api/admin/tenants?plan=${plan.id}`),
    );
    expect(tenants.total).toBe(4);
    expect(
      (tenants.items as Array<{ id: string }>).map(({ id }) => id).sort(),
    ).toEqual(orgs.map(({ id }) => id).sort());

    // Plano sem assinatura: lista vazia, não erro.
    const unused = await createPlanRow(owner, { isFree: false });
    const emptyRow = ((await bodyOf(await get(support, "/api/admin/plans"))).plans as Row[]).find(
      ({ id }) => id === unused.id,
    );
    expect(emptyRow).toMatchObject({ organizations: [], more: 0 });
    expect((await get(support, `/api/admin/tenants?plan=${unused.id}`)).status).toBe(200);
    expect((await get(support, "/api/admin/tenants?plan=nao-e-uuid")).status).toBe(400);
  });

  it("auditoria: filtra pelo nome da organização, sem tratar % e _ como curinga", async () => {
    const [first, second] = orgs;
    const byName = await bodyOf(
      await get(support, `/api/admin/audit?tenantQ=${encodeURIComponent(first?.name ?? "")}`),
    );
    const items = byName.items as Array<{ tenantId: string; tenantName: string }>;

    expect(items.length).toBeGreaterThan(0);
    expect(items.every(({ tenantId }) => tenantId === first?.id)).toBe(true);
    expect(byName.total).toBe(items.length);

    // Busca parcial e sem diferenciar maiúsculas.
    const partial = await bodyOf(
      await get(support, `/api/admin/audit?tenantQ=${encodeURIComponent(`org ${tag} b`)}`),
    );
    expect(
      (partial.items as Array<{ tenantId: string }>).every(
        ({ tenantId }) => tenantId === second?.id,
      ),
    ).toBe(true);

    const wildcard = await bodyOf(await get(support, "/api/admin/audit?tenantQ=%25"));
    expect(
      (wildcard.items as Array<{ tenantName: string | null }>).every(
        ({ tenantName }) => tenantName?.includes("%"),
      ),
    ).toBe(true);

    const none = await bodyOf(await get(support, `/api/admin/audit?tenantQ=zz-${tag}-inexistente`));
    expect(none).toMatchObject({ total: 0, items: [] });
  });
});

describe("etapa 2: excluir plano e preço", () => {
  async function newPlan(options: { isFree?: boolean } = {}) {
    const plan = await createPlanRow(owner, { isFree: options.isFree ?? false });
    const [price] = await owner<{ id: string }[]>`
      insert into plan_price (plan_id, provider, interval, amount_cents, provider_price_ref)
      values (${plan.id}, 'stripe', 'month', 4900, 'price_abc')
      returning id
    `;

    return { ...plan, priceId: price?.id ?? "" };
  }

  const planExists = async (id: string) =>
    (await owner`select 1 from plan where id = ${id}`).length === 1;

  async function tenantOn(planId: string, name: string) {
    const user = await createUser(owner);
    const tenant = await createTenant(user, name);
    await ensureSubscription(owner, tenant.id, planId);

    return tenant;
  }

  it("exclui plano sem uso, leva os preços e audita com o que saiu", async () => {
    const plan = await newPlan();
    const response = await send(platformOwner, "DELETE", `/api/admin/plans/${plan.id}`);

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      ok: true,
      providerRefs: [{ provider: "stripe", ref: "price_abc" }],
    });
    expect(await planExists(plan.id)).toBe(false);
    expect(await owner`select 1 from plan_price where plan_id = ${plan.id}`).toHaveLength(0);

    const [entry] = await asPlatform(
      owner,
      (tx) => tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_log
        where action = 'admin.plan_deleted' and target_id = ${plan.id}
      `,
    );
    expect(entry?.metadata).toMatchObject({ slug: plan.slug, prices: 1 });
  });

  it("plano inexistente é 404", async () => {
    const response = await send(platformOwner, "DELETE", `/api/admin/plans/${randomUUID()}`);

    expect(response.status).toBe(404);
  });

  it("plano com assinatura, em qualquer status, é 409 e traz os nomes", async () => {
    const plan = await newPlan();
    const tenant = await tenantOn(plan.id, `Org ${tag} Uso`);

    for (const status of ["active", "canceled"]) {
      await ensureSubscription(owner, tenant.id, plan.id, status);
      const response = await send(platformOwner, "DELETE", `/api/admin/plans/${plan.id}`);
      const body = await bodyOf(response);

      expect(response.status, status).toBe(409);
      expect(body.code).toBe("PLAN_IN_USE");
      expect(body.tenants).toEqual([{ id: tenant.id, name: `Org ${tag} Uso` }]);
    }
    expect(await planExists(plan.id)).toBe(true);
  });

  it("plano só citado como troca pendente também é 409", async () => {
    const current = await newPlan();
    const target = await newPlan();
    const tenant = await tenantOn(current.id, `Org ${tag} Pendente`);
    await asPlatform(
      owner,
      (tx) =>
        tx`update subscription set pending_plan_id = ${target.id} where tenant_id = ${tenant.id}`,
    );

    const response = await send(platformOwner, "DELETE", `/api/admin/plans/${target.id}`);

    expect(response.status).toBe(409);
    expect((await bodyOf(response)).code).toBe("PLAN_IN_USE");
    expect(await planExists(target.id)).toBe(true);
  });

  it("plano padrão do trial é 409; trocando o padrão, exclui", async () => {
    const plan = await newPlan();
    const other = await newPlan();
    await setSettings(owner, { trialPlanId: plan.id, trialDays: 14, graceDays: 7 });

    const blocked = await send(platformOwner, "DELETE", `/api/admin/plans/${plan.id}`);
    expect(blocked.status).toBe(409);
    expect((await bodyOf(blocked)).code).toBe("PLAN_IS_TRIAL_DEFAULT");

    await setSettings(owner, { trialPlanId: other.id, trialDays: 14, graceDays: 7 });
    expect((await send(platformOwner, "DELETE", `/api/admin/plans/${plan.id}`)).status).toBe(200);
  });

  it("o único plano gratuito ativo, sem padrão do trial, é 409; havendo outro, exclui", async () => {
    const restore = await hideFreePlans(owner);

    try {
      await owner`delete from platform_setting where key = 'trial_plan_id'`;
      const only = await createPlanRow(owner, { isFree: true });

      const blocked = await send(platformOwner, "DELETE", `/api/admin/plans/${only.id}`);
      expect(blocked.status).toBe(409);
      expect((await bodyOf(blocked)).code).toBe("LAST_FREE_PLAN");

      await createPlanRow(owner, { isFree: true });
      expect((await send(platformOwner, "DELETE", `/api/admin/plans/${only.id}`)).status).toBe(
        200,
      );

      // Plano pago nunca é "o último gratuito".
      const paid = await createPlanRow(owner, { isFree: false });
      expect((await send(platformOwner, "DELETE", `/api/admin/plans/${paid.id}`)).status).toBe(
        200,
      );
    } finally {
      await restore();
    }
  });

  it("assinatura criada no meio da exclusão não vira erro 500", async () => {
    const plan = await newPlan();
    const user = await createUser(owner);
    const tenant = await createTenant(user, `Org ${tag} Corrida`);

    // As duas operações correm juntas: ou a exclusão passa antes (e a assinatura falha na FK),
    // ou a assinatura entra antes (e a exclusão responde 409).
    const [deleted, subscribed] = await Promise.all([
      send(platformOwner, "DELETE", `/api/admin/plans/${plan.id}`),
      ensureSubscription(owner, tenant.id, plan.id).then(
        () => "ok",
        () => "fk",
      ),
    ]);

    expect(deleted.status).toBe(subscribed === "ok" ? 409 : 200);
    expect(deleted.status).not.toBe(500);
  });

  it("suporte e usuário comum recebem 403; nada é apagado", async () => {
    const plan = await newPlan();
    const regular = await createUser(owner);

    for (const user of [support, regular]) {
      expect((await send(user, "DELETE", `/api/admin/plans/${plan.id}`)).status).toBe(403);
      expect(
        (await send(user, "DELETE", `/api/admin/plans/${plan.id}/prices/${plan.priceId}`)).status,
      ).toBe(403);
    }
    expect(await planExists(plan.id)).toBe(true);
  });

  it("exclui preço sem uso e audita; a referência no provedor volta para a tela avisar", async () => {
    const plan = await newPlan();
    const path = `/api/admin/plans/${plan.id}/prices/${plan.priceId}`;
    const response = await send(platformOwner, "DELETE", path);

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      ok: true,
      providerRefs: [{ provider: "stripe", ref: "price_abc" }],
    });
    expect(await owner`select 1 from plan_price where id = ${plan.priceId}`).toHaveLength(0);
    expect(
      await asPlatform(
        owner,
        (tx) => tx`select 1 from audit_log
          where action = 'admin.plan_price_deleted' and target_id = ${plan.priceId}`,
      ),
    ).toHaveLength(1);

    expect((await send(platformOwner, "DELETE", path)).status).toBe(404);
  });

  it("preço de outro plano é 404; em uso (atual ou pendente) é 409", async () => {
    const plan = await newPlan();
    const other = await newPlan();

    const wrongPlan = await send(
      platformOwner,
      "DELETE",
      `/api/admin/plans/${other.id}/prices/${plan.priceId}`,
    );
    expect(wrongPlan.status).toBe(404);

    const tenant = await tenantOn(plan.id, `Org ${tag} Preço`);
    const path = `/api/admin/plans/${plan.id}/prices/${plan.priceId}`;

    await asPlatform(
      owner,
      (tx) =>
        tx`update subscription set plan_price_id = ${plan.priceId} where tenant_id = ${tenant.id}`,
    );
    const current = await send(platformOwner, "DELETE", path);
    expect(current.status).toBe(409);
    expect((await bodyOf(current)).code).toBe("PRICE_IN_USE");

    await asPlatform(
      owner,
      (tx) =>
        tx`update subscription set plan_price_id = null,
          metadata = ${tx.json({ pendingPlanPriceId: plan.priceId })}
          where tenant_id = ${tenant.id}`,
    );
    const pending = await send(platformOwner, "DELETE", path);
    expect(pending.status).toBe(409);
    expect((await bodyOf(pending)).code).toBe("PRICE_IN_USE");
    expect(await owner`select 1 from plan_price where id = ${plan.priceId}`).toHaveLength(1);
  });

  it("arquivar e reativar seguem pelo PATCH e ficam auditados com os campos", async () => {
    const plan = await newPlan();
    const path = `/api/admin/plans/${plan.id}`;

    const archived = await send(platformOwner, "PATCH", path, { active: false });
    expect((await bodyOf(archived)).plan).toMatchObject({ active: false });
    const restored = await send(platformOwner, "PATCH", path, { active: true });
    expect((await bodyOf(restored)).plan).toMatchObject({ active: true });

    const price = await send(platformOwner, "PATCH", `${path}/prices/${plan.priceId}`, {
      active: false,
    });
    expect(price.status).toBe(200);

    const rows = await asPlatform(
      owner,
      (tx) => tx<{ action: string; metadata: Record<string, string> }[]>`
        select action, metadata from audit_log
        where target_id in (${plan.id}, ${plan.priceId}) and action like 'admin.plan%'
        order by created_at
      `,
    );
    expect(rows.map(({ action }) => action)).toEqual([
      "admin.plan_updated",
      "admin.plan_updated",
      "admin.plan_price_updated",
    ]);
    expect(rows[0]?.metadata).toMatchObject({ fields: "active" });
  });
});

describe("etapa 3c: editar organização", () => {
  let tenant: { id: string; slug: string };
  let tenantOwner: TestUser;
  const path = (id: string) => `/api/admin/tenants/${id}`;

  beforeAll(async () => {
    tenantOwner = await createUser(owner);
    tenant = await createTenant(tenantOwner, `Edita ${tag}`);
  });

  const updates = (id: string) =>
    asPlatform(
      owner,
      (tx) =>
        tx`select 1 from audit_log where action = 'admin.tenant_updated' and target_id = ${id}`,
    );

  it("troca o nome e audita antes e depois no tenant", async () => {
    const response = await send(platformOwner, "PATCH", path(tenant.id), {
      name: `Renomeada ${tag}`,
    });

    expect(response.status).toBe(200);
    expect((await bodyOf(response)).tenant).toEqual({
      id: tenant.id,
      name: `Renomeada ${tag}`,
      slug: tenant.slug,
    });

    const [entry] = await asPlatform(
      owner,
      (tx) => tx<{ tenant_id: string; actor_type: string; metadata: Record<string, string> }[]>`
        select tenant_id, actor_type, metadata from audit_log
        where action = 'admin.tenant_updated' and target_id = ${tenant.id}
        order by created_at desc limit 1
      `,
    );
    expect(entry).toMatchObject({
      tenant_id: tenant.id,
      actor_type: "platform",
      metadata: { fields: "name", name_before: `Edita ${tag}`, name_after: `Renomeada ${tag}` },
    });
  });

  it("troca o slug; slug em uso é 409; formato inválido e corpo vazio são 400", async () => {
    const newSlug = `novo-${tag}`;
    const ok = await send(platformOwner, "PATCH", path(tenant.id), { slug: newSlug });
    expect(ok.status).toBe(200);
    expect((await bodyOf(ok)).tenant).toMatchObject({ slug: newSlug });
    expect(
      await owner`select 1 from organization where id = ${tenant.id} and slug = ${newSlug}`,
    ).toHaveLength(1);

    const [other] = await owner<{ slug: string }[]>`
      select slug from organization where id <> ${tenant.id} limit 1
    `;
    const taken = await send(platformOwner, "PATCH", path(tenant.id), { slug: other?.slug });
    expect(taken.status).toBe(409);
    expect((await bodyOf(taken)).code).toBe("SLUG_TAKEN");

    for (const body of [{ slug: "Slug Inválido" }, { slug: "ab" }, {}, { name: "x" }]) {
      expect((await send(platformOwner, "PATCH", path(tenant.id), body)).status).toBe(400);
    }
  });

  it("repetir os mesmos valores responde 200 e não audita de novo", async () => {
    const current = await send(platformOwner, "PATCH", path(tenant.id), {
      name: `Renomeada ${tag}`,
    });
    expect(current.status).toBe(200);

    const before = (await updates(tenant.id)).length;
    const again = await send(platformOwner, "PATCH", path(tenant.id), {
      name: `Renomeada ${tag}`,
    });
    expect(again.status).toBe(200);
    // Sem mudança real não há "antes e depois" a registrar.
    expect((await updates(tenant.id)).length).toBe(before);
  });

  it("organização em exclusão é 409 TENANT_DELETING; suspensa pode ser editada", async () => {
    const user = await createUser(owner);
    const target = await createTenant(user, `Excluindo ${tag}`);

    await asPlatform(
      owner,
      (tx) =>
        tx`update organization set status = 'suspended', access_mode = 'locked' where id = ${target.id}`,
    );
    const suspended = await send(platformOwner, "PATCH", path(target.id), {
      name: `Suspensa ${tag}`,
    });
    expect(suspended.status).toBe(200);

    await asPlatform(
      owner,
      (tx) => tx`update organization set status = 'deleting' where id = ${target.id}`,
    );
    const blocked = await send(platformOwner, "PATCH", path(target.id), { name: "Outro nome" });
    expect(blocked.status).toBe(409);
    expect((await bodyOf(blocked)).code).toBe("TENANT_DELETING");
  });

  it("suporte, usuário comum e dono do tenant recebem 403; inexistente é 404", async () => {
    const regular = await createUser(owner);

    for (const user of [support, regular, tenantOwner]) {
      expect((await send(user, "PATCH", path(tenant.id), { name: "Invasão" })).status).toBe(403);
    }
    expect(
      (await send(platformOwner, "PATCH", path(randomUUID()), { name: "Nome ok" })).status,
    ).toBe(404);
  });

  it("magic link com o slug antigo, reaproveitado por outra organização, não abre essa organização", async () => {
    mail.reset();
    const ownerA = await createUser(owner);
    const a = await createTenant(ownerA, `Portal A ${tag}`);
    const ownerC = await createUser(owner);
    await createTenant(ownerC, `Portal C ${tag}`);
    const email = customerEmail();
    const customerA = await createCustomer(ownerA, { email });
    await createCustomer(ownerC, { email });

    // O link sai com o slug de A.
    const invite = await call("POST", `/api/customers/${customerA.id}/invite`, {
      cookie: ownerA.cookie,
    });
    expect(invite.status).toBe(200);
    const link = lastLink(mail, email);
    expect(link.org).toBe(a.slug);

    // A plataforma renomeia o slug de A, e outra pessoa cria B com o slug antigo.
    const renamed = await send(platformOwner, "PATCH", path(a.id), { slug: `a-${tag}-novo` });
    expect(renamed.status).toBe(200);
    const ownerB = await createUser(owner);
    const created = await call("POST", "/api/tenant", {
      cookie: ownerB.cookie,
      body: { name: `Portal B ${tag}`, slug: a.slug },
    });
    expect(created.status).toBe(201);
    const b = ((await created.json()) as { tenant: { id: string } }).tenant;

    // O token é da pessoa, não do slug. O `org` antigo só escolhe entre os tenants dela, e B
    // não é um deles: ela fica sem organização ativa, com A e C disponíveis.
    const entered = await verify(link.token, link.org);
    expect(entered.status).toBe(200);
    await waitForBackgroundTasks();

    const me = await call("GET", "/api/portal/me", { cookie: sessionCookies(entered) });
    const body = (await me.json()) as {
      active: { id: string } | null;
      tenants: { id: string }[];
    };

    // A entrada vale para quem o convite abriu (A); o slug antigo, agora de B, não leva a B.
    expect(body.active?.id).not.toBe(b.id);
    expect(body.tenants.map(({ id }) => id)).not.toContain(b.id);
    expect(body.tenants.map(({ id }) => id)).toContain(a.id);
  });
});
