import { randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect } from "vitest";
import { api } from "@/api/app";

/** Cenários de tenant pela API, com Postgres real. Cada chamada usa um IP próprio. */

const PASSWORD = "senha-forte-123";
export const DOMAIN = "tenant-test.bizu.local";
export const APP_ORIGIN = "http://localhost:5173";

// Cada arquivo roda com o módulo novo: sem o sorteio, repetiria os IPs do anterior e
// herdaria os contadores de `rate_limit`, que ficam no banco.
let ipCounter = randomInt(0, 60_000);

function nextIp() {
  ipCounter += 1;
  return `10.40.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

export function newEmail() {
  return `${randomUUID()}@${DOMAIN}`.toLowerCase();
}

export function connectOwner() {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error("DIRECT_URL não definida");
  return postgres(url, { max: 2 });
}

type CallOptions = { cookie?: string; body?: unknown; origin?: string };

export function call(
  method: string,
  path: string,
  { cookie, body, origin = APP_ORIGIN }: CallOptions = {},
) {
  const headers: Record<string, string> = {
    "X-Forwarded-For": nextIp(),
    Origin: origin,
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  return api.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Cabeçalhos para comparar respostas: o nonce da CSP muda a cada uma, por definição. */
export function comparableHeaders(response: Response) {
  const headers = Object.fromEntries(response.headers);
  const policy = "content-security-policy-report-only";

  delete headers.date;
  if (headers[policy]) {
    headers[policy] = headers[policy].replace(/'nonce-[^']+'/, "'nonce'");
  }

  return headers;
}

function sessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

export type TestUser = { id: string; email: string; cookie: string };

/** Entra de novo com a senha: sessão nova, como em outro navegador. */
export async function signIn(email: string) {
  const response = await call("POST", "/api/auth/sign-in/email", {
    body: { email, password: PASSWORD },
  });
  expect(response.status).toBe(200);
  return sessionCookies(response);
}

/** Cadastra e marca como verificado, sem passar pelo e-mail (coberto em `auth.test.ts`). */
export async function createUser(
  owner: postgres.Sql,
  email = newEmail(),
): Promise<TestUser> {
  const signUp = await call("POST", "/api/auth/sign-up/email", {
    body: {
      name: "Pessoa Teste",
      email,
      password: PASSWORD,
      phone: "11987654321",
      acceptTerms: true,
      termsVersion: "2026-11",
    },
  });
  expect(signUp.status).toBe(200);

  const [row] = await owner<{ id: string }[]>`
    update "user" set email_verified = true where email = ${email} returning id
  `;
  if (!row) throw new Error("usuário não criado");

  return { id: row.id, email, cookie: await signIn(email) };
}

export async function createTenant(user: TestUser, name = "Clínica Teste") {
  const response = await call("POST", "/api/tenant", {
    cookie: user.cookie,
    body: { name },
  });
  expect(response.status).toBe(201);

  const { tenant } = (await response.json()) as {
    tenant: { id: string; slug: string };
  };
  return tenant;
}

/** Atalho para os testes que não tratam do convite. */
export async function addMember(
  owner: postgres.Sql,
  tenantId: string,
  user: TestUser,
  role: string,
) {
  const [row] = await owner<{ id: string }[]>`
    insert into member (organization_id, user_id, role)
    values (${tenantId}, ${user.id}, ${role})
    returning id
  `;
  if (!row) throw new Error("membro não criado");

  const response = await call("POST", "/api/tenant/active", {
    cookie: user.cookie,
    body: { tenantId },
  });
  expect(response.status).toBe(200);

  return row.id;
}

export async function createRole(
  user: TestUser,
  name: string,
  permissions: string[],
) {
  const response = await call("POST", "/api/roles", {
    cookie: user.cookie,
    body: { name, permissions },
  });
  expect(response.status).toBe(201);

  const { role } = (await response.json()) as { role: { id: string } };
  return role;
}

/** Remove o que os testes criaram. `audit_log` exige o bypass, mesmo para o dono. */
export async function cleanUp(owner: postgres.Sql) {
  const pattern = `%@${DOMAIN}`;

  await owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    await tx`
      delete from audit_log where tenant_id in (
        select organization_id from member m
        join "user" u on u.id = m.user_id
        where u.email like ${pattern}
      )
    `;
    await tx`
      delete from audit_log where actor_id in (
        select id from "user" where email like ${pattern}
      )
    `;
    await tx`
      delete from organization where id in (
        select organization_id from member m
        join "user" u on u.id = m.user_id
        where u.email like ${pattern}
      )
    `;
    await tx`
      delete from consent_log where subject_id in (
        select id from "user" where email like ${pattern}
      )
    `;
    await tx`delete from "user" where email like ${pattern}`;
  });
}
