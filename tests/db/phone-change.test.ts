import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withScope } from "@/db/rls";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { resetEnvForTests } from "@/lib/env";
import { autoLinkContact } from "@/lib/inbox/contacts";
import { phoneValues } from "@/lib/phone/columns";
import { ensureUserVerification, issueVerificationToken } from "@/lib/phone/requests";
import { asPlatform, makePlatformUser } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, tenantScope } from "./channels-helpers";
import { seedConversation } from "./inbox-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, createCustomer, inviteAndEnter } from "./portal-helpers";
import { applyCookies } from "./security-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * Troca de telefone pelo pedido (`docs/specs/pre-producao/spec.md`, bloco T, "Contratos"): o
 * cadastro mantém o número antigo, e a confirmação dele, até o número novo ser confirmado pelo link
 * (na sessão do próprio cadastro) ou liberado pelo responsável. O envio do link pelos canais está em
 * `phone-delivery.test.ts`; aqui o token é emitido direto por `issueVerificationToken`.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;
let platformOwner: TestUser;

type RequestRow = {
  id: string;
  tenant_id: string | null;
  status: string;
  purpose: string;
  phone_key: string;
  token_hash: string | null;
  confirmed_by: string | null;
  requested_by_type: string | null;
  requested_by_id: string | null;
};
type Verification = { at: Date | null; via: string | null };

const requestsOf = (subjectId: string) =>
  asPlatform(
    owner,
    (tx) => tx<RequestRow[]>`
      select id, tenant_id, status, purpose, phone_key, token_hash, confirmed_by,
        requested_by_type, requested_by_id
      from phone_verification where subject_id = ${subjectId} order by created_at
    `,
  );

const openOf = async (subjectId: string, purpose: "signup" | "change") =>
  (await requestsOf(subjectId)).filter(
    (row) => row.purpose === purpose && ["sent", "awaiting_manual"].includes(row.status),
  );

/** A troca aberta do cadastro; falha se não houver exatamente uma. */
async function openChange(subjectId: string) {
  const open = await openOf(subjectId, "change");
  expect(open).toHaveLength(1);
  return open[0] as RequestRow;
}

const userPhone = async (id: string) =>
  (
    await owner<({ phone_key: string } & Verification)[]>`
      select phone_key, phone_verified_at as at, phone_verified_via as via
      from "user" where id = ${id}
    `
  )[0];

const customerPhone = (id: string) =>
  asPlatform(owner, async (tx) => {
    const [row] = await tx<
      ({ phone_key: string; phone_normalized: string; user_id: string | null } & Verification)[]
    >`
      select phone_key, phone_normalized, user_id, phone_verified_at as at,
        phone_verified_via as via
      from customer where id = ${id}
    `;
    return row;
  });

const vouchesOf = (userId: string) =>
  asPlatform(
    owner,
    (tx) => tx<{ tenant_id: string; phone_key: string }[]>`
      select tenant_id, phone_key from phone_tenant_vouch where user_id = ${userId}
    `,
  );

async function setUserPhone(user: TestUser, phone: string, via: string | null) {
  const values = phoneValues(phone);
  await owner`
    update "user" set phone = ${values.phone}, phone_normalized = ${values.phoneNormalized},
      phone_key = ${values.phoneKey}, phone_verified_at = ${via ? new Date() : null},
      phone_verified_via = ${via}
    where id = ${user.id}
  `;
  return values.phoneKey;
}

/** O owner de uma organização com o número confirmado no sistema inteiro. */
async function confirmedOwner(phone = uniquePhone()) {
  const user = await createUser(owner);
  const tenant = await createTenant(user);
  await waitForBackgroundTasks();
  const key = await setUserPhone(user, phone, "manual");
  // Como a confirmação da plataforma faria: nada mais pendente.
  await asPlatform(
    owner,
    (tx) => tx`
      update phone_verification set status = 'canceled', token_hash = null, expires_at = null
      where subject_id = ${user.id} and status in ('sent', 'awaiting_manual')
    `,
  );
  return { user, tenant, phone, key };
}

const vouch = (userId: string, tenantId: string) =>
  asPlatform(
    owner,
    (tx) => tx`
      insert into phone_tenant_vouch (user_id, tenant_id, phone_key)
      select id, ${tenantId}, phone_key from "user" where id = ${userId}
      on conflict (user_id, tenant_id) do update set phone_key = excluded.phone_key
    `,
  );

const askChange = (cookie: string, phone: string) =>
  call("POST", "/api/me/phone-change", { cookie, body: { phone } });

const confirmByLink = (cookie: string, token: string) =>
  call("POST", "/api/me/phone-verification/confirm", { cookie, body: { token } });

const confirmInPortal = (cookie: string, token: string) =>
  call("POST", "/api/portal/me/phone-verification/confirm", { cookie, body: { token } });

const releaseInTenant = (cookie: string, id: string) =>
  call("POST", `/api/phone-verifications/${id}/confirm`, { cookie });

const tokenOf = async (requestId: string) => (await issueVerificationToken(requestId)) as string;

function setPhoneRequired(value: "true" | "false") {
  process.env.PHONE_VERIFICATION_REQUIRED = value;
  resetEnvForTests();
}

beforeAll(async () => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
  platformOwner = await makePlatformUser(owner, "platform_owner");
});

afterEach(() => setPhoneRequired("false"));

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await waitForBackgroundTasks();
  await cleanUpChannels(owner, []);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("troca de número da conta da equipe", () => {
  it("a conta segue com o número antigo, confirmado, até o link do número novo ser confirmado na sessão dela", async () => {
    const { user, key, phone } = await confirmedOwner();
    const next = uniquePhone();

    const asked = await askChange(user.cookie, next);
    expect(asked.status).toBe(202);
    expect(await asked.json()).toEqual({ ok: true });

    // Nada mudou na conta: o número novo está só no pedido.
    expect(await userPhone(user.id)).toMatchObject({ phone_key: key, via: "manual" });
    const change = await openChange(user.id);
    expect(change).toMatchObject({
      tenant_id: null,
      status: "awaiting_manual",
      phone_key: phoneValues(next).phoneKey,
      requested_by_type: "user",
      requested_by_id: user.id,
    });
    const overview = await call("GET", "/api/me/phone-verification", { cookie: user.cookie });
    expect(await overview.json()).toMatchObject({
      pending: null,
      confirmedGlobally: true,
      // Os 4 últimos dígitos do número da conta. Antes isto passava a `phone_key` por `phoneValues`,
      // que só é telefone válido quando o número sorteado não começa com 1: o teste falhava por
      // cerca de 2h47 a cada 25 h, conforme a hora (`uniquePhone` parte de `Date.now()`).
      phoneHint: phone.slice(-4),
      change: { status: "awaiting_manual", phoneHint: next.slice(-4), responsible: "platform" },
    });

    // O link do número novo não serve a outra conta.
    const token = await tokenOf(change.id);
    expect(token).toMatch(/^u\./);
    const stranger = await createUser(owner);
    expect((await confirmByLink(stranger.cookie, token)).status).toBe(400);
    expect(await userPhone(user.id)).toMatchObject({ phone_key: key, via: "manual" });

    // Na sessão da própria conta, troca e confirma no sistema inteiro (pedido da plataforma).
    expect((await confirmByLink(user.cookie, token)).status).toBe(200);
    expect(await userPhone(user.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      via: "whatsapp",
    });
    expect((await requestsOf(user.id)).find(({ id }) => id === change.id)).toMatchObject({
      status: "confirmed",
      token_hash: null,
    });
    // Usado, não vale de novo.
    expect((await confirmByLink(user.cookie, token)).status).toBe(400);

    // A auditoria diz que foi uma troca, sem o número.
    const audits = await asPlatform(
      owner,
      (tx) => tx<{ action: string; metadata: Record<string, unknown> }[]>`
        select action, metadata from audit_log
        where target_id = ${user.id} and action like 'phone.%' order by created_at
      `,
    );
    expect(audits.map(({ action }) => action)).toEqual(["phone.change_requested", "phone.verified"]);
    expect(audits[1]?.metadata).toMatchObject({ via: "whatsapp", purpose: "change" });
    expect(JSON.stringify(audits)).not.toContain(phoneValues(next).phoneNormalized.slice(2));
  });

  it("o membro comum sem confirmação no sistema troca perante a organização em uso: vale só nela", async () => {
    const { user: boss, tenant } = await confirmedOwner();
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    await waitForBackgroundTasks();
    const old = await setUserPhone(person, uniquePhone(), null);
    await vouch(person.id, tenant.id);
    await call("POST", "/api/tenant/active", { cookie: person.cookie, body: { tenantId: tenant.id } });

    const next = uniquePhone();
    expect((await askChange(person.cookie, next)).status).toBe(202);
    const change = await openChange(person.id);
    expect(change.tenant_id).toBe(tenant.id);
    // A liberação da organização segue valendo para o número que a conta tem.
    expect(await vouchesOf(person.id)).toEqual([{ tenant_id: tenant.id, phone_key: old }]);

    // O owner libera à mão: a conta fica com o número novo, liberado só nesta organização.
    expect((await releaseInTenant(boss.cookie, change.id)).status).toBe(200);
    expect(await userPhone(person.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      at: null,
      via: null,
    });
    expect(await vouchesOf(person.id)).toEqual([
      { tenant_id: tenant.id, phone_key: phoneValues(next).phoneKey },
    ]);
    // Para o sistema inteiro, o número novo ainda deve a confirmação da plataforma.
    const signup = await openOf(person.id, "signup");
    expect(signup.map(({ tenant_id, phone_key }) => ({ tenant_id, phone_key }))).toEqual([
      { tenant_id: null, phone_key: phoneValues(next).phoneKey },
    ]);
  });

  it("o membro comum já confirmado no sistema troca perante a plataforma, e a fila dela o mostra", async () => {
    const { tenant } = await confirmedOwner();
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    await waitForBackgroundTasks();
    await setUserPhone(person, uniquePhone(), "manual");

    const next = uniquePhone();
    expect((await askChange(person.cookie, next)).status).toBe(202);
    const change = await openChange(person.id);
    expect(change.tenant_id).toBeNull();

    // Sem link (sem canal da plataforma, ou o link não chegou), quem fecha é o proprietário.
    const queue = await call("GET", "/api/admin/phone-verifications", {
      cookie: platformOwner.cookie,
    });
    const { items } = (await queue.json()) as { items: Array<{ id: string; purpose: string }> };
    expect(items.find(({ id }) => id === change.id)).toMatchObject({ purpose: "change" });

    const released = await call("POST", `/api/admin/phone-verifications/${change.id}/confirm`, {
      cookie: platformOwner.cookie,
    });
    expect(released.status).toBe(200);
    expect(await userPhone(person.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      via: "manual",
    });
  });

  it("quem sai da organização que respondia pela troca perde a troca, e isso fica auditado", async () => {
    const { user: boss, tenant } = await confirmedOwner();
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    await waitForBackgroundTasks();
    await setUserPhone(person, uniquePhone(), null);
    await call("POST", "/api/tenant/active", { cookie: person.cookie, body: { tenantId: tenant.id } });
    expect((await askChange(person.cookie, uniquePhone())).status).toBe(202);
    const change = await openChange(person.id);
    expect(change.tenant_id).toBe(tenant.id);

    const [membership] = await owner<{ id: string }[]>`
      select id from member where user_id = ${person.id} and organization_id = ${tenant.id}
    `;
    expect(
      (await call("DELETE", `/api/team/members/${membership?.id}`, { cookie: boss.cookie })).status,
    ).toBeLessThan(300);
    await waitForBackgroundTasks();

    expect((await requestsOf(person.id)).find(({ id }) => id === change.id)?.status).toBe("canceled");
    const audits = await asPlatform(
      owner,
      (tx) => tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_log where action = 'phone.change_canceled' and target_id = ${person.id}
      `,
    );
    expect(audits.map(({ metadata }) => metadata)).toEqual([{ reason: "left_tenant" }]);
  });

  it("cancelar restaura tudo, e o token da troca cancelada não vale", async () => {
    const { user, key } = await confirmedOwner();
    expect((await askChange(user.cookie, uniquePhone())).status).toBe(202);
    const change = await openChange(user.id);
    const token = await tokenOf(change.id);

    const canceled = await call("DELETE", "/api/me/phone-change", { cookie: user.cookie });
    expect(canceled.status).toBe(204);
    expect((await requestsOf(user.id)).find(({ id }) => id === change.id)).toMatchObject({
      status: "canceled",
      token_hash: null,
    });
    expect((await confirmByLink(user.cookie, token)).status).toBe(400);
    expect(await userPhone(user.id)).toMatchObject({ phone_key: key, via: "manual" });
    // Sem troca aberta, cancelar de novo é o mesmo 204.
    expect((await call("DELETE", "/api/me/phone-change", { cookie: user.cookie })).status).toBe(204);
  });

  it("uma troca por cadastro: outro número substitui a anterior; o mesmo número reenvia a que existe", async () => {
    const { user } = await confirmedOwner();
    const first = uniquePhone();
    const second = uniquePhone();
    await askChange(user.cookie, first);
    const a = await openChange(user.id);
    const tokenA = await tokenOf(a.id);

    await askChange(user.cookie, second);
    const b = await openChange(user.id);
    expect(b.id).not.toBe(a.id);
    expect(b.phone_key).toBe(phoneValues(second).phoneKey);
    expect((await requestsOf(user.id)).find(({ id }) => id === a.id)?.status).toBe("canceled");
    expect((await confirmByLink(user.cookie, tokenA)).status).toBe(400);

    expect((await askChange(user.cookie, second)).status).toBe(202);
    expect((await openChange(user.id)).id).toBe(b.id);
  });

  it("o mesmo número é 400 `PHONE_UNCHANGED`; fixo é 400", async () => {
    const { user, phone } = await confirmedOwner();
    const same = await askChange(user.cookie, `+55 ${phone}`);
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ code: "PHONE_UNCHANGED" });
    expect((await askChange(user.cookie, "1133334444")).status).toBe(400);
    expect(await openOf(user.id, "change")).toEqual([]);
  });

  it("número em uso: o pedido responde igual, e a liberação recusa sem tirar o número de quem o tem", async () => {
    const { user: boss, tenant } = await confirmedOwner();
    const holder = await createUser(owner);
    const person = await createUser(owner);
    await addMember(owner, tenant.id, holder, "member");
    await addMember(owner, tenant.id, person, "member");
    await waitForBackgroundTasks();
    const taken = uniquePhone();
    await setUserPhone(holder, taken, null);
    await vouch(holder.id, tenant.id);
    await setUserPhone(person, uniquePhone(), null);

    // A mesma resposta para o número livre e para o de um colega: o pedido não é um oráculo.
    const free = await askChange(person.cookie, uniquePhone());
    const used = await askChange(person.cookie, taken);
    expect([free.status, used.status]).toEqual([202, 202]);
    expect(await used.json()).toEqual(await free.json());

    const change = await openChange(person.id);
    const refused = await releaseInTenant(boss.cookie, change.id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PHONE_IN_USE" });
    expect((await userPhone(person.id))?.phone_key).not.toBe(phoneValues(taken).phoneKey);
    expect(await vouchesOf(holder.id)).toEqual([
      { tenant_id: tenant.id, phone_key: phoneValues(taken).phoneKey },
    ]);
  });

  it("a sessão personificada não pede nem cancela a troca", async () => {
    const { user: boss, tenant } = await confirmedOwner();
    const target = await createUser(owner);
    await addMember(owner, tenant.id, target, "member");
    const support = await makePlatformUser(owner, "platform_support");
    const grant = await call("POST", "/api/tenant/support-grant", {
      cookie: boss.cookie,
      body: { hours: 1 },
    });
    expect(grant.status).toBe(201);
    const started = await call("POST", "/api/admin/impersonate", {
      cookie: support.cookie,
      body: { userId: target.id, tenantId: tenant.id, reason: "Teste da troca de telefone" },
    });
    expect(started.status).toBe(200);
    const cookie = applyCookies(support.cookie, started);

    const asked = await askChange(cookie, uniquePhone());
    expect(asked.status).toBe(403);
    expect(await asked.json()).toMatchObject({ code: "IMPERSONATION_BLOCKED" });
    expect((await call("DELETE", "/api/me/phone-change", { cookie })).status).toBe(403);
    expect(await openOf(target.id, "change")).toEqual([]);

    await call("POST", "/api/admin/stop-impersonating", { cookie, body: {} });
  });
});

describe("com o bloqueio de telefone ligado", () => {
  it("a conta pendente corrige o número pela troca, e nada mais abre até a confirmação", async () => {
    const person = await createUser(owner);
    await waitForBackgroundTasks();
    await setUserPhone(person, uniquePhone(), null);
    await ensureUserVerification(person.id);
    setPhoneRequired("true");

    const blocked = await call("GET", "/api/me", { cookie: person.cookie });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "PHONE_UNVERIFIED" });

    const next = uniquePhone();
    expect((await askChange(person.cookie, next)).status).toBe(202);
    expect((await call("DELETE", "/api/me/phone-change", { cookie: person.cookie })).status).toBe(204);
    expect((await askChange(person.cookie, next)).status).toBe(202);
    // Pedir a troca não abre o resto.
    expect((await call("GET", "/api/me", { cookie: person.cookie })).status).toBe(403);
    expect((await call("GET", "/api/me/sessions", { cookie: person.cookie })).status).toBe(403);

    const change = await openChange(person.id);
    expect((await confirmByLink(person.cookie, await tokenOf(change.id))).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: person.cookie })).status).toBe(200);
    expect(await userPhone(person.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      via: "whatsapp",
    });
  });
});

describe("troca de número da ficha de cliente", () => {
  it("portal: a ficha segue com o número antigo; o link do número novo, na sessão do portal, troca, e a conversa do número antigo continua na ficha", async () => {
    const { user: boss, tenant } = await confirmedOwner();
    const channel = await seedCloudChannel(tenantScope(tenant.id));
    const customer = await createCustomer(boss);
    const before = await customerPhone(customer.id);
    const seeded = await seedConversation(tenantScope(tenant.id), channel.id, {
      phone: before?.phone_normalized ?? "",
    });
    await asPlatform(
      owner,
      (tx) => tx`update chat_contact set customer_id = ${customer.id} where id = ${seeded.contactId}`,
    );
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);

    const next = uniquePhone();
    const asked = await call("POST", "/api/portal/me/phone-change", {
      cookie,
      body: { phone: next },
    });
    expect(asked.status).toBe(202);
    expect(await customerPhone(customer.id)).toMatchObject({
      phone_key: before?.phone_key,
      via: "team",
    });
    const change = await openChange(customer.id);
    expect(change).toMatchObject({ tenant_id: tenant.id, requested_by_type: "portal_user" });

    const token = await tokenOf(change.id);
    expect(token).toMatch(/^c\./);
    // Nem a equipe nem outro cliente confirmam com o link.
    expect((await confirmByLink(boss.cookie, token)).status).toBe(400);
    const other = await createCustomer(boss);
    const otherCookie = await inviteAndEnter(boss, mail, other.id, other.email);
    expect((await confirmInPortal(otherCookie, token)).status).toBe(400);

    expect((await confirmInPortal(cookie, token)).status).toBe(200);
    expect(await customerPhone(customer.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      via: "whatsapp",
    });
    // P1: o histórico é do cadastro, não do número.
    const [contact] = await asPlatform(
      owner,
      (tx) => tx<{ customer_id: string | null }[]>`
        select customer_id from chat_contact where id = ${seeded.contactId}
      `,
    );
    expect(contact?.customer_id).toBe(customer.id);
    // A troca pedida pela pessoa leva o número à conta do portal, só declarado.
    const [account] = await owner<({ phone_key: string } & Verification)[]>`
      select phone_key, phone_verified_at as at, phone_verified_via as via
      from portal_user where email = ${customer.email}
    `;
    expect(account).toMatchObject({ phone_key: phoneValues(next).phoneKey, at: null, via: null });
  });

  it("portal: número de outro cliente — 202 no pedido, 409 só para quem provou a posse", async () => {
    const { user: boss } = await confirmedOwner();
    const taken = uniquePhone();
    await createCustomer(boss, { phone: taken });
    const customer = await createCustomer(boss);
    const before = await customerPhone(customer.id);
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);

    const asked = await call("POST", "/api/portal/me/phone-change", {
      cookie,
      body: { phone: taken },
    });
    expect(asked.status).toBe(202);

    const change = await openChange(customer.id);
    const refused = await confirmInPortal(cookie, await tokenOf(change.id));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PHONE_IN_USE" });
    expect(await customerPhone(customer.id)).toMatchObject({
      phone_key: before?.phone_key,
      via: "team",
    });
  });

  it("equipe: número de outro cliente é 409 no pedido; a troca pedida por um colaborador só vale com o owner, como `team` (TC-5)", async () => {
    const { user: boss, tenant } = await confirmedOwner();
    const collaborator = await createUser(owner);
    await addMember(owner, tenant.id, collaborator, "member");
    await call("POST", "/api/tenant/active", {
      cookie: collaborator.cookie,
      body: { tenantId: tenant.id },
    });
    const taken = uniquePhone();
    await createCustomer(boss, { phone: taken });
    const customer = await createCustomer(boss);
    const before = await customerPhone(customer.id);

    const conflict = await call("POST", `/api/customers/${customer.id}/phone-change`, {
      cookie: collaborator.cookie,
      body: { phone: taken },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "PHONE_IN_USE" });

    const next = uniquePhone();
    const asked = await call("POST", `/api/customers/${customer.id}/phone-change`, {
      cookie: collaborator.cookie,
      body: { phone: next },
    });
    expect(asked.status).toBe(202);
    const detail = await call("GET", `/api/customers/${customer.id}`, { cookie: boss.cookie });
    expect(await detail.json()).toMatchObject({
      customer: {
        phoneVerified: true,
        phoneChange: { status: "awaiting_manual", phoneHint: next.slice(-4) },
      },
    });
    const change = await openChange(customer.id);
    expect(change).toMatchObject({ requested_by_type: "user", requested_by_id: collaborator.id });

    // O colaborador não confirma: nem pelo link (não é a sessão da ficha), nem à mão.
    const token = await tokenOf(change.id);
    expect((await confirmByLink(collaborator.cookie, token)).status).toBe(400);
    expect((await releaseInTenant(collaborator.cookie, change.id)).status).toBe(403);
    expect(await customerPhone(customer.id)).toMatchObject({ phone_key: before?.phone_key });

    // Antes da liberação, a conversa do número novo não é da ficha.
    const channel = await seedCloudChannel(tenantScope(tenant.id));
    const thread = await seedConversation(tenantScope(tenant.id), channel.id, {
      phone: phoneValues(next).phoneNormalized,
    });
    const link = () =>
      withScope(tenantScope(tenant.id), (tx) =>
        autoLinkContact(tx, tenantScope(tenant.id), thread.contactId, phoneValues(next).phoneKey),
      );
    expect(await link()).toBeNull();

    // O owner libera: quem informou o número foi a equipe, então vale como no cadastro (`team`).
    // A ficha volta a atrair as conversas do número; não é ligada a ninguém da equipe.
    expect((await releaseInTenant(boss.cookie, change.id)).status).toBe(200);
    expect(await customerPhone(customer.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      via: "team",
      user_id: null,
    });
    expect(await link()).toEqual({ customerId: customer.id });
  });

  it("portal: a troca que a própria pessoa pediu e o owner liberou vale como `manual` e não atrai conversa", async () => {
    const { user: boss, tenant } = await confirmedOwner();
    const customer = await createCustomer(boss);
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);

    const next = uniquePhone();
    const asked = await call("POST", "/api/portal/me/phone-change", {
      cookie,
      body: { phone: next },
    });
    expect(asked.status).toBe(202);
    const change = await openChange(customer.id);
    expect(change).toMatchObject({ requested_by_type: "portal_user" });

    expect((await releaseInTenant(boss.cookie, change.id)).status).toBe(200);
    expect(await customerPhone(customer.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      via: "manual",
    });

    // Quem declarou o número foi a pessoa, e ninguém provou a posse: a conversa não é ligada sozinha.
    const channel = await seedCloudChannel(tenantScope(tenant.id));
    const thread = await seedConversation(tenantScope(tenant.id), channel.id, {
      phone: phoneValues(next).phoneNormalized,
    });
    expect(
      await withScope(tenantScope(tenant.id), (tx) =>
        autoLinkContact(tx, tenantScope(tenant.id), thread.contactId, phoneValues(next).phoneKey),
      ),
    ).toBeNull();
  });

  it("a equipe e o portal cancelam a troca da ficha; a ficha fica como estava", async () => {
    const { user: boss } = await confirmedOwner();
    const customer = await createCustomer(boss);
    const before = await customerPhone(customer.id);
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);

    await call("POST", `/api/customers/${customer.id}/phone-change`, {
      cookie: boss.cookie,
      body: { phone: uniquePhone() },
    });
    const first = await openChange(customer.id);
    expect(
      (await call("DELETE", `/api/customers/${customer.id}/phone-change`, { cookie: boss.cookie }))
        .status,
    ).toBe(204);
    expect((await requestsOf(customer.id)).find(({ id }) => id === first.id)?.status).toBe(
      "canceled",
    );

    await call("POST", "/api/portal/me/phone-change", { cookie, body: { phone: uniquePhone() } });
    const second = await openChange(customer.id);
    expect((await call("DELETE", "/api/portal/me/phone-change", { cookie })).status).toBe(204);
    expect((await requestsOf(customer.id)).find(({ id }) => id === second.id)?.status).toBe(
      "canceled",
    );
    expect(await customerPhone(customer.id)).toMatchObject({
      phone_key: before?.phone_key,
      via: "team",
    });
  });
});

describe("/admin: edição do telefone de uma conta", () => {
  it("passa pelo pedido de troca, que o proprietário libera à mão (`manual`)", async () => {
    const { user: target } = await confirmedOwner();
    const next = uniquePhone();

    const edited = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: platformOwner.cookie,
      body: { phone: next },
    });
    expect(edited.status).toBe(200);
    expect(await userPhone(target.id)).toMatchObject({
      phone_key: phoneValues(next).phoneKey,
      via: "manual",
    });
    const [change] = (await requestsOf(target.id)).filter(({ purpose }) => purpose === "change");
    expect(change).toMatchObject({
      tenant_id: null,
      status: "confirmed",
      confirmed_by: platformOwner.id,
      requested_by_id: platformOwner.id,
    });
  });

  it("número que outra conta do grupo já confirmou: 409, e nenhum pedido fica", async () => {
    const { phone: taken } = await confirmedOwner();
    const { user: target, key } = await confirmedOwner();

    const refused = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: platformOwner.cookie,
      body: { phone: taken },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PHONE_IN_USE" });
    expect(await userPhone(target.id)).toMatchObject({ phone_key: key, via: "manual" });
    expect((await requestsOf(target.id)).filter(({ purpose }) => purpose === "change")).toEqual([]);
  });
});
