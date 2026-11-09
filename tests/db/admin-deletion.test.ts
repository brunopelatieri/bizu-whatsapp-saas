import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerQueues } from "@/jobs";
import { getBoss } from "@/jobs/boss";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider, type MemoryEmailProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { setProvidersForTests } from "@/lib/payments/registry";
import { setStorageForTests } from "@/lib/storage";
import { createLocalProvider } from "@/lib/storage/providers/local";
import {
  asPlatform,
  bodyOf,
  cleanUpBilling,
  createPlanRow,
  createStubProvider,
  ensureSubscription,
  makePlatformUser,
  STUB_ID,
  subscriptionState,
  updateSubscription,
} from "./billing-helpers";
import {
  cleanUpPortal,
  createCustomer,
  inviteAndEnter,
} from "./portal-helpers";
import { applyCookies, PASSWORD } from "./security-helpers";
import {
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * Exclusões e edição de pessoas pelo `/admin` (`docs/specs/admin-crud/spec.md`, etapas 4 a 7):
 * agendada ou imediata, confirmação no servidor, cancelamento só pelo lado que pediu,
 * `platform_owner` protegido e a troca de e-mail que desfaz o acesso não provado.
 */

let owner: postgres.Sql;
let mail: MemoryEmailProvider;
let storageDir: string;
let platformOwner: TestUser;
let support: TestUser;

/** Contas e organizações anonimizadas escapam do padrão de e-mail de `cleanUp`. */
const userIds: string[] = [];
const tenantIds: string[] = [];
const portalIds: string[] = [];

async function newUser() {
  const user = await createUser(owner);
  userIds.push(user.id);
  return user;
}

async function newTenant(user: TestUser, name = "Clínica Admin C") {
  const tenant = await createTenant(user, name);
  tenantIds.push(tenant.id);
  return tenant;
}

const send = (user: TestUser | undefined, method: string, pathname: string, body?: unknown) =>
  call(method, pathname, { cookie: user?.cookie, body });

type RequestRow = {
  id: string;
  status: string;
  origin: string;
  metadata: Record<string, unknown>;
  scheduled_for: Date;
};

async function requestOf(subjectId: string) {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<RequestRow[]>`
      select id, status, origin, metadata, scheduled_for from deletion_request
      where subject_id = ${subjectId} order by created_at desc limit 1
    `,
  );
  return row;
}

async function orgOf(tenantId: string) {
  const [row] = await owner<{ name: string; status: string; access_mode: string }[]>`
    select name, status, access_mode from organization where id = ${tenantId}
  `;
  return row;
}

async function userRow(id: string) {
  const [row] = await owner<
    { email: string; role: string; banned: boolean; email_verified: boolean; name: string }[]
  >`select email, role, banned, email_verified, name from "user" where id = ${id}`;
  return row;
}

const sessionsOf = async (table: string, userId: string) => {
  const [row] = await owner<{ total: number }[]>`
    select count(*)::int as total from ${owner(table)} where user_id = ${userId}
  `;
  return row?.total ?? 0;
};

async function templatesSentTo(to: string) {
  await waitForBackgroundTasks();
  // O cadastro de teste ainda manda a verificação em segundo plano: não é deste fluxo.
  return mail.sent
    .filter((m) => m.to === to && m.tags?.template !== "verify-email")
    .map((m) => m.tags?.template);
}

async function auditCount(action: string, targetId: string) {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<{ total: number; mode: string | null }[]>`
      select count(*)::int as total, max(metadata->>'mode') as mode from audit_log
      where action = ${action} and target_id = ${targetId}
    `,
  );
  return row;
}

async function signInStatus(email: string, password = PASSWORD) {
  return (await call("POST", "/api/auth/sign-in/email", { body: { email, password } })).status;
}

beforeAll(async () => {
  await registerQueues(await getBoss());
  mail = createMemoryProvider();
  setEmailProviderForTests(mail);
  owner = connectOwner();
  storageDir = await mkdtemp(path.join(os.tmpdir(), "bizu-admin-c-"));
  setStorageForTests(createLocalProvider(storageDir));

  platformOwner = await makePlatformUser(owner, "platform_owner");
  support = await makePlatformUser(owner, "platform_support");
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
      await tx`delete from deletion_request where subject_id in ${tx(tenantIds)}`;
      await tx`delete from organization where id in ${tx(tenantIds)}`;
    }
    if (userIds.length > 0) {
      await tx`delete from audit_log where actor_id in ${tx(userIds)} or target_id in ${tx(userIds)}`;
      await tx`delete from deletion_request where subject_id in ${tx(userIds)}`;
      await tx`delete from consent_log where subject_id in ${tx(userIds)}`;
      await tx`delete from "user" where id in ${tx(userIds)}`;
    }
    if (portalIds.length > 0) {
      await tx`delete from audit_log where target_id in ${tx(portalIds)}`;
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

beforeEach(() => {
  mail.reset();
  setProvidersForTests(undefined);
});

describe("acesso às rotas novas", () => {
  const anyId = randomUUID();
  const writes = [
    ["DELETE", `/api/admin/tenants/${anyId}`, { mode: "scheduled", confirm: "x" }],
    ["POST", `/api/admin/tenants/${anyId}/deletion/cancel`, undefined],
    ["PATCH", `/api/admin/users/${anyId}`, { name: "Novo Nome" }],
    ["POST", `/api/admin/users/${anyId}/revoke-sessions`, undefined],
    ["DELETE", `/api/admin/users/${anyId}`, { mode: "scheduled", confirm: "x" }],
    ["POST", `/api/admin/users/${anyId}/deletion/cancel`, undefined],
    ["PATCH", `/api/admin/portal-users/${anyId}`, { name: "Novo Nome" }],
    ["DELETE", `/api/admin/portal-users/${anyId}`, { mode: "scheduled", confirm: "x" }],
    ["POST", `/api/admin/portal-users/${anyId}/deletion/cancel`, undefined],
  ] as const;

  it.each(writes)("suporte não escreve: %s %s responde 403", async (method, pathname, body) => {
    const response = await send(support, method, pathname, body);

    expect(response.status).toBe(403);
    expect((await bodyOf(response)).code).toBe("PLATFORM_FORBIDDEN");
  });

  it.each(writes)("sem sessão: %s %s responde 401", async (method, pathname, body) => {
    expect((await send(undefined, method, pathname, body)).status).toBe(401);
  });

  it("suporte lê os detalhes; id inexistente é 404", async () => {
    const person = await newUser();

    expect((await send(support, "GET", `/api/admin/users/${person.id}`)).status).toBe(200);
    expect((await send(support, "GET", `/api/admin/users/${anyId}`)).status).toBe(404);
    expect((await send(support, "GET", `/api/admin/portal-users/${anyId}`)).status).toBe(404);
    expect((await send(support, "GET", `/api/admin/tenants/${anyId}/deletion`)).status).toBe(200);
  });

  it("sessão personificada recebe 403 nas rotas novas", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner);
    const grant = await send(tenantOwner, "POST", "/api/tenant/support-grant", { hours: 1 });
    expect(grant.status).toBe(201);

    const entered = await call("POST", "/api/admin/impersonate", {
      cookie: platformOwner.cookie,
      body: { userId: tenantOwner.id, tenantId: tenant.id },
    });
    expect(entered.status).toBe(200);
    const cookie = applyCookies(platformOwner.cookie, entered);

    const response = await call("DELETE", `/api/admin/tenants/${tenant.id}`, {
      cookie,
      body: { mode: "now", confirm: tenant.slug },
    });
    expect(response.status).toBe(403);
    expect((await orgOf(tenant.id))?.status).toBe("active");
    expect(
      (await call("GET", `/api/admin/users/${tenantOwner.id}`, { cookie })).status,
    ).toBe(403);
  });
});

describe("regra comum da exclusão", () => {
  it("confirmação conferida no servidor e corpo validado", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner);

    const wrong = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "now",
      confirm: "outro-slug",
    });
    expect(wrong.status).toBe(400);
    expect((await bodyOf(wrong)).code).toBe("CONFIRMATION_MISMATCH");

    const noMode = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      confirm: tenant.slug,
    });
    expect(noMode.status).toBe(400);

    const userWrong = await send(platformOwner, "DELETE", `/api/admin/users/${tenantOwner.id}`, {
      mode: "scheduled",
      confirm: "outra@pessoa.local",
    });
    expect(userWrong.status).toBe(400);

    expect(await requestOf(tenant.id)).toBeUndefined();
    expect(await requestOf(tenantOwner.id)).toBeUndefined();
    expect((await orgOf(tenant.id))?.status).toBe("active");
  });

  it("pedido da própria pessoa é `self`: a plataforma não cancela, mas pode antecipar", async () => {
    const person = await newUser();

    const asked = await send(person, "DELETE", "/api/me", { password: PASSWORD });
    expect(asked.status).toBe(200);
    expect(await requestOf(person.id)).toMatchObject({ origin: "self", metadata: {} });

    const cancel = await send(platformOwner, "POST", `/api/admin/users/${person.id}/deletion/cancel`);
    expect(cancel.status).toBe(409);
    expect((await bodyOf(cancel)).code).toBe("DELETION_NOT_PLATFORM");

    const again = await send(platformOwner, "DELETE", `/api/admin/users/${person.id}`, {
      mode: "scheduled",
      confirm: person.email,
    });
    expect(again.status).toBe(409);
    expect((await bodyOf(again)).code).toBe("DELETION_PENDING");

    // `now` antecipa o pedido existente e executa a mesma anonimização do job.
    const now = await send(platformOwner, "DELETE", `/api/admin/users/${person.id}`, {
      mode: "now",
      confirm: person.email.toUpperCase(),
    });
    expect(now.status).toBe(200);
    expect(await requestOf(person.id)).toMatchObject({ status: "executed", origin: "self" });
    expect((await userRow(person.id))?.email).toBe(`deleted+${person.id}@invalid`);
    expect(await templatesSentTo(person.email)).toContain("deletion-executed");
    expect((await auditCount("admin.user_deletion_executed", person.id))?.mode).toBe("now");
  });
});

describe("organização", () => {
  async function paidTenant(name: string) {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, name);
    const paid = await createPlanRow(owner, { isFree: false });
    await ensureSubscription(owner, tenant.id, paid.id);
    await updateSubscription(owner, tenant.id, {
      status: "active",
      provider: STUB_ID,
      provider_subscription_ref: `sub_${randomUUID().slice(0, 8)}`,
    });
    return { tenantOwner, tenant };
  }

  it("provedor falha: nada é agendado (409 PROVIDER_CANCEL_FAILED)", async () => {
    setProvidersForTests([
      createStubProvider({
        async cancelSubscription() {
          throw new Error("provedor fora do ar");
        },
      }),
    ]);
    const { tenant } = await paidTenant("Provedor Falha");

    const response = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "scheduled",
      confirm: tenant.slug,
    });

    expect(response.status).toBe(409);
    expect((await bodyOf(response)).code).toBe("PROVIDER_CANCEL_FAILED");
    expect(await requestOf(tenant.id)).toBeUndefined();
    expect(await orgOf(tenant.id)).toMatchObject({ status: "active", access_mode: "full" });
    expect((await subscriptionState(owner, tenant.id)).status).toBe("active");
  });

  it("agenda: encerra no provedor, trava, avisa e o owner não cancela o pedido da plataforma", async () => {
    const stub = createStubProvider();
    setProvidersForTests([stub]);
    const { tenantOwner, tenant } = await paidTenant("Agendada Pela Plataforma");

    const response = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "scheduled",
      confirm: tenant.slug,
      reason: "Pedido por contrato",
    });
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.mode).toBe("scheduled");
    expect((new Date(body.scheduledFor as string).getTime() - Date.now()) / 86_400_000).toBeGreaterThan(29.9);

    expect(stub.calls.cancelSubscription).toHaveLength(1);
    expect((await subscriptionState(owner, tenant.id)).status).toBe("canceled");
    expect(await orgOf(tenant.id)).toMatchObject({ status: "deleting", access_mode: "locked" });
    expect(await requestOf(tenant.id)).toMatchObject({
      status: "pending",
      origin: "platform",
      metadata: { reason: "Pedido por contrato", previousStatus: "active" },
    });
    expect(await templatesSentTo(tenantOwner.email)).toContain("deletion-scheduled");
    expect(mail.sent.at(-1)?.text).toContain("administração");
    expect((await auditCount("admin.tenant_deletion_requested", tenant.id))?.mode).toBe("scheduled");

    const detail = await bodyOf(await send(support, "GET", `/api/admin/tenants/${tenant.id}/deletion`));
    expect(detail.deletion).toMatchObject({ origin: "platform" });

    const twice = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "scheduled",
      confirm: tenant.slug,
    });
    expect((await bodyOf(twice)).code).toBe("DELETION_PENDING");

    // A tela de privacidade do owner sabe que o pedido não é dele.
    const privacy = await bodyOf(await send(tenantOwner, "GET", "/api/me/deletion"));
    expect(privacy.tenants).toEqual([
      expect.objectContaining({ tenantId: tenant.id, origin: "platform" }),
    ]);

    const byOwner = await send(tenantOwner, "POST", "/api/tenant/deletion/cancel", {
      tenantId: tenant.id,
    });
    expect(byOwner.status).toBe(409);
    expect((await bodyOf(byOwner)).code).toBe("DELETION_BY_PLATFORM");

    const canceled = await send(platformOwner, "POST", `/api/admin/tenants/${tenant.id}/deletion/cancel`);
    expect(canceled.status).toBe(200);
    // A assinatura foi encerrada: a organização volta em somente leitura.
    expect(await orgOf(tenant.id)).toMatchObject({ status: "active", access_mode: "read_only" });
    expect(await requestOf(tenant.id)).toMatchObject({ status: "canceled" });

    const none = await send(platformOwner, "POST", `/api/admin/tenants/${tenant.id}/deletion/cancel`);
    expect(none.status).toBe(409);
    expect((await bodyOf(none)).code).toBe("NO_PENDING_DELETION");
  });

  it("a plataforma não cancela o pedido do owner", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, "Pedido do Owner");

    expect((await send(tenantOwner, "DELETE", "/api/tenant", { password: PASSWORD })).status).toBe(200);

    const response = await send(platformOwner, "POST", `/api/admin/tenants/${tenant.id}/deletion/cancel`);
    expect(response.status).toBe(409);
    expect((await bodyOf(response)).code).toBe("DELETION_NOT_PLATFORM");
    expect(await requestOf(tenant.id)).toMatchObject({ status: "pending", origin: "self" });
  });

  it("aceita organização suspensa, e cancelar devolve a suspensão", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, "Suspensa Excluída");
    expect((await send(platformOwner, "POST", `/api/admin/tenants/${tenant.id}/suspend`, {})).status).toBe(200);

    const response = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "scheduled",
      confirm: tenant.slug,
    });
    expect(response.status).toBe(200);
    expect(await requestOf(tenant.id)).toMatchObject({ metadata: { previousStatus: "suspended" } });

    expect((await send(platformOwner, "POST", `/api/admin/tenants/${tenant.id}/deletion/cancel`)).status).toBe(200);
    expect(await orgOf(tenant.id)).toMatchObject({ status: "suspended", access_mode: "locked" });
  });

  it("agora: anonimiza na hora, avisa os owners e não tem volta", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, "Excluída Agora");

    const response = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "now",
      confirm: tenant.slug,
    });
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).mode).toBe("now");

    expect(await orgOf(tenant.id)).toMatchObject({ name: "Organização removida", status: "deleted" });
    expect(await requestOf(tenant.id)).toMatchObject({ status: "executed", origin: "platform" });
    expect(await templatesSentTo(tenantOwner.email)).toEqual(["deletion-executed"]);
    expect((await auditCount("admin.tenant_deletion_executed", tenant.id))?.total).toBe(1);

    const again = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "now",
      confirm: `removida-${tenant.id}`,
    });
    expect(again.status).toBe(404);
  });
});

describe("usuários de equipe e suporte", () => {
  it("platform_owner é protegido e ninguém age sobre si mesmo", async () => {
    const otherOwner = await makePlatformUser(owner, "platform_owner");

    for (const [method, suffix, body] of [
      ["PATCH", "", { name: "Outro Nome" }],
      ["POST", "/revoke-sessions", undefined],
      ["DELETE", "", { mode: "now", confirm: otherOwner.email }],
    ] as const) {
      const response = await send(platformOwner, method, `/api/admin/users/${otherOwner.id}${suffix}`, body);
      expect(response.status, `${method} ${suffix}`).toBe(403);
      expect((await bodyOf(response)).code).toBe("PLATFORM_OWNER_PROTECTED");

      const self = await send(platformOwner, method, `/api/admin/users/${platformOwner.id}${suffix}`, {
        ...body,
        ...(method === "DELETE" ? { confirm: platformOwner.email } : {}),
      });
      expect(self.status, `self ${method} ${suffix}`).toBe(409);
      expect((await bodyOf(self)).code).toBe("SELF_ACTION");
    }

    expect((await userRow(otherOwner.id))?.name).toBe("Pessoa Teste");
  });

  it("detalhe traz organizações com nome, papel, estado e plano", async () => {
    const person = await newUser();
    const tenant = await newTenant(person, "Detalhe Ltda");

    const body = await bodyOf(await send(support, "GET", `/api/admin/users/${person.id}`));

    expect(body.user).toMatchObject({
      id: person.id,
      email: person.email,
      platformRole: "user",
      emailVerified: true,
      banned: false,
    });
    expect((body.user as { sessions: number }).sessions).toBeGreaterThanOrEqual(1);
    expect(body.organizations).toEqual([
      expect.objectContaining({ id: tenant.id, name: "Detalhe Ltda", slug: tenant.slug, role: "owner" }),
    ]);
    expect(body.deletion).toBeNull();
  });

  it("trocar o e-mail desverifica, derruba sessões, avisa o antigo e o reset prova o novo", async () => {
    const person = await newUser();
    const taken = await newUser();

    const conflict = await send(platformOwner, "PATCH", `/api/admin/users/${person.id}`, {
      email: taken.email,
    });
    expect(conflict.status).toBe(409);
    expect((await bodyOf(conflict)).code).toBe("EMAIL_TAKEN");

    const renamed = await send(platformOwner, "PATCH", `/api/admin/users/${person.id}`, {
      name: "Nome Novo",
    });
    expect(renamed.status).toBe(200);
    expect(await userRow(person.id)).toMatchObject({ name: "Nome Novo", email_verified: true });
    expect(await sessionsOf("session", person.id)).toBeGreaterThan(0);

    const newAddress = `novo-${randomUUID()}@tenant-test.bizu.local`;
    const changed = await send(platformOwner, "PATCH", `/api/admin/users/${person.id}`, {
      email: newAddress.toUpperCase(),
    });
    expect(changed.status).toBe(200);
    expect(await userRow(person.id)).toMatchObject({ email: newAddress, email_verified: false });
    expect(await sessionsOf("session", person.id)).toBe(0);
    expect((await send(person, "GET", "/api/me")).status).toBe(401);
    expect(await templatesSentTo(person.email)).toEqual(["email-changed"]);
    expect(await templatesSentTo(newAddress)).toEqual(["reset-password"]);
    expect(mail.sent.find((m) => m.to === person.email)?.text).not.toContain(newAddress);

    const token = mail.sent
      .find((m) => m.to === newAddress)
      ?.text.match(/redefinir-senha\?token=([^\s&"]+)/)?.[1];
    expect(token).toBeDefined();
    const reset = await call("POST", "/api/auth/reset-password", {
      body: { newPassword: "senha-nova-do-admin-1", token: decodeURIComponent(token ?? "") },
    });
    expect(reset.status).toBe(200);
    expect((await userRow(person.id))?.email_verified).toBe(true);
    expect(await signInStatus(newAddress, "senha-nova-do-admin-1")).toBe(200);
  });

  it("conta com e-mail trocado não vira cadastro pendente: cadastro anônimo não a apaga", async () => {
    const person = await newUser();
    const tenant = await newTenant(person, "Não Some Ltda");

    // Link de reset pedido antes, para o endereço antigo.
    await call("POST", "/api/auth-ext/forgot-password", { body: { email: person.email } });
    await waitForBackgroundTasks();
    const oldToken = mail.sent
      .filter((m) => m.to === person.email && m.tags?.template === "reset-password")
      .at(-1)
      ?.text.match(/redefinir-senha\?token=([^\s&"]+)/)?.[1];
    expect(oldToken).toBeDefined();

    const newAddress = `trocado-${randomUUID()}@tenant-test.bizu.local`;
    expect(
      (await send(platformOwner, "PATCH", `/api/admin/users/${person.id}`, { email: newAddress })).status,
    ).toBe(200);

    // A senha antiga saiu, e o link antigo não vale mais.
    const [credential] = await owner<{ total: number }[]>`
      select count(*)::int as total from account where user_id = ${person.id}
    `;
    expect(credential?.total).toBe(0);
    const stale = await call("POST", "/api/auth/reset-password", {
      body: { newPassword: "senha-do-antigo-1", token: decodeURIComponent(oldToken ?? "") },
    });
    expect(stale.status).toBe(400);
    expect((await userRow(person.id))?.email_verified).toBe(false);

    // Mais de 24 h depois, alguém cadastra o endereço novo: a conta continua lá.
    await owner`update "user" set created_at = now() - interval '3 days' where id = ${person.id}`;
    const signup = await call("POST", "/api/auth/sign-up/email", {
      body: {
        name: "Intruso",
        email: newAddress,
        password: "senha-do-intruso-1",
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: "2026-11",
      },
    });
    expect(signup.status).toBe(200);
    expect(await userRow(person.id)).toMatchObject({ email: newAddress, name: "Pessoa Teste" });
    expect((await orgOf(tenant.id))?.status).toBe("active");
    const [members] = await owner<{ total: number }[]>`
      select count(*)::int as total from member where user_id = ${person.id}
    `;
    expect(members?.total).toBe(1);
  });

  it("PATCH sem mudança real responde 400, sem tocar na conta", async () => {
    const person = await newUser();

    const response = await send(platformOwner, "PATCH", `/api/admin/users/${person.id}`, {
      email: person.email,
    });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).code).toBe("NOTHING_TO_CHANGE");
    expect(await userRow(person.id)).toMatchObject({ email_verified: true });
  });

  it("revogar sessões devolve quantas caíram", async () => {
    const person = await newUser();

    const response = await send(platformOwner, "POST", `/api/admin/users/${person.id}/revoke-sessions`);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).revoked).toBeGreaterThanOrEqual(1);
    expect((await send(person, "GET", "/api/me")).status).toBe(401);
    expect((await auditCount("admin.user_sessions_revoked", person.id))?.total).toBe(1);
  });

  it("único owner: 409 LAST_OWNER sem a flag; com ela, agenda as organizações e bane a conta", async () => {
    const person = await newUser();
    const tenant = await newTenant(person, "Dono Único Ltda");

    const refused = await send(platformOwner, "DELETE", `/api/admin/users/${person.id}`, {
      mode: "scheduled",
      confirm: person.email,
    });
    expect(refused.status).toBe(409);
    const refusedBody = await bodyOf(refused);
    expect(refusedBody.code).toBe("LAST_OWNER");
    expect(refusedBody.tenants).toEqual([{ id: tenant.id, name: "Dono Único Ltda" }]);
    expect(await requestOf(person.id)).toBeUndefined();
    expect((await orgOf(tenant.id))?.status).toBe("active");

    const response = await send(platformOwner, "DELETE", `/api/admin/users/${person.id}`, {
      mode: "scheduled",
      confirm: person.email,
      deleteSoleOrganizations: true,
    });
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).tenants).toEqual([{ id: tenant.id, name: "Dono Único Ltda" }]);

    expect(await orgOf(tenant.id)).toMatchObject({ status: "deleting" });
    expect(await requestOf(tenant.id)).toMatchObject({ origin: "platform", status: "pending" });
    expect(await requestOf(person.id)).toMatchObject({
      origin: "platform",
      metadata: { wasBanned: false },
    });
    expect(await userRow(person.id)).toMatchObject({ banned: true });
    expect(await sessionsOf("session", person.id)).toBe(0);
    expect(await signInStatus(person.email)).not.toBe(200);

    // Cancelar a conta desbaneia; a organização tem o próprio cancelamento.
    const canceled = await send(platformOwner, "POST", `/api/admin/users/${person.id}/deletion/cancel`);
    expect(canceled.status).toBe(200);
    expect(await userRow(person.id)).toMatchObject({ banned: false });
    expect(await signInStatus(person.email)).toBe(200);
    expect((await orgOf(tenant.id))?.status).toBe("deleting");
    expect((await auditCount("admin.user_deletion_canceled", person.id))?.total).toBe(1);
  });

  it("com a flag, organização já agendada segue o próprio pedido e a conta é agendada", async () => {
    const person = await newUser();
    const tenant = await newTenant(person, "Já Agendada Ltda");

    const first = await send(platformOwner, "DELETE", `/api/admin/tenants/${tenant.id}`, {
      mode: "scheduled",
      confirm: tenant.slug,
    });
    expect(first.status).toBe(200);
    const tenantRequest = await requestOf(tenant.id);

    const response = await send(platformOwner, "DELETE", `/api/admin/users/${person.id}`, {
      mode: "scheduled",
      confirm: person.email,
      deleteSoleOrganizations: true,
    });
    expect(response.status).toBe(200);

    // O pedido da organização é o mesmo (não houve um segundo), e a conta foi agendada e banida.
    expect(await requestOf(tenant.id)).toMatchObject({ id: tenantRequest?.id, status: "pending" });
    expect(await requestOf(person.id)).toMatchObject({ origin: "platform", status: "pending" });
    expect(await userRow(person.id)).toMatchObject({ banned: true });
  });

  it("quem já estava banido continua banido depois do cancelamento", async () => {
    const person = await newUser();
    expect((await send(platformOwner, "POST", `/api/admin/users/${person.id}/ban`, { reason: "abuso" })).status).toBe(200);

    expect(
      (
        await send(platformOwner, "DELETE", `/api/admin/users/${person.id}`, {
          mode: "scheduled",
          confirm: person.email,
        })
      ).status,
    ).toBe(200);
    expect(await requestOf(person.id)).toMatchObject({ metadata: { wasBanned: true } });

    expect((await send(platformOwner, "POST", `/api/admin/users/${person.id}/deletion/cancel`)).status).toBe(200);
    expect(await userRow(person.id)).toMatchObject({ banned: true });
  });

  it("suporte excluído agora perde o papel de plataforma", async () => {
    const staff = await makePlatformUser(owner, "platform_support");
    userIds.push(staff.id);

    const response = await send(platformOwner, "DELETE", `/api/admin/users/${staff.id}`, {
      mode: "now",
      confirm: staff.email,
    });
    expect(response.status).toBe(200);

    expect(await userRow(staff.id)).toMatchObject({
      email: `deleted+${staff.id}@invalid`,
      role: "user",
    });
    expect(await templatesSentTo(staff.email)).toEqual(["deletion-executed"]);
    expect((await send(platformOwner, "GET", `/api/admin/users/${staff.id}`)).status).toBe(404);

    // Anonimizada, a conta sai também da lista (o detalhe já é 404).
    const listed = await send(platformOwner, "GET", `/api/admin/users?q=${staff.id}`);
    expect((await bodyOf(listed)).items).toEqual([]);
  });

  it("agora, com a flag: executa as organizações e depois a conta", async () => {
    const person = await newUser();
    const tenant = await newTenant(person, "Some Junto Ltda");

    const response = await send(platformOwner, "DELETE", `/api/admin/users/${person.id}`, {
      mode: "now",
      confirm: person.email,
      deleteSoleOrganizations: true,
    });
    expect(response.status).toBe(200);
    expect((await orgOf(tenant.id))?.status).toBe("deleted");
    expect((await userRow(person.id))?.email).toBe(`deleted+${person.id}@invalid`);
  });
});

describe("pessoas do portal", () => {
  async function portalPerson(tenantOwner: TestUser) {
    const record = await createCustomer(tenantOwner);
    const cookie = await inviteAndEnter(tenantOwner, mail, record.id, record.email);
    const [person] = await owner<{ id: string }[]>`
      select id from portal_user where email = ${record.email}
    `;
    portalIds.push(person?.id ?? "");
    return { record, cookie, id: person?.id ?? "", email: record.email };
  }

  it("detalhe traz a pessoa e os vínculos com o nome da organização", async () => {
    const tenantOwner = await newUser();
    const tenant = await newTenant(tenantOwner, "Vínculo Ltda");
    const person = await portalPerson(tenantOwner);

    const body = await bodyOf(await send(support, "GET", `/api/admin/portal-users/${person.id}`));

    expect(body.person).toMatchObject({ email: person.email, emailVerified: true, hasPassword: false });
    expect(body.links).toEqual([
      expect.objectContaining({ tenant: { id: tenant.id, name: "Vínculo Ltda" }, status: "active" }),
    ]);
    expect(body.deletion).toBeNull();
  });

  it("trocar o e-mail muda todos os vínculos e tira senha e sessões; conflito não muda nada", async () => {
    const ownerA = await newUser();
    const ownerB = await newUser();
    const tenantA = await newTenant(ownerA, "Tenant A");
    const tenantB = await newTenant(ownerB, "Tenant B");
    const person = await portalPerson(ownerA);
    const inB = await createCustomer(ownerB, { email: person.email });
    await inviteAndEnter(ownerB, mail, inB.id, person.email);

    const password = await call("POST", "/api/portal/auth-ext/set-password", {
      cookie: person.cookie,
      body: { newPassword: "senha-do-portal-123" },
    });
    expect(password.status).toBe(200);

    // B já tem outro cliente com o endereço novo: 409 com o nome, e nada muda.
    const newAddress = `novo-${randomUUID()}@tenant-test.bizu.local`;
    await createCustomer(ownerB, { email: newAddress });
    const conflict = await send(platformOwner, "PATCH", `/api/admin/portal-users/${person.id}`, {
      email: newAddress,
    });
    expect(conflict.status).toBe(409);
    const conflictBody = await bodyOf(conflict);
    expect(conflictBody.code).toBe("EMAIL_TAKEN");
    expect(conflictBody.tenants).toEqual([{ id: tenantB.id, name: "Tenant B" }]);
    const [unchanged] = await owner<{ email: string }[]>`
      select email from portal_user where id = ${person.id}
    `;
    expect(unchanged?.email).toBe(person.email);
    expect(await sessionsOf("portal_session", person.id)).toBeGreaterThan(0);

    const freeAddress = `livre-${randomUUID()}@tenant-test.bizu.local`;
    const changed = await send(platformOwner, "PATCH", `/api/admin/portal-users/${person.id}`, {
      email: freeAddress,
      name: "Pessoa Renomeada",
    });
    expect(changed.status).toBe(200);

    const [row] = await owner<{ email: string; name: string; email_verified: boolean }[]>`
      select email, name, email_verified from portal_user where id = ${person.id}
    `;
    expect(row).toEqual({ email: freeAddress, name: "Pessoa Renomeada", email_verified: false });
    const links = await asPlatform(
      owner,
      (tx) => tx<{ tenant_id: string; email: string; name: string }[]>`
        select tenant_id, email, name from customer where portal_user_id = ${person.id}
      `,
    );
    expect(links.map(({ email }) => email)).toEqual([freeAddress, freeAddress]);
    // O nome do cadastro em cada tenant é do owner.
    expect(links.every(({ name }) => name === "Cliente Teste")).toBe(true);
    expect(await sessionsOf("portal_session", person.id)).toBe(0);
    const [accounts] = await owner<{ total: number }[]>`
      select count(*)::int as total from portal_account where user_id = ${person.id}
    `;
    expect(accounts?.total).toBe(0);
    expect(await templatesSentTo(person.email)).toContain("email-changed");

    const audits = await asPlatform(
      owner,
      (tx) => tx<{ tenant_id: string; actor_type: string }[]>`
        select tenant_id, actor_type from audit_log
        where action = 'customer.updated' and target_id in ${tx([person.record.id, inB.id])}
      `,
    );
    expect(audits.map(({ tenant_id }) => tenant_id).sort()).toEqual([tenantA.id, tenantB.id].sort());
    expect(audits.every(({ actor_type }) => actor_type === "platform")).toBe(true);

    // O endereço novo entra por magic link, que prova a posse.
    const asked = await call("POST", "/api/portal/auth-ext/magic-link", {
      body: { email: freeAddress, org: tenantA.slug },
    });
    expect(asked.status).toBe(200);
    expect(await templatesSentTo(freeAddress)).toContain("portal-magic-link");
  });

  it("e-mail de outra pessoa do portal é 409", async () => {
    const tenantOwner = await newUser();
    await newTenant(tenantOwner);
    const first = await portalPerson(tenantOwner);
    const second = await portalPerson(tenantOwner);

    const response = await send(platformOwner, "PATCH", `/api/admin/portal-users/${first.id}`, {
      email: second.email,
    });
    expect(response.status).toBe(409);
    expect((await bodyOf(response)).code).toBe("EMAIL_TAKEN");
  });

  it("excluir agora anonimiza a pessoa e os cadastros; agendar e cancelar volta o acesso", async () => {
    const tenantOwner = await newUser();
    await newTenant(tenantOwner);
    const scheduled = await portalPerson(tenantOwner);

    const response = await send(platformOwner, "DELETE", `/api/admin/portal-users/${scheduled.id}`, {
      mode: "scheduled",
      confirm: scheduled.email,
    });
    expect(response.status).toBe(200);
    expect(await sessionsOf("portal_session", scheduled.id)).toBe(0);
    expect(await requestOf(scheduled.id)).toMatchObject({ origin: "platform", status: "pending" });
    const [stillActive] = await asPlatform(
      owner,
      (tx) => tx<{ status: string }[]>`select status from customer where id = ${scheduled.record.id}`,
    );
    expect(stillActive?.status).toBe("active");

    expect(
      (await send(platformOwner, "POST", `/api/admin/portal-users/${scheduled.id}/deletion/cancel`)).status,
    ).toBe(200);
    expect(await requestOf(scheduled.id)).toMatchObject({ status: "canceled" });

    const gone = await portalPerson(tenantOwner);
    const now = await send(platformOwner, "DELETE", `/api/admin/portal-users/${gone.id}`, {
      mode: "now",
      confirm: gone.email,
    });
    expect(now.status).toBe(200);
    const [person] = await owner<{ email: string }[]>`select email from portal_user where id = ${gone.id}`;
    expect(person?.email).toBe(`deleted+${gone.id}@invalid`);
    const [record] = await asPlatform(
      owner,
      (tx) => tx<{ name: string; status: string }[]>`select name, status from customer where id = ${gone.record.id}`,
    );
    expect(record).toEqual({ name: "Cliente removido", status: "blocked" });
    expect(await templatesSentTo(gone.email)).toContain("deletion-executed");
  });

  it("a própria pessoa não cancela o pedido da plataforma", async () => {
    const tenantOwner = await newUser();
    await newTenant(tenantOwner);
    const person = await portalPerson(tenantOwner);
    expect(
      (
        await send(platformOwner, "DELETE", `/api/admin/portal-users/${person.id}`, {
          mode: "scheduled",
          confirm: person.email,
        })
      ).status,
    ).toBe(200);

    // Sem sessão (barrada), a rota da pessoa nem abre.
    const own = await call("POST", "/api/portal/me/deletion/cancel", { cookie: person.cookie });
    expect(own.status).toBe(401);
    expect(await requestOf(person.id)).toMatchObject({ status: "pending" });
  });
});

