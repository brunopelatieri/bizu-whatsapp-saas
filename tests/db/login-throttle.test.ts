import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { pruneLoginThrottle } from "@/lib/auth/login-throttle-store";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { resetEnvForTests } from "@/lib/env";
import {
  APP_ORIGIN,
  call,
  cleanUp,
  connectOwner,
  createUser,
  newEmail,
} from "./tenant-helpers";

/**
 * Bloqueio de login por tentativas (`src/api/login-throttle.ts`), pela API e com Postgres
 * real. `call` usa um IP por chamada: o limite por IP do Better Auth (3 a cada 10 s) não
 * entra na conta, e o que se mede é o contador por e-mail.
 */

const PASSWORD = "Senha-forte-123";
const WRONG = "senha errada";
const MAX_ATTEMPTS = 3;

const LOGIN_ENV = {
  LOGIN_LOCKOUT_SCOPE: "email",
  LOGIN_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
  LOGIN_ATTEMPT_WINDOW_MINUTES: "15",
  LOGIN_LOCKOUT_MINUTES: "10",
};

const mail = createMemoryProvider();
let owner: postgres.Sql;
const previous: Record<string, string | undefined> = {};

function setLoginEnv(values: Partial<typeof LOGIN_ENV>) {
  Object.assign(process.env, { ...LOGIN_ENV, ...values });
  resetEnvForTests();
}

const teamSignIn = (email: string, password = PASSWORD) =>
  call("POST", "/api/auth/sign-in/email", { body: { email, password } });

const portalSignIn = (email: string, password = PASSWORD) =>
  call("POST", "/api/portal/auth/sign-in/email", { body: { email, password } });

/** Com IP fixo, para o escopo `email_ip` e para o limite por IP do Better Auth. */
function teamSignInFrom(ip: string, email: string, password = PASSWORD) {
  return api.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: APP_ORIGIN,
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify({ email, password }),
  });
}

let rawIp = 0;

/** Corpo e `Content-Type` crus: o que um cliente fora do navegador consegue mandar. */
function rawSignIn(path: string, contentType: string, body: string) {
  rawIp += 1;

  return api.request(path, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Origin: APP_ORIGIN,
      "X-Forwarded-For": `10.78.0.${rawIp}`,
    },
    body,
  });
}

const FORM = "application/x-www-form-urlencoded";
const asForm = (email: string, password: string) =>
  new URLSearchParams({ email, password }).toString();

async function failTimes(
  times: number,
  email: string,
  signIn: (email: string, password: string) => Response | Promise<Response> = teamSignIn,
) {
  for (let attempt = 0; attempt < times; attempt += 1) {
    const response = await signIn(email, WRONG);
    expect(response.status).toBe(401);
  }
}

const rows = () =>
  owner<
    { realm: string; failures: number; locked_until: Date | null }[]
  >`select realm, failures, locked_until from login_throttle order by realm`;

async function lastResetToken(to: string) {
  await waitForBackgroundTasks();

  const message = mail.sent
    .filter((m) => m.to === to && m.tags?.template === "reset-password")
    .at(-1);
  const match = message?.text.match(/https?:\/\/\S+token=(\S+)/);
  if (!match?.[1]) throw new Error(`sem link de reset para ${to}`);
  return decodeURIComponent(match[1]);
}

describe("bloqueio de login por tentativas", () => {
  beforeAll(async () => {
    for (const key of Object.keys(LOGIN_ENV)) previous[key] = process.env[key];
    setLoginEnv({});
    setEmailProviderForTests(mail);
    owner = connectOwner();
    // Os arquivos anteriores deixam as falhas de login deles na tabela, que é compartilhada.
    await owner`delete from login_throttle`;
  });

  afterEach(async () => {
    setLoginEnv({});
    await waitForBackgroundTasks();
    await owner`delete from login_throttle`;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvForTests();
    setEmailProviderForTests(undefined);

    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from audit_log where action = 'auth.login_locked'`;
    });
    await cleanUp(owner);
    await owner.end();
  });

  it("bloqueia depois de N falhas, inclusive para a senha certa, e avisa quanto falta", async () => {
    const user = await createUser(owner);

    await failTimes(MAX_ATTEMPTS - 1, user.email);
    expect((await rows())[0]).toMatchObject({ failures: MAX_ATTEMPTS - 1, locked_until: null });

    // A falha que fecha a conta ainda responde como senha errada.
    await failTimes(1, user.email);

    const blocked = await teamSignIn(user.email);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: "Muitas tentativas. Tente mais tarde.",
    });

    const retryAfter = Number(blocked.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(10 * 60);
    expect(blocked.headers.getSetCookie()).toEqual([]);

    // Bloqueado, a tentativa não chega a conferir a senha nem soma falha.
    expect((await rows())[0]?.failures).toBe(MAX_ATTEMPTS);
  });

  it("o login certo zera a contagem", async () => {
    const user = await createUser(owner);

    await failTimes(MAX_ATTEMPTS - 1, user.email);
    expect((await teamSignIn(user.email)).status).toBe(200);
    expect(await rows()).toEqual([]);

    // Recomeça do zero: de novo N - 1 falhas sem bloquear.
    await failTimes(MAX_ATTEMPTS - 1, user.email);
    expect((await teamSignIn(user.email)).status).toBe(200);
  });

  it("ignora a caixa do e-mail: é a mesma conta", async () => {
    const user = await createUser(owner);

    await failTimes(1, user.email.toUpperCase());
    await failTimes(MAX_ATTEMPTS - 1, user.email);

    expect((await teamSignIn(user.email)).status).toBe(429);
    expect(await rows()).toHaveLength(1);
  });

  it("o bloqueio expira sozinho", async () => {
    const user = await createUser(owner);

    await failTimes(MAX_ATTEMPTS, user.email);
    expect((await teamSignIn(user.email)).status).toBe(429);

    await owner`update login_throttle set locked_until = now() - interval '1 second'`;

    expect((await teamSignIn(user.email)).status).toBe(200);
  });

  it("e-mail sem conta bloqueia igual: a resposta não diz se ele existe", async () => {
    const known = await createUser(owner);
    const unknown = newEmail();

    await failTimes(MAX_ATTEMPTS, known.email);
    await failTimes(MAX_ATTEMPTS, unknown);

    const [a, b] = await Promise.all([teamSignIn(known.email), teamSignIn(unknown)]);

    expect(a.status).toBe(429);
    expect(b.status).toBe(429);
    expect(await a.json()).toEqual(await b.json());
  });

  it("audita o bloqueio só com hashes, sem ator", async () => {
    const email = newEmail();

    await failTimes(MAX_ATTEMPTS, email);
    await waitForBackgroundTasks();

    const audits = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<{ actor_id: string | null; metadata: Record<string, unknown> }[]>`
        select actor_id, metadata from audit_log
        where action = 'auth.login_locked' order by created_at desc limit 1
      `;
    });

    expect(audits[0]?.actor_id).toBeNull();
    expect(audits[0]?.metadata).toMatchObject({ realm: "team", scope: "email" });
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(email);
  });

  it("equipe e portal não dividem o contador", async () => {
    const user = await createUser(owner);

    await failTimes(MAX_ATTEMPTS, user.email);
    expect((await teamSignIn(user.email)).status).toBe(429);

    // O mesmo e-mail no portal segue respondendo como senha errada, e conta à parte.
    await failTimes(MAX_ATTEMPTS, user.email, portalSignIn);
    expect((await portalSignIn(user.email, WRONG)).status).toBe(429);

    expect((await rows()).map(({ realm }) => realm)).toEqual(["portal", "team"]);
  });

  it("redefinir a senha derruba o bloqueio", async () => {
    const user = await createUser(owner);
    const newPassword = "Outra-senha-456";

    await failTimes(MAX_ATTEMPTS, user.email);
    expect((await teamSignIn(user.email)).status).toBe(429);

    await call("POST", "/api/auth-ext/forgot-password", { body: { email: user.email } });
    const reset = await call("POST", "/api/auth/reset-password", {
      body: { token: await lastResetToken(user.email), newPassword },
    });
    expect(reset.status).toBe(200);
    await waitForBackgroundTasks();

    expect(await rows()).toEqual([]);
    expect((await teamSignIn(user.email, newPassword)).status).toBe(200);
  });

  it("com email_ip, só o IP que errou espera: o dono entra de outro lugar", async () => {
    setLoginEnv({ LOGIN_LOCKOUT_SCOPE: "email_ip", LOGIN_MAX_ATTEMPTS: "2" });
    const user = await createUser(owner);
    const attacker = "10.77.1.1";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await teamSignInFrom(attacker, user.email, WRONG)).status).toBe(401);
    }

    // Do IP que errou, nem a senha certa entra.
    expect((await teamSignInFrom(attacker, user.email)).status).toBe(429);
    // De outro IP, entra.
    expect((await teamSignInFrom("10.77.1.2", user.email)).status).toBe(200);
  });

  it("recusa o login enviado como formulário: o Better Auth o aceitaria sem passar pelo bloqueio", async () => {
    const user = await createUser(owner);

    for (const path of ["/api/auth/sign-in/email", "/api/portal/auth/sign-in/email"]) {
      // Nem com a senha certa: a rota só lê JSON.
      const form = await rawSignIn(path, FORM, asForm(user.email, PASSWORD));

      expect(form.status).toBe(415);
      expect(form.headers.getSetCookie()).toEqual([]);
    }

    // Bloqueada, a conta não entra por formulário nem com a senha certa.
    await failTimes(MAX_ATTEMPTS, user.email);
    const blocked = await rawSignIn("/api/auth/sign-in/email", FORM, asForm(user.email, PASSWORD));
    expect(blocked.status).toBe(415);
    expect((await teamSignIn(user.email)).status).toBe(429);
  });

  it("corpo que não é o JSON esperado responde 400, sem conferir senha", async () => {
    const user = await createUser(owner);
    const bodies = [
      "{",
      "null",
      JSON.stringify({ password: PASSWORD }),
      JSON.stringify({ email: [user.email], password: PASSWORD }),
      JSON.stringify({ email: user.email }),
      // O JSON com rótulo de formulário não passa, e o formulário com rótulo de JSON também não.
      asForm(user.email, PASSWORD),
    ];

    for (const body of bodies) {
      const response = await rawSignIn("/api/auth/sign-in/email", "application/json", body);

      expect(response.status).toBe(400);
      expect(response.headers.getSetCookie()).toEqual([]);
    }

    expect(await rows()).toEqual([]);
  });

  it("tentativas simultâneas não passam do limite: só N chegam a conferir a senha", async () => {
    const user = await createUser(owner);

    const responses = await Promise.all(
      Array.from({ length: MAX_ATTEMPTS + 5 }, () => teamSignIn(user.email, WRONG)),
    );
    const statuses = responses.map(({ status }) => status);

    expect(statuses.filter((status) => status === 401)).toHaveLength(MAX_ATTEMPTS);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    expect((await rows())[0]?.failures).toBe(MAX_ATTEMPTS);
  });

  it("resposta que não fala da senha devolve a tentativa", async () => {
    setLoginEnv({ LOGIN_MAX_ATTEMPTS: "10" });
    const user = await createUser(owner);
    const ip = "10.79.1.1";

    // O limite por IP do Better Auth é 3 a cada 10 s: a quarta é 429 dele, não senha errada.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await teamSignInFrom(ip, user.email, WRONG)).status).toBe(401);
    }
    const limited = await teamSignInFrom(ip, user.email, WRONG);

    expect(limited.status).toBe(429);
    expect((await rows())[0]).toMatchObject({ failures: 3, locked_until: null });
  });

  it("com email_ip, redefinir a senha zera as chaves de todos os IPs daquele e-mail", async () => {
    setLoginEnv({ LOGIN_LOCKOUT_SCOPE: "email_ip", LOGIN_MAX_ATTEMPTS: "2" });
    const user = await createUser(owner);
    const newPassword = "Outra-senha-456";

    for (const ip of ["10.80.1.1", "10.80.1.2"]) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect((await teamSignInFrom(ip, user.email, WRONG)).status).toBe(401);
      }
    }
    expect(await rows()).toHaveLength(2);

    await call("POST", "/api/auth-ext/forgot-password", { body: { email: user.email } });
    const reset = await call("POST", "/api/auth/reset-password", {
      body: { token: await lastResetToken(user.email), newPassword },
    });
    expect(reset.status).toBe(200);
    await waitForBackgroundTasks();

    expect(await rows()).toEqual([]);
    expect((await teamSignInFrom("10.80.1.1", user.email, newPassword)).status).toBe(200);
  });

  it("com off, nada bloqueia nem é gravado", async () => {
    setLoginEnv({ LOGIN_LOCKOUT_SCOPE: "off" });
    const user = await createUser(owner);

    await failTimes(MAX_ATTEMPTS + 2, user.email);

    expect((await teamSignIn(user.email)).status).toBe(200);
    expect(await rows()).toEqual([]);
  });

  it("a limpeza tira só o que já venceu", async () => {
    await failTimes(1, newEmail());
    await failTimes(1, newEmail());

    await owner`
      update login_throttle set updated_at = now() - interval '2 hours'
      where ctid = (select ctid from login_throttle limit 1)
    `;

    expect(await pruneLoginThrottle()).toBe(1);
    expect(await rows()).toHaveLength(1);
  });
});
