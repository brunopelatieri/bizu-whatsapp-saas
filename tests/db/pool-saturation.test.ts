import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { asPlatform, bodyOf, cleanUpBilling, createPlanRow, ensureSubscription } from "./billing-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, customerEmail } from "./portal-helpers";
import { call, cleanUp, connectOwner, createTenant, createUser, newEmail, type TestUser } from "./tenant-helpers";

/**
 * As seções que seguram uma conexão do pool enquanto o código de dentro pede **outra** (a trava de
 * `members` com o Better Auth em `withinLimit`; `createOrganizationWithinLimit`) não podem ocupar o
 * pool inteiro: com 10 conexões e 10 pedidos simultâneos, todas ficariam presas esperando uma
 * conexão que nunca volta, e o processo inteiro pararia (o `postgres.js` não tem prazo para a fila
 * do pool). Aqui entram mais pedidos do que conexões; todos têm de terminar em poucos segundos.
 */

const POOL = 10;
const REQUESTS = POOL + 4;
/** Normalmente termina em 1 a 3 s. Pool travado não termina: o teste falha em vez de pendurar a suíte. */
const SETTLE_MS = 25_000;

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

/** Espera todos; se o pool travar, rejeita em `SETTLE_MS` com uma mensagem que diz o motivo. */
async function settled(requests: (Response | Promise<Response>)[]) {
  let timer: NodeJS.Timeout | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`pool travado: ${REQUESTS} pedidos simultâneos não terminaram em ${SETTLE_MS} ms`)),
      SETTLE_MS,
    );
  });

  try {
    return await Promise.race([Promise.all(requests), stuck]);
  } finally {
    clearTimeout(timer);
  }
}

const statuses = (responses: Response[]) => responses.map((response) => response.status).sort();

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

const invite = (boss: TestUser, email = newEmail()) =>
  call("POST", "/api/team/invitations", { cookie: boss.cookie, body: { email, role: "member" } });

const newCustomer = (boss: TestUser) =>
  call("POST", "/api/customers", {
    cookie: boss.cookie,
    body: { name: "Cliente Simultâneo", email: customerEmail(), phone: uniquePhone() },
  });

const customersOf = async (tenantId: string) => {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<{ total: number }[]>`select count(*)::int as total from customer where tenant_id = ${tenantId}`,
  );
  return row?.total ?? 0;
};

describe("convites: mais pedidos do que conexões", () => {
  it("numa organização com `members` sem limite (sem trava, mas com a transação aberta)", async () => {
    const { boss } = await tenantWith({});

    const responses = await settled(Array.from({ length: REQUESTS }, () => invite(boss)));

    expect(statuses(responses)).toEqual(Array(REQUESTS).fill(201));
  }, 40_000);

  it("em organizações diferentes, cada uma com a própria trava", async () => {
    // Em série: criar a organização também passa por uma seção que segura conexão.
    const tenants: Awaited<ReturnType<typeof tenantWith>>[] = [];
    for (let index = 0; index < REQUESTS; index += 1) tenants.push(await tenantWith({ members: 5 }));

    const responses = await settled(tenants.map(({ boss }) => invite(boss)));

    expect(statuses(responses)).toEqual(Array(REQUESTS).fill(201));
  }, 90_000);

  it("na mesma organização, com limite: passa o que cabe e o resto recebe o 403 de sempre", async () => {
    const { boss } = await tenantWith({ members: 3 }); // o owner ocupa uma vaga

    const responses = await settled(Array.from({ length: REQUESTS }, () => invite(boss)));

    expect(statuses(responses)).toEqual([201, 201, ...Array(REQUESTS - 2).fill(403)]);
  }, 40_000);

  it("aceites simultâneos de convidados diferentes", async () => {
    const { boss, tenant } = await tenantWith({});
    const guests: { user: TestUser; invitationId: string }[] = [];
    for (let index = 0; index < REQUESTS; index += 1) {
      const user = await createUser(owner);
      const invited = await invite(boss, user.email);
      expect(invited.status).toBe(201);
      guests.push({ user, invitationId: ((await bodyOf(invited)).invitation as { id: string }).id });
    }

    const responses = await settled(
      guests.map(({ user, invitationId }) =>
        call("POST", `/api/invitations/${invitationId}/accept`, { cookie: user.cookie }),
      ),
    );

    expect(statuses(responses)).toEqual(Array(REQUESTS).fill(200));
    const [row] = await owner<{ total: number }[]>`
      select count(*)::int as total from member where organization_id = ${tenant.id}
    `;
    expect(row?.total).toBe(REQUESTS + 1);
  }, 120_000);
});

describe("criação de organização (`createOrganizationWithinLimit`): mais pedidos do que conexões", () => {
  it("de pessoas diferentes", async () => {
    const users = await Promise.all(Array.from({ length: REQUESTS }, () => createUser(owner)));

    const responses = await settled(
      // Nome distinto: o slug nasce do nome, e dois iguais ao mesmo tempo disputam o mesmo slug.
      users.map((user, index) =>
        call("POST", "/api/tenant", { cookie: user.cookie, body: { name: `Organização Simultânea ${index}-${randomUUID().slice(0, 6)}` } }),
      ),
    );

    expect(statuses(responses)).toEqual(Array(REQUESTS).fill(201));
  }, 90_000);

  it("da mesma pessoa: uma passa e as outras recebem 403 PLAN_LIMIT_REACHED", async () => {
    const user = await createUser(owner);

    const responses = await settled(
      Array.from({ length: REQUESTS }, () =>
        call("POST", "/api/tenant", { cookie: user.cookie, body: { name: "Organização Repetida" } }),
      ),
    );

    expect(statuses(responses)).toEqual([201, ...Array(REQUESTS - 1).fill(403)]);
  }, 40_000);
});

describe("clientes: a gravação usa só a própria transação", () => {
  it("cadastro pela equipe, plano sem limite e plano com limite folgado", async () => {
    for (const limits of [{}, { customers: 1000 }] as Record<string, number | null>[]) {
      const { boss, tenant } = await tenantWith(limits);

      const responses = await settled(Array.from({ length: REQUESTS }, () => newCustomer(boss)));

      expect(statuses(responses)).toEqual(Array(REQUESTS).fill(201));
      expect(await customersOf(tenant.id)).toBe(REQUESTS);
    }
  }, 60_000);

  it("uma vaga e mais pedidos do que conexões: passa um, o resto recebe 403, e o pool segue livre", async () => {
    const { boss, tenant } = await tenantWith({ customers: 1 });

    const responses = await settled(Array.from({ length: REQUESTS }, () => newCustomer(boss)));

    expect(statuses(responses)).toEqual([201, ...Array(REQUESTS - 1).fill(403)]);
    expect(await customersOf(tenant.id)).toBe(1);
  }, 40_000);

  it("autocadastro do portal: confirmações simultâneas", async () => {
    const { tenant } = await tenantWith({ customers: 1000 }, true);
    const tokens: string[] = [];
    for (let index = 0; index < REQUESTS; index += 1) {
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
      tokens.push(
        decodeURIComponent(
          mail.sent.filter((message) => message.to === email).at(-1)?.text.match(/token=([^&\s"]+)/)?.[1] as string,
        ),
      );
    }

    await settled(tokens.map((token) => call("POST", "/api/portal/auth/verify-email", { body: { token, org: tenant.slug } })));
    await waitForBackgroundTasks();

    expect(await customersOf(tenant.id)).toBe(REQUESTS);
  }, 120_000);
});
