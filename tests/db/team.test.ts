import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { reservedPermissions } from "@/lib/auth/permissions";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  newEmail,
  signIn,
  type TestUser,
} from "./tenant-helpers";

const mail = createMemoryProvider();
let owner: postgres.Sql;

async function json(response: Response) {
  return (await response.clone().json()) as Record<string, never> & {
    code?: string;
    error?: string;
  };
}

function invite(user: TestUser, email: string, role = "member") {
  return call("POST", "/api/team/invitations", {
    cookie: user.cookie,
    body: { email, role },
  });
}

async function invitationLink(email: string) {
  await waitForBackgroundTasks();

  const message = mail.sent
    .filter((m) => m.to === email && m.tags?.template === "invite-member")
    .at(-1);
  const id = message?.text.match(/\/convite\/([0-9a-f-]{36})/)?.[1];
  if (!id) throw new Error(`Nenhum convite para ${email}`);

  return id;
}

async function memberIdOf(tenantId: string, user: TestUser) {
  const [row] = await owner<{ id: string }[]>`
    select id from member
    where organization_id = ${tenantId} and user_id = ${user.id}
  `;
  return row?.id;
}

async function auditRows(tenantId: string) {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    return tx<{ action: string; metadata: unknown; ip_hash: string | null }[]>`
      select action, metadata, ip_hash from audit_log
      where tenant_id = ${tenantId} order by created_at
    `;
  });
}

beforeAll(() => {
  owner = connectOwner();
  setEmailProviderForTests(mail);
});

afterEach(async () => {
  await waitForBackgroundTasks();
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUp(owner);
  await owner.end();
});

describe("tenant", () => {
  it("cria o tenant, torna o criador owner e ativa na sessão", async () => {
    const user = await createUser(owner);

    const created = await call("POST", "/api/tenant", {
      cookie: user.cookie,
      body: { name: "Clínica São João" },
    });
    const { tenant } = await created.json();

    expect(tenant.slug).toMatch(/^clinica-sao-joao/);

    const me = await (
      await call("GET", "/api/me", { cookie: user.cookie })
    ).json();

    expect(me.user.activeTenant).toMatchObject({ id: tenant.id, role: "owner" });
    expect(me.permissions).toContain("organization:delete");
  });

  it("slug em uso responde 409", async () => {
    const first = await createUser(owner);
    const slug = `slug-${randomUUID()}`;
    await call("POST", "/api/tenant", {
      cookie: first.cookie,
      body: { name: "Primeira", slug },
    });

    const second = await createUser(owner);
    const response = await call("POST", "/api/tenant", {
      cookie: second.cookie,
      body: { name: "Segunda", slug },
    });

    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe("SLUG_TAKEN");
  });

  it("sem assinatura paga, recusa a segunda organização do mesmo dono", async () => {
    // Trial ou sem assinatura valem 1 (`limits.organizations`, tech/23-billing-planos.md).
    const user = await createUser(owner);
    await createTenant(user, "Um");

    const response = await call("POST", "/api/tenant", {
      cookie: user.cookie,
      body: { name: "Dois" },
    });

    expect(response.status).toBe(403);
    expect((await json(response)).code).toBe("PLAN_LIMIT_REACHED");
  });

  it("troca de tenant e sessão nova abre no último usado", async () => {
    const user = await createUser(owner);
    const first = await createTenant(user, "Primeiro");
    // Membro (não dono) de outra organização: não conta no limite de organizações.
    const other = await createUser(owner);
    const second = await createTenant(other, "Segundo");
    await addMember(owner, second.id, user, "member");
    await call("POST", "/api/tenant/active", {
      cookie: user.cookie,
      body: { tenantId: second.id },
    });

    const switched = await call("POST", "/api/tenant/active", {
      cookie: user.cookie,
      body: { tenantId: first.id },
    });
    expect(switched.status).toBe(200);

    const cookie = await signIn(user.email);
    const me = await (await call("GET", "/api/me", { cookie })).json();

    expect(me.user.activeTenant.id).toBe(first.id);
    expect(me.tenants).toHaveLength(2);
  });

  it("não ativa tenant de que não é membro", async () => {
    const outsider = await createUser(owner);
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);

    const response = await call("POST", "/api/tenant/active", {
      cookie: outsider.cookie,
      body: { tenantId: tenant.id },
    });

    expect(response.status).toBe(404);
  });

  it.each([
    ["suspended", "full", "GET", "/api/team", "TENANT_SUSPENDED"],
    ["active", "locked", "GET", "/api/team", "TENANT_SUSPENDED"],
    ["active", "read_only", "PATCH", "/api/tenant", "TENANT_READ_ONLY"],
  ])(
    "status %s e modo %s recusam %s %s",
    async (status, accessMode, method, path, code) => {
      const user = await createUser(owner);
      const tenant = await createTenant(user);
      await owner`
        update organization
        set status = ${status}, access_mode = ${accessMode}
        where id = ${tenant.id}
      `;

      const response = await call(method, path, {
        cookie: user.cookie,
        body: method === "GET" ? undefined : { name: "Novo nome" },
      });

      expect(response.status).toBe(403);
      expect((await json(response)).code).toBe(code);
    },
  );

  it("read_only ainda permite leitura", async () => {
    const user = await createUser(owner);
    const tenant = await createTenant(user);
    await owner`
      update organization set access_mode = 'read_only' where id = ${tenant.id}
    `;

    const response = await call("GET", "/api/team", { cookie: user.cookie });

    expect(response.status).toBe(200);
  });

  it("recusa Origin de outro site", async () => {
    const user = await createUser(owner);

    const response = await call("POST", "/api/tenant", {
      cookie: user.cookie,
      body: { name: "Forjado" },
      origin: "https://atacante.example",
    });

    expect(response.status).toBe(403);
  });
});

describe("rotas HTTP do plugin", () => {
  it.each([
    ["POST", "/api/auth/organization/create"],
    ["POST", "/api/auth/organization/create-role"],
    ["POST", "/api/auth/organization/update-member-role"],
    ["POST", "/api/auth/organization/remove-member"],
    ["POST", "/api/auth/organization/invite-member"],
    ["POST", "/api/auth/organization/accept-invitation"],
    ["POST", "/api/auth/organization/set-active"],
    ["GET", "/api/auth/organization/list"],
  ])("%s %s não responde", async (method, path) => {
    const user = await createUser(owner);

    const response = await call(method, path, {
      cookie: user.cookie,
      body: method === "POST" ? {} : undefined,
    });

    expect(response.status).toBe(404);
  });
});

describe("convite ponta a ponta", () => {
  it("convidar, abrir sem consumir, aceitar uma vez só", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner, "Acme");
    const email = newEmail();

    const created = await invite(tenantOwner, email, "admin");
    expect(created.status).toBe(201);

    const id = await invitationLink(email);
    const guest = await createUser(owner, email);

    // Scanner de e-mail: várias aberturas, com ou sem sessão.
    for (const cookie of [undefined, guest.cookie]) {
      const page = await call("GET", `/api/invitations/${id}`, { cookie });
      expect(page.status).toBe(200);
      expect(page.headers.get("Cache-Control")).toBe("no-store");
      expect((await page.json()).invitation).toMatchObject({
        email,
        tenantName: "Acme",
        roleLabel: "Administrador",
      });
    }

    expect(await memberIdOf(tenant.id, guest)).toBeUndefined();

    const accepted = await call("POST", `/api/invitations/${id}/accept`, {
      cookie: guest.cookie,
    });
    expect(accepted.status).toBe(200);
    expect(await memberIdOf(tenant.id, guest)).toBeDefined();

    const me = await (
      await call("GET", "/api/me", { cookie: guest.cookie })
    ).json();
    expect(me.user.activeTenant).toMatchObject({
      id: tenant.id,
      role: "admin",
    });

    const second = await call("POST", `/api/invitations/${id}/accept`, {
      cookie: guest.cookie,
    });
    expect(second.status).toBe(404);

    const used = await call("GET", `/api/invitations/${id}`);
    expect(used.status).toBe(404);
  });

  it("a página /convite/:id não tem loader nem action", async () => {
    const route = await readFile("src/routes/auth/invite.tsx", "utf8");

    expect(route).not.toMatch(/export\s+(async\s+)?(function|const)\s+(loader|action)/);
  });

  it("aceite exige sessão", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner);
    const email = newEmail();
    await invite(tenantOwner, email);

    const response = await call(
      "POST",
      `/api/invitations/${await invitationLink(email)}/accept`,
    );

    expect(response.status).toBe(401);
  });

  it("convite de outro e-mail é recusado", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const email = newEmail();
    await invite(tenantOwner, email);

    const stranger = await createUser(owner);
    const response = await call(
      "POST",
      `/api/invitations/${await invitationLink(email)}/accept`,
      { cookie: stranger.cookie },
    );

    expect(response.status).toBe(403);
    expect(await memberIdOf(tenant.id, stranger)).toBeUndefined();
  });

  it("conta não verificada não aceita", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner);
    const guest = await createUser(owner);
    await invite(tenantOwner, guest.email);
    await owner`
      update "user" set email_verified = false where id = ${guest.id}
    `;

    const response = await call(
      "POST",
      `/api/invitations/${await invitationLink(guest.email)}/accept`,
      { cookie: guest.cookie },
    );

    expect(response.status).toBe(403);
  });

  it("convite revogado é recusado", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner);
    const guest = await createUser(owner);
    await invite(tenantOwner, guest.email);
    const id = await invitationLink(guest.email);

    const revoked = await call("DELETE", `/api/team/invitations/${id}`, {
      cookie: tenantOwner.cookie,
    });
    expect(revoked.status).toBe(200);

    const page = await call("GET", `/api/invitations/${id}`);
    const accept = await call("POST", `/api/invitations/${id}/accept`, {
      cookie: guest.cookie,
    });

    expect(page.status).toBe(404);
    expect(accept.status).toBe(404);
  });

  it("convite vencido é recusado", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner);
    const guest = await createUser(owner);
    await invite(tenantOwner, guest.email);
    const id = await invitationLink(guest.email);
    await owner`
      update invitation set expires_at = now() - interval '1 minute'
      where id = ${id}
    `;

    const response = await call("POST", `/api/invitations/${id}/accept`, {
      cookie: guest.cookie,
    });

    expect(response.status).toBe(404);
  });

  it("reconvidar invalida o link anterior", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner);
    const email = newEmail();

    await invite(tenantOwner, email);
    const first = await invitationLink(email);
    await invite(tenantOwner, email, "admin");
    const second = await invitationLink(email);

    expect(second).not.toBe(first);
    expect((await call("GET", `/api/invitations/${first}`)).status).toBe(404);
    expect((await call("GET", `/api/invitations/${second}`)).status).toBe(200);
  });

  it("reenvio mantém o link, renova o prazo e manda outro e-mail", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner);
    const email = newEmail();
    await invite(tenantOwner, email);
    const id = await invitationLink(email);
    await owner`
      update invitation set expires_at = now() + interval '1 hour' where id = ${id}
    `;

    const response = await call("POST", `/api/team/invitations/${id}/resend`, {
      cookie: tenantOwner.cookie,
    });
    expect(response.status).toBe(200);
    expect(await invitationLink(email)).toBe(id);

    const sent = mail.sent.filter(
      (m) => m.to === email && m.tags?.template === "invite-member",
    );
    const [row] = await owner<{ remaining: boolean }[]>`
      select expires_at > now() + interval '40 hours' as remaining
      from invitation where id = ${id}
    `;

    expect(sent).toHaveLength(2);
    expect(row?.remaining).toBe(true);
  });

  it("convidar quem já é membro responde 409", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "member");

    const response = await invite(tenantOwner, colleague.email);

    expect(response.status).toBe(409);
  });

  it.each([["read_only"], ["locked"]])(
    "tenant em %s não recebe membro novo",
    async (accessMode) => {
      const tenantOwner = await createUser(owner);
      const tenant = await createTenant(tenantOwner);
      const guest = await createUser(owner);
      await invite(tenantOwner, guest.email);
      const id = await invitationLink(guest.email);
      await owner`
        update organization set access_mode = ${accessMode} where id = ${tenant.id}
      `;

      const response = await call("POST", `/api/invitations/${id}/accept`, {
        cookie: guest.cookie,
      });

      expect(response.status).toBe(404);
      expect(await memberIdOf(tenant.id, guest)).toBeUndefined();
    },
  );

  it("onboarding lista os convites do e-mail verificado", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner, "Convida");
    const guest = await createUser(owner);
    await invite(tenantOwner, guest.email);

    const { invitations } = await (
      await call("GET", "/api/me/invitations", { cookie: guest.cookie })
    ).json();

    expect(invitations).toEqual([
      expect.objectContaining({
        tenantName: "Convida",
        roleLabel: "Colaborador",
      }),
    ]);
  });
});

describe("escalada de permissão", () => {
  it("admin não convida owner", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const admin = await createUser(owner);
    await addMember(owner, tenant.id, admin, "admin");

    const response = await invite(admin, newEmail(), "owner");

    expect(response.status).toBe(403);
  });

  it("papel desconhecido não vira convite", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner);

    const response = await invite(tenantOwner, newEmail(), "inexistente");

    expect(response.status).toBe(400);
  });

  it.each([["member,owner"], ["owner, member"], ["a"]])(
    "nome de papel inválido %j é recusado",
    async (role) => {
      const tenantOwner = await createUser(owner);
      await createTenant(tenantOwner);

      const response = await invite(tenantOwner, newEmail(), role);

      expect(response.status).toBe(400);
    },
  );

  it("papel personalizado não concede papel acima do seu", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    await createRole(tenantOwner, "gestor", [
      "member:update",
      "invitation:create",
    ]);
    const manager = await createUser(owner);
    await addMember(owner, tenant.id, manager, "gestor");
    const colleague = await createUser(owner);
    const colleagueMember = await addMember(
      owner,
      tenant.id,
      colleague,
      "gestor",
    );

    const invited = await invite(manager, newEmail(), "admin");
    const promoted = await call(
      "PATCH",
      `/api/team/members/${colleagueMember}`,
      { cookie: manager.cookie, body: { role: "admin" } },
    );
    const selfPromoted = await call(
      "PATCH",
      `/api/team/members/${await memberIdOf(tenant.id, manager)}`,
      { cookie: manager.cookie, body: { role: "owner" } },
    );

    expect(invited.status).toBe(403);
    expect(promoted.status).toBe(403);
    expect(selfPromoted.status).toBe(403);
  });

  it("quem não vê um convite de papel maior não o gere", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const admin = await createUser(owner);
    await addMember(owner, tenant.id, admin, "admin");
    const email = newEmail();
    await invite(tenantOwner, email, "owner");
    const id = await invitationLink(email);

    const team = await (
      await call("GET", "/api/team", { cookie: admin.cookie })
    ).json();
    const canceled = await call("DELETE", `/api/team/invitations/${id}`, {
      cookie: admin.cookie,
    });

    expect(team.invitations).toEqual([]);
    expect(canceled.status).toBe(404);
  });

  it("reconvidar não derruba convite de papel maior", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const admin = await createUser(owner);
    await addMember(owner, tenant.id, admin, "admin");
    const email = newEmail();
    await invite(tenantOwner, email, "owner");
    const id = await invitationLink(email);

    const response = await invite(admin, email, "member");

    expect(response.status).toBe(409);
    expect((await json(response)).code).toBe("ALREADY_INVITED");
    expect((await call("GET", `/api/invitations/${id}`)).status).toBe(200);
  });

  it("reconvidar exige poder revogar o convite anterior", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    await createRole(tenantOwner, "so-convida", ["invitation:create"]);
    const inviter = await createUser(owner);
    await addMember(owner, tenant.id, inviter, "so-convida");
    const email = newEmail();
    await invite(tenantOwner, email, "so-convida");
    const id = await invitationLink(email);

    const response = await invite(inviter, email, "so-convida");

    expect(response.status).toBe(409);
    expect((await call("GET", `/api/invitations/${id}`)).status).toBe(200);
  });

  it("admin reconvida quando pode gerir o convite anterior", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const admin = await createUser(owner);
    await addMember(owner, tenant.id, admin, "admin");
    const email = newEmail();
    await invite(tenantOwner, email, "member");

    const response = await invite(admin, email, "admin");

    expect(response.status).toBe(201);
  });

  it("colaborador não vê os ids dos convites", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "member");
    await invite(tenantOwner, newEmail());

    const team = await (
      await call("GET", "/api/team", { cookie: colleague.cookie })
    ).json();

    expect(team.members).toHaveLength(2);
    expect(team.invitations).toEqual([]);
  });

  it("a lista da equipe traz só o tipo do telefone (para o botão Conversar), nunca o número", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "member");

    const response = await call("GET", "/api/team", { cookie: colleague.cookie });
    const team = await response.json();

    expect(team.members).toHaveLength(2);
    for (const member of team.members) {
      expect(member.phoneKind).toBe("mobile");
      expect(JSON.stringify(member)).not.toMatch(/11987654321|phone_|phoneNormalized|"phone"/);
    }
  });

  it("admin não altera nem remove owner", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const admin = await createUser(owner);
    await addMember(owner, tenant.id, admin, "admin");
    const ownerMember = await memberIdOf(tenant.id, tenantOwner);

    const changed = await call("PATCH", `/api/team/members/${ownerMember}`, {
      cookie: admin.cookie,
      body: { role: "member" },
    });
    const removed = await call("DELETE", `/api/team/members/${ownerMember}`, {
      cookie: admin.cookie,
    });

    expect(changed.status).toBe(403);
    expect(removed.status).toBe(403);
  });
});

describe("último owner", () => {
  it("não sai nem é rebaixado", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const memberId = await memberIdOf(tenant.id, tenantOwner);

    const removed = await call("DELETE", `/api/team/members/${memberId}`, {
      cookie: tenantOwner.cookie,
    });
    const demoted = await call("PATCH", `/api/team/members/${memberId}`, {
      cookie: tenantOwner.cookie,
      body: { role: "admin" },
    });

    expect(removed.status).toBe(409);
    expect((await json(removed)).code).toBe("LAST_OWNER");
    expect(demoted.status).toBe(409);
  });

  it("com dois owners, um pode sair", async () => {
    const first = await createUser(owner);
    const tenant = await createTenant(first);
    const second = await createUser(owner);
    await addMember(owner, tenant.id, second, "owner");

    const response = await call(
      "DELETE",
      `/api/team/members/${await memberIdOf(tenant.id, second)}`,
      { cookie: first.cookie },
    );

    expect(response.status).toBe(200);
  });

  it("dois owners se rebaixando ao mesmo tempo: só um consegue", async () => {
    const first = await createUser(owner);
    const tenant = await createTenant(first);
    const second = await createUser(owner);
    await addMember(owner, tenant.id, second, "owner");

    const responses = await Promise.all([
      call("PATCH", `/api/team/members/${await memberIdOf(tenant.id, second)}`, {
        cookie: first.cookie,
        body: { role: "member" },
      }),
      call("PATCH", `/api/team/members/${await memberIdOf(tenant.id, first)}`, {
        cookie: second.cookie,
        body: { role: "member" },
      }),
    ]);
    const owners = await owner`
      select 1 from member
      where organization_id = ${tenant.id} and role = 'owner'
    `;

    expect(owners.length).toBe(1);
    expect(responses.map(({ status }) => status).sort()).toEqual(
      expect.arrayContaining([200]),
    );
  });
});

describe("remoção", () => {
  it("corta o acesso na hora e a sessão cai no próximo tenant", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner, "Sai daqui");
    const colleague = await createUser(owner);
    const own = await createTenant(colleague, "Fica aqui");
    const memberId = await addMember(owner, tenant.id, colleague, "admin");

    const removed = await call("DELETE", `/api/team/members/${memberId}`, {
      cookie: tenantOwner.cookie,
    });
    expect(removed.status).toBe(200);

    const blocked = await call("GET", "/api/team", {
      cookie: colleague.cookie,
    });
    expect(blocked.status).toBe(403);

    const me = await (
      await call("GET", "/api/me", { cookie: colleague.cookie })
    ).json();
    expect(me.user.activeTenant.id).toBe(own.id);
    expect(me.tenants).toHaveLength(1);

    const back = await call("GET", "/api/team", { cookie: colleague.cookie });
    expect(back.status).toBe(200);
  });

  it("sem outro tenant, /api/me não devolve tenant ativo", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const colleague = await createUser(owner);
    const memberId = await addMember(owner, tenant.id, colleague, "member");

    await call("DELETE", `/api/team/members/${memberId}`, {
      cookie: tenantOwner.cookie,
    });
    const me = await (
      await call("GET", "/api/me", { cookie: colleague.cookie })
    ).json();

    expect(me.user.activeTenant).toBeNull();
    expect(me.tenants).toEqual([]);
    expect(me.permissions).toEqual([]);
  });
});

describe("ids cruzados entre tenants", () => {
  it("nada de outro tenant é alcançável: 404", async () => {
    const ownerA = await createUser(owner);
    await createTenant(ownerA, "Tenant A");

    const ownerB = await createUser(owner);
    const tenantB = await createTenant(ownerB, "Tenant B");
    const colleagueB = await createUser(owner);
    const memberB = await addMember(owner, tenantB.id, colleagueB, "member");
    const roleB = await createRole(ownerB, "exclusivo", ["customer:read"]);
    const invited = newEmail();
    await invite(ownerB, invited);
    const invitationB = await invitationLink(invited);

    const attempts = [
      ["PATCH", `/api/team/members/${memberB}`, { role: "admin" }],
      ["DELETE", `/api/team/members/${memberB}`, undefined],
      ["DELETE", `/api/team/invitations/${invitationB}`, undefined],
      ["POST", `/api/team/invitations/${invitationB}/resend`, undefined],
      ["PATCH", `/api/roles/${roleB.id}`, { name: "roubado" }],
      ["DELETE", `/api/roles/${roleB.id}`, undefined],
    ] as const;

    for (const [method, path, body] of attempts) {
      const response = await call(method, path, { cookie: ownerA.cookie, body });
      expect([method, path, response.status]).toEqual([method, path, 404]);
    }

    const untouched = await (
      await call("GET", "/api/team", { cookie: ownerB.cookie })
    ).json();

    expect(untouched.members).toHaveLength(2);
    expect(untouched.invitations).toHaveLength(1);
  });

  it("id malformado responde 404", async () => {
    const user = await createUser(owner);
    await createTenant(user);

    const response = await call("DELETE", "/api/team/members/nao-e-uuid", {
      cookie: user.cookie,
    });

    expect(response.status).toBe(404);
  });

  it("papel de outro tenant não vale em convite", async () => {
    const ownerA = await createUser(owner);
    await createTenant(ownerA);
    const ownerB = await createUser(owner);
    await createTenant(ownerB);
    await createRole(ownerB, "so-no-b", ["customer:read"]);

    const response = await invite(ownerA, newEmail(), "so-no-b");

    expect(response.status).toBe(400);
  });
});

describe("papéis personalizados", () => {
  it.each(reservedPermissions.map((permission) => [permission]))(
    "permissão reservada %s responde 400",
    async (permission) => {
      const user = await createUser(owner);
      await createTenant(user);

      const response = await call("POST", "/api/roles", {
        cookie: user.cookie,
        body: { name: "abusado", permissions: [permission] },
      });

      expect(response.status).toBe(400);
    },
  );

  it("reservada também é recusada ao editar", async () => {
    const user = await createUser(owner);
    await createTenant(user);
    const role = await createRole(user, "editado", ["customer:read"]);

    const response = await call("PATCH", `/api/roles/${role.id}`, {
      cookie: user.cookie,
      body: { permissions: ["customer:read", "billing:manage"] },
    });

    expect(response.status).toBe(400);
  });

  it.each([
    ["recurso interno do plugin", ["ac:create"]],
    ["permissão que não existe", ["customer:voar"]],
    ["lista vazia", []],
  ])("recusa %s", async (_label, permissions) => {
    const user = await createUser(owner);
    await createTenant(user);

    const response = await call("POST", "/api/roles", {
      cookie: user.cookie,
      body: { name: "invalido", permissions },
    });

    expect(response.status).toBe(400);
  });

  it.each([["owner"], ["admin"], ["member"], ["com,virgula"], ["Com Espaço"]])(
    "recusa o nome %s",
    async (name) => {
      const user = await createUser(owner);
      await createTenant(user);

      const response = await call("POST", "/api/roles", {
        cookie: user.cookie,
        body: { name, permissions: ["customer:read"] },
      });

      expect(response.status).toBe(400);
    },
  );

  it("nome repetido responde 409", async () => {
    const user = await createUser(owner);
    await createTenant(user);
    await createRole(user, "repetido", ["customer:read"]);

    const response = await call("POST", "/api/roles", {
      cookie: user.cookie,
      body: { name: "repetido", permissions: ["customer:read"] },
    });

    expect(response.status).toBe(409);
  });

  it("cria, lista, edita e exclui", async () => {
    const user = await createUser(owner);
    await createTenant(user);
    const role = await createRole(user, "recepcao", [
      "customer:read",
      "customer:create",
    ]);

    const edited = await call("PATCH", `/api/roles/${role.id}`, {
      cookie: user.cookie,
      body: { name: "atendimento", permissions: ["customer:read"] },
    });
    expect(edited.status).toBe(200);

    const { roles } = await (
      await call("GET", "/api/roles", { cookie: user.cookie })
    ).json();
    expect(roles).toEqual([
      expect.objectContaining({
        id: role.id,
        name: "atendimento",
        permissions: ["customer:read"],
      }),
    ]);

    const removed = await call("DELETE", `/api/roles/${role.id}`, {
      cookie: user.cookie,
    });
    expect(removed.status).toBe(200);
  });

  it("bloqueia excluir ou renomear papel em uso por membro", async () => {
    const user = await createUser(owner);
    const tenant = await createTenant(user);
    const role = await createRole(user, "em-uso", ["customer:read"]);
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "em-uso");

    const removed = await call("DELETE", `/api/roles/${role.id}`, {
      cookie: user.cookie,
    });
    const renamed = await call("PATCH", `/api/roles/${role.id}`, {
      cookie: user.cookie,
      body: { name: "outro-nome" },
    });

    expect(removed.status).toBe(409);
    expect((await json(removed)).code).toBe("ROLE_IN_USE");
    expect(renamed.status).toBe(409);
  });

  it("bloqueia excluir papel de convite pendente", async () => {
    const user = await createUser(owner);
    await createTenant(user);
    const role = await createRole(user, "convidado", ["customer:read"]);
    await invite(user, newEmail(), "convidado");

    const response = await call("DELETE", `/api/roles/${role.id}`, {
      cookie: user.cookie,
    });

    expect(response.status).toBe(409);
  });

  it("nome parecido não conta como uso", async () => {
    const user = await createUser(owner);
    const tenant = await createTenant(user);
    const role = await createRole(user, "vendas", ["customer:read"]);
    await createRole(user, "vendas-sul", ["customer:read"]);
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "vendas-sul");

    const response = await call("DELETE", `/api/roles/${role.id}`, {
      cookie: user.cookie,
    });

    expect(response.status).toBe(200);
  });
});

describe("auditoria", () => {
  it("registra o ciclo da equipe, com IP em hash e sem dado pessoal", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner);
    const guest = await createUser(owner);

    await invite(tenantOwner, guest.email, "member");
    await call(
      "POST",
      `/api/invitations/${await invitationLink(guest.email)}/accept`,
      { cookie: guest.cookie },
    );
    const memberId = await memberIdOf(tenant.id, guest);
    await call("PATCH", `/api/team/members/${memberId}`, {
      cookie: tenantOwner.cookie,
      body: { role: "admin" },
    });
    await call("DELETE", `/api/team/members/${memberId}`, {
      cookie: tenantOwner.cookie,
    });

    const rows = await auditRows(tenant.id);

    expect(rows.map(({ action }) => action)).toEqual([
      "tenant.created",
      "member.invited",
      "member.joined",
      "member.role_changed",
      "member.removed",
    ]);

    for (const { ip_hash } of rows) expect(ip_hash).toMatch(/^[0-9a-f]{64}$/);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(guest.email);
    expect(serialized).not.toContain("10.40.");
  });
});
