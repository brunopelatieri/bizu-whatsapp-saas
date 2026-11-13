import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPlatformScope, withTenant } from "@/db/rls";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { phoneValues } from "@/lib/phone/columns";
import {
  ensureUserVerification,
  issueVerificationToken,
  prunePhoneVerifications,
  releaseTenantPhoneResponsibility,
} from "@/lib/phone/requests";
import { teamPhoneHolders } from "@/lib/phone/uniqueness";
import { asPlatform, makePlatformUser } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, tenantScope } from "./channels-helpers";
import { seedConversation } from "./inbox-helpers";
import { uniquePhone } from "./phone-helpers";
import {
  cleanUpPortal,
  createCustomer,
  customerEmail,
  inviteAndEnter,
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

/**
 * Pedidos de confirmação de telefone (`docs/specs/pre-producao/spec.md`, bloco T, fase T2a):
 * quem abre o pedido, o link de uso único que só confirma na sessão da própria conta, "quem
 * provou a posse fica com o número", e a liberação à mão.
 *
 * O alcance é o do RESPONSÁVEL do pedido: o da plataforma (pelo link ou pelo proprietário) vale
 * no sistema inteiro; o de uma organização (pelo link que sai pelo canal dela, ou pelo owner)
 * vale só dentro dela.
 *
 * O envio do link pelos canais é a T2b: aqui o token é emitido direto por
 * `issueVerificationToken`.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;
let platformOwner: TestUser;

type RequestRow = {
  id: string;
  tenant_id: string | null;
  status: string;
  phone_key: string;
  token_hash: string | null;
  confirmed_by: string | null;
};
type Verification = { at: Date | null; via: string | null };

const requestsOf = (subjectId: string) =>
  asPlatform(
    owner,
    (tx) => tx<RequestRow[]>`
      select id, tenant_id, status, phone_key, token_hash, confirmed_by
      from phone_verification where subject_id = ${subjectId} order by created_at
    `,
  );

const openRequests = async (subjectId: string) =>
  (await requestsOf(subjectId)).filter(({ status }) =>
    ["sent", "awaiting_manual"].includes(status),
  );

/**
 * O pedido aberto do cadastro; falha se não houver exatamente um. Com `tenantId`, o pedido
 * perante aquele responsável (`null` = a plataforma): a conta pode ter um com cada.
 */
async function openRequestOf(subjectId: string, tenantId?: string | null) {
  const all = await openRequests(subjectId);
  const open = tenantId === undefined ? all : all.filter((row) => row.tenant_id === tenantId);
  expect(open).toHaveLength(1);
  return open[0] as RequestRow;
}

/** Perante quem a conta tem pedido aberto (`null` = a plataforma). */
const openScopes = async (subjectId: string) =>
  (await openRequests(subjectId)).map(({ tenant_id }) => tenant_id).sort();

/** As organizações cujo owner liberou o número da conta. */
const vouchesOf = (userId: string) =>
  asPlatform(owner, async (tx) =>
    (
      await tx<{ tenant_id: string }[]>`
        select tenant_id from phone_tenant_vouch where user_id = ${userId} order by created_at
      `
    ).map(({ tenant_id }) => tenant_id),
  );

const teamHolders = (tenantId: string, key: string) =>
  withPlatformScope("teste", (tx) => teamPhoneHolders(tx, tenantId, key));

const userPhone = async (id: string) =>
  (
    await owner<({ phone_key: string } & Verification)[]>`
      select phone_key, phone_verified_at as at, phone_verified_via as via
      from "user" where id = ${id}
    `
  )[0];

const customerPhone = (id: string) =>
  asPlatform(owner, async (tx) => {
    const [row] = await tx<({ phone_key: string; user_id: string | null } & Verification)[]>`
      select phone_key, user_id, phone_verified_at as at, phone_verified_via as via
      from customer where id = ${id}
    `;
    return row;
  });

const portalAccount = async (email: string) =>
  (
    await owner<Verification[]>`
      select phone_verified_at as at, phone_verified_via as via from portal_user where email = ${email}
    `
  )[0];

const contactCustomer = (contactId: string) =>
  asPlatform(owner, async (tx) => {
    const [row] = await tx<{ customer_id: string | null }[]>`
      select customer_id from chat_contact where id = ${contactId}
    `;
    return row?.customer_id ?? null;
  });

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

/** Conta nova com um número próprio, só declarado, e o pedido já aberto na plataforma. */
async function pendingUser(phone = uniquePhone()) {
  const user = await createUser(owner);
  await waitForBackgroundTasks();
  const key = await setUserPhone(user, phone, null);
  await ensureUserVerification(user.id);

  return { user, phone, key };
}

/** Conta com o número confirmado para o sistema inteiro (como a plataforma libera). */
async function confirmedUser(phone = uniquePhone()) {
  const user = await createUser(owner);
  await waitForBackgroundTasks();
  const key = await setUserPhone(user, phone, "manual");
  return { user, phone, key };
}

const confirmByLink = (cookie: string, token: string) =>
  call("POST", "/api/me/phone-verification/confirm", { cookie, body: { token } });

const confirmInPortal = (cookie: string, token: string) =>
  call("POST", "/api/portal/me/phone-verification/confirm", { cookie, body: { token } });

const releaseInTenant = (cookie: string, id: string) =>
  call("POST", `/api/phone-verifications/${id}/confirm`, { cookie });

const releaseInPlatform = (id: string) =>
  call("POST", `/api/admin/phone-verifications/${id}/confirm`, {
    cookie: platformOwner.cookie,
  });

/** Os pedidos que a fila da plataforma mostra, percorrendo todas as páginas. */
async function platformQueue() {
  type Item = { id: string; subjectType: string; name: string; createdAt: string };
  const items: Item[] = [];
  for (let page = 1; page < 500; page += 1) {
    const list = await call("GET", `/api/admin/phone-verifications?page=${page}`, {
      cookie: platformOwner.cookie,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Item[]; pageSize: number };
    items.push(...body.items);
    if (body.items.length < body.pageSize) break;
  }
  return items;
}

/** Convida pelo e-mail e aceita, como a tela faria. */
async function inviteAndAccept(boss: TestUser, guest: TestUser, role = "member") {
  const invited = await call("POST", "/api/team/invitations", {
    cookie: boss.cookie,
    body: { email: guest.email, role },
  });
  expect(invited.status).toBe(201);
  await waitForBackgroundTasks();
  const id = mail.sent
    .filter((m) => m.to === guest.email && m.tags?.template === "invite-member")
    .at(-1)
    ?.text.match(/\/convite\/([0-9a-f-]{36})/)?.[1];
  const accepted = await call("POST", `/api/invitations/${id}/accept`, { cookie: guest.cookie });
  expect(accepted.status).toBe(200);
}

async function allowSelfSignup(tenantId: string) {
  await owner`
    update organization set settings = ${owner.json({ portal_self_signup: true })}
    where id = ${tenantId}
  `;
}

/** Cliente com conta no portal que trocou o próprio telefone: ficha pendente e pedido aberto. */
async function pendingPortalCustomer(boss: TestUser, phone = uniquePhone()) {
  const customer = await createCustomer(boss);
  const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);
  const changed = await call("PATCH", "/api/portal/me", {
    cookie,
    body: { name: "Cliente", phone },
  });
  expect(changed.status).toBe(200);

  return { customer, cookie, phone };
}

beforeAll(async () => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
  platformOwner = await makePlatformUser(owner, "platform_owner");
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await waitForBackgroundTasks();
  await cleanUpChannels(owner, []);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("quem abre o pedido", () => {
  it("o cadastro da equipe abre o pedido na plataforma, esperando liberação", async () => {
    const user = await createUser(owner);
    await waitForBackgroundTasks();

    const request = await openRequestOf(user.id);

    expect(request).toMatchObject({
      tenant_id: null,
      status: "awaiting_manual",
      token_hash: null,
    });
    expect((await userPhone(user.id))?.at).toBeNull();

    const mine = await call("GET", "/api/me/phone-verification", { cookie: user.cookie });
    expect(await mine.json()).toMatchObject({
      pending: { status: "awaiting_manual", phoneHint: "4321" },
    });
  });

  it("conta com o telefone já confirmado não ganha pedido novo", async () => {
    const { user } = await confirmedUser();
    const before = await requestsOf(user.id);

    expect(await ensureUserVerification(user.id)).toBeNull();
    expect(await requestsOf(user.id)).toEqual(before);
  });

  it("no aceite do convite, a organização que convidou também passa a responder", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: guest } = await pendingUser();

    await inviteAndAccept(boss, guest);

    // Um pedido perante cada responsável: o da plataforma (do cadastro) continua.
    expect(await openScopes(guest.id)).toEqual([tenant.id, null].sort());
  });

  it("duas aberturas ao mesmo tempo, para o mesmo responsável, deixam um pedido só", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: guest } = await pendingUser();
    await addMember(owner, tenant.id, guest, "member");
    const scope = { kind: "tenant", tenantId: tenant.id } as const;

    // Sem a trava da conta, a segunda bateria no índice único e derrubaria quem chamou.
    const opened = await Promise.all(
      Array.from({ length: 4 }, () => ensureUserVerification(guest.id, scope)),
    );

    const request = await openRequestOf(guest.id, tenant.id);
    expect(opened).toEqual(Array.from({ length: 4 }, () => request.id));
  });

  it("entrar em outra organização, ou sair de uma, não mexe no pedido das demais", async () => {
    const bossX = await createUser(owner);
    const x = await createTenant(bossX, "Organização X");
    const bossY = await createUser(owner);
    const y = await createTenant(bossY, "Organização Y");
    const { user: guest } = await pendingUser();

    await inviteAndAccept(bossY, guest);
    const inY = await openRequestOf(guest.id, y.id);
    await inviteAndAccept(bossX, guest);

    // O pedido de Y é o mesmo de antes, e X ganhou o dela.
    expect((await openRequestOf(guest.id, y.id)).id).toBe(inY.id);
    const inX = await openRequestOf(guest.id, x.id);

    // Y remove a pessoa: só o que era de Y termina.
    const [membership] = await owner<{ id: string }[]>`
      select id from member where organization_id = ${y.id} and user_id = ${guest.id}
    `;
    const removed = await call("DELETE", `/api/team/members/${membership?.id}`, {
      cookie: bossY.cookie,
    });
    expect(removed.status).toBe(200);

    expect((await openRequestOf(guest.id, x.id)).id).toBe(inX.id);
    expect(await openScopes(guest.id)).toEqual([x.id, null].sort());
  });

  it("quem é owner de uma organização responde à plataforma, mesmo entrando em outra por convite", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const { user: otherOwner } = await pendingUser();
    await createTenant(otherOwner, "A organização dele");

    await inviteAndAccept(boss, otherOwner);

    // Nenhuma organização entra na história: só a plataforma libera um owner (P16).
    expect(await openScopes(otherOwner.id)).toEqual([null]);
  });

  it("o cliente que troca o próprio telefone no portal entra na fila da organização", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const first = uniquePhone();
    const { customer, cookie } = await pendingPortalCustomer(boss, first);

    const opened = await openRequestOf(customer.id);
    expect(opened).toMatchObject({
      tenant_id: tenant.id,
      status: "awaiting_manual",
      phone_key: phoneValues(first).phoneKey,
    });
    const mine = await call("GET", "/api/portal/me/phone-verification", { cookie });
    expect(await mine.json()).toMatchObject({
      pending: { status: "awaiting_manual", phoneHint: first.slice(-4) },
    });

    // Trocou de novo: o pedido do número anterior cai e vale o do atual.
    const second = uniquePhone();
    await call("PATCH", "/api/portal/me", { cookie, body: { name: "Cliente", phone: second } });
    const current = await openRequestOf(customer.id);
    expect(current.id).not.toBe(opened.id);
    expect(current.phone_key).toBe(phoneValues(second).phoneKey);
    expect((await requestsOf(customer.id)).find(({ id }) => id === opened.id)?.status).toBe(
      "canceled",
    );
  });

  it("a equipe informa outro número: vale na hora e o pedido aberto é encerrado", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const { customer } = await pendingPortalCustomer(boss);
    await openRequestOf(customer.id);

    const edited = await call("PATCH", `/api/customers/${customer.id}`, {
      cookie: boss.cookie,
      body: { phone: uniquePhone() },
    });
    expect(edited.status).toBe(200);

    expect((await requestsOf(customer.id)).map(({ status }) => status)).toEqual(["canceled"]);
    expect((await customerPhone(customer.id))?.via).toBe("team");
  });
});

describe("o link", () => {
  it("confirma só na sessão da própria conta, uma vez, e o token não fica no banco", async () => {
    const { user } = await pendingUser();
    const request = await openRequestOf(user.id);
    const token = (await issueVerificationToken(request.id)) as string;
    // O prefixo diz à página qual sessão pedir (`u.` a da equipe); o resto são 32 bytes.
    expect(token).toMatch(/^u\.[A-Za-z0-9_-]{43}$/);

    const stored = await openRequestOf(user.id);
    expect(stored.status).toBe("sent");
    expect(stored.token_hash).not.toBeNull();
    expect(stored.token_hash).not.toContain(token);

    // Sem sessão não há o que confirmar.
    expect(
      (await call("POST", "/api/me/phone-verification/confirm", { body: { token } })).status,
    ).toBe(401);
    // Quem recebeu o link de outra pessoa e está na PRÓPRIA conta também não confirma nada:
    // é o ataque de se cadastrar com o número da vítima e esperar ela clicar.
    const victim = await createUser(owner);
    const stolen = await confirmByLink(victim.cookie, token);
    expect(stolen.status).toBe(400);
    expect(await stolen.json()).toMatchObject({ code: "INVALID_OR_EXPIRED" });
    expect((await userPhone(user.id))?.at).toBeNull();
    expect((await userPhone(victim.id))?.at).toBeNull();

    const confirmed = await confirmByLink(user.cookie, token);
    expect(confirmed.status).toBe(200);
    expect(await userPhone(user.id)).toMatchObject({ via: "whatsapp" });
    expect((await requestsOf(user.id)).at(-1)).toMatchObject({
      status: "confirmed",
      token_hash: null,
      confirmed_by: null,
    });

    const again = await confirmByLink(user.cookie, token);
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "INVALID_OR_EXPIRED" });
    const mine = await call("GET", "/api/me/phone-verification", { cookie: user.cookie });
    expect(await mine.json()).toMatchObject({ pending: null });
  });

  it("dois cliques ao mesmo tempo: um confirma, o outro é recusado", async () => {
    const { user } = await pendingUser();
    const token = (await issueVerificationToken((await openRequestOf(user.id)).id)) as string;

    const responses = await Promise.all([
      confirmByLink(user.cookie, token),
      confirmByLink(user.cookie, token),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 400]);
    expect(await userPhone(user.id)).toMatchObject({ via: "whatsapp" });
  });

  it("link novo invalida o anterior; vencido e inventado respondem igual", async () => {
    const { user } = await pendingUser();
    const request = await openRequestOf(user.id);
    const old = (await issueVerificationToken(request.id)) as string;
    const current = (await issueVerificationToken(request.id)) as string;

    const replaced = await confirmByLink(user.cookie, old);
    const invented = await confirmByLink(user.cookie, `u.${"a".repeat(43)}`);
    // `phone_verification` tem RLS forçado: até o dono da tabela precisa do bypass.
    await asPlatform(
      owner,
      (tx) => tx`update phone_verification set expires_at = now() - interval '1 second' where id = ${request.id}`,
    );
    const expired = await confirmByLink(user.cookie, current);

    const bodies = await Promise.all([replaced, invented, expired].map((r) => r.json()));
    expect([replaced, invented, expired].map(({ status }) => status)).toEqual([400, 400, 400]);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    expect((await userPhone(user.id))?.at).toBeNull();

    // Token fora do formato nem chega ao banco.
    expect((await confirmByLink(user.cookie, "curto")).status).toBe(400);
  });

  it("o pedido só vale para o número que o cadastro ainda tem", async () => {
    const { user } = await pendingUser();
    const token = (await issueVerificationToken((await openRequestOf(user.id)).id)) as string;

    // A conta trocou de número depois que o link saiu.
    await setUserPhone(user, uniquePhone(), null);

    expect((await confirmByLink(user.cookie, token)).status).toBe(400);
    expect((await userPhone(user.id))?.at).toBeNull();
  });

  it("quem provou a posse fica com o número: o outro owner volta a pendente, com pedido e auditoria", async () => {
    const phone = uniquePhone();
    const { user: previous } = await confirmedUser(phone);
    await createTenant(previous, "Tinha o número");
    const { user: prover } = await pendingUser(phone);
    await createTenant(prover, "Provou o número");
    // Uma conta com o mesmo número em OUTRO grupo (membro comum de outra organização) não é
    // de nenhum grupo de quem provou: fica como está.
    const bystanderOrg = await createUser(owner);
    const elsewhere = await createTenant(bystanderOrg, "Sem relação");
    const { user: bystander } = await confirmedUser(phone);
    await addMember(owner, elsewhere.id, bystander, "member");

    const token = (await issueVerificationToken((await openRequestOf(prover.id)).id)) as string;
    expect((await confirmByLink(prover.cookie, token)).status).toBe(200);

    expect(await userPhone(prover.id)).toMatchObject({ via: "whatsapp" });
    expect(await userPhone(previous.id)).toMatchObject({ at: null, via: null });
    expect(await userPhone(bystander.id)).toMatchObject({ via: "manual" });
    // Quem perdeu a confirmação volta para a fila da plataforma e fica registrado.
    expect((await openRequestOf(previous.id)).tenant_id).toBeNull();
    const audits = await asPlatform(
      owner,
      (tx) => tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_log
        where action = 'phone.unverified' and target_id = ${previous.id}
      `,
    );
    expect(audits.map(({ metadata }) => metadata)).toEqual([{ reason: "claimed" }]);
  });

  it("na ficha do cliente, confirma a ficha e liga o contato que já escreveu; a conta do portal, não", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const channel = await seedCloudChannel(tenantScope(tenant.id));
    const phone = uniquePhone();
    // O dono do número já conversa com a organização, sem cadastro.
    const seeded = await seedConversation(tenantScope(tenant.id), channel.id, {
      phone: phoneValues(phone).phoneNormalized,
    });
    const { customer, cookie } = await pendingPortalCustomer(boss, phone);
    const token = (await issueVerificationToken((await openRequestOf(customer.id)).id)) as string;

    // Fora da sessão do cliente o link não vale: nem para a equipe, nem para outro cliente.
    expect((await confirmByLink(boss.cookie, token)).status).toBe(400);
    const other = await createCustomer(boss);
    const otherCookie = await inviteAndEnter(boss, mail, other.id, other.email);
    expect((await confirmInPortal(otherCookie, token)).status).toBe(400);
    expect((await customerPhone(customer.id))?.at).toBeNull();

    expect((await confirmInPortal(cookie, token)).status).toBe(200);

    expect(await customerPhone(customer.id)).toMatchObject({ via: "whatsapp" });
    expect(await contactCustomer(seeded.contactId)).toBe(customer.id);
    // O pedido da ficha é da organização, e o link saiu pelo canal dela: a conta do portal é
    // global, e nada do que uma organização atesta a confirma.
    expect(await portalAccount(customer.email)).toEqual({ at: null, via: null });
  });
});

describe("o link de um pedido de organização vale só nela", () => {
  it("fachada que conhece o próprio link não confirma o número fora dela", async () => {
    // O canal por QR Code é o WhatsApp do owner: ele lê o link que a organização envia. Aqui o
    // atacante controla a fachada E a conta, e "prova" o número da vítima com o link dela.
    const attacker = await createUser(owner);
    const facade = await createTenant(attacker, "Fachada com canal");
    const victimPhone = uniquePhone();
    const { user: puppet, key } = await pendingUser(victimPhone);
    await inviteAndAccept(attacker, puppet);

    // Uma organização real, com a vítima como cliente e a conta do atacante na equipe.
    const realOwner = await createUser(owner);
    const real = await createTenant(realOwner, "Organização de verdade");
    const created = await call("POST", "/api/customers", {
      cookie: realOwner.cookie,
      body: { name: "Vítima", phone: victimPhone },
    });
    const record = ((await created.json()) as { customer: { id: string } }).customer;
    await inviteAndAccept(realOwner, puppet);

    const token = (await issueVerificationToken(
      (await openRequestOf(puppet.id, facade.id)).id,
    )) as string;
    expect((await confirmByLink(puppet.cookie, token)).status).toBe(200);

    // Vale na fachada, como a liberação do owner dela: uma linha, sem autor.
    expect(await vouchesOf(puppet.id)).toEqual([facade.id]);
    expect(await teamHolders(facade.id, key)).toEqual([puppet.id]);
    // A conta não muda, e os outros responsáveis seguem esperando.
    expect(await userPhone(puppet.id)).toMatchObject({ at: null, via: null });
    expect(await openScopes(puppet.id)).toEqual([real.id, null].sort());
    // Na organização real, nada: nem o número vale para a equipe, nem a ficha da vítima é ligada.
    expect(await teamHolders(real.id, key)).toEqual([]);
    expect((await customerPhone(record.id))?.user_id).toBeNull();
    const mine = await call("GET", "/api/me/phone-verification", { cookie: puppet.cookie });
    expect(((await mine.json()) as { pending: unknown }).pending).not.toBeNull();
  });

  it("o link do pedido da plataforma vale em todo lugar e encerra os das organizações", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: guest, key, phone } = await pendingUser();
    const existing = await call("POST", "/api/customers", {
      cookie: boss.cookie,
      body: { name: "Também é cliente", phone },
    });
    const record = ((await existing.json()) as { customer: { id: string } }).customer;
    await inviteAndAccept(boss, guest);
    expect(await openScopes(guest.id)).toEqual([tenant.id, null].sort());

    const token = (await issueVerificationToken(
      (await openRequestOf(guest.id, null)).id,
    )) as string;
    expect((await confirmByLink(guest.cookie, token)).status).toBe(200);

    expect(await userPhone(guest.id)).toMatchObject({ via: "whatsapp" });
    expect(await openScopes(guest.id)).toEqual([]);
    expect(await teamHolders(tenant.id, key)).toEqual([guest.id]);
    // Com prova que vale no sistema inteiro, a ficha de cliente da pessoa é ligada (D-9).
    expect((await customerPhone(record.id))?.user_id).toBe(guest.id);
  });

  it("não tira o número de um colega: com outro da equipe já confirmado nele, é recusado", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const phone = uniquePhone();
    const { user: colleague, key } = await confirmedUser(phone);
    await addMember(owner, tenant.id, colleague, "member");
    const { user: guest } = await pendingUser(phone);
    await inviteAndAccept(boss, guest);

    const token = (await issueVerificationToken(
      (await openRequestOf(guest.id, tenant.id)).id,
    )) as string;
    const refused = await confirmByLink(guest.cookie, token);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PHONE_IN_USE" });
    expect(await vouchesOf(guest.id)).toEqual([]);
    expect(await userPhone(colleague.id)).toMatchObject({ via: "manual" });
    expect(await teamHolders(tenant.id, key)).toEqual([colleague.id]);
  });

  it("clicado por quem virou owner: é recusado e o pedido vai para a plataforma", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const elsewhereOwner = await createUser(owner);
    const elsewhere = await createTenant(elsewhereOwner, "Outra");
    const { user: member } = await pendingUser();
    await inviteAndAccept(boss, member);
    const token = (await issueVerificationToken(
      (await openRequestOf(member.id, tenant.id)).id,
    )) as string;
    // Owner de outra organização gravado direto no banco, sem a rota que encaminha o pedido.
    await owner`
      insert into member (organization_id, user_id, role) values (${elsewhere.id}, ${member.id}, 'owner')
    `;

    const response = await confirmByLink(member.cookie, token);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PLATFORM_ONLY" });
    expect(await vouchesOf(member.id)).toEqual([]);
    expect(await openScopes(member.id)).toEqual([null]);
  });
});

describe("liberação à mão pela plataforma", () => {
  it("só o proprietário vê e libera a fila dos que se cadastraram sem convite", async () => {
    const support = await makePlatformUser(owner, "platform_support");
    const { user } = await pendingUser();
    const request = await openRequestOf(user.id);

    const forbidden = await call("GET", "/api/admin/phone-verifications", {
      cookie: support.cookie,
    });
    expect(forbidden.status).toBe(403);

    // A fila é paginada, do mais antigo para o mais novo.
    const queue = await platformQueue();
    const times = queue.map(({ createdAt }) => createdAt);
    expect(times).toEqual([...times].sort());
    expect(queue.find(({ id }) => id === request.id)).toMatchObject({
      subjectType: "user",
      name: "Pessoa Teste",
    });

    expect((await releaseInPlatform(request.id)).status).toBe(200);

    // Vale no sistema inteiro.
    expect(await userPhone(user.id)).toMatchObject({ via: "manual" });
    expect((await requestsOf(user.id)).at(-1)).toMatchObject({
      status: "confirmed",
      confirmed_by: platformOwner.id,
    });

    // Encerrado: não se libera duas vezes.
    expect((await releaseInPlatform(request.id)).status).toBe(404);
  });

  it("a fila mostra quem responde à plataforma: owners e quem não é de organização nenhuma", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const { user: member } = await pendingUser();
    await inviteAndAccept(boss, member);
    const { user: tenantOwner } = await pendingUser();
    await createTenant(tenantOwner, "É owner");

    const ids = (await platformQueue()).map(({ id }) => id);

    // O membro comum tem o pedido da plataforma aberto (é o caminho dele para o link que vale em
    // todo lugar), mas quem o libera à mão é a organização: não entra na fila do proprietário.
    expect(ids).not.toContain((await openRequestOf(member.id, null)).id);
    expect(ids).toContain((await openRequestOf(tenantOwner.id, null)).id);
  });

  it("não prova a posse: com outro owner já confirmado no número, é recusada", async () => {
    const phone = uniquePhone();
    const { user: holder } = await confirmedUser(phone);
    await createTenant(holder, "Tem o número");
    const { user: claimant } = await pendingUser(phone);
    await createTenant(claimant, "Quer o número");
    const request = await openRequestOf(claimant.id);

    const refused = await releaseInPlatform(request.id);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PHONE_IN_USE" });
    expect((await userPhone(claimant.id))?.at).toBeNull();
    expect(await userPhone(holder.id)).toMatchObject({ via: "manual" });
    expect((await openRequestOf(claimant.id)).status).toBe("awaiting_manual");
  });

  it("ninguém libera o próprio telefone", async () => {
    // Um proprietário da plataforma com o telefone pendente e o pedido na fila dele mesmo.
    const self = await makePlatformUser(owner, "platform_owner");
    await waitForBackgroundTasks();
    await setUserPhone(self, uniquePhone(), null);
    await ensureUserVerification(self.id);
    const request = await openRequestOf(self.id);

    const response = await call(
      "POST",
      `/api/admin/phone-verifications/${request.id}/confirm`,
      { cookie: self.cookie },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SELF_CONFIRMATION" });
    expect((await userPhone(self.id))?.at).toBeNull();
  });
});

describe("liberação à mão pela organização", () => {
  it("só o owner libera, só os pedidos dela, e nunca os da plataforma", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const admin = await createUser(owner);
    await addMember(owner, tenant.id, admin, "admin");
    const stranger = await createUser(owner);
    await createTenant(stranger, "Outra organização");

    // Um cliente da organização com o telefone pendente...
    const { customer } = await pendingPortalCustomer(boss);
    const request = await openRequestOf(customer.id);
    // ...e uma conta sem convite, que é da plataforma.
    const { user: unrelated } = await pendingUser();
    const platformRequest = await openRequestOf(unrelated.id);

    expect((await call("GET", "/api/phone-verifications")).status).toBe(401);
    expect(
      (await call("GET", "/api/phone-verifications", { cookie: admin.cookie })).status,
    ).toBe(403);
    expect((await releaseInTenant(admin.cookie, request.id)).status).toBe(403);

    const list = await call("GET", "/api/phone-verifications", { cookie: boss.cookie });
    const { items, total } = (await list.json()) as {
      items: { id: string; name: string | null }[];
      total: number;
    };
    expect(items.map(({ id }) => id)).toEqual([request.id]);
    expect(total).toBe(1);
    expect(items[0]?.name).toBe("Cliente");

    // O owner de outra organização não alcança o pedido; nem este owner, o da plataforma; nem
    // o proprietário da plataforma, o da organização.
    expect((await releaseInTenant(stranger.cookie, request.id)).status).toBe(404);
    expect((await releaseInTenant(boss.cookie, platformRequest.id)).status).toBe(404);
    expect((await releaseInPlatform(request.id)).status).toBe(404);
    expect((await customerPhone(customer.id))?.at).toBeNull();

    expect((await releaseInTenant(boss.cookie, request.id)).status).toBe(200);
    expect(await customerPhone(customer.id)).toMatchObject({ via: "manual" });
  });

  it("na ficha, a liberação não entrega o que depende de prova: nem a conta do portal, nem o contato, nem a ligação com a equipe", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const channel = await seedCloudChannel(tenantScope(tenant.id));
    // Um colaborador com o telefone confirmado, e alguém que já escreveu por esse número.
    const { user: colleague, phone } = await confirmedUser();
    await addMember(owner, tenant.id, colleague, "member");
    const seeded = await seedConversation(tenantScope(tenant.id), channel.id, {
      phone: phoneValues(phone).phoneNormalized,
    });
    // A pessoa do portal DECLARA o número do colaborador.
    const { customer } = await pendingPortalCustomer(boss, phone);

    const released = await releaseInTenant(boss.cookie, (await openRequestOf(customer.id)).id);
    expect(released.status).toBe(200);

    // A ficha fica confirmada para a organização (a escolha é do owner)...
    expect(await customerPhone(customer.id)).toMatchObject({ via: "manual", user_id: null });
    // ...mas a conta global do portal continua pendente, e o histórico do número não muda de mãos.
    expect(await portalAccount(customer.email)).toEqual({ at: null, via: null });
    expect(await contactCustomer(seeded.contactId)).toBeNull();
  });

  it("na conta de um membro, vale só dentro da organização que liberou", async () => {
    // O ataque: uma organização de fachada "confirma" o número da vítima numa conta do atacante.
    const attacker = await createUser(owner);
    const facade = await createTenant(attacker, "Fachada");
    const victimPhone = uniquePhone();
    const { user: puppet, key } = await pendingUser(victimPhone);
    await inviteAndAccept(attacker, puppet);

    // Uma organização real, que tem a vítima como cliente (número confirmado pela equipe).
    const realOwner = await createUser(owner);
    const real = await createTenant(realOwner, "Organização real");
    const created = await call("POST", "/api/customers", {
      cookie: realOwner.cookie,
      body: { name: "Vítima", phone: victimPhone },
    });
    expect(created.status).toBe(201);
    const record = ((await created.json()) as { customer: { id: string } }).customer;

    const released = await releaseInTenant(
      attacker.cookie,
      (await openRequestOf(puppet.id, facade.id)).id,
    );
    expect(released.status).toBe(200);
    // A conta em si não muda: a liberação é uma linha da fachada, e só.
    expect(await userPhone(puppet.id)).toMatchObject({ at: null, via: null });
    expect(await vouchesOf(puppet.id)).toEqual([facade.id]);
    // Para a plataforma o número segue pendente, com o pedido dela aberto.
    expect((await openRequestOf(puppet.id, null)).status).toBe("awaiting_manual");

    // A conta entra na organização real por um convite comum.
    await inviteAndAccept(realOwner, puppet);

    // Nada do que a fachada atestou vale aqui: a ficha da vítima não é ligada à conta...
    expect((await customerPhone(record.id))?.user_id).toBeNull();
    // ...para a equipe da organização real o número não está confirmado...
    expect(await teamHolders(real.id, key)).toEqual([]);
    // ...e ela ganha a própria fila, porque para ela o telefone é pendente.
    expect((await openRequestOf(puppet.id, real.id)).status).toBe("awaiting_manual");

    // Na fachada, vale.
    expect(await teamHolders(facade.id, key)).toEqual([puppet.id]);
  });

  it("a liberação de uma organização não apaga a de outra", async () => {
    const bossX = await createUser(owner);
    const x = await createTenant(bossX, "Libera primeiro");
    const bossY = await createUser(owner);
    const y = await createTenant(bossY, "Libera depois");
    const { user: guest, key } = await pendingUser();
    await inviteAndAccept(bossX, guest);
    await inviteAndAccept(bossY, guest);

    expect((await releaseInTenant(bossX.cookie, (await openRequestOf(guest.id, x.id)).id)).status).toBe(200);
    expect((await releaseInTenant(bossY.cookie, (await openRequestOf(guest.id, y.id)).id)).status).toBe(200);

    expect((await vouchesOf(guest.id)).sort()).toEqual([x.id, y.id].sort());
    expect(await teamHolders(x.id, key)).toEqual([guest.id]);
    expect(await teamHolders(y.id, key)).toEqual([guest.id]);
    // De dentro de X, o que Y atestou nem é visível (RLS de `phone_tenant_vouch`).
    expect(await withTenant(x.id, (tx) => teamPhoneHolders(tx, y.id, key))).toEqual([]);
  });

  it("o /admin troca o número da conta: o que as organizações atestaram sobre o antigo sai", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: guest, phone, key } = await pendingUser();
    await inviteAndAccept(boss, guest);
    await releaseInTenant(boss.cookie, (await openRequestOf(guest.id, tenant.id)).id);
    expect(await vouchesOf(guest.id)).toEqual([tenant.id]);

    const changed = await call("PATCH", `/api/admin/users/${guest.id}`, {
      cookie: platformOwner.cookie,
      body: { phone: uniquePhone() },
    });
    expect(changed.status).toBe(200);
    expect(await vouchesOf(guest.id)).toEqual([]);

    // A conta retoma o número antigo, só declarado: a liberação antiga não revive.
    await setUserPhone(guest, phone, null);
    expect(await teamHolders(tenant.id, key)).toEqual([]);
  });

  it("a ficha liberada à mão não vira a ficha de quem entra na equipe com o número", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    // A pessoa do portal declara o número de um futuro colaborador, e o owner libera a ficha.
    const { user: colleague, phone } = await confirmedUser();
    const { customer } = await pendingPortalCustomer(boss, phone);
    await releaseInTenant(boss.cookie, (await openRequestOf(customer.id)).id);
    expect(await customerPhone(customer.id)).toMatchObject({ via: "manual" });

    // O colaborador, confirmado para o sistema inteiro, entra na equipe.
    await inviteAndAccept(boss, colleague);

    // A ficha é de outra pessoa: não é ligada (e não seria apagada quando ele saísse, D-11).
    expect((await customerPhone(customer.id))?.user_id).toBeNull();
  });

  it("a liberação do owner não liga a ficha de um cliente à conta: isso exige prova de posse", async () => {
    // O colaborador declara o número de um cliente da organização, e o owner o libera.
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const clientPhone = uniquePhone();
    const existing = await call("POST", "/api/customers", {
      cookie: boss.cookie,
      body: { name: "Cliente de verdade", phone: clientPhone },
    });
    const record = ((await existing.json()) as { customer: { id: string } }).customer;
    const { user: insider } = await pendingUser(clientPhone);
    await inviteAndAccept(boss, insider);

    const released = await releaseInTenant(
      boss.cookie,
      (await openRequestOf(insider.id, tenant.id)).id,
    );
    expect(released.status).toBe(200);

    // A ficha do cliente não vira "a ficha do colaborador", nem a que nascer depois.
    expect((await customerPhone(record.id))?.user_id).toBeNull();
    const removedFirst = await call("DELETE", `/api/customers/${record.id}`, {
      cookie: boss.cookie,
    });
    expect(removedFirst.status).toBe(200);
    const again = await call("POST", "/api/customers", {
      cookie: boss.cookie,
      body: { name: "Cadastrado de novo", phone: clientPhone },
    });
    expect(((await again.json()) as { customer: { team: unknown } }).customer.team).toBeNull();
  });

  it("quem vira owner sai da fila das organizações: só a plataforma o libera", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: member } = await pendingUser();
    await inviteAndAccept(boss, member);
    const request = await openRequestOf(member.id, tenant.id);

    // A pessoa abre a própria organização: o pedido sai da fila de onde ela é só membro.
    await createTenant(member, "Agora sou owner");

    expect(await openScopes(member.id)).toEqual([null]);
    expect((await releaseInTenant(boss.cookie, request.id)).status).toBe(404);
    expect(await vouchesOf(member.id)).toEqual([]);
  });

  it("virou owner sem passar pelos ganchos: a organização recebe PLATFORM_ONLY e o pedido é encaminhado", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const elsewhereOwner = await createUser(owner);
    const elsewhere = await createTenant(elsewhereOwner, "Outra");
    const { user: member } = await pendingUser();
    await inviteAndAccept(boss, member);
    const request = await openRequestOf(member.id, tenant.id);
    // Owner de outra organização gravado direto no banco, sem a rota que encaminha o pedido.
    await owner`
      insert into member (organization_id, user_id, role) values (${elsewhere.id}, ${member.id}, 'owner')
    `;

    const response = await releaseInTenant(boss.cookie, request.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PLATFORM_ONLY" });
    expect(await vouchesOf(member.id)).toEqual([]);
    // Não fica encalhado onde ninguém pode liberar: agora só a plataforma responde.
    expect(await openScopes(member.id)).toEqual([null]);
  });

  it("o owner não libera o próprio telefone, nem o de quem não é mais da equipe", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: guest } = await pendingUser();
    const memberId = await addMember(owner, tenant.id, guest, "member");
    await ensureUserVerification(guest.id, { kind: "tenant", tenantId: tenant.id });
    const request = await openRequestOf(guest.id, tenant.id);

    // O próprio membro, com um papel que libera, tenta se liberar.
    await owner`update member set role = 'owner' where id = ${memberId}`;
    const self = await releaseInTenant(guest.cookie, request.id);
    expect(self.status).toBe(403);
    expect(await self.json()).toMatchObject({ code: "SELF_CONFIRMATION" });

    // Saiu da equipe: o pedido deixa de valer para a organização.
    await owner`delete from member where id = ${memberId}`;
    const stale = await releaseInTenant(boss.cookie, request.id);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "VERIFICATION_STALE" });
    expect(await vouchesOf(guest.id)).toEqual([]);
  });

  it("membro removido: a liberação da organização cai, com registro, e a plataforma segue respondendo", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: guest, key } = await pendingUser();
    await inviteAndAccept(boss, guest);
    const released = await releaseInTenant(
      boss.cookie,
      (await openRequestOf(guest.id, tenant.id)).id,
    );
    expect(released.status).toBe(200);
    expect(await vouchesOf(guest.id)).toEqual([tenant.id]);

    const [membership] = await owner<{ id: string }[]>`
      select id from member where organization_id = ${tenant.id} and user_id = ${guest.id}
    `;
    const removed = await call("DELETE", `/api/team/members/${membership?.id}`, {
      cookie: boss.cookie,
    });
    expect(removed.status).toBe(200);

    expect(await vouchesOf(guest.id)).toEqual([]);
    expect(await teamHolders(tenant.id, key)).toEqual([]);
    expect(await openScopes(guest.id)).toEqual([null]);
    const audits = await asPlatform(
      owner,
      (tx) => tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_log
        where action = 'phone.unverified' and target_id = ${guest.id}
      `,
    );
    expect(audits.map(({ metadata }) => metadata)).toEqual([{ reason: "left_tenant" }]);
  });

  it("organização excluída: as liberações dela caem e os pedidos voltam à plataforma", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const { user: vouched, key } = await pendingUser();
    const { user: waiting } = await pendingUser();
    await inviteAndAccept(boss, vouched);
    await inviteAndAccept(boss, waiting);
    await releaseInTenant(boss.cookie, (await openRequestOf(vouched.id, tenant.id)).id);
    expect(await teamHolders(tenant.id, key)).toEqual([vouched.id]);

    await withPlatformScope("teste: exclusão da organização", (tx) =>
      releaseTenantPhoneResponsibility(tx, tenant.id),
    );

    expect(await vouchesOf(vouched.id)).toEqual([]);
    expect(await openScopes(vouched.id)).toEqual([null]);
    expect(await openScopes(waiting.id)).toEqual([null]);
  });

});

describe("portal: o que uma organização atesta não vale em outra", () => {
  it("a ficha liberada por uma organização não nasce confirmada em outra", async () => {
    // O ataque: o owner de uma organização de fachada libera o número da vítima na PRÓPRIA
    // ficha de portal, e reaproveita a confirmação de e-mail para ganhar uma ficha em outra.
    const attacker = await createUser(owner);
    const facade = await createTenant(attacker, "Fachada do portal");
    await allowSelfSignup(facade.id);
    const realOwner = await createUser(owner);
    const real = await createTenant(realOwner, "Organização com portal");
    await allowSelfSignup(real.id);

    const email = customerEmail();
    const signup = await call("POST", "/api/portal/auth-ext/sign-up", {
      body: {
        name: "Atacante",
        email,
        password: "Senha-do-portal-1",
        org: facade.slug,
        phone: uniquePhone(),
        acceptTerms: true,
        termsVersion: "2026-11",
      },
    });
    expect(signup.status).toBe(200);
    await waitForBackgroundTasks();
    const token = decodeURIComponent(
      mail.sent
        .filter((m) => m.to === email)
        .at(-1)
        ?.text.match(/token=([^&\s"]+)/)?.[1] as string,
    );

    const first = await call("POST", "/api/portal/auth/verify-email", {
      body: { token, org: facade.slug },
    });
    expect(first.status).toBe(200);
    const facadeRecords = await asPlatform(
      owner,
      (tx) => tx<{ id: string }[]>`
        select id from customer where tenant_id = ${facade.id} and email = ${email}
      `,
    );
    expect(facadeRecords).toHaveLength(1);
    const facadeRecord = facadeRecords[0] as { id: string };

    // Pendente na fachada; o owner dela libera à mão.
    const released = await releaseInTenant(
      attacker.cookie,
      (await openRequestOf(facadeRecord.id)).id,
    );
    expect(released.status).toBe(200);
    expect(await customerPhone(facadeRecord.id)).toMatchObject({ via: "manual" });
    // A conta global do portal NÃO fica confirmada pela liberação de uma organização.
    expect(await portalAccount(email)).toEqual({ at: null, via: null });

    // O mesmo token de e-mail, agora apontado para a organização real.
    await call("POST", "/api/portal/auth/verify-email", { body: { token, org: real.slug } });
    const realRecords = await asPlatform(
      owner,
      (tx) => tx<({ id: string } & Verification)[]>`
        select id, phone_verified_at as at, phone_verified_via as via
        from customer where tenant_id = ${real.id} and email = ${email}
      `,
    );

    // A ficha que nasce na organização real nasce pendente e na fila DELA.
    expect(realRecords).toHaveLength(1);
    expect(realRecords[0]).toMatchObject({ at: null, via: null });
    expect((await openRequestOf(realRecords[0]?.id as string)).tenant_id).toBe(real.id);
  });
});

describe("limpeza", () => {
  it("excluir o cliente apaga os pedidos dele", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const { customer } = await pendingPortalCustomer(boss);
    await openRequestOf(customer.id);

    const removed = await call("DELETE", `/api/customers/${customer.id}`, {
      cookie: boss.cookie,
    });
    expect(removed.status).toBe(200);

    expect(await requestsOf(customer.id)).toEqual([]);
  });

  it("a manutenção tira os encerrados antigos e os sem cadastro, e devolve à fila o link vencido", async () => {
    const { user: old } = await pendingUser();
    const { user: expired } = await pendingUser();
    const { user: gone } = await pendingUser();
    const oldRequest = await openRequestOf(old.id);
    const expiredRequest = await openRequestOf(expired.id);
    await issueVerificationToken(expiredRequest.id);
    await asPlatform(owner, async (tx) => {
      await tx`
        update phone_verification set status = 'canceled', updated_at = now() - interval '40 days'
        where id = ${oldRequest.id}
      `;
      await tx`
        update phone_verification set expires_at = now() - interval '1 minute'
        where id = ${expiredRequest.id}
      `;
    });
    // A conta some sem passar por quem apaga os pedidos (`subject_id` não tem FK).
    await owner`delete from "user" where id = ${gone.id}`;
    expect(await openRequests(gone.id)).toHaveLength(1);

    expect(await prunePhoneVerifications()).toBeGreaterThanOrEqual(2);

    // Só o encerrado há mais de 30 dias: o cancelado recente (o do cadastro) continua.
    expect((await requestsOf(old.id)).map(({ id }) => id)).not.toContain(oldRequest.id);
    expect(await requestsOf(gone.id)).toEqual([]);
    expect(await openRequestOf(expired.id)).toMatchObject({
      status: "awaiting_manual",
      token_hash: null,
    });
  });

  it("a manutenção tira a liberação de quem saiu da equipe ou trocou de número", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const vouch = async () => {
      const { user } = await pendingUser();
      await inviteAndAccept(boss, user);
      await releaseInTenant(boss.cookie, (await openRequestOf(user.id, tenant.id)).id);
      expect(await vouchesOf(user.id)).toEqual([tenant.id]);
      return user;
    };
    const stays = await vouch();
    const left = await vouch();
    const renumbered = await vouch();
    // Alguém que só tinha o pedido na fila da organização.
    const { user: waiting } = await pendingUser();
    await inviteAndAccept(boss, waiting);
    await openRequestOf(waiting.id, tenant.id);
    // Por caminhos que não passam pelos ganchos.
    await owner`
      delete from member where organization_id = ${tenant.id} and user_id in (${left.id}, ${waiting.id})
    `;
    await setUserPhone(renumbered, uniquePhone(), null);

    await prunePhoneVerifications();

    expect(await vouchesOf(stays.id)).toEqual([tenant.id]);
    expect(await vouchesOf(left.id)).toEqual([]);
    expect(await vouchesOf(renumbered.id)).toEqual([]);
    // O pedido que ficaria encalhado na fila da organização é encerrado; o da plataforma segue.
    expect(await openScopes(waiting.id)).toEqual([null]);
  });

  it("nas contas, o banco só aceita as formas que valem no sistema inteiro", async () => {
    const { user } = await pendingUser();
    const { customer } = await pendingPortalCustomer(await tenantBoss());

    for (const via of ["team", "inbound"]) {
      await expect(
        owner`update "user" set phone_verified_at = now(), phone_verified_via = ${via} where id = ${user.id}`,
      ).rejects.toThrow(/user_phone_via_global/);
      await expect(
        owner`update portal_user set phone_verified_at = now(), phone_verified_via = ${via} where email = ${customer.email}`,
      ).rejects.toThrow(/portal_user_phone_via_global/);
    }
  });
});

async function tenantBoss() {
  const boss = await createUser(owner);
  await createTenant(boss);
  return boss;
}
