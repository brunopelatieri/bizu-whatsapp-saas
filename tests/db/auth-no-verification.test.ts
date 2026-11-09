import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { resetAuthForTests } from "@/lib/auth/server";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { resetEnvForTests } from "@/lib/env";
import {
  call,
  cleanUp,
  comparableHeaders,
  connectOwner,
  createUser,
  newEmail,
  type TestUser,
} from "./tenant-helpers";

/**
 * `EMAIL_VERIFICATION_REQUIRED=false`, o padrão do template: o cadastro entra direto, sem
 * abrir sessão por si (a resposta é a mesma para e-mail novo e existente), e o que depende de
 * provar o e-mail continua fechado. O resto da suíte roda com a verificação ligada.
 */

const PASSWORD = "senha-forte-123";
const mail = createMemoryProvider();
let owner: postgres.Sql;
function signUp(email: string, password = PASSWORD) {
  return call("POST", "/api/auth/sign-up/email", {
    body: {
      name: "Pessoa Sem Link",
      email,
      password,
      phone: "11987654321",
      acceptTerms: true,
      termsVersion: "2026-11",
    },
  });
}

function signIn(email: string, password = PASSWORD) {
  return call("POST", "/api/auth/sign-in/email", {
    body: { email, password },
  });
}

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

async function templatesSentTo(to: string) {
  await waitForBackgroundTasks();
  return mail.sent.filter((m) => m.to === to).map((m) => m.tags?.template);
}

function setVerification(value: "true" | "false") {
  process.env.EMAIL_VERIFICATION_REQUIRED = value;
  resetEnvForTests();
  resetAuthForTests();
}

beforeAll(() => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
  setVerification("false");
});

afterAll(async () => {
  setVerification("true");
  setEmailProviderForTests(undefined);
  await cleanUp(owner);
  await owner.end();
});

describe("cadastro sem verificação", () => {
  it("não abre sessão nem envia link; o login em seguida entra", async () => {
    const email = newEmail();
    const response = await signUp(email);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, verifyEmail: false });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await templatesSentTo(email)).not.toContain("verify-email");

    const login = await signIn(email);
    expect(login.status).toBe(200);

    const me = await call("GET", "/api/me", { cookie: cookiesOf(login) });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { emailVerified: boolean } };
    expect(body.user.emailVerified).toBe(false);
  });

  it("e-mail existente recebe a mesma resposta e o dono é avisado", async () => {
    const taken = newEmail();
    const fresh = newEmail();
    expect((await signUp(taken)).status).toBe(200);

    const repeated = await signUp(taken, "outra-senha-123");
    const brandNew = await signUp(fresh);

    expect(repeated.status).toBe(brandNew.status);
    expect(await repeated.text()).toBe(await brandNew.text());
    expect(comparableHeaders(repeated)).toEqual(comparableHeaders(brandNew));
    expect(await templatesSentTo(taken)).toContain("existing-user-signup");

    // A senha de quem tentou de novo não vale: a conta segue com a do dono.
    expect((await signIn(taken, "outra-senha-123")).status).toBe(401);
    expect((await signIn(taken)).status).toBe(200);
  });

  it("conta não verificada antiga não é apagada por um novo cadastro", async () => {
    const email = newEmail();
    await signUp(email);
    await owner`
      update "user" set created_at = now() - interval '2 days' where email = ${email}
    `;

    await signUp(email, "senha-de-outro-123");

    expect((await signIn(email)).status).toBe(200);
    expect((await signIn(email, "senha-de-outro-123")).status).toBe(401);
  });
});

describe("o que depende do e-mail", () => {
  let inviter: TestUser;
  let tenantId: string;

  beforeAll(async () => {
    inviter = await createUser(owner);
    const created = await call("POST", "/api/tenant", {
      cookie: inviter.cookie,
      body: { name: "Convites sem link" },
    });
    expect(created.status).toBe(201);
    tenantId = ((await created.json()) as { tenant: { id: string } }).tenant.id;
  });

  async function unverifiedSession(email = newEmail()) {
    await signUp(email);
    const login = await signIn(email);
    expect(login.status).toBe(200);
    return { email, cookie: cookiesOf(login) };
  }

  async function inviteFor(email: string) {
    const [row] = await owner<{ id: string }[]>`
      insert into invitation (organization_id, email, role, status, expires_at, inviter_id)
      values (${tenantId}, ${email}, 'member', 'pending', now() + interval '1 day', ${inviter.id})
      returning id
    `;
    if (!row) throw new Error("convite não criado");
    return row.id;
  }

  it("conta não verificada cria a própria organização", async () => {
    const { cookie } = await unverifiedSession();
    const response = await call("POST", "/api/tenant", {
      cookie,
      body: { name: "Organização sem link" },
    });

    expect(response.status).toBe(201);
  });

  it("não lista convites do e-mail sem verificá-lo, mas aceita pelo link", async () => {
    const { email, cookie } = await unverifiedSession();
    const invitationId = await inviteFor(email);

    const listed = await call("GET", "/api/me/invitations", { cookie });
    expect(await listed.json()).toEqual({ invitations: [] });

    const accepted = await call("POST", `/api/invitations/${invitationId}/accept`, { cookie });
    expect(accepted.status).toBe(200);
  });
});
