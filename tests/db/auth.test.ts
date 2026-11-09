import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { api } from "@/api/app";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { getAuth } from "@/lib/auth/server";
import { hashToken } from "@/lib/auth/verification-issue";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { comparableHeaders } from "./tenant-helpers";

/**
 * Fluxos de autenticação pela API, com Postgres real e e-mail em memória
 * (cenários de `spec-testes-operacao.md`). Cada teste usa um IP próprio para não
 * dividir contadores de rate limit com os demais.
 */

const PASSWORD = "senha-forte-123";
const DOMAIN = "auth-test.bizu.local";

const mail = createMemoryProvider();
let owner: postgres.Sql;
let ipCounter = 0;

type RequestOptions = {
  ip?: string;
  cookie?: string;
  origin?: string;
};

function nextIp() {
  ipCounter += 1;
  return `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function newEmail() {
  return `${randomUUID()}@${DOMAIN}`;
}

function headersFor({ ip, cookie, origin }: RequestOptions) {
  const headers: Record<string, string> = {
    "X-Forwarded-For": ip ?? nextIp(),
    Origin: origin ?? "http://localhost:5173",
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function post(path: string, body: unknown, options: RequestOptions = {}) {
  return api.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headersFor(options) },
    body: JSON.stringify(body),
  });
}

function get(path: string, options: RequestOptions = {}) {
  return api.request(path, { headers: headersFor(options) });
}

function signUp(email: string, options: RequestOptions = {}) {
  return post(
    "/api/auth/sign-up/email",
    {
      name: "Ana Teste",
      email,
      password: PASSWORD,
      phone: "11987654321",
      acceptTerms: true,
      termsVersion: "2026-11",
    },
    options,
  );
}

function signIn(email: string, password = PASSWORD, options: RequestOptions = {}) {
  return post("/api/auth/sign-in/email", { email, password }, options);
}

function verify(token: string, options: RequestOptions = {}) {
  return post("/api/auth/verify-email", { token }, options);
}

function sessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Espera os envios em segundo plano e pega o `token` do último e-mail do template. */
async function lastToken(to: string, template: string) {
  await waitForBackgroundTasks();

  const message = mail.sent
    .filter((m) => m.to === to && m.tags?.template === template)
    .at(-1);
  if (!message) throw new Error(`Nenhum e-mail ${template} para ${to}`);

  const match = message.text.match(/https?:\/\/\S+token=(\S+)/);
  if (!match?.[1]) throw new Error(`E-mail ${template} sem link`);
  return decodeURIComponent(match[1]);
}

async function templatesSentTo(to: string) {
  await waitForBackgroundTasks();
  return mail.sent.filter((m) => m.to === to).map((m) => m.tags?.template);
}

async function isVerified(email: string) {
  const [row] = await owner`
    select email_verified from "user" where email = ${email}
  `;
  return row?.email_verified as boolean | undefined;
}

/** Cadastra, confirma e devolve os cookies de sessão. */
async function verifiedUser(email = newEmail()) {
  await signUp(email);
  const response = await verify(await lastToken(email, "verify-email"));
  expect(response.status).toBe(200);
  return { email, cookie: sessionCookies(response) };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tudo o que um cliente pode comparar, menos o relógio. */
async function observable(response: Response) {
  const headers = comparableHeaders(response);
  return { status: response.status, body: await response.text(), headers };
}

describe("autenticação", () => {
  beforeAll(() => {
    const url = process.env.DIRECT_URL;
    if (!url) throw new Error("DIRECT_URL não definida");
    owner = postgres(url, { max: 1 });
    setEmailProviderForTests(mail);
  });

  beforeEach(() => {
    mail.reset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await waitForBackgroundTasks();
  });

  afterAll(async () => {
    await owner`delete from "user" where email like ${`%@${DOMAIN}`}`;
    await owner`delete from rate_limit where key like '10.20.%'`;
    await owner.end();
    setEmailProviderForTests(undefined);
  });

  describe("cadastro e verificação de e-mail", () => {
    it("cadastro não abre sessão e envia o link da página, não o da API", async () => {
      const email = newEmail();

      const response = await signUp(email);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, verifyEmail: true });
      expect(response.headers.getSetCookie()).toEqual([]);

      await waitForBackgroundTasks();
      const [message] = mail.sent;
      expect(message?.text).toContain(
        "http://localhost:5173/verificar-email?token=",
      );
      expect(message?.text).not.toContain("/api/auth");
    });

    it("guarda só o hash do token", async () => {
      const email = newEmail();
      await signUp(email);
      const token = await lastToken(email, "verify-email");

      const [row] = await owner`
        select i.token_hash, i.kind from email_verification_issue i
        join "user" u on u.id = i.user_id where u.email = ${email}
      `;

      expect(row).toEqual({ token_hash: hashToken(token), kind: "verify" });
    });

    it("cadastro exige o aceite dos termos e senha de 10 caracteres", async () => {
      const email = newEmail();
      const base = { name: "Ana", email, termsVersion: "2026-11" };

      const noTerms = await post("/api/auth/sign-up/email", {
        ...base,
        password: PASSWORD,
        phone: "11987654321",
        acceptTerms: false,
      });
      const shortPassword = await post("/api/auth/sign-up/email", {
        ...base,
        password: "curta",
        phone: "11987654321",
        acceptTerms: true,
      });

      expect(noTerms.status).toBe(400);
      expect(shortPassword.status).toBe(400);
      expect(await isVerified(email)).toBeUndefined();
    });

    it("não aceita papel enviado no cadastro", async () => {
      const email = newEmail();

      await post("/api/auth/sign-up/email", {
        name: "Ana",
        email,
        password: PASSWORD,
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: "2026-11",
        role: "platform_owner",
      });

      const [row] = await owner`select role from "user" where email = ${email}`;
      expect(row?.role).toBe("user");
    });

    it("GET e HEAD não consomem o token nem alteram email_verified", async () => {
      const email = newEmail();
      await signUp(email);
      const token = await lastToken(email, "verify-email");
      const query = `token=${encodeURIComponent(token)}`;

      const direct = await get(`/api/auth/verify-email?${query}`);
      const head = await api.request(`/api/auth/verify-email?${query}`, {
        method: "HEAD",
      });
      const trailing = await get(`/api/auth/verify-email/?${query}`);
      const doubled = await get(`/api/auth//verify-email?${query}`);

      expect(direct.status).toBe(405);
      expect(head.status).toBe(405);
      expect(trailing.ok).toBe(false);
      expect(doubled.ok).toBe(false);
      expect(await isVerified(email)).toBe(false);

      // O token continua valendo para o botão.
      expect((await verify(token)).status).toBe(200);
    });

    it("POST verifica e abre sessão; o segundo POST responde 400", async () => {
      const email = newEmail();
      await signUp(email);
      const token = await lastToken(email, "verify-email");

      const first = await verify(token);
      const second = await verify(token);

      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ step: "verified" });
      expect(await isVerified(email)).toBe(true);
      expect(second.status).toBe(400);
      expect(await second.json()).toEqual({
        error: "Link inválido ou expirado.",
      });

      const me = await get("/api/me", { cookie: sessionCookies(first) });
      expect(me.status).toBe(200);
      expect((await me.json()).user).toMatchObject({
        email,
        name: "Ana Teste",
        emailVerified: true,
        platformRole: "user",
        activeTenant: null,
      });
    });

    it("dois cliques simultâneos: só um passa", async () => {
      const email = newEmail();
      await signUp(email);
      const token = await lastToken(email, "verify-email");

      const statuses = (
        await Promise.all([verify(token), verify(token), verify(token)])
      ).map((response) => response.status);

      expect(statuses.sort()).toEqual([200, 400, 400]);
    });

    it("reenvio invalida o link anterior", async () => {
      const email = newEmail();
      await signUp(email);
      const firstToken = await lastToken(email, "verify-email");

      // JWTs emitidos no mesmo segundo são idênticos.
      await sleep(1100);
      const resend = await post("/api/auth-ext/resend-verification", { email });
      const secondToken = await lastToken(email, "verify-email");

      expect(resend.status).toBe(200);
      expect(secondToken).not.toBe(firstToken);
      expect((await verify(firstToken)).status).toBe(400);
      expect(await isVerified(email)).toBe(false);
      expect((await verify(secondToken)).status).toBe(200);
      expect(await isVerified(email)).toBe(true);
    });

    it("recusa token expirado", async () => {
      const email = newEmail();
      await signUp(email);
      const token = await lastToken(email, "verify-email");

      vi.useFakeTimers({
        toFake: ["Date"],
        now: Date.now() + 3601 * 1000,
      });
      const response = await verify(token);

      expect(response.status).toBe(400);
      expect(await isVerified(email)).toBe(false);
    });

    it("recusa token desconhecido sem chamar o Better Auth", async () => {
      const response = await verify("nao-e-um-token");

      expect(response.status).toBe(400);
    });

    it("login antes de verificar responde 401, não abre sessão e reenvia o link", async () => {
      const email = newEmail();
      await signUp(email);
      await waitForBackgroundTasks();
      mail.reset();

      const response = await signIn(email);

      expect(response.status).toBe(401);
      expect(sessionCookies(response)).not.toContain("session_token=");
      expect(await templatesSentTo(email)).toEqual(["verify-email"]);
    });

    it("cadastro + login não revelam se o e-mail já existia", async () => {
      const password = "senha-de-quem-sonda";

      const probe = async (email: string) => {
        await post("/api/auth/sign-up/email", {
          name: "Sonda",
          email,
          password,
          phone: "11987654321",
          acceptTerms: true,
          termsVersion: "2026-11",
        });
        await waitForBackgroundTasks();

        const response = await signIn(email, password);

        return {
          status: response.status,
          headers: comparableHeaders(response),
          body: await response.text(),
        };
      };

      const pending = newEmail();
      await signUp(pending);

      const newAccount = await probe(newEmail());
      const verified = await probe((await verifiedUser()).email);
      const unverified = await probe(pending);

      expect(newAccount.status).toBe(401);
      expect(newAccount).toEqual(verified);
      expect(newAccount).toEqual(unverified);
    });

    it("reenvio para conta já verificada não envia nada", async () => {
      const { email } = await verifiedUser();
      mail.reset();

      const response = await post("/api/auth-ext/resend-verification", {
        email,
      });

      expect(response.status).toBe(200);
      expect(await templatesSentTo(email)).toEqual([]);
    });
  });

  describe("cadastro pendente vencido", () => {
    const ATTACKER_PASSWORD = "senha-do-atacante";

    /** Conta não verificada criada há 25 h, com a senha de quem cadastrou. */
    async function stalePendingSignup(email: string) {
      await post("/api/auth/sign-up/email", {
        name: "Atacante",
        email,
        password: ATTACKER_PASSWORD,
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: "2026-11",
      });
      await waitForBackgroundTasks();
      await owner`
        update "user" set created_at = now() - interval '25 hours'
        where email = ${email}
      `;
      mail.reset();
    }

    it("reenvio e login não geram link novo", async () => {
      const email = newEmail();
      await stalePendingSignup(email);

      const resend = await post("/api/auth-ext/resend-verification", { email });
      const login = await signIn(email, ATTACKER_PASSWORD);

      expect(resend.status).toBe(200);
      expect(login.status).toBe(401);
      expect(await templatesSentTo(email)).toEqual([]);
    });

    it("novo cadastro recria a conta e a senha antiga deixa de valer", async () => {
      const email = newEmail();
      await stalePendingSignup(email);

      const signup = await signUp(email);
      expect(await signup.json()).toEqual({ ok: true, verifyEmail: true });
      expect(await templatesSentTo(email)).toEqual(["verify-email"]);

      const token = await lastToken(email, "verify-email");
      expect((await verify(token)).status).toBe(200);

      expect((await signIn(email, ATTACKER_PASSWORD)).status).toBe(401);
      expect((await signIn(email)).status).toBe(200);
    });

    it("cadastro pendente dentro do prazo não é apagado", async () => {
      const email = newEmail();
      await signUp(email);
      await lastToken(email, "verify-email");
      mail.reset();

      await signUp(email);

      expect(await templatesSentTo(email)).toEqual(["existing-user-signup"]);
    });

    it("conta verificada antiga não é apagada", async () => {
      const { email } = await verifiedUser();
      await owner`
        update "user" set created_at = now() - interval '30 days'
        where email = ${email}
      `;

      await signUp(email);

      expect(await isVerified(email)).toBe(true);
    });
  });

  describe("respostas uniformes", () => {
    it("cadastro é igual para e-mail novo e existente, e avisa o dono", async () => {
      const { email } = await verifiedUser();
      mail.reset();

      const existing = await signUp(email);
      const fresh = await signUp(newEmail());

      expect(await observable(existing)).toEqual(await observable(fresh));
      expect(await templatesSentTo(email)).toEqual(["existing-user-signup"]);
    });

    it("cadastro repetido não troca a senha de quem já tem conta", async () => {
      const { email } = await verifiedUser();

      await post("/api/auth/sign-up/email", {
        name: "Invasor",
        email,
        password: "outra-senha-123",
        phone: "11987654321",
        acceptTerms: true,
        termsVersion: "2026-11",
      });

      expect((await signIn(email, "outra-senha-123")).status).toBe(401);
      expect((await signIn(email)).status).toBe(200);
    });

    it("reenvio é igual para e-mail existente e inexistente", async () => {
      const email = newEmail();
      await signUp(email);

      const existing = await post("/api/auth-ext/resend-verification", {
        email,
      });
      const unknown = await post("/api/auth-ext/resend-verification", {
        email: newEmail(),
      });

      expect(await observable(existing)).toEqual(await observable(unknown));
      expect((await lastToken(email, "verify-email")).length).toBeGreaterThan(0);
    });

    it("esqueci a senha é igual para e-mail existente e inexistente", async () => {
      const { email } = await verifiedUser();
      mail.reset();

      const existing = await post("/api/auth-ext/forgot-password", { email });
      const unknown = await post("/api/auth-ext/forgot-password", {
        email: newEmail(),
      });

      expect(await observable(existing)).toEqual(await observable(unknown));
      expect(await templatesSentTo(email)).toEqual(["reset-password"]);
    });

    it("troca para e-mail já usado responde igual a e-mail livre", async () => {
      const taken = await verifiedUser();
      const { cookie } = await verifiedUser();

      const used = await post(
        "/api/auth/change-email",
        { newEmail: taken.email },
        { cookie },
      );
      const free = await post(
        "/api/auth/change-email",
        { newEmail: newEmail() },
        { cookie },
      );

      expect([used.status, await used.text()]).toEqual([
        free.status,
        await free.text(),
      ]);
    });
  });

  describe("recuperação de senha", () => {
    it("o link leva à página e o token é de uso único", async () => {
      const { email } = await verifiedUser();
      await post("/api/auth-ext/forgot-password", { email });
      const token = await lastToken(email, "reset-password");
      const message = mail.sent.at(-1);

      expect(message?.text).toContain(
        "http://localhost:5173/redefinir-senha?token=",
      );

      const newPassword = "nova-senha-456";
      const first = await post("/api/auth/reset-password", {
        token,
        newPassword,
      });
      const second = await post("/api/auth/reset-password", {
        token,
        newPassword: "terceira-senha-789",
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(400);
      expect((await signIn(email)).status).toBe(401);
      expect((await signIn(email, newPassword)).status).toBe(200);
      expect(await templatesSentTo(email)).toContain("password-changed");
    });

    it("o GET do token não o consome", async () => {
      const { email } = await verifiedUser();
      await post("/api/auth-ext/forgot-password", { email });
      const token = await lastToken(email, "reset-password");

      await get(`/api/auth/reset-password/${token}?callbackURL=/redefinir-senha`);

      const response = await post("/api/auth/reset-password", {
        token,
        newPassword: "nova-senha-456",
      });
      expect(response.status).toBe(200);
    });

    it("não guarda o token legível no banco", async () => {
      const { email } = await verifiedUser();
      await post("/api/auth-ext/forgot-password", { email });
      const token = await lastToken(email, "reset-password");

      const rows = await owner`
        select identifier from verification where identifier like ${`%${token}%`}
      `;

      expect(rows).toHaveLength(0);
    });

    it("o reset encerra as sessões abertas", async () => {
      const { email, cookie } = await verifiedUser();
      expect((await get("/api/me", { cookie })).status).toBe(200);

      await post("/api/auth-ext/forgot-password", { email });
      await post("/api/auth/reset-password", {
        token: await lastToken(email, "reset-password"),
        newPassword: "nova-senha-456",
      });

      // Vale mesmo com o cookie de cache da sessão ainda dentro dos 5 minutos.
      expect((await get("/api/me", { cookie })).status).toBe(401);
    });
  });

  describe("troca de e-mail", () => {
    it("aprova no endereço atual, confirma no novo e avisa o antigo", async () => {
      const { email, cookie } = await verifiedUser();
      const target = newEmail();
      mail.reset();

      const request = await post(
        "/api/auth/change-email",
        { newEmail: target },
        { cookie },
      );
      expect(request.status).toBe(200);

      const approval = await lastToken(email, "change-email-confirm");
      expect(await templatesSentTo(target)).toEqual([]);

      const approved = await verify(approval);
      expect(await approved.json()).toEqual({ step: "change-approved" });
      expect(await isVerified(target)).toBeUndefined();

      const confirmation = await lastToken(target, "verify-email");
      const confirmed = await verify(confirmation);
      expect(await confirmed.json()).toEqual({ step: "change-done" });
      expect((await verify(confirmation)).status).toBe(400);

      expect(await isVerified(target)).toBe(true);
      expect(await isVerified(email)).toBeUndefined();
      expect(await templatesSentTo(email)).toContain("change-email-done");
    });

    it("exige sessão", async () => {
      const response = await post("/api/auth/change-email", {
        newEmail: newEmail(),
      });

      expect(response.status).toBe(401);
    });
  });

  describe("sessão", () => {
    it("/api/me responde 401 sem sessão e com cookie forjado", async () => {
      const anonymous = await get("/api/me");
      const forged = await get("/api/me", {
        cookie: "bizu.session_token=forjado.assinatura",
      });

      expect(anonymous.status).toBe(401);
      expect(forged.status).toBe(401);
    });

    it("cookie de sessão é HttpOnly, SameSite=Lax e usa o prefixo bizu", async () => {
      const email = newEmail();
      await signUp(email);
      const response = await verify(await lastToken(email, "verify-email"));

      const cookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("bizu.session_token="));

      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it("login e logout", async () => {
      const { email } = await verifiedUser();

      const login = await signIn(email);
      const cookie = sessionCookies(login);
      expect(login.status).toBe(200);
      expect((await get("/api/me", { cookie })).status).toBe(200);

      const logout = await post("/api/auth/sign-out", {}, { cookie });
      expect(logout.status).toBe(200);
      expect((await get("/api/me", { cookie })).status).toBe(401);
    });
  });

  describe("proteções", () => {
    it("limita login: a quarta tentativa em 10 s responde 429", async () => {
      const ip = nextIp();
      const email = newEmail();

      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await signIn(email, "errada-errada", { ip })).status);
      }

      expect(statuses).toEqual([401, 401, 401, 429]);
    });

    it("X-Forwarded-For forjado à esquerda do proxy não burla o limite", async () => {
      const ip = nextIp();
      const email = newEmail();

      for (let i = 0; i < 3; i += 1) {
        await signIn(email, "errada-errada", { ip: `9.9.9.${i}, ${ip}` });
      }
      const blocked = await signIn(email, "errada-errada", {
        ip: `8.8.8.8, ${ip}`,
      });

      expect(blocked.status).toBe(429);
    });

    it("limita reenvio por IP e por e-mail", async () => {
      const ip = nextIp();
      const sendFrom = (from: string, email: string) =>
        post("/api/auth-ext/resend-verification", { email }, { ip: from });

      for (let i = 0; i < 3; i += 1) await sendFrom(ip, newEmail());
      const byIp = await sendFrom(ip, newEmail());

      const email = newEmail();
      for (let i = 0; i < 3; i += 1) await sendFrom(nextIp(), email);
      const byEmail = await sendFrom(nextIp(), email);

      expect(byIp.status).toBe(429);
      expect(byIp.headers.get("Retry-After")).toBeTruthy();
      expect(byEmail.status).toBe(429);
    });

    it("recusa origem estranha nas rotas próprias e nas do Better Auth", async () => {
      const origin = "https://evil.example";
      const email = newEmail();

      const resend = await post(
        "/api/auth-ext/resend-verification",
        { email },
        { origin },
      );
      const forgot = await post(
        "/api/auth-ext/forgot-password",
        { email },
        { origin },
      );
      const verification = await verify("qualquer", { origin });
      const signup = await signUp(email, { origin });
      const login = await signIn(email, PASSWORD, { origin });

      expect(login.status).toBe(403);
      expect(resend.status).toBe(403);
      expect(forgot.status).toBe(403);
      expect(verification.status).toBe(403);
      expect(signup.status).toBe(403);
    });

    it("rotas substituídas ou reservadas não existem por HTTP", async () => {
      const { cookie, email } = await verifiedUser();

      const resend = await post("/api/auth/send-verification-email", { email });
      const forgot = await post("/api/auth/request-password-reset", { email });
      const impersonate = await post(
        "/api/auth/admin/impersonate-user",
        { userId: randomUUID() },
        { cookie },
      );

      expect(resend.status).toBe(404);
      expect(forgot.status).toBe(404);
      expect(impersonate.status).toBe(404);
    });

    it.each([
      "/api/auth/request-password-reset/",
      "/api/auth//request-password-reset",
      "/api/auth/send-verification-email/",
      "/api/auth//send-verification-email",
      "/api/auth/admin/impersonate-user/",
      "/api/auth/admin//impersonate-user",
      "/api/auth/REQUEST-PASSWORD-RESET",
      "/api/auth/request%2Dpassword%2Dreset",
    ])("variante de caminho não reabre %s", async (path) => {
      const { cookie, email } = await verifiedUser();
      mail.reset();

      const response = await post(
        path,
        { email, userId: randomUUID() },
        { cookie },
      );

      expect(response.ok).toBe(false);
      expect(await templatesSentTo(email)).toEqual([]);
    });

    const ADMIN_WRITE_PATHS = [
      "/admin/set-role",
      "/admin/create-user",
      "/admin/update-user",
      "/admin/ban-user",
      "/admin/unban-user",
      "/admin/revoke-user-session",
      "/admin/revoke-user-sessions",
      "/admin/remove-user",
      "/admin/set-user-password",
    ];
    const ADMIN_READ_PATHS = [
      "/admin/get-user",
      "/admin/has-permission",
      "/admin/list-user-sessions",
      "/admin/list-users",
    ];
    const ADMIN_IMPERSONATION_PATHS = [
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
    ];

    async function platformOwnerAndTarget() {
      const actor = await verifiedUser();
      const target = await verifiedUser();
      await owner`
        update "user" set role = 'platform_owner' where email = ${actor.email}
      `;
      const [row] = await owner<{ id: string }[]>`
        select id from "user" where email = ${target.email}
      `;

      return { cookie: actor.cookie, target, targetId: row?.id as string };
    }

    const targetState = async (id: string) => {
      const [row] = await owner`
        select role, banned, name from "user" where id = ${id}
      `;
      return row;
    };

    it("toda rota do plugin admin está classificada, e a de escrita fechada", () => {
      const auth = getAuth();
      const plugin = Object.values(auth.api).flatMap((endpoint) => {
        const { path } = endpoint as { path?: string };
        return path?.startsWith("/admin/") ? [path] : [];
      });

      expect([...plugin].sort()).toEqual(
        [...ADMIN_WRITE_PATHS, ...ADMIN_READ_PATHS, ...ADMIN_IMPERSONATION_PATHS].sort(),
      );
      expect(auth.options.disabledPaths).toEqual(
        expect.arrayContaining([...ADMIN_WRITE_PATHS, ...ADMIN_IMPERSONATION_PATHS]),
      );
    });

    it.each(ADMIN_WRITE_PATHS)(
      "%s não existe por HTTP, nem para o proprietário",
      async (path) => {
        const { cookie, target, targetId } = await platformOwnerAndTarget();
        const before = await targetState(targetId);

        const response = await post(
          `/api/auth${path}`,
          {
            userId: targetId,
            role: "platform_owner",
            newPassword: "senha-trocada-123",
            data: { name: "Alterado" },
            email: newEmail(),
            password: "senha-trocada-123",
            name: "Criado",
            sessionToken: "x",
          },
          { cookie },
        );

        expect(response.status).toBe(404);
        expect(await targetState(targetId)).toEqual(before);
        expect((await get("/api/me", { cookie: target.cookie })).status).toBe(200);
      },
    );

    it.each([
      "/api/auth/admin/ban-user/",
      "/api/auth/admin//ban-user",
      "/api/auth//admin/ban-user",
      "/api/auth/ADMIN/BAN-USER",
      "/api/auth/admin/ban%2Duser",
      "/api/auth/admin%2Fban-user",
    ])("variante de caminho não reabre %s", async (path) => {
      const { cookie, targetId } = await platformOwnerAndTarget();

      const response = await post(path, { userId: targetId }, { cookie });

      expect(response.ok).toBe(false);
      expect((await targetState(targetId))?.banned).toBe(false);
    });

    it("suporte lê usuários, mas não bane nem revoga sessões", async () => {
      const target = await verifiedUser();
      const support = await verifiedUser();
      await owner`
        update "user" set role = 'platform_support' where email = ${support.email}
      `;
      const [row] = await owner`
        select id from "user" where email = ${target.email}
      `;
      const options = { cookie: support.cookie };

      const list = await get("/api/auth/admin/list-users", options);
      const ban = await post(
        "/api/auth/admin/ban-user",
        { userId: row?.id },
        options,
      );
      const revoke = await post(
        "/api/auth/admin/revoke-user-sessions",
        { userId: row?.id },
        options,
      );

      expect(list.status).toBe(200);
      expect(ban.status).toBe(404);
      expect(revoke.status).toBe(404);
      expect((await get("/api/me", { cookie: target.cookie })).status).toBe(200);
    });

    it("usuário comum não usa rotas do plugin admin", async () => {
      const { cookie } = await verifiedUser();

      const response = await get("/api/auth/admin/list-users", { cookie });

      expect(response.status).toBe(403);
    });
  });
});
