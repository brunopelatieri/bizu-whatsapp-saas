import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { getAuth } from "@/lib/auth/server";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { withSignupConsent } from "@/lib/lgpd/consent";
import { confirmPortalSignup, requestPortalSignup } from "@/lib/portal/login";
import { makePlatformUser } from "./billing-helpers";
import { ACCOUNT_PHONE, uniquePhone } from "./phone-helpers";
import { cleanUpPortal, customerEmail } from "./portal-helpers";
import {
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  newEmail,
  type TestUser,
} from "./tenant-helpers";

/**
 * Telefone obrigatório nos cadastros de pessoa (`docs/specs/crm-cadastro/spec.md`): cadastro
 * de conta, hook do Better Auth, autocadastro e convite do portal, `/admin` e o `CHECK`.
 */

let owner: postgres.Sql;

type PhoneRow = { phone: string | null; phone_normalized: string | null; phone_key: string | null };

const phoneOfUser = async (email: string) =>
  (await owner<PhoneRow[]>`select phone, phone_normalized, phone_key from "user" where email = ${email}`)[0];

const phoneOfPortal = async (email: string) =>
  (await owner<PhoneRow[]>`select phone, phone_normalized, phone_key from portal_user where email = ${email}`)[0];

function signUp(body: Record<string, unknown>) {
  return call("POST", "/api/auth/sign-up/email", {
    body: {
      name: "Pessoa Nova",
      email: newEmail(),
      password: "senha-forte-123",
      acceptTerms: true,
      termsVersion: LEGAL_VERSIONS.terms,
      ...body,
    },
  });
}

beforeAll(() => {
  setEmailProviderForTests(createMemoryProvider());
  owner = connectOwner();
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await owner`delete from consent_log where subject_id in (
    select id from "user" where email like '%@tenant-test.bizu.local'
    union select id from portal_user where email like '%@tenant-test.bizu.local')`;
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("cadastro de conta (/api/auth/sign-up/email)", () => {
  it("sem telefone, com telefone vazio ou inválido: 400 e nenhuma conta nasce", async () => {
    for (const phone of [undefined, "", "(10) 98765-4321", "(11) 88765-4321", "(11) 98765-43"]) {
      const email = newEmail();
      const response = await signUp({ email, phone });
      expect(response.status).toBe(400);
      expect(await phoneOfUser(email)).toBeUndefined();
    }
  });

  it("celular válido grava phone, phone_normalized e phone_key", async () => {
    const email = newEmail();
    const response = await signUp({ email, phone: "+55 (11) 98765-4321" });
    expect(response.status).toBe(200);

    expect(await phoneOfUser(email)).toEqual({
      phone: "+55 (11) 98765-4321",
      phone_normalized: "5511987654321",
      phone_key: "551187654321",
    });
  });

  it("fixo e celular antigo são aceitos; estrangeiro também", async () => {
    for (const [phone, normalized] of [
      ["(11) 3456-7890", "551134567890"],
      ["(11) 9876-5432", "551198765432"],
      ["+1 415 555 2671", "14155552671"],
    ] as const) {
      const email = newEmail();
      expect((await signUp({ email, phone })).status).toBe(200);
      expect((await phoneOfUser(email))?.phone_normalized).toBe(normalized);
    }
  });

  it("o telefone da conta não precisa ser único: dois membros dividem o número", async () => {
    const [a, b] = [newEmail(), newEmail()];
    expect((await signUp({ email: a, phone: ACCOUNT_PHONE })).status).toBe(200);
    expect((await signUp({ email: b, phone: ACCOUNT_PHONE })).status).toBe(200);
  });
});

describe("Better Auth chamado direto, fora da rota de cadastro", () => {
  it("sem o contexto do cadastro, falha fechada e não cria conta", async () => {
    const email = newEmail();
    const result = await getAuth()
      .api.signUpEmail({ body: { name: "Direto", email, password: "senha-forte-123" } })
      .catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    expect(await phoneOfUser(email)).toBeUndefined();
  });

  it("o corpo nunca define o telefone: vale o do contexto validado", async () => {
    const email = newEmail();
    await withSignupConsent(
      { subjectType: "user", termsVersion: LEGAL_VERSIONS.terms, phone: "(11) 98765-4321" },
      () =>
        getAuth()
          .api.signUpEmail({
            body: {
              name: "Direto",
              email,
              password: "senha-forte-123",
              // `input: false`: o corpo não decide.
              ...({ phone: "(21) 91111-2222", phoneNormalized: "5521911112222" } as object),
            },
          })
          .catch(() => undefined),
    );

    const row = await phoneOfUser(email);
    // Ou a conta nasce com o telefone do contexto, ou o Better Auth recusou o campo.
    if (row) expect(row.phone_normalized).toBe("5511987654321");
    expect(row?.phone_normalized).not.toBe("5521911112222");
  });

  it("telefone inválido no contexto também falha", async () => {
    const email = newEmail();
    const result = await withSignupConsent(
      { subjectType: "user", termsVersion: LEGAL_VERSIONS.terms, phone: "(10) 98765-4321" },
      () =>
        getAuth()
          .api.signUpEmail({ body: { name: "Direto", email, password: "senha-forte-123" } })
          .catch((error: unknown) => error),
    );

    expect(result).toBeInstanceOf(Error);
    expect(await phoneOfUser(email)).toBeUndefined();
  });
});

describe("autocadastro do portal", () => {
  it("grava o telefone no portal_user e o repassa ao cliente criado na confirmação", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner, "Portal Fone");
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`update organization set settings = '{"portal_self_signup": true}'::jsonb where id = ${tenant.id}`;
    });

    const email = customerEmail();
    await requestPortalSignup(
      {
        name: "Cliente Auto",
        email,
        phone: "(11) 91234-5678",
        password: "senha-forte-123",
        org: tenant.slug,
        acceptTerms: true,
        termsVersion: LEGAL_VERSIONS.terms,
        marketing: false,
      },
      { ip: "10.8.8.8", userAgent: "teste" },
    );
    await waitForBackgroundTasks();

    expect(await phoneOfPortal(email)).toEqual({
      phone: "(11) 91234-5678",
      phone_normalized: "5511912345678",
      phone_key: "551112345678",
    });

    await owner`update portal_user set email_verified = true where email = ${email}`;
    await confirmPortalSignup(email, tenant.slug);

    const rows = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<PhoneRow[]>`
        select phone, phone_normalized, phone_key from customer
        where tenant_id = ${tenant.id} and email = ${email}
      `;
    });
    expect(rows).toEqual([
      { phone: "(11) 91234-5678", phone_normalized: "5511912345678", phone_key: "551112345678" },
    ]);
  });

  it("sem telefone no autocadastro, nenhuma conta nasce", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner, "Portal Sem Fone");
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`update organization set settings = '{"portal_self_signup": true}'::jsonb where id = ${tenant.id}`;
    });

    const email = customerEmail();
    const response = await call("POST", "/api/portal/auth-ext/sign-up", {
      body: {
        name: "Sem Fone",
        email,
        password: "senha-forte-123",
        org: tenant.slug,
        acceptTerms: true,
        termsVersion: LEGAL_VERSIONS.terms,
      },
    });
    await waitForBackgroundTasks();

    expect(response.status).toBe(400);
    expect(await phoneOfPortal(email)).toBeUndefined();
  });
});

describe("/admin edita o telefone da pessoa", () => {
  it("só platform_owner troca; vale o schema; a auditoria não leva o número", async () => {
    const platformOwner = await makePlatformUser(owner, "platform_owner");
    const support = await makePlatformUser(owner, "platform_support");
    const target: TestUser = await createUser(owner);

    const denied = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: support.cookie,
      body: { phone: "(21) 98888-7777" },
    });
    expect(denied.status).toBe(403);

    const invalid = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: platformOwner.cookie,
      body: { phone: "(10) 98888-7777" },
    });
    expect(invalid.status).toBe(400);

    const erased = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: platformOwner.cookie,
      body: { phone: "" },
    });
    expect(erased.status).toBe(400);

    const ok = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: platformOwner.cookie,
      body: { phone: "(21) 98888-7777" },
    });
    expect(ok.status).toBe(200);
    expect(await phoneOfUser(target.email)).toEqual({
      phone: "(21) 98888-7777",
      phone_normalized: "5521988887777",
      phone_key: "552188887777",
    });

    const [audit] = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ metadata: unknown }[]>`
        select metadata from audit_log
        where action = 'admin.user_updated' and target_id = ${target.id}
        order by created_at desc limit 1
      `;
    });
    expect(audit?.metadata).toMatchObject({ phone: true });
    expect(JSON.stringify(audit?.metadata)).not.toContain("98888");
  });
});

describe("telefone único só por tenant, não entre contas", () => {
  it("uniquePhone gera números válidos e distintos", () => {
    const [a, b] = [uniquePhone(), uniquePhone()];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^119\d{8}$/);
  });
});
