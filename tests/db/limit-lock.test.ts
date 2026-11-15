import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { limitLockKey, type LimitMetric } from "@/lib/billing/limits";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import {
  asPlatform,
  bodyOf,
  cleanUpBilling,
  createPlanRow,
  ensureSubscription,
} from "./billing-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, customerEmail } from "./portal-helpers";
import { call, cleanUp, connectOwner, createTenant, createUser, newEmail, type TestUser } from "./tenant-helpers";

/**
 * Garantia contra corrida nos limites `customers` e `members` (bloco Q, Q1): conferência e
 * gravação na mesma transação, sob `pg_advisory_xact_lock` por organização e métrica
 * (`withinLimit`, `src/lib/billing/limits.ts`). Com uma vaga só e pedidos simultâneos, passa um.
 */

const mail = createMemoryProvider();
const PASSWORD = "Senha-do-portal-1";
let owner: postgres.Sql;

beforeAll(() => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await cleanUpBilling(owner);
  await owner.end();
});

/** Organização com o plano pedido (assinatura ativa, sem trial). */
async function tenantWith(limits: Record<string, number | null>, selfSignup = false) {
  const boss = await createUser(owner);
  const tenant = await createTenant(boss);
  const plan = await createPlanRow(owner, { isFree: false, limits });
  await ensureSubscription(owner, tenant.id, plan.id);
  if (selfSignup) {
    await asPlatform(
      owner,
      (tx) =>
        tx`update organization set settings = ${tx.json({ portal_self_signup: true })} where id = ${tenant.id}`,
    );
  }

  return { boss, tenant };
}

const newCustomer = (boss: TestUser, phone = uniquePhone()) =>
  call("POST", "/api/customers", {
    cookie: boss.cookie,
    body: { name: "Cliente Simultâneo", email: customerEmail(), phone },
  });

const invite = (boss: TestUser, email = newEmail()) =>
  call("POST", "/api/team/invitations", { cookie: boss.cookie, body: { email, role: "member" } });

const statuses = (responses: Response[]) => responses.map((response) => response.status).sort();

const customersOf = async (tenantId: string) => {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<{ total: number }[]>`select count(*)::int as total from customer where tenant_id = ${tenantId}`,
  );
  return row?.total ?? 0;
};

const invitationsOf = async (tenantId: string) => {
  const [row] = await owner<{ total: number }[]>`
    select count(*)::int as total from invitation where organization_id = ${tenantId} and status = 'pending'
  `;
  return row?.total ?? 0;
};

const membersOf = async (tenantId: string) => {
  const [row] = await owner<{ total: number }[]>`
    select count(*)::int as total from member where organization_id = ${tenantId}
  `;
  return row?.total ?? 0;
};

/** Segura a trava de uma métrica numa transação à parte, como uma requisição lenta seguraria. */
async function holdLock(tenantId: string, metric: LimitMetric) {
  let release!: () => void;
  let acquired!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const done = owner.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${limitLockKey(tenantId, metric)}, 0))`;
    acquired();
    await hold;
  });
  await ready;

  return {
    release: async () => {
      release();
      await done;
    },
  };
}

/** Quanto esperar para concluir que uma chamada está presa na trava, e para dar uma livre por concluída. */
const WAITING_MS = 500;
const DONE_MS = 10_000;

/** `waiting` se a chamada segue pendente depois de `ms`; senão, o status dela. */
async function settleWithin(request: Response | Promise<Response>, ms: number) {
  const pending = Symbol("pending");
  const result = await Promise.race([
    request,
    new Promise<symbol>((resolve) => setTimeout(() => resolve(pending), ms)),
  ]);

  return result === pending ? ("waiting" as const) : (result as Response).status;
}

describe("clientes: uma vaga, pedidos simultâneos", () => {
  it("cadastro pela equipe: passa um, os outros recebem 403 PLAN_LIMIT_REACHED", async () => {
    const { boss, tenant } = await tenantWith({ customers: 1 });

    const responses = await Promise.all(Array.from({ length: 6 }, () => newCustomer(boss)));

    expect(statuses(responses)).toEqual([201, 403, 403, 403, 403, 403]);
    for (const refused of responses.filter(({ status }) => status === 403)) {
      expect(await bodyOf(refused)).toMatchObject({ code: "PLAN_LIMIT_REACHED" });
    }
    expect(await customersOf(tenant.id)).toBe(1);
  });

  it("com duas vagas e mais pedidos, nunca passa do limite", async () => {
    const { boss, tenant } = await tenantWith({ customers: 3 });
    await newCustomer(boss);

    const responses = await Promise.all(Array.from({ length: 6 }, () => newCustomer(boss)));

    expect(statuses(responses).filter((status) => status === 201)).toHaveLength(2);
    expect(await customersOf(tenant.id)).toBe(3);
  });

  it("o autocadastro do portal e a equipe disputam a mesma vaga: fica uma ficha", async () => {
    const { boss, tenant } = await tenantWith({ customers: 1 }, true);
    const signups: { email: string; token: string }[] = [];

    for (let index = 0; index < 2; index += 1) {
      const email = customerEmail();
      const signup = await call("POST", "/api/portal/auth-ext/sign-up", {
        body: {
          name: "Pessoa do portal",
          email,
          password: PASSWORD,
          org: tenant.slug,
          phone: uniquePhone(),
          acceptTerms: true,
          termsVersion: "2026-11",
        },
      });
      expect(signup.status).toBe(200);
      await waitForBackgroundTasks();
      const token = decodeURIComponent(
        mail.sent.filter((message) => message.to === email).at(-1)?.text.match(/token=([^&\s"]+)/)?.[1] as string,
      );
      signups.push({ email, token });
    }

    // Sem ficha ainda: o cadastro só vira ficha quando o e-mail é confirmado.
    expect(await customersOf(tenant.id)).toBe(0);

    await Promise.all([
      ...signups.map(({ token }) =>
        call("POST", "/api/portal/auth/verify-email", { body: { token, org: tenant.slug } }),
      ),
      newCustomer(boss),
    ]);
    await waitForBackgroundTasks();

    expect(await customersOf(tenant.id)).toBe(1);
  });

  it("plano cheio: o autocadastro não abre ficha nem `claim` do número de uma ficha existente", async () => {
    const { boss, tenant } = await tenantWith({ customers: 1 }, true);
    const phone = uniquePhone();
    expect((await newCustomer(boss, phone)).status).toBe(201);

    const email = customerEmail();
    const signup = await call("POST", "/api/portal/auth-ext/sign-up", {
      body: {
        name: "Quer o número",
        email,
        password: PASSWORD,
        org: tenant.slug,
        phone,
        acceptTerms: true,
        termsVersion: "2026-11",
      },
    });
    expect(signup.status).toBe(200);
    await waitForBackgroundTasks();
    const token = decodeURIComponent(
      mail.sent.filter((message) => message.to === email).at(-1)?.text.match(/token=([^&\s"]+)/)?.[1] as string,
    );
    await call("POST", "/api/portal/auth/verify-email", { body: { token, org: tenant.slug } });
    await waitForBackgroundTasks();

    const claims = await asPlatform(
      owner,
      (tx) =>
        tx<{ total: number }[]>`
          select count(*)::int as total from phone_verification
          where tenant_id = ${tenant.id} and purpose = 'claim'
        `,
    );
    expect(claims[0]?.total).toBe(0);
    expect(await customersOf(tenant.id)).toBe(1);
  });
});

describe("membros: uma vaga, pedidos simultâneos", () => {
  it("convites: passa um, os outros recebem 403 PLAN_LIMIT_REACHED", async () => {
    const { boss, tenant } = await tenantWith({ members: 2 }); // o owner já ocupa uma

    const responses = await Promise.all(Array.from({ length: 6 }, () => invite(boss)));

    expect(statuses(responses)).toEqual([201, 403, 403, 403, 403, 403]);
    for (const refused of responses.filter(({ status }) => status === 403)) {
      expect(await bodyOf(refused)).toMatchObject({ code: "PLAN_LIMIT_REACHED" });
    }
    expect(await invitationsOf(tenant.id)).toBe(1);
  });

  it("convite pendente continua ocupando a vaga: o aceite dele passa e um convite novo, não", async () => {
    const { boss, tenant } = await tenantWith({ members: 2 });
    const guest = await createUser(owner);
    const invited = await invite(boss, guest.email);
    expect(invited.status).toBe(201);
    const invitationId = ((await bodyOf(invited)).invitation as { id: string }).id;

    const [accepted, another] = await Promise.all([
      call("POST", `/api/invitations/${invitationId}/accept`, { cookie: guest.cookie }),
      invite(boss),
    ]);

    expect(accepted.status).toBe(200);
    expect(another.status).toBe(403);
    expect(await membersOf(tenant.id)).toBe(2);
    expect(await invitationsOf(tenant.id)).toBe(0);
  });

  it("aceite e convites novos ao mesmo tempo: a soma de membros e convites nunca passa do limite", async () => {
    const { boss, tenant } = await tenantWith({ members: 3 });
    const guest = await createUser(owner);
    const invited = await invite(boss, guest.email); // owner + 1 pendente: sobra uma vaga
    const invitationId = ((await bodyOf(invited)).invitation as { id: string }).id;

    const [accepted, ...others] = await Promise.all([
      call("POST", `/api/invitations/${invitationId}/accept`, { cookie: guest.cookie }),
      ...Array.from({ length: 5 }, () => invite(boss)),
    ]);

    expect(accepted.status).toBe(200);
    expect(statuses(others)).toEqual([201, 403, 403, 403, 403]);
    expect((await membersOf(tenant.id)) + (await invitationsOf(tenant.id))).toBe(3);
  });
});

describe("a trava é por organização e por métrica", () => {
  it("a trava de `customers` espera quem cria cliente, mas não o convite nem outra organização", async () => {
    const { boss, tenant } = await tenantWith({ customers: 5, members: 5 });
    const other = await tenantWith({ customers: 5, members: 5 });
    const lock = await holdLock(tenant.id, "customers");

    try {
      expect(await settleWithin(invite(boss), DONE_MS)).toBe(201); // outra métrica
      expect(await settleWithin(newCustomer(other.boss), DONE_MS)).toBe(201); // outra organização

      const blocked = newCustomer(boss);
      expect(await settleWithin(blocked, WAITING_MS)).toBe("waiting");
      await lock.release();
      expect((await blocked).status).toBe(201);
    } finally {
      await lock.release().catch(() => undefined);
    }
  });

  it("a trava de `members` espera quem convida, mas não quem cria cliente", async () => {
    const { boss, tenant } = await tenantWith({ customers: 5, members: 5 });
    const lock = await holdLock(tenant.id, "members");

    try {
      expect(await settleWithin(newCustomer(boss), DONE_MS)).toBe(201);

      const blocked = invite(boss);
      expect(await settleWithin(blocked, WAITING_MS)).toBe("waiting");
      await lock.release();
      expect((await blocked).status).toBe(201);
    } finally {
      await lock.release().catch(() => undefined);
    }
  });

  it("plano sem limite na métrica não toma a trava", async () => {
    const { boss, tenant } = await tenantWith({ members: 5 }); // `customers` ilimitado
    const lock = await holdLock(tenant.id, "customers");

    try {
      expect(await settleWithin(newCustomer(boss), DONE_MS)).toBe(201);
    } finally {
      await lock.release();
    }
  });
});
