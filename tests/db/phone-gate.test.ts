import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import { PORTAL_PHONE_PENDING_ALLOWED, TEAM_PHONE_PENDING_ALLOWED } from "@/api/phone-gate";
import { withScope } from "@/db/rls";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { resetEnvForTests } from "@/lib/env";
import { autoLinkContact } from "@/lib/inbox/contacts";
import { phoneValues } from "@/lib/phone/columns";
import { teamPhoneGatePasses } from "@/lib/phone/gate";
import { asPlatform, makePlatformUser } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, tenantScope } from "./channels-helpers";
import { seedConversation } from "./inbox-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, createCustomer, customerEmail, inviteAndEnter } from "./portal-helpers";
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
 * Portão de telefone (`docs/specs/pre-producao/spec.md`, T3 e D-2). Com
 * `PHONE_VERIFICATION_REQUIRED=true`, a sessão cujo telefone não vale recebe 403 `PHONE_UNVERIFIED`
 * em tudo, menos na lista explícita de `src/api/phone-gate.ts`.
 *
 * O resto do `test:db` roda com a variável desligada (`vitest.db.config.ts`): os outros arquivos
 * criam contas com telefone pendente para conferir outras regras. Aqui ela liga a cada teste.
 *
 * Os cenários montam o estado no banco (liberação, confirmação) e conferem o efeito pela API.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;

let ownerA: TestUser;
let ownerB: TestUser;
let tenantA: string;
let tenantB: string;
/** Membro comum de A e de B, com o telefone pendente. */
let member: TestUser;

function setPhoneRequired(value: "true" | "false") {
  process.env.PHONE_VERIFICATION_REQUIRED = value;
  resetEnvForTests();
}

function setEmailRequired(value: "true" | "false") {
  process.env.EMAIL_VERIFICATION_REQUIRED = value;
  resetEnvForTests();
}

/** Número próprio, sem confirmação: os helpers dão a todos o mesmo número. */
async function pendingPhone(user: TestUser) {
  const phone = phoneValues(uniquePhone());
  await owner`
    update "user" set phone = ${phone.phone}, phone_normalized = ${phone.phoneNormalized},
      phone_key = ${phone.phoneKey}, phone_verified_at = null, phone_verified_via = null
    where id = ${user.id}
  `;
  await asPlatform(owner, (tx) => tx`delete from phone_tenant_vouch where user_id = ${user.id}`);
  return phone;
}

/** A confirmação que vale no sistema inteiro (a do proprietário da plataforma). */
async function confirmGlobally(user: TestUser) {
  await pendingPhone(user);
  await owner`
    update "user" set phone_verified_at = now(), phone_verified_via = 'manual' where id = ${user.id}
  `;
}

/** A liberação do owner de uma organização, para o número atual da conta. */
const vouch = (user: TestUser, tenantId: string) =>
  asPlatform(
    owner,
    (tx) => tx`
      insert into phone_tenant_vouch (user_id, tenant_id, phone_key)
      select id, ${tenantId}, phone_key from "user" where id = ${user.id}
      on conflict (user_id, tenant_id) do update set phone_key = excluded.phone_key
    `,
  );

const activate = async (user: TestUser, tenantId: string) => {
  const response = await call("POST", "/api/tenant/active", { cookie: user.cookie, body: { tenantId } });
  expect(response.status).toBe(200);
};

async function expectBlocked(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "PHONE_UNVERIFIED" });
}

async function codeOf(response: Response) {
  const body = (await response.clone().json().catch(() => null)) as { code?: string } | null;
  return body?.code;
}

beforeAll(async () => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
  setPhoneRequired("false");

  ownerA = await createUser(owner);
  tenantA = (await createTenant(ownerA, "Portão A")).id;
  ownerB = await createUser(owner);
  tenantB = (await createTenant(ownerB, "Portão B")).id;
  await confirmGlobally(ownerA);
  await confirmGlobally(ownerB);

  member = await createUser(owner);
  await addMember(owner, tenantA, member, "member");
  await addMember(owner, tenantB, member, "member");
  await pendingPhone(member);
});

afterEach(() => {
  setPhoneRequired("false");
  setEmailRequired("true");
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  delete process.env.PHONE_VERIFICATION_REQUIRED;
  resetEnvForTests();
  await cleanUpChannels(owner, [tenantA, tenantB]);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("com PHONE_VERIFICATION_REQUIRED=true, toda rota privada", () => {
  /**
   * Rotas que não passam por `requireAuth` nem por `requirePortalAuth`: saúde, webhooks (assinados),
   * o Better Auth (a própria conta) e as páginas públicas de login, cadastro e convite. Rota nova
   * fora desta lista entra na conferência sozinha e precisa responder `PHONE_UNVERIFIED`.
   */
  const PUBLIC = new Set([
    "GET /api/health",
    "GET /api/ready",
    "POST /api/contact",
    "POST /api/csp-report",
    "GET /api/invitations/:id",
    "GET /api/inbox/media-out/:token",
    "GET /api/webhooks/whatsapp/cloud/:key",
    "POST /api/webhooks/whatsapp/cloud/:key",
    "POST /api/webhooks/whatsapp/evolution/:secret",
    "POST /api/webhooks/email/:provider",
    "POST /api/webhooks/payments/:provider",
    "GET /api/auth/*",
    "POST /api/auth/*",
    "POST /api/auth/sign-in/email",
    "POST /api/auth/sign-up/email",
    "GET /api/auth/verify-email",
    "POST /api/auth/verify-email",
    "POST /api/auth-ext/forgot-password",
    "POST /api/auth-ext/resend-verification",
    "GET /api/portal/auth/*",
    "POST /api/portal/auth/*",
    "POST /api/portal/auth/sign-in/email",
    "GET /api/portal/auth/magic-link/verify",
    "POST /api/portal/auth/magic-link/verify",
    "GET /api/portal/auth/verify-email",
    "POST /api/portal/auth/verify-email",
    "GET /api/portal/auth-ext/org/:slug",
    "POST /api/portal/auth-ext/magic-link",
    "POST /api/portal/auth-ext/sign-up",
  ]);

  const registered = () => {
    const seen = new Map<string, { method: string; path: string }>();
    for (const { method, path } of api.routes) {
      if (method === "ALL" || !path.startsWith("/api/")) continue;
      seen.set(`${method} ${path}`, { method, path });
    }
    return [...seen.values()];
  };

  const concrete = (path: string) =>
    path.replace(/:[A-Za-z]+(\{[^}]*\})?\??/g, randomUUID()).replace(/\*/g, "x");

  it("responde 403 PHONE_UNVERIFIED à equipe e ao portal pendentes; só a lista passa", async () => {
    const email = customerEmail();
    const created = await createCustomer(ownerA, { email });
    const portalCookie = await inviteAndEnter(ownerA, mail, created.id, email);
    // Cliente criado pela equipe nasce `team` (confirmado): aqui, a ficha volta a pendente.
    await asPlatform(
      owner,
      (tx) => tx`update customer set phone_verified_at = null, phone_verified_via = null where id = ${created.id}`,
    );

    setPhoneRequired("true");
    // Na organização B, onde ninguém o liberou.
    await activate(member, tenantB);

    const failures: string[] = [];
    let checked = 0;

    for (const { method, path } of registered()) {
      if (PUBLIC.has(`${method} ${path}`)) continue;

      const portal = path.startsWith("/api/portal/");
      const url = concrete(path);
      const response = await call(method, url, {
        cookie: portal ? portalCookie : member.cookie,
        body: method === "GET" ? undefined : {},
      });
      const code = await codeOf(response);
      const list = portal ? PORTAL_PHONE_PENDING_ALLOWED : TEAM_PHONE_PENDING_ALLOWED;
      const allowed = list.some((entry) => entry.method === method && entry.path.test(url));
      checked += 1;

      if (allowed && code === "PHONE_UNVERIFIED") failures.push(`${method} ${path}: barrada, mas está na lista`);
      if (!allowed && (response.status !== 403 || code !== "PHONE_UNVERIFIED")) {
        failures.push(`${method} ${path}: ${response.status} ${code ?? ""}`);
      }
    }

    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(150);
  });

  it("cada entrada da lista do que passa é uma rota que existe", () => {
    const routes = registered().map(({ method, path }) => ({ method, url: concrete(path) }));

    for (const entry of [...TEAM_PHONE_PENDING_ALLOWED, ...PORTAL_PHONE_PENDING_ALLOWED]) {
      expect(
        routes.some(({ method, url }) => method === entry.method && entry.path.test(url)),
        `${entry.method} ${entry.path}`,
      ).toBe(true);
    }
  });

  it("as rotas da lista funcionam para a conta pendente", async () => {
    setPhoneRequired("true");
    await activate(member, tenantB);

    const state = await call("GET", "/api/me/phone-verification", { cookie: member.cookie });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ confirmedGlobally: false, answersTo: "organization" });

    const resend = await call("POST", "/api/me/phone-verification/resend", {
      cookie: member.cookie,
      body: { responsible: tenantB },
    });
    expect(resend.status).toBe(202);

    const confirm = await call("POST", "/api/me/phone-verification/confirm", {
      cookie: member.cookie,
      body: { token: `u.${"a".repeat(43)}` },
    });
    expect(confirm.status).toBe(400);
    expect(await codeOf(confirm)).toBe("INVALID_OR_EXPIRED");

    // Sair é do Better Auth: não passa pelo portão.
    const other = await createUser(owner);
    await addMember(owner, tenantB, other, "member");
    await pendingPhone(other);
    const signOut = await call("POST", "/api/auth/sign-out", { cookie: other.cookie, body: {} });
    expect(signOut.status).toBe(200);
  });

  it("leituras do plugin admin do Better Auth (dados de outras pessoas) também têm o portão", async () => {
    const support = await makePlatformUser(owner, "platform_support");
    await pendingPhone(support);
    setPhoneRequired("true");

    await expectBlocked(await call("GET", "/api/auth/admin/list-users", { cookie: support.cookie }));
    // A própria sessão continua legível: é por ela que a tela sabe quem é.
    expect((await call("GET", "/api/auth/get-session", { cookie: support.cookie })).status).toBe(200);

    await confirmGlobally(support);
    expect((await call("GET", "/api/auth/admin/list-users", { cookie: support.cookie })).status).toBe(200);
  });
});

describe("predicado do portão", () => {
  it("membro liberado só em A passa em A e não em B, nem sem organização ativa", async () => {
    await vouch(member, tenantA);
    setPhoneRequired("true");

    await activate(member, tenantA);
    expect((await call("GET", "/api/tenant", { cookie: member.cookie })).status).toBe(200);
    expect((await call("GET", "/api/me", { cookie: member.cookie })).status).toBe(200);

    await activate(member, tenantB);
    await expectBlocked(await call("GET", "/api/tenant", { cookie: member.cookie }));

    await owner`update session set active_organization_id = null where user_id = ${member.id}`;
    await expectBlocked(await call("GET", "/api/me", { cookie: member.cookie }));

    await pendingPhone(member);
  });

  it("a liberação vale para o número de quando foi dada: trocado o número, cai", async () => {
    await vouch(member, tenantA);
    await pendingPhone(member);
    setPhoneRequired("true");

    await activate(member, tenantA);
    await expectBlocked(await call("GET", "/api/tenant", { cookie: member.cookie }));
  });

  it("owner com liberação de organização, mas sem a confirmação do sistema, não passa", async () => {
    const pendingOwner = await createUser(owner);
    const own = (await createTenant(pendingOwner, "Portão C")).id;
    await addMember(owner, tenantA, pendingOwner, "member");
    await pendingPhone(pendingOwner);
    await vouch(pendingOwner, own);
    await vouch(pendingOwner, tenantA);
    setPhoneRequired("true");

    await activate(pendingOwner, own);
    await expectBlocked(await call("GET", "/api/tenant", { cookie: pendingOwner.cookie }));
    // Nem como membro comum de outra organização: owner responde à plataforma (P16).
    await activate(pendingOwner, tenantA);
    await expectBlocked(await call("GET", "/api/tenant", { cookie: pendingOwner.cookie }));

    await confirmGlobally(pendingOwner);
    expect((await call("GET", "/api/tenant", { cookie: pendingOwner.cookie })).status).toBe(200);
  });

  it("equipe da plataforma liberada por uma organização não passa nem nela nem no /admin", async () => {
    const support = await makePlatformUser(owner, "platform_support");
    await addMember(owner, tenantA, support, "member");
    await pendingPhone(support);
    await vouch(support, tenantA);
    setPhoneRequired("true");

    await activate(support, tenantA);
    await expectBlocked(await call("GET", "/api/tenant", { cookie: support.cookie }));
    await expectBlocked(await call("GET", "/api/admin/tenants", { cookie: support.cookie }));

    await confirmGlobally(support);
    expect((await call("GET", "/api/admin/tenants", { cookie: support.cookie })).status).toBe(200);
  });

  it("portal: vale a ficha da organização em uso", async () => {
    const email = customerEmail();
    const inA = await createCustomer(ownerA, { email });
    const inB = await createCustomer(ownerB, { email });
    await inviteAndEnter(ownerB, mail, inB.id, email);
    const cookie = await inviteAndEnter(ownerA, mail, inA.id, email);
    await asPlatform(
      owner,
      (tx) => tx`update customer set phone_verified_at = null, phone_verified_via = null where id = ${inA.id}`,
    );
    setPhoneRequired("true");

    // A sessão está em A (último convite): a ficha de A está pendente.
    await expectBlocked(await call("GET", "/api/portal/customer", { cookie }));
    const state = await call("GET", "/api/portal/me/phone-verification", { cookie });
    expect(state.status).toBe(200);

    // Trocar de organização passa pelo portão; em B a ficha está confirmada (`team`).
    expect(
      (await call("POST", "/api/portal/active-tenant", { cookie, body: { tenantId: tenantB } })).status,
    ).toBe(200);
    expect((await call("GET", "/api/portal/customer", { cookie })).status).toBe(200);
    expect((await call("GET", "/api/portal/me", { cookie })).status).toBe(200);
  });

  it("portal: corrigir o número passa pelo portão e deixa a ficha pendente", async () => {
    const email = customerEmail();
    const created = await createCustomer(ownerA, { email });
    const cookie = await inviteAndEnter(ownerA, mail, created.id, email);
    await asPlatform(
      owner,
      (tx) => tx`update customer set phone_verified_at = null, phone_verified_via = null where id = ${created.id}`,
    );
    setPhoneRequired("true");

    const fixed = await call("PATCH", "/api/portal/me", {
      cookie,
      body: { name: "Cliente Teste", phone: uniquePhone() },
    });
    expect(fixed.status).toBe(200);
    await expectBlocked(await call("GET", "/api/portal/customer", { cookie }));
  });

  it("a sessão personificada sobre uma conta pendente vê o portão e consegue sair", async () => {
    const support = await makePlatformUser(owner, "platform_support");
    await confirmGlobally(support);
    const target = await createUser(owner);
    await addMember(owner, tenantA, target, "member");
    await pendingPhone(target);
    const grant = await call("POST", "/api/tenant/support-grant", {
      cookie: ownerA.cookie,
      body: { hours: 1 },
    });
    expect(grant.status).toBe(201);
    setPhoneRequired("true");

    const started = await call("POST", "/api/admin/impersonate", {
      cookie: support.cookie,
      body: { userId: target.id, tenantId: tenantA, reason: "Teste do portão de telefone" },
    });
    expect(started.status).toBe(200);
    const cookie = applyCookies(support.cookie, started);

    await expectBlocked(await call("GET", "/api/tenant", { cookie }));
    expect((await call("GET", "/api/me/phone-verification", { cookie })).status).toBe(200);
    expect((await call("POST", "/api/admin/stop-impersonating", { cookie, body: {} })).status).toBe(200);
  });
});

describe("com PHONE_VERIFICATION_REQUIRED=false", () => {
  it("a conta pendente entra, vê o aviso, e o vínculo automático espera a confirmação", async () => {
    const phone = await pendingPhone(member);
    await activate(member, tenantB);

    expect((await call("GET", "/api/tenant", { cookie: member.cookie })).status).toBe(200);
    const me = await call("GET", "/api/me", { cookie: member.cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ phonePending: true });

    const channel = await seedCloudChannel(tenantScope(tenantB));
    const thread = await seedConversation(tenantScope(tenantB), channel.id, {
      phone: phone.phoneNormalized,
    });
    const link = (contactId: string) =>
      withScope(tenantScope(tenantB), (tx) =>
        autoLinkContact(tx, tenantScope(tenantB), contactId, phone.phoneKey),
      );
    expect(await link(thread.contactId)).toBeNull();

    // Liberado por B, passa a valer ali: o aviso some e o vínculo acontece.
    await vouch(member, tenantB);
    expect(await (await call("GET", "/api/me", { cookie: member.cookie })).json()).toMatchObject({
      phonePending: false,
    });
    expect(await link(thread.contactId)).toEqual({ userId: member.id });

    await pendingPhone(member);
  });
});

describe("junto com EMAIL_VERIFICATION_REQUIRED", () => {
  it("e-mail antes do telefone, inclusive nas rotas que confirmam o telefone", async () => {
    await pendingPhone(member);
    await activate(member, tenantB);
    setPhoneRequired("true");
    await owner`update "user" set email_verified = false where id = ${member.id}`;

    try {
      setEmailRequired("true");
      for (const path of ["/api/tenant", "/api/me/phone-verification"]) {
        const response = await call("GET", path, { cookie: member.cookie });
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe("EMAIL_NOT_VERIFIED");
      }

      // Desligada a do e-mail, sobra a do telefone.
      setEmailRequired("false");
      await expectBlocked(await call("GET", "/api/tenant", { cookie: member.cookie }));
      expect((await call("GET", "/api/me/phone-verification", { cookie: member.cookie })).status).toBe(200);

      // Com o telefone valendo e a do e-mail ligada, sobra a do e-mail.
      setEmailRequired("true");
      await vouch(member, tenantB);
      expect(await codeOf(await call("GET", "/api/tenant", { cookie: member.cookie }))).toBe(
        "EMAIL_NOT_VERIFIED",
      );
    } finally {
      await owner`update "user" set email_verified = true where id = ${member.id}`;
      await pendingPhone(member);
    }
  });
});

describe("primeiro proprietário e contas antigas", () => {
  it("promovido pelo SQL da documentação, entra com a exigência ligada", async () => {
    const promoted = await createUser(owner);
    await pendingPhone(promoted);
    setPhoneRequired("true");

    // Só o papel: o telefone do cadastro está pendente e não haveria quem o liberasse.
    await owner`update "user" set role = 'platform_owner' where id = ${promoted.id}`;
    await expectBlocked(await call("GET", "/api/admin/tenants", { cookie: promoted.cookie }));

    // O comando de `tech/08-auth.md` e do README: papel e telefone juntos.
    await owner`
      update "user" set role = 'platform_owner', phone_verified_at = now(), phone_verified_via = 'manual'
      where email = ${promoted.email}
    `;
    expect((await call("GET", "/api/admin/tenants", { cookie: promoted.cookie })).status).toBe(200);
  });

  it("conta com o telefone confirmado como a migration 0035 deixou as antigas passa sem organização", async () => {
    const legacy = await createUser(owner);
    await confirmGlobally(legacy);

    expect(await teamPhoneGatePasses(legacy.id, null)).toBe(true);
  });
});
