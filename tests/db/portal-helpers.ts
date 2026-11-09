import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { expect } from "vitest";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import type { MemoryEmailProvider } from "@/lib/email/providers/memory";
import { call, DOMAIN, type TestUser } from "./tenant-helpers";
import { uniquePhone } from "./phone-helpers";

/** Cenários do portal pela API, com Postgres real e e-mail em memória. */

export function customerEmail() {
  return `cliente-${randomUUID()}@${DOMAIN}`.toLowerCase();
}

export function sessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

export async function createCustomer(
  user: TestUser,
  values: { email?: string; name?: string; status?: string; phone?: string } = {},
) {
  const email = values.email ?? customerEmail();
  const response = await call("POST", "/api/customers", {
    cookie: user.cookie,
    body: { name: "Cliente Teste", phone: uniquePhone(), ...values, email },
  });
  expect(response.status).toBe(201);

  const { customer } = (await response.json()) as {
    customer: { id: string; email: string; status: string };
  };
  return customer;
}

/** O link do último e-mail para este endereço. */
export function lastLink(mail: MemoryEmailProvider, email: string) {
  const message = mail.sent.filter(({ to }) => to === email).at(-1);
  const match = message?.text.match(
    /\/portal\/entrar\?token=([^&\s"]+)&org=([a-z0-9-]+)/,
  );
  if (!match?.[1] || !match[2]) throw new Error(`sem link para ${email}`);

  return { token: match[1], org: match[2], message };
}

export function verify(token: string, org?: string) {
  return call("POST", "/api/portal/auth/magic-link/verify", {
    body: { token, org },
  });
}

/** Convida e entra pelo link, como o cliente faria. Devolve o cookie do portal. */
export async function inviteAndEnter(
  user: TestUser,
  mail: MemoryEmailProvider,
  customerId: string,
  email: string,
) {
  const invite = await call("POST", `/api/customers/${customerId}/invite`, {
    cookie: user.cookie,
  });
  expect(invite.status).toBe(200);

  const { token, org } = lastLink(mail, email);
  const response = await verify(token, org);
  expect(response.status).toBe(200);
  await waitForBackgroundTasks();

  return sessionCookies(response);
}

/** Identidades do portal não têm vínculo com `user`: `cleanUp` não as alcança. */
export async function cleanUpPortal(owner: postgres.Sql) {
  const pattern = `%@${DOMAIN}`;

  await owner`
    delete from consent_log where subject_id in (
      select id from portal_user where email like ${pattern}
    )
  `;
  await owner`delete from portal_user where email like ${pattern}`;
}
