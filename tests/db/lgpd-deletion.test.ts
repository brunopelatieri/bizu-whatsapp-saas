import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerQueues } from "@/jobs";
import { getBoss } from "@/jobs/boss";
import { createMemoryProvider, type MemoryEmailProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { uploadFile } from "@/lib/files";
import { executeDeletion, executeDueDeletions } from "@/lib/lgpd/deletion";
import { processExport } from "@/lib/lgpd/export";
import { setProvidersForTests } from "@/lib/payments/registry";
import { setStorageForTests } from "@/lib/storage";
import { createLocalProvider } from "@/lib/storage/providers/local";
import {
  asPlatform,
  cleanUpBilling,
  createPlanRow,
  createStubProvider,
  ensureSubscription,
  makePlatformUser,
  STUB_ID,
  subscriptionState,
  updateSubscription,
} from "./billing-helpers";
import { createCustomer, customerEmail, inviteAndEnter } from "./portal-helpers";
import { cleanUpPortal } from "./portal-helpers";
import { enableTwoFactor, PASSWORD, totpCode } from "./security-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  signIn,
  type TestUser,
} from "./tenant-helpers";

let owner: postgres.Sql;
let mail: MemoryEmailProvider;
let storageDir: string;

/** Contas e organizações que a exclusão anonimiza escapam do padrão de e-mail de `cleanUp`. */
const userIds: string[] = [];
const tenantIds: string[] = [];
const portalIds: string[] = [];

async function newUser() {
  const user = await createUser(owner);
  userIds.push(user.id);
  return user;
}

async function newTenant(user: TestUser, name: string) {
  const tenant = await createTenant(user, name);
  tenantIds.push(tenant.id);
  return tenant;
}

const del = (pathname: string, cookie: string | undefined, body?: unknown) =>
  call("DELETE", pathname, { cookie, body });

async function requestOf(subjectId: string) {
  const [row] = await asPlatform(
    owner,
    (tx) =>
      tx<{ id: string; status: string; scheduled_for: Date; tenant_id: string | null }[]>`
        select id, status, scheduled_for, tenant_id from deletion_request
        where subject_id = ${subjectId} order by created_at desc limit 1
      `,
  );
  return row;
}

async function makeDue(requestId: string) {
  await asPlatform(
    owner,
    (tx) =>
      tx`update deletion_request set scheduled_for = now() - interval '1 day' where id = ${requestId}`,
  );
}

const countOf = async (table: string, column: string, id: string) => {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<{ total: number }[]>`
      select count(*)::int as total from ${tx(table)} where ${tx(column)} = ${id}
    `,
  );
  return row?.total ?? 0;
};

beforeAll(async () => {
  await registerQueues(await getBoss());
  mail = createMemoryProvider();
  setEmailProviderForTests(mail);
  owner = connectOwner();
  storageDir = await mkdtemp(path.join(os.tmpdir(), "bizu-delete-"));
  setStorageForTests(createLocalProvider(storageDir));
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  setStorageForTests(undefined);
  setProvidersForTests(undefined);
  await rm(storageDir, { recursive: true, force: true });

  await asPlatform(owner, async (tx) => {
    if (tenantIds.length > 0) {
      await tx`delete from audit_log where tenant_id in ${tx(tenantIds)}`;
      await tx`delete from subscription where tenant_id in ${tx(tenantIds)}`;
      await tx`delete from deletion_request where tenant_id in ${tx(tenantIds)}`;
      await tx`delete from organization where id in ${tx(tenantIds)}`;
    }
    if (userIds.length > 0) {
      await tx`delete from audit_log where actor_id in ${tx(userIds)}`;
      await tx`delete from deletion_request where subject_id in ${tx(userIds)}`;
      await tx`delete from data_export where subject_id in ${tx(userIds)}`;
      await tx`delete from consent_log where subject_id in ${tx(userIds)}`;
      await tx`delete from "user" where id in ${tx(userIds)}`;
    }
    if (portalIds.length > 0) {
      await tx`delete from audit_log where actor_id in ${tx(portalIds)}`;
      await tx`delete from deletion_request where subject_id in ${tx(portalIds)}`;
      await tx`delete from consent_log where subject_id in ${tx(portalIds)}`;
      await tx`delete from portal_user where id in ${tx(portalIds)}`;
    }
  });
  await cleanUpPortal(owner);
  await cleanUpBilling(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("DELETE /api/me", () => {
  it("exige sessão, origem do app, corpo válido e a senha certa", async () => {
    const user = await newUser();

    expect((await del("/api/me", undefined, { password: PASSWORD })).status).toBe(401);
    expect(
      (
        await call("DELETE", "/api/me", {
          cookie: user.cookie,
          origin: "https://evil.example",
          body: { password: PASSWORD },
        })
      ).status,
    ).toBe(403);
    expect((await del("/api/me", user.cookie, {})).status).toBe(400);

    const wrong = await del("/api/me", user.cookie, { password: "errada-errada-1" });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(await requestOf(user.id)).toBeUndefined();
  });

  it("recusa o último proprietário de uma organização e conta da plataforma", async () => {
    const user = await newUser();
    const tenant = await newTenant(user, "Dona Única");

    const refused = await del("/api/me", user.cookie, { password: PASSWORD });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code: string; error: string };
    expect(body.code).toBe("LAST_OWNER");
    expect(body.error).toContain("Dona Única");
    expect(await requestOf(user.id)).toBeUndefined();

    // Com outro proprietário, a recusa some.
    const partner = await newUser();
    await addMember(owner, tenant.id, partner, "owner");
    expect((await del("/api/me", user.cookie, { password: PASSWORD })).status).toBe(200);

    const staff = await makePlatformUser(owner, "platform_owner");
    userIds.push(staff.id);
    const platform = await del("/api/me", staff.cookie, { password: PASSWORD });
    expect(platform.status).toBe(403);
    expect(await platform.json()).toMatchObject({ code: "PLATFORM_ACCOUNT" });
  });

  it("agenda 30 dias, avisa por e-mail, encerra as outras sessões e é idempotente", async () => {
    const user = await newUser();
    const other = await signIn(user.email);
    expect((await call("GET", "/api/me", { cookie: other })).status).toBe(200);

    const response = await del("/api/me", user.cookie, { password: PASSWORD });
    expect(response.status).toBe(200);
    const { scheduledFor } = (await response.json()) as { scheduledFor: string };

    const days = (new Date(scheduledFor).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const request = await requestOf(user.id);
    expect(request).toMatchObject({ status: "pending", tenant_id: null });

    // A sessão que pediu continua; a outra caiu.
    expect((await call("GET", "/api/me", { cookie: user.cookie })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: other })).status).toBe(401);

    const message = mail.sent.filter(({ to }) => to === user.email).at(-1);
    expect(message?.subject).toMatch(/exclusão/i);
    expect(message?.text).toContain("/app/configuracoes/privacidade");

    const audited = await asPlatform(
      owner,
      (tx) => tx<{ action: string }[]>`
        select action from audit_log where actor_id = ${user.id} and action = 'lgpd.deletion_requested'
      `,
    );
    expect(audited).toHaveLength(1);

    // Pedir de novo devolve o mesmo agendamento, sem segundo pedido nem segundo e-mail.
    const again = await del("/api/me", user.cookie, { password: PASSWORD });
    expect(((await again.json()) as { scheduledFor: string }).scheduledFor).toBe(scheduledFor);
    expect(await countOf("deletion_request", "subject_id", user.id)).toBe(1);

    const status = await call("GET", "/api/me/deletion", { cookie: user.cookie });
    expect(((await status.json()) as { account: string | null }).account).toBe(scheduledFor);
  });

  it("com 2FA ativo exige também o código", async () => {
    const user = await newUser();
    const setup = await enableTwoFactor(user);

    const noCode = await del("/api/me", user.cookie, { password: PASSWORD });
    expect(noCode.status).toBe(403);
    const badCode = await del("/api/me", user.cookie, { password: PASSWORD, totp: "000000" });
    expect(badCode.status).toBe(403);
    expect(await badCode.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
    const badPassword = await del("/api/me", user.cookie, {
      password: "errada-errada-1",
      totp: totpCode(setup.totpURI),
    });
    expect(badPassword.status).toBe(403);
    expect(await requestOf(user.id)).toBeUndefined();

    const ok = await del("/api/me", user.cookie, {
      password: PASSWORD,
      totp: totpCode(setup.totpURI),
    });
    expect(ok.status).toBe(200);
  });

  it("limita as tentativas de senha por usuário", async () => {
    const user = await newUser();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await del("/api/me", user.cookie, { password: "errada-errada-1" })).status);
    }

    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("cancelar a exclusão da conta", () => {
  it("desfaz dentro da carência e o job não executa mais nada", async () => {
    const user = await newUser();
    await del("/api/me", user.cookie, { password: PASSWORD });
    const request = await requestOf(user.id);

    expect((await call("POST", "/api/me/deletion/cancel", { cookie: user.cookie })).status).toBe(
      200,
    );
    expect((await requestOf(user.id))?.status).toBe("canceled");
    expect(
      ((await (await call("GET", "/api/me/deletion", { cookie: user.cookie })).json()) as {
        account: string | null;
      }).account,
    ).toBeNull();

    // Sem pedido em aberto, não há o que cancelar.
    expect((await call("POST", "/api/me/deletion/cancel", { cookie: user.cookie })).status).toBe(
      404,
    );

    await makeDue(request?.id ?? "");
    expect(await executeDeletion(request?.id ?? "")).toBe("skipped");
    const [row] = await owner<{ email: string }[]>`select email from "user" where id = ${user.id}`;
    expect(row?.email).toBe(user.email);

    // Pode pedir de novo depois de cancelar.
    expect((await del("/api/me", user.cookie, { password: PASSWORD })).status).toBe(200);
  });
});

describe("bordas da carência e da propriedade", () => {
  it("cancela mesmo depois do prazo, enquanto o job ainda não executou", async () => {
    const user = await newUser();
    await del("/api/me", user.cookie, { password: PASSWORD });
    const request = await requestOf(user.id);
    await makeDue(request?.id ?? "");

    expect((await call("POST", "/api/me/deletion/cancel", { cookie: user.cookie })).status).toBe(
      200,
    );
    expect(await executeDeletion(request?.id ?? "")).toBe("skipped");
    const [row] = await owner<{ email: string }[]>`select email from "user" where id = ${user.id}`;
    expect(row?.email).toBe(user.email);
  });

  it("o único proprietário de uma organização suspensa também não exclui a conta", async () => {
    const user = await newUser();
    const tenant = await newTenant(user, "Suspensa Sem Dono");
    await owner`update organization set status = 'suspended', access_mode = 'locked' where id = ${tenant.id}`;

    const refused = await del("/api/me", user.cookie, { password: PASSWORD });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "LAST_OWNER" });
  });
});

describe("job lgpd.delete: conta de equipe", () => {
  it("anonimiza, remove sessões, 2FA, vínculos e exportações, e mantém a auditoria", async () => {
    const user = await newUser();
    const partner = await newUser();
    const tenant = await newTenant(partner, "Mantida Ltda");
    await addMember(owner, tenant.id, user, "member");
    await call("POST", "/api/me/export", { cookie: user.cookie });
    const exportRow = await asPlatform(
      owner,
      (tx) => tx<{ id: string }[]>`select id from data_export where subject_id = ${user.id}`,
    );
    await processExport(exportRow[0]?.id ?? "");
    expect(await readdir(path.join(storageDir, "exports"))).toHaveLength(1);

    const auditBefore = await countOf("audit_log", "actor_id", user.id);
    expect(auditBefore).toBeGreaterThan(0);

    await del("/api/me", user.cookie, { password: PASSWORD });
    const request = await requestOf(user.id);
    await makeDue(request?.id ?? "");

    const result = await executeDueDeletions();
    expect(result.executed).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    const [row] = await owner<{ email: string; name: string; email_verified: boolean }[]>`
      select email, name, email_verified from "user" where id = ${user.id}
    `;
    expect(row).toMatchObject({
      email: `deleted+${user.id}@invalid`,
      name: "Usuário removido",
      email_verified: false,
    });
    expect(JSON.stringify(row)).not.toContain(user.email);

    for (const [table, column] of [
      ["account", "user_id"],
      ["session", "user_id"],
      ["two_factor", "user_id"],
      ["member", "user_id"],
      ["data_export", "subject_id"],
    ] as const) {
      expect(await countOf(table, column, user.id), table).toBe(0);
    }

    // Auditoria e a organização do parceiro continuam.
    expect(await countOf("audit_log", "actor_id", user.id)).toBeGreaterThanOrEqual(auditBefore);
    expect(await countOf("member", "organization_id", tenant.id)).toBe(1);
    const [executed] = await asPlatform(
      owner,
      (tx) => tx<{ id: string }[]>`
        select id from audit_log where action = 'lgpd.deletion_executed' and target_id = ${user.id}
      `,
    );
    expect(executed).toBeDefined();
    expect((await requestOf(user.id))?.status).toBe("executed");

    // O arquivo da exportação saiu do armazenamento.
    expect(await readdir(path.join(storageDir, "exports"))).toHaveLength(0);

    // Não entra mais, nem pela sessão antiga nem pela senha.
    expect((await call("GET", "/api/me", { cookie: user.cookie })).status).toBe(401);
    const login = await call("POST", "/api/auth/sign-in/email", {
      body: { email: user.email, password: PASSWORD },
    });
    expect(login.status).not.toBe(200);
  });

  it("é idempotente: executar de novo não altera nada", async () => {
    const user = await newUser();
    await del("/api/me", user.cookie, { password: PASSWORD });
    const request = await requestOf(user.id);
    await makeDue(request?.id ?? "");

    expect(await executeDeletion(request?.id ?? "")).toBe("executed");
    const snapshot = await owner`select * from "user" where id = ${user.id}`;

    expect(await executeDeletion(request?.id ?? "")).toBe("skipped");
    expect(await executeDueDeletions()).toMatchObject({ errors: 0 });
    expect(await owner`select * from "user" where id = ${user.id}`).toEqual(snapshot);
    expect(
      await asPlatform(
        owner,
        (tx) => tx`select id from audit_log where action = 'lgpd.deletion_executed' and target_id = ${user.id}`,
      ),
    ).toHaveLength(1);
  });

  it("não executa antes do fim da carência", async () => {
    const user = await newUser();
    await del("/api/me", user.cookie, { password: PASSWORD });
    const request = await requestOf(user.id);

    expect(await executeDeletion(request?.id ?? "")).toBe("skipped");
    const [row] = await owner<{ email: string }[]>`select email from "user" where id = ${user.id}`;
    expect(row?.email).toBe(user.email);
  });

  it("recusa executar se a pessoa virou a última proprietária durante a carência", async () => {
    const user = await newUser();
    const partner = await newUser();
    const tenant = await newTenant(user, "Virou Única");
    await addMember(owner, tenant.id, partner, "owner");

    await del("/api/me", user.cookie, { password: PASSWORD });
    const request = await requestOf(user.id);
    await owner`delete from member where organization_id = ${tenant.id} and user_id = ${partner.id}`;
    await makeDue(request?.id ?? "");

    expect(await executeDeletion(request?.id ?? "")).toBe("failed");
    const [row] = await owner<{ email: string }[]>`select email from "user" where id = ${user.id}`;
    expect(row?.email).toBe(user.email);
    expect((await requestOf(user.id))?.status).toBe("failed");
  });
});

describe("exclusão da conta do portal", () => {
  async function portalCustomer() {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, "Portal Exclui");
    const email = customerEmail();
    const record = await createCustomer(tenantOwner, { email, name: "Cliente Sai" });
    const cookie = await inviteAndEnter(tenantOwner, mail, record.id, email);
    const [person] = await owner<{ id: string }[]>`select id from portal_user where email = ${email}`;
    portalIds.push(person?.id ?? "");

    return { tenantOwner, tenant, email, record, cookie, portalId: person?.id ?? "" };
  }

  it("sem senha: manda link de confirmação, consumido só no clique e uma única vez", async () => {
    const { email, cookie, portalId, record, tenantOwner } = await portalCustomer();

    expect((await del("/api/portal/me", tenantOwner.cookie, {})).status).toBe(401);

    const asked = await del("/api/portal/me", cookie, {});
    expect(asked.status).toBe(202);
    expect(await asked.json()).toEqual({ confirmationSent: true });
    expect(await requestOf(portalId)).toBeUndefined();

    const message = mail.sent.filter(({ to }) => to === email).at(-1);
    const token = message?.text.match(/confirmar-exclusao=([^&\s"]+)/)?.[1];
    expect(token).toBeDefined();

    // O link só abre uma página: nenhum GET na API o consome.
    expect((await call("GET", `/api/portal/me/deletion/confirm?token=${token}`, { cookie })).status).toBe(
      404,
    );
    expect(await requestOf(portalId)).toBeUndefined();

    // Com a sessão de outra pessoa o token não serve (e é descartado).
    const stranger = await portalCustomer();
    const wrongPerson = await call("POST", "/api/portal/me/deletion/confirm", {
      cookie: stranger.cookie,
      body: { token },
    });
    expect(wrongPerson.status).toBe(400);

    const again = await call("POST", "/api/portal/me/deletion/confirm", {
      cookie,
      body: { token },
    });
    expect(again.status).toBe(400);

    // Novo pedido, novo link: agora confirma.
    await del("/api/portal/me", cookie, {});
    const next = mail.sent.filter(({ to }) => to === email).at(-1)?.text.match(/confirmar-exclusao=([^&\s"]+)/)?.[1];
    const confirmed = await call("POST", "/api/portal/me/deletion/confirm", {
      cookie,
      body: { token: next },
    });
    expect(confirmed.status).toBe(200);
    expect((await requestOf(portalId))?.status).toBe("pending");

    const reuse = await call("POST", "/api/portal/me/deletion/confirm", {
      cookie,
      body: { token: next },
    });
    expect(reuse.status).toBe(400);

    // O job anonimiza a pessoa e o cadastro dela na organização (campos adicionais inclusive).
    await asPlatform(
      owner,
      (tx) => tx`update customer set custom_fields = '{"x": "valor pessoal"}'::jsonb where id = ${record.id}`,
    );
    const request = await requestOf(portalId);
    await makeDue(request?.id ?? "");
    expect(await executeDeletion(request?.id ?? "")).toBe("executed");

    const [person] = await owner<{ email: string; name: string }[]>`
      select email, name from portal_user where id = ${portalId}
    `;
    expect(person).toEqual({ email: `deleted+${portalId}@invalid`, name: "Usuário removido" });
    const [customerRow] = await asPlatform(
      owner,
      (tx) => tx<
        { name: string; email: string; status: string; portal_user_id: string | null }[]
      >`select name, email, status, portal_user_id from customer where id = ${record.id}`,
    );
    expect(customerRow).toEqual({
      name: "Cliente removido",
      email: `deleted+${record.id}@invalid`,
      status: "blocked",
      portal_user_id: null,
    });
    const [anonymizedFields] = await asPlatform(
      owner,
      (tx) => tx<{ custom_fields: unknown }[]>`select custom_fields from customer where id = ${record.id}`,
    );
    expect(anonymizedFields?.custom_fields).toEqual({});
    expect(await countOf("portal_session", "user_id", portalId)).toBe(0);
    expect(await countOf("portal_account", "user_id", portalId)).toBe(0);
  });

  it("com senha: confirma a senha e agenda na hora; cancela dentro da carência", async () => {
    const { cookie, portalId } = await portalCustomer();

    const set = await call("POST", "/api/portal/auth-ext/set-password", {
      cookie,
      body: { newPassword: "senha-do-portal-123" },
    });
    expect(set.status).toBe(200);

    const wrong = await del("/api/portal/me", cookie, { password: "errada-errada-1" });
    expect(wrong.status).toBe(403);
    expect((await del("/api/portal/me", cookie, {})).status).toBe(403);
    expect(await requestOf(portalId)).toBeUndefined();

    const ok = await del("/api/portal/me", cookie, { password: "senha-do-portal-123" });
    expect(ok.status).toBe(200);
    expect((await requestOf(portalId))?.status).toBe("pending");

    const listed = await call("GET", "/api/portal/me/deletion", { cookie });
    expect(((await listed.json()) as { account: string | null }).account).not.toBeNull();

    expect((await call("POST", "/api/portal/me/deletion/cancel", { cookie })).status).toBe(200);
    expect((await requestOf(portalId))?.status).toBe("canceled");
    expect((await call("POST", "/api/portal/me/deletion/cancel", { cookie })).status).toBe(404);
  });
});

describe("exclusão da organização", () => {
  it("só o proprietário, com senha; encerra a cobrança, suspende e agenda", async () => {
    const stub = createStubProvider();
    setProvidersForTests([stub]);

    const tenantOwner = await newUser();
    const admin = await newUser();
    const tenant = await newTenant(tenantOwner, "Vai Embora Ltda");
    await addMember(owner, tenant.id, admin, "admin");
    await createCustomer(tenantOwner, { name: "Cliente da Org" });
    const paid = await createPlanRow(owner, { isFree: false });
    await ensureSubscription(owner, tenant.id, paid.id);
    await updateSubscription(owner, tenant.id, {
      status: "active",
      provider: STUB_ID,
      provider_subscription_ref: "sub_exclusao_1",
    });

    expect((await del("/api/tenant", admin.cookie, { password: PASSWORD })).status).toBe(403);
    expect((await del("/api/tenant", undefined, { password: PASSWORD })).status).toBe(401);
    const wrong = await del("/api/tenant", tenantOwner.cookie, { password: "errada-errada-1" });
    expect(wrong.status).toBe(403);
    expect(stub.calls.cancelSubscription).toBeUndefined();

    const response = await del("/api/tenant", tenantOwner.cookie, { password: PASSWORD });
    expect(response.status).toBe(200);
    const { scheduledFor } = (await response.json()) as { scheduledFor: string };
    expect((new Date(scheduledFor).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(29.9);

    // A cobrança no provedor foi encerrada agora, e a assinatura local também.
    expect(stub.calls.cancelSubscription?.[0]?.[1]).toBe("sub_exclusao_1");
    expect(stub.calls.cancelSubscription?.[0]?.[2]).toEqual({ atPeriodEnd: false });
    expect((await subscriptionState(owner, tenant.id)).status).toBe("canceled");

    const [org] = await owner<{ status: string; access_mode: string }[]>`
      select status, access_mode from organization where id = ${tenant.id}
    `;
    expect(org).toEqual({ status: "deleting", access_mode: "locked" });
    expect((await requestOf(tenant.id))?.tenant_id).toBe(tenant.id);

    // A organização some para a equipe enquanto aguarda.
    const blocked = await call("GET", "/api/tenant", { cookie: tenantOwner.cookie });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "TENANT_SUSPENDED" });

    const message = mail.sent.filter(({ to }) => to === tenantOwner.email).at(-1);
    expect(message?.text).toContain("Vai Embora Ltda");

    // Só o proprietário desiste; o admin não enxerga o pedido.
    const refused = await call("POST", "/api/tenant/deletion/cancel", {
      cookie: admin.cookie,
      body: { tenantId: tenant.id },
    });
    expect(refused.status).toBe(404);

    const status = await call("GET", "/api/me/deletion", { cookie: tenantOwner.cookie });
    const listed = (await status.json()) as { tenants: Array<{ tenantId: string }> };
    expect(listed.tenants.map(({ tenantId }) => tenantId)).toEqual([tenant.id]);

    const canceled = await call("POST", "/api/tenant/deletion/cancel", {
      cookie: tenantOwner.cookie,
      body: { tenantId: tenant.id },
    });
    expect(canceled.status).toBe(200);

    // De volta, mas sem a cobrança que foi encerrada: somente leitura até contratar de novo.
    const [back] = await owner<{ status: string; access_mode: string }[]>`
      select status, access_mode from organization where id = ${tenant.id}
    `;
    expect(back).toEqual({ status: "active", access_mode: "read_only" });
    expect((await call("GET", "/api/tenant", { cookie: tenantOwner.cookie })).status).toBe(200);
  });

  it("vale mesmo em somente leitura e bloqueada por cobrança, mas não suspensa pela plataforma", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, "Sem Pagar Ltda");

    for (const mode of ["read_only", "locked"]) {
      await owner`update organization set access_mode = ${mode} where id = ${tenant.id}`;
      const response = await del("/api/tenant", tenantOwner.cookie, { password: PASSWORD });
      expect(response.status, mode).toBe(200);

      await call("POST", "/api/tenant/deletion/cancel", {
        cookie: tenantOwner.cookie,
        body: { tenantId: tenant.id },
      });
    }

    await owner`update organization set status = 'suspended', access_mode = 'locked' where id = ${tenant.id}`;
    expect((await del("/api/tenant", tenantOwner.cookie, { password: PASSWORD })).status).toBe(403);
  });

  it("o job anonimiza a organização e mantém fatura, assinatura e auditoria", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, "Apagar Ltda");
    const record = await createCustomer(tenantOwner, { name: "Cliente Apagado" });
    const plan = await createPlanRow(owner, { isFree: true });
    await ensureSubscription(owner, tenant.id, plan.id);
    const stored = await uploadFile({
      tenantId: tenant.id,
      userId: tenantOwner.id,
      name: "contrato.txt",
      mime: "text/plain",
      content: Buffer.from("conteúdo"),
    });
    await asPlatform(
      owner,
      (tx) => tx`
        insert into billing_profile (tenant_id, legal_name, document, document_type, email)
        values (${tenant.id}, 'Apagar Ltda ME', '12345678000190', 'cnpj', 'financeiro@apagar.test')
      `,
    );
    await asPlatform(
      owner,
      (tx) => tx`
        insert into invoice (tenant_id, subscription_id, provider, provider_ref, amount_cents, currency, status)
        select ${tenant.id}, id, 'pagarme', ${`in_${tenant.id}`}, 9900, 'BRL', 'paid'
        from subscription where tenant_id = ${tenant.id}
      `,
    );
    expect(await readdir(path.join(storageDir, "tenants", tenant.id))).toHaveLength(1);

    await del("/api/tenant", tenantOwner.cookie, { password: PASSWORD });
    const request = await requestOf(tenant.id);
    await makeDue(request?.id ?? "");
    expect(await executeDeletion(request?.id ?? "")).toBe("executed");

    const [org] = await owner<{ name: string; slug: string; status: string }[]>`
      select name, slug, status from organization where id = ${tenant.id}
    `;
    expect(org).toEqual({
      name: "Organização removida",
      slug: `removida-${tenant.id}`,
      status: "deleted",
    });
    expect(await countOf("member", "organization_id", tenant.id)).toBe(0);

    const [customerRow] = await asPlatform(
      owner,
      (tx) => tx<{ name: string; email: string; status: string }[]>`
        select name, email, status from customer where id = ${record.id}
      `,
    );
    expect(customerRow).toEqual({
      name: "Cliente removido",
      email: `deleted+${record.id}@invalid`,
      status: "blocked",
    });

    const [profile] = await asPlatform(
      owner,
      (tx) => tx<{ legal_name: string; document: string; email: string }[]>`
        select legal_name, document, email from billing_profile where tenant_id = ${tenant.id}
      `,
    );
    expect(profile).toEqual({
      legal_name: "Organização removida",
      document: "",
      email: "removido@invalid",
    });

    // Fatura (obrigação fiscal), assinatura e auditoria seguem.
    expect(await countOf("invoice", "tenant_id", tenant.id)).toBe(1);
    expect(await countOf("subscription", "tenant_id", tenant.id)).toBe(1);
    expect(await countOf("audit_log", "tenant_id", tenant.id)).toBeGreaterThan(0);

    // O arquivo saiu do armazenamento e do banco.
    expect(await countOf("file", "tenant_id", tenant.id)).toBe(0);
    expect(await readdir(path.join(storageDir, "tenants", tenant.id))).toHaveLength(0);
    expect(stored.key).toContain(tenant.id);

    // O proprietário não entra mais na organização.
    expect((await call("GET", "/api/tenant", { cookie: tenantOwner.cookie })).status).toBe(403);
    expect(await executeDeletion(request?.id ?? "")).toBe("skipped");
  });
});

