import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBillingTrial } from "@/jobs/billing";
import { runSeed, SEED_CUSTOMERS, SEED_MANUAL_TENANTS, SEED_USERS } from "@/db/seed";
import { checkLimit } from "@/lib/billing/limits";
import { computeTrialEnd, DAY_MS } from "@/lib/billing/trial";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import {
  call,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  newEmail,
  type TestUser,
} from "./tenant-helpers";
import {
  bodyOf,
  cleanUpBilling,
  createPlanRow,
  restoreSettings,
  saveSettings,
  type SavedSettings,
  setSettings,
} from "./billing-helpers";

/**
 * Plano padrão e trial no onboarding, estados de cobrança em `/api/me`, `read_only` e
 * `locked` em `requireTenant`, limite de assentos, job `billing.trial` e seed.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;
let saved: SavedSettings;
let trialPlan: { id: string; slug: string };
let freePlan: { id: string; slug: string };

type SubscriptionRow = {
  id: string;
  status: string;
  plan_id: string;
  trial_ends_at: Date | null;
  metadata: { trialNotices?: Record<string, string> };
};

async function subscriptionOf(tenantId: string) {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    const [row] = await tx<SubscriptionRow[]>`
      select id, status, plan_id, trial_ends_at, metadata
      from subscription where tenant_id = ${tenantId}
    `;
    return row;
  });
}

async function accessModeOf(tenantId: string) {
  const [row] = await owner<{ access_mode: string }[]>`
    select access_mode from organization where id = ${tenantId}
  `;
  return row?.access_mode;
}

async function events(tenantId: string) {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    return tx<{ from_status: string | null; to_status: string; source: string }[]>`
      select from_status, to_status, source from subscription_event
      where tenant_id = ${tenantId} order by created_at
    `;
  });
}

/** O job só olha estes tenants: não mexe nos dados do seed nem de outros testes. */
const only = (...tenantIds: string[]) => ({ tenantIds });

const me = async (user: TestUser) => bodyOf(await call("GET", "/api/me", { cookie: user.cookie }));

beforeAll(async () => {
  owner = connectOwner();
  saved = await saveSettings(owner);

  trialPlan = await createPlanRow(owner, {
    isFree: false,
    limits: { members: 2, customers: 5 },
    features: ["audit_export"],
  });
  freePlan = await createPlanRow(owner, { isFree: true, limits: { members: 1 } });
  await setSettings(owner, { trialPlanId: trialPlan.id, trialDays: 14, graceDays: 7 });
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUpBilling(owner);
  await restoreSettings(owner, saved);
  await cleanUp(owner);
  await owner.end();
});

describe("trial no onboarding", () => {
  it("o tenant nasce trialing no plano padrão, com fim em 14 dias", async () => {
    const before = Date.now();
    const user = await createUser(owner);
    const tenant = await createTenant(user);
    const subscription = await subscriptionOf(tenant.id);

    expect(subscription).toMatchObject({ status: "trialing", plan_id: trialPlan.id });
    const endsAt = subscription?.trial_ends_at?.getTime() ?? 0;
    expect(endsAt).toBeGreaterThanOrEqual(before + 14 * DAY_MS - 1000);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 14 * DAY_MS + 1000);

    expect(await events(tenant.id)).toEqual([
      { from_status: null, to_status: "trialing", source: "system" },
    ]);
  });

  it("/api/me expõe estado, plano, features e limites", async () => {
    const user = await createUser(owner);
    await createTenant(user);

    const body = await me(user);

    expect(body.billing).toMatchObject({
      state: "trialing",
      plan: { slug: trialPlan.slug, isFree: false },
      trialDaysLeft: 14,
    });
    expect(body.features).toEqual(["audit_export"]);
    expect(body.limits).toEqual({ members: 2, customers: 5 });
  });

  it("sem tenant, /api/me não traz cobrança", async () => {
    const user = await createUser(owner);

    const body = await me(user);

    expect(body.billing).toBeNull();
    expect(body.features).toEqual([]);
    expect(body.limits).toEqual({});
  });

  it("mudar a configuração não altera tenants já criados", async () => {
    const user = await createUser(owner);
    const tenant = await createTenant(user);
    const first = await subscriptionOf(tenant.id);

    await setSettings(owner, { trialPlanId: freePlan.id, trialDays: 0, graceDays: 7 });
    try {
      expect(await subscriptionOf(tenant.id)).toEqual(first);

      // Já o próximo tenant nasce no plano gratuito, ativo e sem fim.
      const other = await createUser(owner);
      const freshTenant = await createTenant(other);

      expect(await subscriptionOf(freshTenant.id)).toMatchObject({
        status: "active",
        plan_id: freePlan.id,
        trial_ends_at: null,
      });
      expect((await me(other)).billing).toMatchObject({
        state: "active",
        trialEndsAt: null,
        trialDaysLeft: null,
      });
    } finally {
      await setSettings(owner, { trialPlanId: trialPlan.id, trialDays: 14, graceDays: 7 });
    }
  });

  it("sem trial e com plano pago configurado, cai no gratuito (nunca pago de graça)", async () => {
    await setSettings(owner, { trialPlanId: trialPlan.id, trialDays: 0, graceDays: 7 });
    try {
      const [fallback] = await owner<{ id: string }[]>`
        select id from plan where is_free and active order by sort_order, name limit 1
      `;
      const user = await createUser(owner);
      const tenant = await createTenant(user);
      const subscription = await subscriptionOf(tenant.id);

      expect(subscription?.status).toBe("active");
      expect(subscription?.plan_id).toBe(fallback?.id);
    } finally {
      await setSettings(owner, { trialPlanId: trialPlan.id, trialDays: 14, graceDays: 7 });
    }
  });
});

describe("estados que bloqueiam", () => {
  let user: TestUser;
  let tenantId: string;

  beforeAll(async () => {
    user = await createUser(owner);
    tenantId = (await createTenant(user)).id;
  });

  const setAccess = (mode: string) =>
    owner`update organization set access_mode = ${mode} where id = ${tenantId}`;

  it("read_only: lê normalmente e recusa escrita com TENANT_READ_ONLY", async () => {
    await setAccess("read_only");

    const read = await call("GET", "/api/team", { cookie: user.cookie });
    expect(read.status).toBe(200);
    expect((await me(user)).billing).toMatchObject({ state: "read_only" });

    const write = await call("PATCH", "/api/tenant", {
      cookie: user.cookie,
      body: { name: "Nome novo" },
    });
    expect(write.status).toBe(403);
    expect((await bodyOf(write)).code).toBe("TENANT_READ_ONLY");

    const invite = await call("POST", "/api/team/invitations", {
      cookie: user.cookie,
      body: { email: newEmail(), role: "member" },
    });
    expect(invite.status).toBe(403);
    expect((await bodyOf(invite)).code).toBe("TENANT_READ_ONLY");
  });

  it("locked: bloqueia até a leitura com TENANT_SUSPENDED", async () => {
    await setAccess("locked");

    const read = await call("GET", "/api/team", { cookie: user.cookie });
    expect(read.status).toBe(403);
    expect((await bodyOf(read)).code).toBe("TENANT_SUSPENDED");

    const write = await call("PATCH", "/api/tenant", {
      cookie: user.cookie,
      body: { name: "Nome novo" },
    });
    expect(write.status).toBe(403);
    expect((await bodyOf(write)).code).toBe("TENANT_SUSPENDED");

    const body = await me(user);
    expect(body.billing).toMatchObject({ state: "locked" });
    expect(body.permissions).toEqual([]);
    expect(body.features).toEqual([]);
    expect(body.limits).toEqual({});
  });

  it("volta ao normal quando o acesso é restaurado", async () => {
    await setAccess("full");

    const write = await call("PATCH", "/api/tenant", {
      cookie: user.cookie,
      body: { name: "Nome final" },
    });
    expect(write.status).toBe(200);
  });
});

describe("limite de assentos", () => {
  it("convite reserva assento e o limite do plano bloqueia o seguinte", async () => {
    setEmailProviderForTests(mail);
    const user = await createUser(owner);
    const { id } = await createTenant(user); // plano com members: 2 → 1 usado

    const first = await call("POST", "/api/team/invitations", {
      cookie: user.cookie,
      body: { email: newEmail(), role: "member" },
    });
    expect(first.status).toBe(201);

    const second = await call("POST", "/api/team/invitations", {
      cookie: user.cookie,
      body: { email: newEmail(), role: "member" },
    });
    expect(second.status).toBe(403);
    expect((await bodyOf(second)).code).toBe("PLAN_LIMIT_REACHED");

    expect(await checkLimit(id, "members")).toMatchObject({
      limit: 2,
      used: 2,
      allowed: false,
    });
  });

  it("reconvidar o mesmo e-mail não ocupa um segundo assento", async () => {
    setEmailProviderForTests(mail);
    const user = await createUser(owner);
    await createTenant(user);
    const email = newEmail();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call("POST", "/api/team/invitations", {
        cookie: user.cookie,
        body: { email, role: "member" },
      });
      expect(response.status).toBe(201);
    }
  });

  it("aceitar um convite que já reservava o assento passa; sem assento livre, não", async () => {
    setEmailProviderForTests(mail);
    const user = await createUser(owner);
    const { id } = await createTenant(user);
    const guest = await createUser(owner);

    const invited = await call("POST", "/api/team/invitations", {
      cookie: user.cookie,
      body: { email: guest.email, role: "member" },
    });
    const invitationId = ((await bodyOf(invited)).invitation as { id: string }).id;

    // Plano encolhe para 1: não sobra assento para o convidado.
    await owner`update plan set limits = ${owner.json({ members: 1 })} where id = ${trialPlan.id}`;
    try {
      const blocked = await call("POST", `/api/invitations/${invitationId}/accept`, {
        cookie: guest.cookie,
      });
      expect(blocked.status).toBe(403);
      expect((await bodyOf(blocked)).code).toBe("PLAN_LIMIT_REACHED");
    } finally {
      await owner`update plan set limits = ${owner.json({ members: 2, customers: 5 })} where id = ${trialPlan.id}`;
    }

    const accepted = await call("POST", `/api/invitations/${invitationId}/accept`, {
      cookie: guest.cookie,
    });
    expect(accepted.status).toBe(200);
    expect(await checkLimit(id, "members")).toMatchObject({ used: 2, allowed: false });
  });

  it("papel personalizado respeita o limite do plano", async () => {
    const plan = await createPlanRow(owner, { isFree: false, limits: { custom_roles: 1 } });
    const user = await createUser(owner);
    const { id } = await createTenant(user);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`update subscription set plan_id = ${plan.id} where tenant_id = ${id}`;
    });

    await createRole(user, "assistente", ["invitation:create"]);

    const refused = await call("POST", "/api/roles", {
      cookie: user.cookie,
      body: { name: "auxiliar", permissions: ["invitation:create"] },
    });
    expect(refused.status).toBe(403);
    expect((await bodyOf(refused)).code).toBe("PLAN_LIMIT_REACHED");
  });

  it("tenant sem assinatura não tem limite", async () => {
    const user = await createUser(owner);
    const { id } = await createTenant(user);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from subscription where tenant_id = ${id}`;
    });

    expect(await checkLimit(id, "members")).toMatchObject({ limit: null, allowed: true });
  });
});

describe("job billing.trial", () => {
  let user: TestUser;
  let tenantId: string;
  let endsAt: Date;

  beforeAll(async () => {
    user = await createUser(owner);
    tenantId = (await createTenant(user, "Clínica do Trial")).id;
    endsAt = (await subscriptionOf(tenantId))?.trial_ends_at as Date;
    mail.reset();
    setEmailProviderForTests(mail);
  });

  const mailsTo = (template: string) =>
    mail.sent.filter(({ to, tags }) => to === user.email && tags?.template === template);

  it("trial longe do fim não manda nada", async () => {
    await runBillingTrial(new Date(), { tenantIds: [tenantId] });

    expect(mail.sent.filter(({ to }) => to === user.email)).toEqual([]);
    expect((await subscriptionOf(tenantId))?.status).toBe("trialing");
  });

  it("T-3 avisa uma vez, mesmo rodando duas vezes", async () => {
    const now = new Date(endsAt.getTime() - 2.5 * DAY_MS);

    await runBillingTrial(now, only(tenantId));
    await runBillingTrial(now, only(tenantId));

    expect(mailsTo("trial-ending")).toHaveLength(1);
    expect(mailsTo("trial-ending")[0]?.subject).toContain("termina em");
  });

  it("T-1 avisa uma vez", async () => {
    const now = new Date(endsAt.getTime() - 0.5 * DAY_MS);

    await runBillingTrial(now, only(tenantId));
    await runBillingTrial(now, only(tenantId));

    expect(mailsTo("trial-ending")).toHaveLength(2);
    expect(mailsTo("trial-ending")[1]?.subject).toContain("amanhã");
  });

  it("no dia do fim avisa (T0) e o tenant ainda não bloqueia: há carência", async () => {
    const now = new Date(endsAt.getTime() + 1000);

    await runBillingTrial(now, only(tenantId));
    await runBillingTrial(now, only(tenantId));

    expect(mailsTo("trial-ending")).toHaveLength(3);
    expect(mailsTo("trial-expired")).toHaveLength(0);
    expect((await subscriptionOf(tenantId))?.status).toBe("trialing");
    expect(await accessModeOf(tenantId)).toBe("full");
  });

  it("passada a carência expira para read_only, avisa uma vez e registra o evento", async () => {
    const now = new Date(endsAt.getTime() + 8 * DAY_MS);

    const first = await runBillingTrial(now, only(tenantId));
    const second = await runBillingTrial(now, only(tenantId));

    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
    expect((await subscriptionOf(tenantId))?.status).toBe("expired");
    expect(await accessModeOf(tenantId)).toBe("read_only");
    expect(mailsTo("trial-expired")).toHaveLength(1);
    expect(mailsTo("trial-ending")).toHaveLength(3);

    expect((await events(tenantId)).at(-1)).toEqual({
      from_status: "trialing",
      to_status: "expired",
      source: "job",
    });

    // O tenant vira somente leitura de verdade na API.
    const write = await call("PATCH", "/api/tenant", {
      cookie: user.cookie,
      body: { name: "Depois do trial" },
    });
    expect(write.status).toBe(403);
    expect((await bodyOf(write)).code).toBe("TENANT_READ_ONLY");
    expect((await me(user)).billing).toMatchObject({ state: "read_only" });
  });

  it("job parado não manda T-3 quando já está a 1 dia do fim", async () => {
    const late = await createUser(owner);
    const lateTenant = (await createTenant(late)).id;
    const lateEnd = (await subscriptionOf(lateTenant))?.trial_ends_at as Date;
    mail.reset();

    await runBillingTrial(new Date(lateEnd.getTime() - 0.4 * DAY_MS), only(lateTenant));

    const sent = mail.sent.filter(({ to }) => to === late.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain("amanhã");
  });

  it("não toca tenant suspenso nem assinatura que não é trial", async () => {
    const suspended = await createUser(owner);
    const suspendedId = (await createTenant(suspended)).id;
    await owner`update organization set status = 'suspended', access_mode = 'locked' where id = ${suspendedId}`;
    const end = (await subscriptionOf(suspendedId))?.trial_ends_at as Date;
    mail.reset();

    await runBillingTrial(new Date(end.getTime() + 30 * DAY_MS), only(suspendedId));

    expect((await subscriptionOf(suspendedId))?.status).toBe("trialing");
    expect(mail.sent.filter(({ to }) => to === suspended.email)).toEqual([]);
  });

  it("falha no aviso de expiração desfaz a expiração: a próxima rodada faz os dois", async () => {
    const flaky = await createUser(owner);
    const flakyId = (await createTenant(flaky)).id;
    const end = (await subscriptionOf(flakyId))?.trial_ends_at as Date;
    const now = new Date(end.getTime() + 8 * DAY_MS);

    setEmailProviderForTests({
      id: "memory",
      send: async () => {
        throw new Error("provedor fora do ar");
      },
    });
    await expect(runBillingTrial(now, only(flakyId))).rejects.toThrow("billing.trial");

    const failed = await subscriptionOf(flakyId);
    expect(failed?.status).toBe("trialing");
    expect(failed?.metadata.trialNotices?.expired).toBeUndefined();
    expect(await accessModeOf(flakyId)).toBe("full");

    mail.reset();
    setEmailProviderForTests(mail);
    const retry = await runBillingTrial(now, only(flakyId));

    expect(retry).toMatchObject({ expired: 1, notices: { expired: 1 } });
    expect((await subscriptionOf(flakyId))?.status).toBe("expired");
    expect(await accessModeOf(flakyId)).toBe("read_only");
    expect(mail.sent.filter(({ to }) => to === flaky.email)).toHaveLength(1);
  });

  it("falha de envio não marca o aviso: a próxima rodada tenta de novo", async () => {
    const flaky = await createUser(owner);
    const flakyId = (await createTenant(flaky)).id;
    const end = (await subscriptionOf(flakyId))?.trial_ends_at as Date;
    const now = new Date(end.getTime() - 0.5 * DAY_MS);

    setEmailProviderForTests({
      id: "memory",
      send: async () => {
        throw new Error("provedor fora do ar");
      },
    });
    await expect(runBillingTrial(now, only(flakyId))).rejects.toThrow("billing.trial");
    expect((await subscriptionOf(flakyId))?.metadata.trialNotices?.t1).toBeUndefined();

    mail.reset();
    setEmailProviderForTests(mail);
    await runBillingTrial(now, only(flakyId));

    expect(mail.sent.filter(({ to }) => to === flaky.email)).toHaveLength(1);
  });
});

describe("seed", () => {
  // O plano `free` do seed, ativo, viraria o padrão dos outros arquivos de teste. Em banco
  // que já tinha o seed (o de desenvolvimento), não há o que desfazer.
  let seededHere = false;

  beforeAll(async () => {
    const found = await owner`select 1 from plan where slug = 'free'`;
    seededHere = found.length === 0;
  });

  afterAll(async () => {
    if (!seededHere) return;

    const emails = Object.values(SEED_USERS).map(({ email }) => email);
    const customers = Object.values(SEED_CUSTOMERS).map(({ email }) => email);
    const slugs = ["acme", "beta", ...SEED_MANUAL_TENANTS.map(({ slug }) => slug)];
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`
        delete from audit_log where tenant_id in (
          select id from organization where slug in ${tx(slugs)}
        )
      `;
      await tx`delete from organization where slug in ${tx(slugs)}`;
      await tx`delete from "user" where email in ${tx(emails)}`;
      await tx`delete from portal_user where email in ${tx(customers)}`;
      await tx`delete from plan where slug in ('free', 'basic', 'pro')`;
    });
  });

  it("roda duas vezes sem erro nem duplicar nada", async () => {
    const counts = async () => {
      const [row] = await owner<{ users: number; plans: number; tenants: number }[]>`
        select
          (select count(*)::int from "user" where email like '%@bizu.local') as users,
          (select count(*)::int from plan where slug in ('free', 'basic', 'pro')) as plans,
          (select count(*)::int from organization where slug = 'acme') as tenants
      `;
      return row;
    };

    await runSeed("Senha-do-seed-123");
    const first = await counts();
    await runSeed("Senha-do-seed-123");

    expect(await counts()).toEqual(first);
    expect(first).toEqual({
      users: Object.keys(SEED_USERS).length,
      plans: 3,
      tenants: 1,
    });

    const [roles] = await owner<{ role: string }[]>`
      select role from "user" where email = ${SEED_USERS.platformOwner.email}
    `;
    expect(roles?.role).toBe("platform_owner");

    const [acme] = await owner<{ id: string }[]>`select id from organization where slug = 'acme'`;
    const subscription = await subscriptionOf(acme?.id as string);
    expect(subscription).toBeDefined();
    expect(
      await owner<{ total: number }[]>`
        select count(*)::int as total from member where organization_id = ${acme?.id as string}
      `,
    ).toEqual([{ total: 3 }]);

    // Cobrança manual: um tenant vencido, em somente leitura, com a fatura em aberto.
    const [expired] = await owner<{ id: string; access_mode: string }[]>`
      select id, access_mode from organization where slug = 'cliente-vencido'
    `;
    expect(expired?.access_mode).toBe("read_only");
    expect((await subscriptionOf(expired?.id as string))?.status).toBe("unpaid");
    const [freePlan] = await owner<{ limits: { organizations?: number } }[]>`
      select limits from plan where slug = 'free'
    `;
    expect(freePlan?.limits.organizations).toBe(1);
  });

  it("não promove conta que outra pessoa cadastrou sem confirmar o e-mail", async () => {
    const { email } = SEED_USERS.platformOwner;
    await owner`update "user" set email_verified = false, role = 'user' where email = ${email}`;

    await expect(runSeed("Senha-do-seed-123")).rejects.toThrow("sem e-mail confirmado");

    const [row] = await owner<{ role: string; email_verified: boolean }[]>`
      select role, email_verified from "user" where email = ${email}
    `;
    await owner`update "user" set email_verified = true, role = 'platform_owner' where email = ${email}`;

    expect(row).toEqual({ role: "user", email_verified: false });
  });

  it("não liga cliente ativo à identidade sem e-mail confirmado", async () => {
    const { email } = SEED_CUSTOMERS.julia;
    await runSeed("Senha-do-seed-123");
    await owner`update portal_user set email_verified = false where email = ${email}`;

    await expect(runSeed("Senha-do-seed-123")).rejects.toThrow("sem e-mail confirmado");

    await owner`update portal_user set email_verified = true where email = ${email}`;
  });

  it("recusa produção sem SEED_ALLOW_PRODUCTION", async () => {
    const { assertSeedAllowed } = await import("@/db/seed");

    expect(() =>
      assertSeedAllowed({ NODE_ENV: "production", SEED_PASSWORD: "Senha-longa-123" }),
    ).toThrow("produção");
    expect(
      assertSeedAllowed({
        NODE_ENV: "production",
        SEED_ALLOW_PRODUCTION: "1",
        SEED_PASSWORD: "Senha-longa-123",
      }),
    ).toBe("Senha-longa-123");
    expect(() => assertSeedAllowed({ NODE_ENV: "development" })).toThrow("SEED_PASSWORD");
    expect(() =>
      assertSeedAllowed({
        NODE_ENV: "production",
        SEED_ALLOW_PRODUCTION: "1",
        SEED_PASSWORD: "Bizu-seed-2026!",
      }),
    ).toThrow(".env.example");
    expect(computeTrialEnd(new Date(0), 1).getTime()).toBe(DAY_MS);
  });
});
