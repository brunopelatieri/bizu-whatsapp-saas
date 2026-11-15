import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { resetEnvForTests } from "@/lib/env";
import { buildExportFiles } from "@/lib/lgpd/export";
import { purgeExpiredPendingSignup } from "@/lib/auth/pending-signup";
import { executeDeletion } from "@/lib/lgpd/deletion";
import { phoneValues } from "@/lib/phone/columns";
import { getStorage } from "@/lib/storage";
import { asPlatform, makePlatformUser } from "./billing-helpers";
import { uniquePhone } from "./phone-helpers";
import { applyCookies, PASSWORD } from "./security-helpers";
import {
  addMember,
  APP_ORIGIN,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
} from "./tenant-helpers";

/**
 * Perfil da própria conta da equipe (`docs/specs/pre-producao/spec.md`, bloco F, F1): nome, foto de
 * perfil (tipo pela assinatura, teto, troca que apaga a anterior), a leitura da foto só por quem
 * divide organização ou é da plataforma, personificação, LGPD e o bloqueio de telefone.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from("WEBP"),
  Buffer.alloc(64, 3),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "utf8",
);

let ip = Math.floor(Math.random() * 40_000);

function sendAvatar(
  cookie: string | undefined,
  { content = PNG, name = "foto.png", type = "image/png" }: { content?: Buffer; name?: string; type?: string } = {},
) {
  ip += 1;
  const form = new FormData();
  form.set("file", new File([new Uint8Array(content)], name, { type }));
  return api.request("/api/me/avatar", {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: APP_ORIGIN,
      "X-Forwarded-For": `10.61.${Math.floor(ip / 250) % 250}.${(ip % 250) + 1}`,
    },
    body: form,
  });
}

const avatarRows = (userId: string) =>
  asPlatform(
    owner,
    (tx) => tx<{ id: string; key: string; tenant_id: string | null; mime: string }[]>`
      select id, key, tenant_id, mime from file
      where owner_type = 'user_avatar' and owner_id = ${userId} order by created_at
    `,
  );

const imageOf = async (userId: string) =>
  (await owner<{ image: string | null }[]>`select image from "user" where id = ${userId}`)[0]?.image;

const objectExists = async (key: string) => (await getStorage().get(key)) !== null;

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEnvForTests();
}

beforeAll(() => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
});

afterEach(() => {
  setEnv("AVATAR_MAX_KB", undefined);
  setEnv("PHONE_VERIFICATION_REQUIRED", "false");
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await waitForBackgroundTasks();
  await cleanUp(owner);
  await owner.end();
});

describe("nome", () => {
  it("PATCH /api/me troca o nome (2 a 120 caracteres) e audita sem o nome", async () => {
    const user = await createUser(owner);

    const updated = await call("PATCH", "/api/me", {
      cookie: user.cookie,
      body: { name: "  Nome Novo  " },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ user: { id: user.id, name: "Nome Novo" } });

    for (const name of ["A", "x".repeat(121)]) {
      expect((await call("PATCH", "/api/me", { cookie: user.cookie, body: { name } })).status).toBe(400);
    }
    // Só o nome: campo a mais é recusado (o e-mail e o telefone têm rotas próprias).
    expect(
      (await call("PATCH", "/api/me", { cookie: user.cookie, body: { name: "Outro", email: "x@y.z" } }))
        .status,
    ).toBe(400);
    expect((await call("PATCH", "/api/me", { body: { name: "Sem Sessão" } })).status).toBe(401);

    const audits = await asPlatform(
      owner,
      (tx) => tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_log where action = 'user.profile_updated' and actor_id = ${user.id}
      `,
    );
    expect(audits.map(({ metadata }) => metadata)).toEqual([{ name: true }]);
  });

  it("o `update-user` do Better Auth não existe (nome e foto só pelas rotas do perfil)", async () => {
    const user = await createUser(owner);
    const response = await call("POST", "/api/auth/update-user", {
      cookie: user.cookie,
      body: { name: "Por Fora", image: "https://exemplo.invalid/x.png" },
    });
    expect(response.status).toBe(404);
    expect(await imageOf(user.id)).toBeNull();
  });
});

describe("foto de perfil", () => {
  it("PNG, JPEG e WebP pela assinatura; a troca apaga a anterior; tirar apaga tudo", async () => {
    const user = await createUser(owner);

    const first = await sendAvatar(user.cookie);
    expect(first.status).toBe(201);
    const body = (await first.json()) as { avatar: { id: string; url: string; mime: string } };
    expect(body.avatar).toMatchObject({ mime: "image/png", url: `/api/avatars/${user.id}?v=${body.avatar.id}` });
    const [stored] = await avatarRows(user.id);
    expect(stored).toMatchObject({ id: body.avatar.id, tenant_id: null, mime: "image/png" });
    expect(await imageOf(user.id)).toBe(body.avatar.id);

    // O tipo declarado não conta: JPEG enviado como "png" é JPEG.
    expect((await sendAvatar(user.cookie, { content: JPEG, name: "x.png", type: "image/png" })).status).toBe(201);
    expect((await sendAvatar(user.cookie, { content: WEBP, name: "x.webp", type: "image/webp" })).status).toBe(201);

    const rows = await avatarRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mime).toBe("image/webp");
    expect(await objectExists(stored?.key ?? "")).toBe(false);
    expect(await objectExists(rows[0]?.key ?? "")).toBe(true);

    const removed = await call("DELETE", "/api/me/avatar", { cookie: user.cookie });
    expect(removed.status).toBe(204);
    expect(await avatarRows(user.id)).toEqual([]);
    expect(await imageOf(user.id)).toBeNull();
    expect(await objectExists(rows[0]?.key ?? "")).toBe(false);
    // Sem foto, o mesmo 204.
    expect((await call("DELETE", "/api/me/avatar", { cookie: user.cookie })).status).toBe(204);
  });

  it("tipo falso (extensão certa, conteúdo errado), SVG e vazio são recusados", async () => {
    const user = await createUser(owner);

    const fake = await sendAvatar(user.cookie, {
      content: Buffer.from("isto não é uma imagem, só texto com cara de png"),
      name: "foto.png",
      type: "image/png",
    });
    expect(fake.status).toBe(415);
    expect(await fake.json()).toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });

    const svg = await sendAvatar(user.cookie, { content: SVG, name: "foto.svg", type: "image/svg+xml" });
    expect(svg.status).toBe(415);
    // SVG disfarçado de PNG também não passa: quem decide é o conteúdo.
    expect((await sendAvatar(user.cookie, { content: SVG, name: "foto.png", type: "image/png" })).status).toBe(415);

    expect((await sendAvatar(user.cookie, { content: Buffer.alloc(0) })).status).toBe(400);
    expect(await avatarRows(user.id)).toEqual([]);
  });

  it("acima de `AVATAR_MAX_KB` é 413", async () => {
    setEnv("AVATAR_MAX_KB", "16");
    const user = await createUser(owner);
    const big = Buffer.concat([PNG, Buffer.alloc(17 * 1024, 1)]);

    const refused = await sendAvatar(user.cookie, { content: big });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(await avatarRows(user.id)).toEqual([]);

    const small = Buffer.concat([PNG, Buffer.alloc(8 * 1024, 1)]);
    expect((await sendAvatar(user.cookie, { content: small })).status).toBe(201);
  });

  it("sem sessão não envia nem tira", async () => {
    expect((await sendAvatar(undefined)).status).toBe(401);
    expect((await call("DELETE", "/api/me/avatar")).status).toBe(401);
  });
});

describe("leitura da foto", () => {
  it("só a própria pessoa, quem divide organização e a equipe da plataforma", async () => {
    const person = await createUser(owner);
    const tenant = await createTenant(person, "Org da foto");
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "member");
    const stranger = await createUser(owner);
    await createTenant(stranger, "Outra org");
    const support = await makePlatformUser(owner, "platform_support");
    expect((await sendAvatar(person.cookie)).status).toBe(201);

    const read = (cookie?: string) => call("GET", `/api/avatars/${person.id}`, { cookie });

    const own = await read(person.cookie);
    expect(own.status).toBe(200);
    expect(own.headers.get("Content-Type")).toBe("image/png");
    expect(own.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(own.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(own.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(Buffer.from(await own.arrayBuffer()).equals(PNG)).toBe(true);

    expect((await read(colleague.cookie)).status).toBe(200);
    expect((await read(support.cookie)).status).toBe(200);
    // Outra organização: o mesmo 404 de "não tem foto".
    expect((await read(stranger.cookie)).status).toBe(404);
    expect((await read()).status).toBe(401);
    // Quem não tem foto, e id malformado: 404.
    expect((await call("GET", `/api/avatars/${colleague.id}`, { cookie: person.cookie })).status).toBe(404);
    expect((await call("GET", "/api/avatars/nao-e-id", { cookie: person.cookie })).status).toBe(404);
  });

  it("arquivo de organização marcado como `user_avatar` não vira a foto de ninguém", async () => {
    const victim = await createUser(owner);
    const tenant = await createTenant(victim, "Org da vítima");
    const attacker = await createUser(owner);
    await addMember(owner, tenant.id, attacker, "admin");
    await call("POST", "/api/tenant/active", { cookie: attacker.cookie, body: { tenantId: tenant.id } });

    ip += 1;
    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG)], "x.png", { type: "image/png" }));
    form.set("ownerType", "user_avatar");
    form.set("ownerId", victim.id);
    const planted = await api.request("/api/files", {
      method: "POST",
      headers: { Cookie: attacker.cookie, Origin: APP_ORIGIN, "X-Forwarded-For": `10.62.0.${(ip % 250) + 1}` },
      body: form,
    });
    expect(planted.status).toBe(201);

    expect((await call("GET", `/api/avatars/${victim.id}`, { cookie: attacker.cookie })).status).toBe(404);
    // E tirar a própria foto não apaga o arquivo da organização.
    await call("DELETE", "/api/me/avatar", { cookie: victim.cookie });
    const left = await asPlatform(
      owner,
      (tx) => tx`select id from file where owner_type = 'user_avatar' and owner_id = ${victim.id}`,
    );
    expect(left).toHaveLength(1);
  });
});

describe("personificação e bloqueio de telefone", () => {
  it("a sessão personificada lê, mas não troca nome nem foto", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss, "Org personificada");
    const target = await createUser(owner);
    await addMember(owner, tenant.id, target, "member");
    expect((await sendAvatar(target.cookie)).status).toBe(201);
    const support = await makePlatformUser(owner, "platform_support");
    expect(
      (await call("POST", "/api/tenant/support-grant", { cookie: boss.cookie, body: { hours: 1 } })).status,
    ).toBe(201);
    const started = await call("POST", "/api/admin/impersonate", {
      cookie: support.cookie,
      body: { userId: target.id, tenantId: tenant.id, reason: "Teste do perfil" },
    });
    expect(started.status).toBe(200);
    const cookie = applyCookies(support.cookie, started);

    for (const response of [
      await call("PATCH", "/api/me", { cookie, body: { name: "Pelo Suporte" } }),
      await sendAvatar(cookie),
      await call("DELETE", "/api/me/avatar", { cookie }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "IMPERSONATION_BLOCKED" });
    }
    expect((await call("GET", `/api/avatars/${target.id}`, { cookie })).status).toBe(200);
    expect(await avatarRows(target.id)).toHaveLength(1);

    await call("POST", "/api/admin/stop-impersonating", { cookie, body: {} });
  });

  it("com o telefone pendente e o bloqueio ligado, nada do perfil abre", async () => {
    const person = await createUser(owner);
    await waitForBackgroundTasks();
    expect((await sendAvatar(person.cookie)).status).toBe(201);
    const phone = phoneValues(uniquePhone());
    await owner`
      update "user" set phone = ${phone.phone}, phone_normalized = ${phone.phoneNormalized},
        phone_key = ${phone.phoneKey}, phone_verified_at = null, phone_verified_via = null
      where id = ${person.id}
    `;
    setEnv("PHONE_VERIFICATION_REQUIRED", "true");

    for (const response of [
      await call("PATCH", "/api/me", { cookie: person.cookie, body: { name: "Pendente" } }),
      await sendAvatar(person.cookie),
      await call("DELETE", "/api/me/avatar", { cookie: person.cookie }),
      await call("GET", `/api/avatars/${person.id}`, { cookie: person.cookie }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "PHONE_UNVERIFIED" });
    }
  });
});

describe("LGPD", () => {
  it("o expurgo do cadastro pendente leva a foto junto", async () => {
    const user = await createUser(owner);
    expect((await sendAvatar(user.cookie)).status).toBe(201);
    const [stored] = await avatarRows(user.id);
    await owner`
      update "user" set email_verified = false, created_at = now() - interval '2 days' where id = ${user.id}
    `;

    await purgeExpiredPendingSignup(user.email);

    expect(await owner`select id from "user" where id = ${user.id}`).toHaveLength(0);
    expect(await avatarRows(user.id)).toEqual([]);
    expect(await objectExists(stored?.key ?? "")).toBe(false);
  });

  it("a exportação traz a foto, e a exclusão da conta a apaga do banco e do armazenamento", async () => {
    const user = await createUser(owner);
    expect((await sendAvatar(user.cookie)).status).toBe(201);
    const [stored] = await avatarRows(user.id);

    const files = await buildExportFiles({ type: "user", id: user.id });
    const photo = files.find(({ name }) => name === "foto-de-perfil.png");
    expect(photo?.data.equals(PNG)).toBe(true);

    expect((await call("DELETE", "/api/me", { cookie: user.cookie, body: { password: PASSWORD } })).status).toBe(
      200,
    );
    const [request] = await asPlatform(
      owner,
      (tx) => tx<{ id: string }[]>`
        select id from deletion_request where subject_id = ${user.id} and status = 'pending'
      `,
    );
    await asPlatform(
      owner,
      (tx) => tx`update deletion_request set scheduled_for = now() - interval '1 day' where id = ${request?.id ?? ""}`,
    );
    expect(await executeDeletion(request?.id ?? "")).toBe("executed");

    expect(await avatarRows(user.id)).toEqual([]);
    expect(await imageOf(user.id)).toBeNull();
    expect(await objectExists(stored?.key ?? "")).toBe(false);
  });
});
