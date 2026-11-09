import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";
import { requestPortalSignup } from "@/lib/portal/login";
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

type ConsentRow = {
  kind: string;
  version: string;
  accepted: boolean;
  ip_hash: string | null;
  user_agent: string | null;
};

let owner: postgres.Sql;

async function consentsOf(subjectId: string) {
  return owner<ConsentRow[]>`
    select kind, version, accepted, ip_hash, user_agent
    from consent_log where subject_id = ${subjectId} order by kind
  `;
}

async function userIdOf(email: string) {
  const [row] = await owner<{ id: string }[]>`select id from "user" where email = ${email}`;
  return row?.id;
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

describe("consentimento no cadastro", () => {
  it("grava termos, privacidade e marketing com hash de IP e user agent", async () => {
    const email = newEmail();
    const response = await call("POST", "/api/auth/sign-up/email", {
      body: {
        name: "Ana",
        email,
        password: "senha-forte-123",
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: LEGAL_VERSIONS.terms,
        marketing: true,
      },
    });
    expect(response.status).toBe(200);
    await waitForBackgroundTasks();

    const rows = await consentsOf((await userIdOf(email)) ?? "");

    expect(rows.map(({ kind }) => kind)).toEqual(["marketing", "privacy", "terms"]);
    expect(rows.every((row) => row.accepted)).toBe(true);
    expect(rows.find(({ kind }) => kind === "terms")?.version).toBe(LEGAL_VERSIONS.terms);
    for (const row of rows) {
      expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
      // O IP nunca é gravado em claro.
      expect(JSON.stringify(row)).not.toContain("10.40.");
    }
  });

  it("marketing recusado grava a recusa; sem o campo, não grava marketing", async () => {
    const refused = newEmail();
    await call("POST", "/api/auth/sign-up/email", {
      body: {
        name: "Bia",
        email: refused,
        password: "senha-forte-123",
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: LEGAL_VERSIONS.terms,
        marketing: false,
      },
    });
    const silent = newEmail();
    await call("POST", "/api/auth/sign-up/email", {
      body: {
        name: "Caio",
        email: silent,
        password: "senha-forte-123",
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: LEGAL_VERSIONS.terms,
      },
    });
    await waitForBackgroundTasks();

    const refusedRows = await consentsOf((await userIdOf(refused)) ?? "");
    expect(refusedRows.find(({ kind }) => kind === "marketing")?.accepted).toBe(false);

    const silentRows = await consentsOf((await userIdOf(silent)) ?? "");
    expect(silentRows.map(({ kind }) => kind)).toEqual(["privacy", "terms"]);
  });

  it("cadastro sem aceitar os termos é recusado e não cria nada", async () => {
    const email = newEmail();
    const response = await call("POST", "/api/auth/sign-up/email", {
      body: {
        name: "Dani",
        email,
        password: "senha-forte-123",
        phone: "11987654321",
        acceptTerms: false,
        termsVersion: LEGAL_VERSIONS.terms,
      },
    });

    expect(response.status).toBe(400);
    expect(await userIdOf(email)).toBeUndefined();
  });

  it("cadastro com e-mail já existente não grava aceite em nome do dono da conta", async () => {
    const existing = await createUser(owner);
    const before = await consentsOf(existing.id);

    await call("POST", "/api/auth/sign-up/email", {
      body: {
        name: "Intruso",
        email: existing.email,
        password: "outra-senha-123",
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: "1999-01",
        marketing: true,
      },
    });
    await waitForBackgroundTasks();

    expect(await consentsOf(existing.id)).toEqual(before);
  });

  it("autocadastro do portal grava o aceite do portal_user", async () => {
    const tenantOwner = await createUser(owner);
    const tenant = await createTenant(tenantOwner, "Portal Consent");
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`update organization set settings = '{"portal_self_signup": true}'::jsonb where id = ${tenant.id}`;
    });

    const email = customerEmail();
    await requestPortalSignup(
      {
        name: "Cliente",
        email,
        phone: "11987654321",
        password: "senha-forte-123",
        org: tenant.slug,
        acceptTerms: true,
        termsVersion: LEGAL_VERSIONS.terms,
        marketing: false,
      },
      { ip: "10.9.9.9", userAgent: "teste" },
    );

    const [person] = await owner<{ id: string }[]>`select id from portal_user where email = ${email}`;
    const rows = await consentsOf(person?.id ?? "");

    expect(rows.map(({ kind }) => kind)).toEqual(["marketing", "privacy", "terms"]);
    expect(rows.find(({ kind }) => kind === "terms")?.user_agent).toBe("teste");
  });
});

describe("re-aceite de uma versão nova", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser(owner);
  });

  it("usuário sem aceite vigente recebe consentRequired e deixa de recebê-lo ao aceitar", async () => {
    // O cadastro de `createUser` já aceitou a versão vigente.
    const initial = await call("GET", "/api/me", { cookie: user.cookie });
    expect(((await initial.json()) as { consentRequired: string[] }).consentRequired).toEqual([]);

    // Simula uma versão nova dos textos: o aceite guardado passa a ser de uma versão antiga.
    await owner`update consent_log set version = '2020-01' where subject_id = ${user.id}`;

    const stale = await call("GET", "/api/me", { cookie: user.cookie });
    expect(((await stale.json()) as { consentRequired: string[] }).consentRequired).toEqual([
      "terms",
      "privacy",
    ]);

    const wrong = await call("POST", "/api/me/consent", {
      cookie: user.cookie,
      body: { accept: true, version: "2020-01" },
    });
    expect(wrong.status).toBe(409);

    const refused = await call("POST", "/api/me/consent", {
      cookie: user.cookie,
      body: { accept: false, version: LEGAL_VERSIONS.terms },
    });
    expect(refused.status).toBe(400);

    const accepted = await call("POST", "/api/me/consent", {
      cookie: user.cookie,
      body: { accept: true, version: LEGAL_VERSIONS.terms },
    });
    expect(accepted.status).toBe(200);

    const after = await call("GET", "/api/me", { cookie: user.cookie });
    expect(((await after.json()) as { consentRequired: string[] }).consentRequired).toEqual([]);

    // O histórico é preservado: a linha antiga continua, e há uma nova.
    const rows = await consentsOf(user.id);
    expect(rows.filter(({ kind }) => kind === "terms").map(({ version }) => version).sort()).toEqual(
      ["2020-01", LEGAL_VERSIONS.terms].sort(),
    );
  });

  it("exige sessão e não aceita origem estranha", async () => {
    const anonymous = await call("POST", "/api/me/consent", {
      body: { accept: true, version: LEGAL_VERSIONS.terms },
    });
    expect(anonymous.status).toBe(401);

    const foreign = await call("POST", "/api/me/consent", {
      cookie: user.cookie,
      origin: "https://evil.example",
      body: { accept: true, version: LEGAL_VERSIONS.terms },
    });
    expect(foreign.status).toBe(403);
  });

  it("marketing pode ser retirado a qualquer momento", async () => {
    const response = await call("POST", "/api/me/consent/marketing", {
      cookie: user.cookie,
      body: { accepted: true },
    });
    expect(response.status).toBe(200);
    await call("POST", "/api/me/consent/marketing", {
      cookie: user.cookie,
      body: { accepted: false },
    });

    const [latest] = await owner<{ accepted: boolean }[]>`
      select accepted from consent_log
      where subject_id = ${user.id} and kind = 'marketing'
      order by created_at desc, id desc limit 1
    `;
    expect(latest?.accepted).toBe(false);
  });
});

