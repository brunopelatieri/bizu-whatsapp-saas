import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { makePlatformUser } from "./billing-helpers";
import { applyCookies, PASSWORD } from "./security-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  newEmail,
  type TestUser,
} from "./tenant-helpers";

const POLICY_KEY = "impersonation_policy";

describe("personificação", () => {
  const mail = createMemoryProvider();
  let owner: postgres.Sql;
  let tenantOwner: TestUser;
  let member: TestUser;
  let support: TestUser;
  let tenantId: string;

  const impersonate = (actor: TestUser, userId: string, target = tenantId) =>
    call("POST", "/api/admin/impersonate", {
      cookie: actor.cookie,
      body: { userId, tenantId: target },
    });

  async function grant(tenantUser = tenantOwner, hours = 24) {
    const response = await call("POST", "/api/tenant/support-grant", {
      cookie: tenantUser.cookie,
      body: { hours },
    });
    expect(response.status).toBe(201);

    const { grant: created } = (await response.json()) as {
      grant: { id: string };
    };
    return created.id;
  }

  /** Sessão do suporte dentro do tenant, com o cookie da sessão original guardado. */
  async function enterAs(user: TestUser, actor = support) {
    const response = await impersonate(actor, user.id);
    expect(response.status).toBe(200);

    return applyCookies(actor.cookie, response);
  }

  async function auditRows(action: string, tenant = tenantId) {
    await waitForBackgroundTasks();

    return owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<
        {
          actor_id: string;
          actor_type: string;
          impersonator_id: string | null;
          metadata: Record<string, unknown>;
        }[]
      >`
        select actor_id, actor_type, impersonator_id, metadata from audit_log
        where action = ${action} and tenant_id = ${tenant}
        order by created_at desc
      `;
    });
  }

  async function templatesSent() {
    await waitForBackgroundTasks();
    return mail.sent.map((message) => message.tags?.template);
  }

  const asGrant = (run: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await run(tx);
    });

  const clearGrants = () =>
    asGrant((tx) => tx`delete from impersonation_grant where tenant_id = ${tenantId}`);

  const setPolicy = (value: string) =>
    owner`
      insert into platform_setting (key, value)
      values (${POLICY_KEY}, ${owner.json(value)})
      on conflict (key) do update set value = excluded.value
    `;

  beforeAll(async () => {
    setEmailProviderForTests(mail);
    owner = connectOwner();

    tenantOwner = await createUser(owner);
    tenantId = (await createTenant(tenantOwner)).id;
    member = await createUser(owner);
    await addMember(owner, tenantId, member, "member");
    support = await makePlatformUser(owner, "platform_support");
  });

  afterAll(async () => {
    setEmailProviderForTests(undefined);
    await owner`delete from platform_setting where key = ${POLICY_KEY}`;
    await cleanUp(owner);
    await owner.end();
  });

  beforeEach(async () => {
    await clearGrants();
    await owner`delete from platform_setting where key = ${POLICY_KEY}`;
    await asGrant(
      (tx) => tx`
        delete from audit_log
        where tenant_id = ${tenantId}
          and action = 'platform.impersonation_requested'
      `,
    );
    await waitForBackgroundTasks();
    mail.reset();
  });

  describe("sem consentimento", () => {
    it("responde 403, pede ao owner e audita", async () => {
      const response = await impersonate(support, member.id);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "IMPERSONATION_CONSENT_REQUIRED",
      });
      expect(await templatesSent()).toEqual(["impersonation-requested"]);
      expect(mail.sent[0]?.to).toBe(tenantOwner.email);

      const [row] = await auditRows("platform.impersonation_requested");
      expect(row).toMatchObject({
        actor_id: support.id,
        actor_type: "platform",
        impersonator_id: support.id,
      });
    });

    it("insistir não repete o e-mail no período", async () => {
      await impersonate(support, member.id);
      await impersonate(support, member.id);

      expect(await templatesSent()).toEqual(["impersonation-requested"]);
    });

    it("tentativa sem e-mail não estica a janela do pedido", async () => {
      await asGrant(
        (tx) => tx`
          insert into audit_log (tenant_id, actor_type, action, metadata)
          values (${tenantId}, 'platform', 'platform.impersonation_requested',
                  ${tx.json({ email_sent: false })})
        `,
      );

      await impersonate(support, member.id);

      expect(await templatesSent()).toEqual(["impersonation-requested"]);
    });

    it("não abre sessão nem devolve cookie", async () => {
      const response = await impersonate(support, member.id);

      expect(response.headers.getSetCookie()).toEqual([]);
    });
  });

  describe("com consentimento", () => {
    it("abre a sessão personificada, com banner e auditoria dupla", async () => {
      const grantId = await grant();

      const cookie = await enterAs(member);

      const me = await call("GET", "/api/me", { cookie });
      expect(await me.json()).toMatchObject({
        user: {
          id: member.id,
          impersonatedBy: support.id,
          activeTenant: { id: tenantId },
        },
      });

      const [row] = await auditRows("platform.impersonation_started");
      expect(row).toMatchObject({
        actor_id: support.id,
        actor_type: "platform",
        impersonator_id: support.id,
        metadata: { grant_id: grantId, policy: "consent" },
      });

      await asGrant(async (tx) => {
        const [used] = await tx`
          select used_by from impersonation_grant where id = ${grantId}
        `;
        expect(used?.used_by).toBe(support.id);
      });

      expect(await templatesSent()).toEqual(["impersonation-started"]);
      expect(mail.sent[0]?.to).toBe(tenantOwner.email);
    });

    it("o que a pessoa personificada faz leva o impersonator_id", async () => {
      await grant();
      const cookie = await enterAs(tenantOwner);

      const response = await call("POST", "/api/customers", {
        cookie,
        body: { name: "Criado pelo suporte", email: newEmail(), phone: "11987654321" },
      });
      expect(response.status).toBe(201);

      const [row] = await auditRows("customer.created");
      expect(row).toMatchObject({
        actor_id: tenantOwner.id,
        impersonator_id: support.id,
      });
    });

    it("a sessão termina junto com o consentimento", async () => {
      const grantId = await grant();
      const soon = new Date(Date.now() + 10 * 60 * 1000);
      await asGrant(
        (tx) => tx`
          update impersonation_grant set expires_at = ${soon}
          where id = ${grantId}
        `,
      );

      const response = await impersonate(support, member.id);
      const { expiresAt } = (await response.json()) as { expiresAt: string };
      const [row] = await owner<{ expires_at: Date }[]>`
        select expires_at from session
        where user_id = ${member.id} and impersonated_by is not null
        order by created_at desc limit 1
      `;

      expect(new Date(expiresAt).getTime()).toBe(soon.getTime());
      expect(row?.expires_at.getTime()).toBe(soon.getTime());
    });

    it("apagar o cookie dont_remember não estica a sessão além do teto", async () => {
      await grant();
      const cookie = await enterAs(member);
      const withoutGuard = cookie
        .split("; ")
        .filter((pair) => !pair.includes("dont_remember"))
        .join("; ");

      // A 1ª leitura sem o cookie renova `expires_at` para 7 dias.
      expect((await call("GET", "/api/me", { cookie: withoutGuard })).status).toBe(200);

      const [refreshed] = await owner<
        { id: string; expires_at: Date; impersonation_expires_at: Date }[]
      >`
        select id, expires_at, impersonation_expires_at from session
        where user_id = ${member.id} and impersonated_by is not null
        order by created_at desc limit 1
      `;
      expect(refreshed?.impersonation_expires_at.getTime()).toBeLessThanOrEqual(
        Date.now() + 60 * 60 * 1000,
      );

      await owner`
        update session set impersonation_expires_at = now() - interval '1 second'
        where id = ${refreshed?.id as string}
      `;

      const expired = await call("GET", "/api/me", { cookie: withoutGuard });
      expect(expired.status).toBe(401);

      const left = await owner`select 1 from session where id = ${refreshed?.id as string}`;
      expect(left).toHaveLength(0);
    });

    it("sessão personificada sem teto gravado não vale", async () => {
      await grant();
      const cookie = await enterAs(member);

      await owner`
        update session set impersonation_expires_at = null
        where user_id = ${member.id} and impersonated_by is not null
      `;

      expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
    });

    it("o último consentimento vale para mais de uma pessoa do suporte", async () => {
      await grant();
      const other = await makePlatformUser(owner, "platform_owner");

      await enterAs(member);
      await enterAs(member, other);
    });
  });

  describe("consentimento que não vale mais", () => {
    it("expirado responde 403", async () => {
      const grantId = await grant();
      await asGrant(
        (tx) => tx`
          update impersonation_grant set expires_at = now() - interval '1 minute'
          where id = ${grantId}
        `,
      );

      expect((await impersonate(support, member.id)).status).toBe(403);
    });

    it("revogado responde 403 e derruba quem estava dentro", async () => {
      const grantId = await grant();
      const cookie = await enterAs(member);

      const revoked = await call("DELETE", `/api/tenant/support-grant/${grantId}`, {
        cookie: tenantOwner.cookie,
      });
      expect(revoked.status).toBe(200);

      expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
      expect((await impersonate(support, member.id)).status).toBe(403);
    });

    it("de outro tenant não libera este", async () => {
      const outsider = await createUser(owner);
      await createTenant(outsider, "Outra Clínica");
      await grant(outsider);

      expect((await impersonate(support, member.id)).status).toBe(403);
    });

    it("revogar id de outro tenant responde 404", async () => {
      const outsider = await createUser(owner);
      await createTenant(outsider, "Mais Uma Clínica");
      const foreign = await grant(outsider);

      const response = await call("DELETE", `/api/tenant/support-grant/${foreign}`, {
        cookie: tenantOwner.cookie,
      });

      expect(response.status).toBe(404);
    });
  });

  describe("política allow_without_consent", () => {
    it("entra sem grant, e audita sem grant_id", async () => {
      await setPolicy("allow_without_consent");

      await enterAs(member);

      const [row] = await auditRows("platform.impersonation_started");
      expect(row?.metadata).toEqual({
        grant_id: null,
        policy: "allow_without_consent",
      });
    });

    it("valor desconhecido cai em consent", async () => {
      await setPolicy("liberado");

      expect((await impersonate(support, member.id)).status).toBe(403);
    });

    it("/api/admin/settings edita a política", async () => {
      const platformOwner = await makePlatformUser(owner, "platform_owner");

      const updated = await call("PATCH", "/api/admin/settings", {
        cookie: platformOwner.cookie,
        body: { impersonationPolicy: "allow_without_consent" },
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        settings: { impersonationPolicy: "allow_without_consent" },
      });

      const invalid = await call("PATCH", "/api/admin/settings", {
        cookie: platformOwner.cookie,
        body: { impersonationPolicy: "liberado" },
      });
      expect(invalid.status).toBe(400);

      const refused = await call("PATCH", "/api/admin/settings", {
        cookie: support.cookie,
        body: { impersonationPolicy: "consent" },
      });
      expect(refused.status).toBe(403);
    });
  });

  describe("quem e quem pode", () => {
    it("quem não é da plataforma não personifica", async () => {
      await grant();

      const response = await impersonate(tenantOwner, member.id);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "PLATFORM_FORBIDDEN" });
    });

    it("sem sessão responde 401", async () => {
      const response = await call("POST", "/api/admin/impersonate", {
        body: { userId: member.id, tenantId },
      });

      expect(response.status).toBe(401);
    });

    it("quem não é membro do tenant responde 404", async () => {
      await grant();
      const outsider = await createUser(owner);

      expect((await impersonate(support, outsider.id)).status).toBe(404);
    });

    it("conta de plataforma não é personificada", async () => {
      await grant();
      const staff = await makePlatformUser(owner, "platform_owner");
      await addMember(owner, tenantId, staff, "member");

      const response = await impersonate(support, staff.id);

      expect(response.status).toBe(403);
      await owner`delete from member where user_id = ${staff.id}`;
    });

    it("sessão personificada não personifica de novo", async () => {
      await grant();
      const cookie = await enterAs(tenantOwner);

      const response = await call("POST", "/api/admin/impersonate", {
        cookie,
        body: { userId: member.id, tenantId },
      });

      expect(response.status).toBe(403);
    });

    it("a tela só oferece com grant ativo ou política liberada", async () => {
      const read = async () => {
        const response = await call("GET", `/api/admin/tenants/${tenantId}`, {
          cookie: support.cookie,
        });
        const { impersonation } = (await response.json()) as {
          impersonation: { allowed: boolean };
        };
        return impersonation.allowed;
      };

      expect(await read()).toBe(false);
      await grant();
      expect(await read()).toBe(true);
    });
  });

  describe("presa ao tenant do consentimento", () => {
    it("não troca de tenant, mesmo sendo membro de outro", async () => {
      // Outra organização da mesma pessoa, como membro: o limite de organizações é de dono.
      const otherTenant = (await createTenant(await createUser(owner), "Filial")).id;
      await addMember(owner, otherTenant, tenantOwner, "admin");
      await call("POST", "/api/tenant/active", {
        cookie: tenantOwner.cookie,
        body: { tenantId },
      });
      await grant();
      const cookie = await enterAs(tenantOwner);

      const response = await call("POST", "/api/tenant/active", {
        cookie,
        body: { tenantId: otherTenant },
      });

      expect(response.status).toBe(403);

      const me = await call("GET", "/api/me", { cookie });
      expect(await me.json()).toMatchObject({
        user: { activeTenant: { id: tenantId } },
      });
    });

    it("/api/me mostra só o tenant do consentimento", async () => {
      await grant();
      const cookie = await enterAs(tenantOwner);

      const me = await call("GET", "/api/me", { cookie });
      const { tenants } = (await me.json()) as { tenants: { id: string }[] };

      expect(tenants.map(({ id }) => id)).toEqual([tenantId]);
    });

    it("não muda o último tenant da pessoa", async () => {
      await grant();
      const [before] = await owner<{ last_tenant_id: string | null }[]>`
        select last_tenant_id from "user" where id = ${member.id}
      `;

      await enterAs(member);

      const [after] = await owner<{ last_tenant_id: string | null }[]>`
        select last_tenant_id from "user" where id = ${member.id}
      `;
      expect(after).toEqual(before);
    });
  });

  describe("blockWhileImpersonating", () => {
    const anyId = randomUUID();
    let cookie: string;

    beforeEach(async () => {
      await grant();
      cookie = await enterAs(tenantOwner);
      await waitForBackgroundTasks();
      mail.reset();
    });

    it.each([
      ["POST", "/api/billing/checkout"],
      ["POST", "/api/billing/change-plan"],
      ["POST", "/api/billing/cancel"],
      ["POST", "/api/billing/reactivate"],
      ["POST", "/api/billing/pause"],
      ["POST", "/api/billing/portal"],
      ["PUT", "/api/billing/profile"],
      ["DELETE", "/api/tenant"],
      ["POST", "/api/tenant"],
      ["PATCH", "/api/tenant/security"],
      ["GET", "/api/tenant/support-grant"],
      ["POST", "/api/tenant/support-grant"],
      ["DELETE", `/api/tenant/support-grant/${anyId}`],
      ["POST", "/api/team/invitations"],
      ["POST", `/api/team/invitations/${anyId}/resend`],
      ["DELETE", `/api/team/invitations/${anyId}`],
      ["PATCH", `/api/team/members/${anyId}`],
      ["DELETE", `/api/team/members/${anyId}`],
      ["POST", "/api/roles"],
      ["PATCH", `/api/roles/${anyId}`],
      ["DELETE", `/api/roles/${anyId}`],
      ["POST", `/api/invitations/${anyId}/accept`],
      ["GET", "/api/me/sessions"],
      ["DELETE", `/api/me/sessions/${anyId}`],
      ["POST", "/api/me/sessions/revoke-others"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/change-email"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/two-factor/enable"],
      ["POST", "/api/auth/two-factor/disable"],
      ["POST", "/api/auth/two-factor/generate-backup-codes"],
      ["POST", "/api/auth/set-password"],
      ["POST", "/api/auth/delete-user"],
    ])("%s %s responde IMPERSONATION_BLOCKED e audita", async (method, path) => {
      const response = await call(method, path, {
        cookie,
        body: method === "GET" || method === "DELETE" ? undefined : {},
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "IMPERSONATION_BLOCKED" });

      const [row] = await auditRows("platform.impersonation_blocked_action");
      expect(row).toMatchObject({
        actor_id: support.id,
        actor_type: "platform",
        impersonator_id: support.id,
        metadata: { method, path },
      });
    });

    it("cookie repetido não escapa do bloqueio", async () => {
      const session = cookie
        .split("; ")
        .find((pair) => pair.includes("session_token")) as string;
      const [name] = session.split("=");

      for (const header of [
        `${session}; ${name}=`,
        `${name}=; ${session}`,
        `${session}; ${name}=forjado`,
      ]) {
        const response = await call("POST", "/api/auth/change-email", {
          cookie: header,
          body: { newEmail: newEmail() },
        });

        expect(response.ok).toBe(false);
        expect(await templatesSent()).toEqual([]);
      }

      const blocked = await call("POST", "/api/auth/change-email", {
        cookie: `${session}; ${name}=`,
        body: { newEmail: newEmail() },
      });

      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ code: "IMPERSONATION_BLOCKED" });
    });

    it("variante de caminho não escapa", async () => {
      for (const path of [
        "/api/auth/change-password/",
        "/api/auth//change-password",
      ]) {
        const response = await call("POST", path, {
          cookie,
          body: {
            currentPassword: PASSWORD,
            newPassword: "senha-trocada-456",
          },
        });

        expect(response.ok).toBe(false);
      }
    });

    it("a senha continua a mesma depois da tentativa", async () => {
      await call("POST", "/api/auth/change-password", {
        cookie,
        body: { currentPassword: PASSWORD, newPassword: "senha-trocada-456" },
      });

      const signIn = await call("POST", "/api/auth/sign-in/email", {
        body: { email: tenantOwner.email, password: PASSWORD },
      });
      expect(signIn.status).toBe(200);
    });

    it("leitura segue liberada, inclusive a da cobrança", async () => {
      for (const path of ["/api/billing/subscription", "/api/team", "/api/customers"]) {
        expect((await call("GET", path, { cookie })).status).toBe(200);
      }
    });

    it("sessão comum não é afetada", async () => {
      const response = await call("POST", "/api/tenant/support-grant", {
        cookie: tenantOwner.cookie,
        body: { hours: 1 },
      });

      expect(response.status).toBe(201);
    });
  });

  describe("stop-impersonating", () => {
    it("devolve a sessão do suporte e audita", async () => {
      await grant();
      const cookie = await enterAs(member);

      const response = await call("POST", "/api/admin/stop-impersonating", {
        cookie,
        body: {},
      });
      expect(response.status).toBe(200);

      const back = applyCookies(cookie, response);
      expect(back).not.toContain("admin_session");

      const me = await call("GET", "/api/me", { cookie: back });
      expect(await me.json()).toMatchObject({
        user: { id: support.id, impersonatedBy: null },
      });

      const [row] = await auditRows("platform.impersonation_stopped");
      expect(row).toMatchObject({
        actor_id: support.id,
        impersonator_id: support.id,
      });

      // A sessão de suporte sumiu de vez: o cookie antigo não vale mais.
      expect((await call("GET", "/api/me", { cookie })).status).toBe(401);
    });

    it("sem a sessão original, encerra só a personificada", async () => {
      await grant();
      const cookie = await enterAs(member);
      const withoutAdmin = cookie
        .split("; ")
        .filter((pair) => !pair.includes("admin_session"))
        .join("; ");

      const response = await call("POST", "/api/admin/stop-impersonating", {
        cookie: withoutAdmin,
        body: {},
      });

      expect(response.status).toBe(200);
      expect((await call("GET", "/api/me", { cookie: withoutAdmin })).status).toBe(401);
      expect(await auditRows("platform.impersonation_stopped")).not.toEqual([]);
    });

    it("em sessão comum responde 400", async () => {
      const response = await call("POST", "/api/admin/stop-impersonating", {
        cookie: member.cookie,
        body: {},
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "NOT_IMPERSONATING" });
    });

    it("sem sessão responde 401", async () => {
      const response = await call("POST", "/api/admin/stop-impersonating", {
        body: {},
      });

      expect(response.status).toBe(401);
    });
  });

  describe("support-grant", () => {
    it("recusa período fora do intervalo", async () => {
      for (const hours of [0, 73, 1.5]) {
        const response = await call("POST", "/api/tenant/support-grant", {
          cookie: tenantOwner.cookie,
          body: { hours },
        });

        expect(response.status).toBe(400);
      }
    });

    it("lista as autorizações e audita criar e revogar", async () => {
      const id = await grant(tenantOwner, 2);

      const list = await call("GET", "/api/tenant/support-grant", {
        cookie: tenantOwner.cookie,
      });
      const text = await list.text();
      const { grants } = JSON.parse(text) as {
        grants: { id: string; used: boolean }[];
      };
      expect(grants.map((row) => row.id)).toEqual([id]);
      expect(grants[0]?.used).toBe(false);
      expect(text).not.toContain("usedBy");

      await call("DELETE", `/api/tenant/support-grant/${id}`, {
        cookie: tenantOwner.cookie,
      });

      expect(await auditRows("support.grant_created")).not.toEqual([]);
      expect(await auditRows("support.grant_revoked")).not.toEqual([]);
    });

    it("em read_only, o owner ainda libera e revoga", async () => {
      await owner`update organization set access_mode = 'read_only' where id = ${tenantId}`;

      try {
        const id = await grant();
        const response = await call("DELETE", `/api/tenant/support-grant/${id}`, {
          cookie: tenantOwner.cookie,
        });

        expect(response.status).toBe(200);
      } finally {
        await owner`update organization set access_mode = 'full' where id = ${tenantId}`;
      }
    });

    it("revogar duas vezes responde 404", async () => {
      const id = await grant();
      const path = `/api/tenant/support-grant/${id}`;

      await call("DELETE", path, { cookie: tenantOwner.cookie });
      const again = await call("DELETE", path, { cookie: tenantOwner.cookie });

      expect(again.status).toBe(404);
    });
  });
});
