import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import {
  cleanUpPortal,
  createCustomer,
  customerEmail,
  inviteAndEnter,
  lastLink,
  sessionCookies,
  verify,
} from "./portal-helpers";
import { asPlatform, cleanUpBilling, makePlatformUser } from "./billing-helpers";
import {
  call,
  cleanUp,
  comparableHeaders,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";
import { phoneRow } from "./phone-helpers";

/**
 * Login do cliente pela API, com Postgres real e e-mail em memória: magic link de uso
 * único, resposta uniforme e quem pode entrar. Isolamento em `portal-isolation.test.ts`.
 */

const PASSWORD = "senha-do-portal-1";
const mail = createMemoryProvider();

describe("portal: autenticação", () => {
  let owner: postgres.Sql;
  let tenantOwner: TestUser;
  let tenant: { id: string; slug: string };

  function askLink(email: string, org = tenant.slug) {
    return call("POST", "/api/portal/auth-ext/magic-link", {
      body: { email, org },
    });
  }

  beforeAll(async () => {
    setEmailProviderForTests(mail);
    owner = connectOwner();
    tenantOwner = await createUser(owner);
    tenant = await createTenant(tenantOwner);
  });

  afterAll(async () => {
    setEmailProviderForTests(undefined);
    await cleanUpPortal(owner);
    await cleanUp(owner);
    await owner.end();
  });

  beforeEach(() => mail.reset());

  describe("magic link", () => {
    it("o token não fica legível no banco", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      await call("POST", `/api/customers/${id}/invite`, {
        cookie: tenantOwner.cookie,
      });
      const { token } = lastLink(mail, email);

      const rows = await owner`
        select 1 from portal_verification
        where identifier like ${`%${token}%`} or value like ${`%${token}%`}
      `;

      expect(rows).toHaveLength(0);
    });

    it("GET não consome o token; o POST entra uma vez só", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      await call("POST", `/api/customers/${id}/invite`, {
        cookie: tenantOwner.cookie,
      });
      const { token, org } = lastLink(mail, email);

      const scanner = await call(
        "GET",
        `/api/portal/auth/magic-link/verify?token=${token}`,
      );
      expect(scanner.status).toBe(405);

      const first = await verify(token, org);
      expect(first.status).toBe(200);
      expect(sessionCookies(first)).toContain("bizu_portal.session_token");

      const second = await verify(token, org);
      expect(second.status).toBe(400);
      expect(sessionCookies(second)).toBe("");
    });

    it("dois cliques simultâneos abrem uma sessão só", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      await call("POST", `/api/customers/${id}/invite`, {
        cookie: tenantOwner.cookie,
      });
      const { token, org } = lastLink(mail, email);

      const responses = await Promise.all([
        verify(token, org),
        verify(token, org),
        verify(token, org),
      ]);

      expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
    });

    it("token inventado responde igual ao usado", async () => {
      const response = await verify("token-que-nao-existe");

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Link inválido ou expirado.",
      });
    });

    it("token vencido não entra", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      await call("POST", `/api/customers/${id}/invite`, {
        cookie: tenantOwner.cookie,
      });
      const { token, org } = lastLink(mail, email);

      await owner`
        update portal_verification
        set expires_at = now() - interval '1 minute'
        where created_at > now() - interval '5 seconds'
      `;

      expect((await verify(token, org)).status).toBe(400);
    });

    it("convite vale 48 h e login vale 10 min", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      await call("POST", `/api/customers/${id}/invite`, {
        cookie: tenantOwner.cookie,
      });
      const [invite] = await owner<{ minutes: number }[]>`
        select extract(epoch from (expires_at - now())) / 60 as minutes
        from portal_verification order by created_at desc limit 1
      `;
      expect(Number(invite?.minutes)).toBeGreaterThan(47 * 60);

      await askLink(email);
      await waitForBackgroundTasks();

      const [login] = await owner<{ minutes: number }[]>`
        select extract(epoch from (expires_at - now())) / 60 as minutes
        from portal_verification order by created_at desc limit 1
      `;
      expect(Number(login?.minutes)).toBeLessThanOrEqual(10);
      expect(lastLink(mail, email).message?.subject).toContain("link de acesso");
    });

    it("entrar marca o e-mail como verificado e grava o último acesso", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      const cookie = await inviteAndEnter(tenantOwner, mail, id, email);

      const [person] = await owner<{ email_verified: boolean }[]>`
        select email_verified from portal_user where email = ${email}
      `;
      expect(person?.email_verified).toBe(true);

      const me = await call("GET", "/api/portal/me", { cookie });
      const body = (await me.json()) as { active: { id: string } | null };
      expect(body.active?.id).toBe(tenant.id);

      const detail = await call("GET", `/api/customers/${id}`, {
        cookie: tenantOwner.cookie,
      });
      const { customer } = (await detail.json()) as {
        customer: { lastLoginAt: string | null; status: string };
      };
      expect(customer.lastLoginAt).not.toBeNull();
      expect(customer.status).toBe("active");
    });
  });

  describe("pedido de link", () => {
    it("resposta igual com e sem cliente; só quem é ativo recebe", async () => {
      const active = await createCustomer(tenantOwner, { status: "active" });
      const lead = await createCustomer(tenantOwner);
      const blocked = await createCustomer(tenantOwner, { status: "blocked" });
      const unknown = customerEmail();

      const responses = await Promise.all([
        askLink(active.email),
        askLink(lead.email),
        askLink(blocked.email),
        askLink(unknown),
        askLink(active.email, "tenant-que-nao-existe"),
      ]);
      await waitForBackgroundTasks();

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      }

      expect(mail.sent.map(({ to }) => to)).toEqual([active.email]);
    });

    it("sem cliente, nada é gravado", async () => {
      const email = customerEmail();
      const [before] = await owner<{ total: number }[]>`
        select count(*)::int as total from portal_verification
      `;

      await askLink(email);
      await waitForBackgroundTasks();

      const [after] = await owner<{ total: number }[]>`
        select count(*)::int as total from portal_verification
      `;
      expect(after?.total).toBe(before?.total);

      const people = await owner`select 1 from portal_user where email = ${email}`;
      expect(people).toHaveLength(0);
    });

    it("limita por IP e por e-mail, sem revelar nada", async () => {
      const email = customerEmail();
      const send = () =>
        call("POST", "/api/portal/auth-ext/magic-link", {
          body: { email, org: tenant.slug },
        });

      const statuses = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await send()).status);

      expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it("tenant suspenso não envia link", async () => {
      const other = await createTenant(await createUser(owner));
      const email = customerEmail();
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        const ph = phoneRow();
        await tx`
          insert into customer (tenant_id, name, email, status, phone, phone_normalized, phone_key)
          values (${other.id}, 'Cliente', ${email}, 'active',
                  ${ph.phone}, ${ph.phoneNormalized}, ${ph.phoneKey})
        `;
      });
      await owner`update organization set status = 'suspended' where id = ${other.id}`;

      await askLink(email, other.slug);
      await waitForBackgroundTasks();

      expect(mail.sent.filter(({ to }) => to === email)).toHaveLength(0);
    });
  });

  describe("quem não pode entrar", () => {
    it("cliente bloqueado perde o acesso na hora, na sessão aberta", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      const cookie = await inviteAndEnter(tenantOwner, mail, id, email);

      expect((await call("GET", "/api/portal/customer", { cookie })).status).toBe(200);

      await call("PATCH", `/api/customers/${id}`, {
        cookie: tenantOwner.cookie,
        body: { status: "blocked" },
      });

      const response = await call("GET", "/api/portal/customer", { cookie });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "PORTAL_TENANT_REQUIRED",
      });

      const me = await call("GET", "/api/portal/me", { cookie });
      const body = (await me.json()) as {
        active: unknown;
        tenants: { status: string; available: boolean }[];
      };
      expect(body.active).toBeNull();
      expect(body.tenants[0]).toMatchObject({
        status: "blocked",
        available: false,
      });
    });

    it("lead que abre um link antigo fica sem tenant", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      await call("POST", `/api/customers/${id}/invite`, {
        cookie: tenantOwner.cookie,
      });
      await call("PATCH", `/api/customers/${id}`, {
        cookie: tenantOwner.cookie,
        body: { status: "lead" },
      });

      const { token, org } = lastLink(mail, email);
      const cookie = sessionCookies(await verify(token, org));

      expect((await call("GET", "/api/portal/customer", { cookie })).status).toBe(403);
    });

    it("rotas do Better Auth fora da lista não respondem", async () => {
      for (const path of [
        "sign-in/magic-link",
        "sign-up/email",
        "request-password-reset",
        "change-email",
        "change-password",
        "update-user",
        "delete-user",
      ]) {
        const response = await call("POST", `/api/portal/auth/${path}`, {
          body: { email: customerEmail() },
        });

        expect(response.status).toBe(404);
      }
    });
  });

  describe("senha", () => {
    async function enterWithPassword() {
      const { id, email } = await createCustomer(tenantOwner);
      const cookie = await inviteAndEnter(tenantOwner, mail, id, email);
      const response = await call("POST", "/api/portal/auth-ext/set-password", {
        cookie,
        body: { newPassword: PASSWORD },
      });
      expect(response.status).toBe(200);

      return { cookie, email };
    }

    function signIn(email: string, password: string) {
      return call("POST", "/api/portal/auth/sign-in/email", {
        body: { email, password },
      });
    }

    it("define pela sessão e passa a entrar com ela", async () => {
      const { email } = await enterWithPassword();

      expect((await signIn(email, "senha-errada-123")).status).toBe(401);

      const response = await signIn(email, PASSWORD);
      expect(response.status).toBe(200);
      expect(sessionCookies(response)).toContain("bizu_portal.session_token");

      const notices = mail.sent.filter(({ to }) => to === email);
      await waitForBackgroundTasks();
      expect(notices.length).toBeGreaterThan(0);
    });

    it("sessão antiga precisa da senha atual; a troca derruba as outras", async () => {
      const { cookie, email } = await enterWithPassword();
      const other = sessionCookies(await signIn(email, PASSWORD));

      await owner`
        update portal_session set created_at = now() - interval '1 hour'
        where user_id = (select id from portal_user where email = ${email})
      `;

      const refused = await call("POST", "/api/portal/auth-ext/set-password", {
        cookie,
        body: { newPassword: "outra-senha-forte-2" },
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "CURRENT_PASSWORD_REQUIRED",
      });

      const wrong = await call("POST", "/api/portal/auth-ext/set-password", {
        cookie,
        body: {
          newPassword: "outra-senha-forte-2",
          currentPassword: "senha-errada-123",
        },
      });
      expect(wrong.status).toBe(403);

      const changed = await call("POST", "/api/portal/auth-ext/set-password", {
        cookie,
        body: { newPassword: "outra-senha-forte-2", currentPassword: PASSWORD },
      });
      expect(changed.status).toBe(200);

      expect((await call("GET", "/api/portal/me", { cookie })).status).toBe(200);
      expect((await call("GET", "/api/portal/me", { cookie: other })).status).toBe(401);
    });

    it("senha curta é recusada", async () => {
      const { id, email } = await createCustomer(tenantOwner);
      const cookie = await inviteAndEnter(tenantOwner, mail, id, email);

      const response = await call("POST", "/api/portal/auth-ext/set-password", {
        cookie,
        body: { newPassword: "curta" },
      });

      expect(response.status).toBe(400);
    });
  });

  describe("autocadastro", () => {
    const signup = (email: string, org: string) =>
      call("POST", "/api/portal/auth-ext/sign-up", {
        body: {
          name: "Pessoa Lead",
          email,
          password: PASSWORD,
          org,
          phone: "11987654321",
          acceptTerms: true,
          termsVersion: "2026-11",
        },
      });

    function confirmToken(email: string) {
      const message = mail.sent.filter(({ to }) => to === email).at(-1);
      const match = message?.text.match(/\/portal\/confirmar\?token=([^&\s"]+)/);
      if (!match?.[1]) throw new Error("sem link de confirmação");

      return match[1];
    }

    async function allowSelfSignup(allowed: boolean) {
      await owner`
        update organization
        set settings = ${owner.json({ portal_self_signup: allowed })}
        where id = ${tenant.id}
      `;
    }

    it("desligado por padrão: responde igual e não cria nada", async () => {
      const email = customerEmail();

      const response = await signup(email, tenant.slug);
      await waitForBackgroundTasks();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mail.sent).toHaveLength(0);
      expect(await owner`select 1 from portal_user where email = ${email}`).toHaveLength(0);
    });

    it("ligado: confirma o e-mail, vira lead e só o owner promove", async () => {
      await allowSelfSignup(true);
      const email = customerEmail();

      expect((await signup(email, tenant.slug)).status).toBe(200);
      await waitForBackgroundTasks();

      const unconfirmed = await call("POST", "/api/portal/auth/sign-in/email", {
        body: { email, password: PASSWORD },
      });
      expect(unconfirmed.status).toBe(401);
      await waitForBackgroundTasks();

      const link = mail.sent.filter(({ to }) => to === email).at(0);
      expect(link?.text).toContain(`&org=${tenant.slug}`);

      const scanner = await call(
        "GET",
        `/api/portal/auth/verify-email?token=${confirmToken(email)}`,
      );
      expect(scanner.status).toBe(405);

      const confirmed = await call("POST", "/api/portal/auth/verify-email", {
        body: { token: confirmToken(email), org: tenant.slug },
      });
      expect(confirmed.status).toBe(200);
      expect(sessionCookies(confirmed)).toBe("");

      const signedIn = await call("POST", "/api/portal/auth/sign-in/email", {
        body: { email, password: PASSWORD },
      });
      expect(signedIn.status).toBe(200);
      const cookie = sessionCookies(signedIn);

      const me = await call("GET", "/api/portal/me", { cookie });
      expect(await me.json()).toMatchObject({
        active: null,
        tenants: [{ id: tenant.id, status: "lead", available: false }],
      });
      expect((await call("GET", "/api/portal/customer", { cookie })).status).toBe(403);

      await allowSelfSignup(false);
    });

    it("telefone de outro cliente do tenant: a confirmação responde igual e não cria linha", async () => {
      await allowSelfSignup(true);
      const holder = await createCustomer(tenantOwner, { phone: "(11) 95555-1234" });
      const email = customerEmail();

      const response = await call("POST", "/api/portal/auth-ext/sign-up", {
        body: {
          name: "Pessoa Colisao",
          email,
          password: PASSWORD,
          org: tenant.slug,
          // O mesmo número, escrito com o 9º dígito e sem ele, é a mesma chave.
          phone: "11 5555-1234",
          acceptTerms: true,
          termsVersion: "2026-11",
        },
      });
      expect(response.status).toBe(200);
      await waitForBackgroundTasks();

      const confirmed = await call("POST", "/api/portal/auth/verify-email", {
        body: { token: confirmToken(email), org: tenant.slug },
      });
      // Mesmo status e corpo de um telefone livre: nada de 500 que revele o número.
      expect(confirmed.status).toBe(200);

      const rows = await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        return tx`select id from customer where tenant_id = ${tenant.id} and email = ${email}`;
      });
      expect(rows).toHaveLength(0);
      expect(holder.id).toBeTruthy();

      await allowSelfSignup(false);
    });

    it("cadastro + login não revelam se o e-mail já existia", async () => {
      await allowSelfSignup(true);
      const fresh = customerEmail();
      const { id, email: taken } = await createCustomer(tenantOwner);
      await call("POST", `/api/customers/${id}/invite`, {
        cookie: tenantOwner.cookie,
      });

      const probe = async (email: string) => {
        await signup(email, tenant.slug);
        await waitForBackgroundTasks();

        const response = await call("POST", "/api/portal/auth/sign-in/email", {
          body: { email, password: PASSWORD },
        });

        return {
          status: response.status,
          headers: comparableHeaders(response),
          body: await response.text(),
        };
      };

      const newAccount = await probe(fresh);
      const existing = await probe(taken);
      await allowSelfSignup(false);

      expect(newAccount.status).toBe(401);
      expect(newAccount).toEqual(existing);
    });

    it("confirmar não liga a identidade a um cliente já ativo", async () => {
      await allowSelfSignup(true);
      const { id, email } = await createCustomer(tenantOwner, {
        status: "active",
      });

      await signup(email, tenant.slug);
      await waitForBackgroundTasks();
      await call("POST", "/api/portal/auth/verify-email", {
        body: { token: confirmToken(email), org: tenant.slug },
      });
      await allowSelfSignup(false);

      const detail = await call("GET", `/api/customers/${id}`, {
        cookie: tenantOwner.cookie,
      });
      expect(await detail.json()).toMatchObject({
        customer: { status: "active", hasPortalAccess: false },
      });
    });

    it("convite derruba a senha de quem cadastrou o e-mail sem provar", async () => {
      await allowSelfSignup(true);
      const email = customerEmail();
      await signup(email, tenant.slug);
      await waitForBackgroundTasks();
      await allowSelfSignup(false);

      const { id } = await createCustomer(tenantOwner, { email });
      await inviteAndEnter(tenantOwner, mail, id, email);

      const attacker = await call("POST", "/api/portal/auth/sign-in/email", {
        body: { email, password: PASSWORD },
      });
      expect(attacker.status).toBe(401);
    });
  });
});

/**
 * Exclusão agendada pela plataforma (`docs/specs/admin-crud/spec.md`, seção 3): na carência,
 * o pedido `origin = platform` barra a sessão, o pedido de link e a senha, sem revelar nada.
 */
describe("portal: barreira na carência da exclusão pela plataforma", () => {
  const barrierMail = createMemoryProvider();
  let owner: postgres.Sql;
  let tenantOwner: TestUser;
  let platformOwner: TestUser;
  let tenant: { id: string; slug: string };

  beforeAll(async () => {
    setEmailProviderForTests(barrierMail);
    owner = connectOwner();
    tenantOwner = await createUser(owner);
    tenant = await createTenant(tenantOwner);
    platformOwner = await makePlatformUser(owner, "platform_owner");
  });

  afterAll(async () => {
    setEmailProviderForTests(undefined);
    await asPlatform(
      owner,
      (tx) => tx`
        delete from deletion_request where subject_id in (
          select id from portal_user where email like ${"%@tenant-test.bizu.local"}
        )
      `,
    );
    await cleanUpPortal(owner);
    await cleanUpBilling(owner);
    await cleanUp(owner);
    await owner.end();
  });

  beforeEach(() => barrierMail.reset());

  async function personWithPassword() {
    const { id, email } = await createCustomer(tenantOwner);
    const cookie = await inviteAndEnter(tenantOwner, barrierMail, id, email);
    const response = await call("POST", "/api/portal/auth-ext/set-password", {
      cookie,
      body: { newPassword: PASSWORD },
    });
    expect(response.status).toBe(200);
    const [person] = await owner<{ id: string }[]>`
      select id from portal_user where email = ${email}
    `;

    return { cookie, email, id: person?.id ?? "" };
  }

  const signIn = (email: string, password: string) =>
    call("POST", "/api/portal/auth/sign-in/email", { body: { email, password } });

  const askLink = (email: string) =>
    call("POST", "/api/portal/auth-ext/magic-link", { body: { email, org: tenant.slug } });

  async function linksTo(email: string) {
    await waitForBackgroundTasks();
    return barrierMail.sent.filter(
      ({ to, tags }) => to === email && tags?.template === "portal-magic-link",
    ).length;
  }

  async function snapshot(response: Response) {
    return {
      status: response.status,
      headers: comparableHeaders(response),
      body: await response.text(),
    };
  }

  it("sem sessão, sem link e a senha certa responde como a errada; cancelar devolve", async () => {
    const { cookie, email, id } = await personWithPassword();

    // Link pedido antes da exclusão: não abre sessão depois dela.
    expect((await askLink(email)).status).toBe(200);
    await waitForBackgroundTasks();
    const { token, org } = lastLink(barrierMail, email);

    const scheduled = await call("DELETE", `/api/admin/portal-users/${id}`, {
      cookie: platformOwner.cookie,
      body: { mode: "scheduled", confirm: email },
    });
    expect(scheduled.status).toBe(200);

    expect((await call("GET", "/api/portal/me", { cookie })).status).toBe(401);

    const stale = await verify(token, org);
    expect(stale.status).toBe(400);
    expect(sessionCookies(stale)).toBe("");

    barrierMail.reset();
    const asked = await askLink(email);
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ ok: true });
    expect(await linksTo(email)).toBe(0);

    const wrong = await snapshot(await signIn(email, "senha-errada-123"));
    const right = await snapshot(await signIn(email, PASSWORD));
    expect(right.status).toBe(401);
    expect(right).toEqual(wrong);

    const canceled = await call("POST", `/api/admin/portal-users/${id}/deletion/cancel`, {
      cookie: platformOwner.cookie,
    });
    expect(canceled.status).toBe(200);
    expect((await signIn(email, PASSWORD)).status).toBe(200);
    await askLink(email);
    expect(await linksTo(email)).toBe(1);
  });

  it("a sessão aberta cai na hora, mesmo sem ter sido apagada", async () => {
    const { cookie, id } = await personWithPassword();
    expect((await call("GET", "/api/portal/me", { cookie })).status).toBe(200);

    await asPlatform(
      owner,
      (tx) => tx`
        insert into deletion_request (subject_type, subject_id, requested_by, scheduled_for, origin)
        values ('portal_user', ${id}, ${platformOwner.id}, now() + interval '30 days', 'platform')
      `,
    );

    expect((await call("GET", "/api/portal/me", { cookie })).status).toBe(401);
  });

  it("o pedido da própria pessoa não barra: ela entra para desistir", async () => {
    const { cookie, id } = await personWithPassword();

    const asked = await call("DELETE", "/api/portal/me", { cookie, body: { password: PASSWORD } });
    expect(asked.status).toBe(200);

    expect((await call("GET", "/api/portal/me", { cookie })).status).toBe(200);
    const byPlatform = await call("POST", `/api/admin/portal-users/${id}/deletion/cancel`, {
      cookie: platformOwner.cookie,
    });
    expect(byPlatform.status).toBe(409);
    expect(((await byPlatform.json()) as { code: string }).code).toBe("DELETION_NOT_PLATFORM");
    expect((await call("POST", "/api/portal/me/deletion/cancel", { cookie })).status).toBe(200);
  });
});
