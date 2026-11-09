import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPlatformScope, withTenant } from "@/db/rls";
import { getDb } from "@/db";
import { customer } from "@/db/schema";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { getAuth } from "@/lib/auth/server";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import {
  cleanUpPortal,
  createCustomer,
  customerEmail,
  inviteAndEnter,
  sessionCookies,
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
 * Identidades de equipe e de portal não se misturam, e o cliente de dois tenants só vê o
 * ativo. Ao fim, os passos de `spec-tenant-rbac.md` para o RLS de `customer`.
 */

const mail = createMemoryProvider();

function cookieValue(cookies: string, name: string) {
  const pair = cookies.split("; ").find((item) => item.startsWith(`${name}=`));
  return pair?.slice(name.length + 1) ?? "";
}

describe("portal: isolamento", () => {
  let owner: postgres.Sql;
  let ownerA: TestUser;
  let ownerB: TestUser;
  let tenantA: { id: string; slug: string };
  let tenantB: { id: string; slug: string };

  beforeAll(async () => {
    setEmailProviderForTests(mail);
    owner = connectOwner();
    ownerA = await createUser(owner);
    tenantA = await createTenant(ownerA, "Clínica A");
    ownerB = await createUser(owner);
    tenantB = await createTenant(ownerB, "Clínica B");
  });

  afterAll(async () => {
    setEmailProviderForTests(undefined);
    await cleanUpPortal(owner);
    await cleanUp(owner);
    await owner.end();
  });

  beforeEach(() => mail.reset());

  describe("cookies", () => {
    let portalCookie: string;
    let customerId: string;

    beforeAll(async () => {
      const { id, email } = await createCustomer(ownerA);
      customerId = id;
      portalCookie = await inviteAndEnter(ownerA, mail, id, email);
    });

    it.each([
      ["GET", "/api/me"],
      ["GET", "/api/me/invitations"],
      ["GET", "/api/customers"],
      ["GET", "/api/team"],
      ["GET", "/api/tenant"],
      ["GET", "/api/billing/subscription"],
      ["GET", "/api/admin/overview"],
    ])("cookie de portal em %s %s responde 401", async (method, path) => {
      const response = await call(method, path, { cookie: portalCookie });

      expect(response.status).toBe(401);
    });

    it.each([
      ["GET", "/api/portal/me"],
      ["GET", "/api/portal/customer"],
      ["POST", "/api/portal/active-tenant"],
      ["PATCH", "/api/portal/me"],
      ["POST", "/api/portal/auth-ext/set-password"],
    ])("cookie de app em %s %s responde 401", async (method, path) => {
      const response = await call(method, path, {
        cookie: ownerA.cookie,
        body: method === "GET" ? undefined : {},
      });

      expect(response.status).toBe(401);
    });

    it("os dois cookies juntos valem cada um na sua área", async () => {
      const cookie = `${ownerA.cookie}; ${portalCookie}`;

      const app = await call("GET", "/api/me", { cookie });
      expect(((await app.json()) as { user: { email: string } }).user.email).toBe(
        ownerA.email,
      );

      const portal = await call("GET", "/api/portal/customer", { cookie });
      expect(portal.status).toBe(200);
    });

    it("cookie de portal renomeado não abre a área de equipe", async () => {
      const token = cookieValue(portalCookie, "bizu_portal.session_token");
      const data = cookieValue(portalCookie, "bizu_portal.session_data");
      const renamed = `bizu.session_token=${token}; bizu.session_data=${data}`;

      expect((await call("GET", "/api/me", { cookie: renamed })).status).toBe(401);

      const session = await call("GET", "/api/auth/get-session", {
        cookie: renamed,
      });
      expect(await session.json()).toBeNull();
    });

    it("cookie de app renomeado não abre o portal", async () => {
      const token = cookieValue(ownerA.cookie, "bizu.session_token");
      const data = cookieValue(ownerA.cookie, "bizu.session_data");
      const renamed = `bizu_portal.session_token=${token}; bizu_portal.session_data=${data}`;

      expect((await call("GET", "/api/portal/me", { cookie: renamed })).status).toBe(401);

      const session = await call("GET", "/api/portal/auth/get-session", {
        cookie: renamed,
      });
      expect(await session.json()).toBeNull();
    });

    it("link de verificação de equipe não confirma e-mail no portal", async () => {
      const { email } = await createCustomer(ownerA);
      const ph = phoneRow();
      const [teamUser] = await owner<{ id: string }[]>`
        insert into portal_user (name, email, phone, phone_normalized, phone_key)
        values ('Pessoa', ${email}, ${ph.phone}, ${ph.phoneNormalized}, ${ph.phoneKey})
        returning id
      `;
      expect(teamUser).toBeDefined();

      await call("POST", "/api/auth/sign-up/email", {
        body: {
          name: "Pessoa",
          email,
          password: "senha-forte-123",
          phone: "11987654321",
          acceptTerms: true,
          termsVersion: "2026-11",
        },
      });
      await waitForBackgroundTasks();

      const message = mail.sent.filter(({ to }) => to === email).at(-1);
      const token = message?.text.match(/verificar-email\?token=([^\s&"]+)/)?.[1];
      expect(token).toBeDefined();

      const response = await call("POST", "/api/portal/auth/verify-email", {
        body: { token },
      });
      expect(response.status).toBe(400);

      const [row] = await owner<{ email_verified: boolean }[]>`
        select email_verified from portal_user where email = ${email}
      `;
      expect(row?.email_verified).toBe(false);

      await owner`delete from "user" where email = ${email}`;
    });

    it("o cliente não vê notas nem etiquetas da equipe", async () => {
      await call("PATCH", `/api/customers/${customerId}`, {
        cookie: ownerA.cookie,
        body: { notes: "Interno: inadimplente", tags: ["risco"] },
      });

      const response = await call("GET", "/api/portal/customer", {
        cookie: portalCookie,
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).not.toContain("inadimplente");
      expect(body).not.toContain("risco");
    });
  });

  describe("cliente em dois tenants", () => {
    let cookie: string;
    let customerA: string;
    let customerB: string;

    function active() {
      return call("GET", "/api/portal/customer", { cookie });
    }

    function choose(tenantId: string) {
      return call("POST", "/api/portal/active-tenant", {
        cookie,
        body: { tenantId },
      });
    }

    beforeAll(async () => {
      const email = customerEmail();

      customerA = (await createCustomer(ownerA, { email, name: "Júlia em A" })).id;
      customerB = (await createCustomer(ownerB, { email, name: "Júlia em B" })).id;

      await inviteAndEnter(ownerA, mail, customerA, email);
      cookie = await inviteAndEnter(ownerB, mail, customerB, email);
    });

    it("lista os dois e abre o do link", async () => {
      const response = await call("GET", "/api/portal/me", { cookie });
      const me = (await response.json()) as {
        tenants: { id: string }[];
        active: { id: string } | null;
      };

      expect(me.tenants.map(({ id }) => id).sort()).toEqual(
        [tenantA.id, tenantB.id].sort(),
      );
      expect(me.active?.id).toBe(tenantB.id);
    });

    it("vê só os dados do tenant ativo", async () => {
      expect(await (await active()).json()).toMatchObject({
        tenant: { id: tenantB.id },
        customer: { name: "Júlia em B" },
      });

      expect((await choose(tenantA.id)).status).toBe(200);

      expect(await (await active()).json()).toMatchObject({
        tenant: { id: tenantA.id },
        customer: { name: "Júlia em A" },
      });
    });

    it("sem `org` no login, a sessão começa sem tenant e pede a escolha", async () => {
      const email = customerEmail();
      const first = await createCustomer(ownerA, { email });
      const second = await createCustomer(ownerB, { email });

      await inviteAndEnter(ownerA, mail, first.id, email);
      await inviteAndEnter(ownerB, mail, second.id, email);

      await call("POST", "/api/portal/auth-ext/set-password", {
        cookie: await inviteAndEnter(ownerB, mail, second.id, email),
        body: { newPassword: "senha-do-portal-1" },
      });

      const signedIn = await call("POST", "/api/portal/auth/sign-in/email", {
        body: { email, password: "senha-do-portal-1" },
      });
      const fresh = sessionCookies(signedIn);

      const me = await call("GET", "/api/portal/me", { cookie: fresh });
      expect(await me.json()).toMatchObject({ active: null });

      const refused = await call("GET", "/api/portal/customer", { cookie: fresh });
      expect(refused.status).toBe(403);
    });

    it("não troca para tenant em que não é cliente", async () => {
      const stranger = await createUser(owner);
      const other = await createTenant(stranger);

      expect((await choose(other.id)).status).toBe(404);
      expect((await choose(randomUUID())).status).toBe(404);
    });

    it("não troca para tenant em que está bloqueado", async () => {
      await call("PATCH", `/api/customers/${customerB}`, {
        cookie: ownerB.cookie,
        body: { status: "blocked" },
      });

      expect((await choose(tenantB.id)).status).toBe(404);

      await call("PATCH", `/api/customers/${customerB}`, {
        cookie: ownerB.cookie,
        body: { status: "active" },
      });
    });

    it("perfil muda só no tenant ativo", async () => {
      await choose(tenantA.id);

      const response = await call("PATCH", "/api/portal/me", {
        cookie,
        body: { name: "Júlia Nova", phone: "11 90000-0000" },
      });
      expect(response.status).toBe(200);

      const inB = await call("GET", `/api/customers/${customerB}`, {
        cookie: ownerB.cookie,
      });
      const { customer: inBCustomer } = (await inB.json()) as {
        customer: { name: string; phone: string };
      };
      // O telefone de B continua o que o owner de B cadastrou, não o do perfil editado em A.
      expect(inBCustomer.name).toBe("Júlia em B");
      expect(inBCustomer.phone).not.toBe("11 90000-0000");

      const inA = await call("GET", `/api/customers/${customerA}`, {
        cookie: ownerA.cookie,
      });
      expect(await inA.json()).toMatchObject({
        customer: { name: "Júlia Nova", phone: "11 90000-0000" },
      });
    });

    it("tenant suspenso fecha o portal", async () => {
      await choose(tenantA.id);
      await owner`
        update organization
        set status = 'suspended', access_mode = 'locked'
        where id = ${tenantA.id}
      `;

      const response = await active();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "TENANT_SUSPENDED" });

      await owner`
        update organization set status = 'active', access_mode = 'full'
        where id = ${tenantA.id}
      `;
    });

    it("tenant somente leitura mantém a leitura e recusa a escrita", async () => {
      await choose(tenantA.id);
      await owner`update organization set access_mode = 'read_only' where id = ${tenantA.id}`;

      expect((await active()).status).toBe(200);

      const write = await call("PATCH", "/api/portal/me", {
        cookie,
        body: { name: "Júlia" },
      });
      expect(write.status).toBe(403);
      expect(await write.json()).toMatchObject({ code: "TENANT_READ_ONLY" });

      await owner`update organization set access_mode = 'full' where id = ${tenantA.id}`;
    });
  });

  describe("permissão do colaborador", () => {
    it("membro sem cliente em A recebe 404 no cliente de B", async () => {
      const { id } = await createCustomer(ownerB);
      const colleague = await createUser(owner);
      await addMember(owner, tenantA.id, colleague, "member");

      const response = await call("GET", `/api/customers/${id}`, {
        cookie: colleague.cookie,
      });

      expect(response.status).toBe(404);
    });
  });

  describe("RLS de customer", () => {
    const marker = `rls-${randomUUID()}`;
    const emailA = `${marker}-a@cliente.test`;
    const emailB = `${marker}-b@cliente.test`;
    const mine = eq(customer.notes, marker);

    beforeAll(async () => {
      // Passo 1: com o dono, um cliente em cada tenant.
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        const pa = phoneRow();
        const pb = phoneRow();
        await tx`
          insert into customer (tenant_id, name, email, notes, phone, phone_normalized, phone_key) values
            (${tenantA.id}, 'A', ${emailA}, ${marker}, ${pa.phone}, ${pa.phoneNormalized}, ${pa.phoneKey}),
            (${tenantB.id}, 'B', ${emailB}, ${marker}, ${pb.phone}, ${pb.phoneNormalized}, ${pb.phoneKey})
        `;
      });
    });

    it("withTenant(A) lê só A", async () => {
      const rows = await withTenant(tenantA.id, (tx) =>
        tx.select({ email: customer.email }).from(customer).where(mine),
      );

      expect(rows).toEqual([{ email: emailA }]);
    });

    it("withTenant(A) não grava em B: 42501", async () => {
      const error = await withTenant(tenantA.id, (tx) =>
        tx.insert(customer).values({
          tenantId: tenantB.id,
          name: "Invasor",
          email: `${marker}-c@cliente.test`,
          ...phoneRow(),
        }),
      ).catch((caught: unknown) => caught);

      expect((error as { cause?: { code?: string } }).cause?.code).toBe("42501");
    });

    it("sem set_config, nada aparece", async () => {
      const rows = await getDb()
        .select({ email: customer.email })
        .from(customer)
        .where(mine);

      expect(rows).toEqual([]);
    });

    it("withPlatformScope lê os dois", async () => {
      const rows = await withPlatformScope("teste: RLS de customer", (tx) =>
        tx.select({ email: customer.email }).from(customer).where(mine),
      );

      expect(rows.map(({ email }) => email).sort()).toEqual(
        [emailA, emailB].sort(),
      );
    });
  });

  it("o `getAuth` da equipe não enxerga sessões do portal", async () => {
    const { id, email } = await createCustomer(ownerA);
    const cookie = await inviteAndEnter(ownerA, mail, id, email);

    const session = await getAuth().api.getSession({
      headers: new Headers({ cookie }),
    });

    expect(session).toBeNull();
  });
});
