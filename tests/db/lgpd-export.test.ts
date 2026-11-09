import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBoss } from "@/jobs/boss";
import { registerQueues } from "@/jobs";
import { createMemoryProvider, type MemoryEmailProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { processExport } from "@/lib/lgpd/export";
import { signExportLink } from "@/lib/lgpd/link";
import { setStorageForTests } from "@/lib/storage";
import { createLocalProvider } from "@/lib/storage/providers/local";
import { unzip } from "../unzip";
import {
  cleanUpPortal,
  createCustomer,
  customerEmail,
  inviteAndEnter,
} from "./portal-helpers";
import {
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  DOMAIN,
  type TestUser,
} from "./tenant-helpers";

let owner: postgres.Sql;
let mail: MemoryEmailProvider;
let storageDir: string;

beforeAll(async () => {
  // O worker cria as filas ao subir; aqui só se enfileira, então a fila precisa existir.
  await registerQueues(await getBoss());
  mail = createMemoryProvider();
  setEmailProviderForTests(mail);
  owner = connectOwner();
  storageDir = await mkdtemp(path.join(os.tmpdir(), "bizu-lgpd-"));
  setStorageForTests(createLocalProvider(storageDir));
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  setStorageForTests(undefined);
  await rm(storageDir, { recursive: true, force: true });
  const pattern = `%@${DOMAIN}`;
  await asPlatform(
    (tx) => tx`
      delete from data_export where subject_id in (
        select id from "user" where email like ${pattern}
        union select id from portal_user where email like ${pattern}
      )
    `,
  );
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

/** `data_export` tem RLS forçado e, sem tenant, só se lê com o bypass (como a aplicação faz). */
function asPlatform<T>(fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return owner.begin(async (tx) => {
    await tx`select set_config('app.bypass_tenant', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** O link de download do último e-mail para o endereço. */
function exportLink(email: string) {
  const message = mail.sent.filter(({ to }) => to === email).at(-1);
  const match = message?.text.match(/https?:\/\/[^\s"]+\/export\/[0-9a-f-]+\/download\?sig=[^\s"]+/);
  if (!match) throw new Error(`sem link de exportação para ${email}`);

  const url = new URL(match[0]);
  return { path: url.pathname + url.search, id: url.pathname.split("/").at(-2) ?? "" };
}

const text = (files: Map<string, Buffer>, name: string) => files.get(name)?.toString() ?? "";

describe("exportação de dados da equipe", () => {
  let tenantOwner: TestUser;
  let colleague: TestUser;
  let tenant: { id: string; slug: string };
  let exportId: string;

  beforeAll(async () => {
    tenantOwner = await createUser(owner);
    tenant = await createTenant(tenantOwner, "Exporta Ltda");
    colleague = await createUser(owner);
    await owner`
      insert into member (organization_id, user_id, role)
      values (${tenant.id}, ${colleague.id}, 'member')
    `;
    const exported = await createCustomer(tenantOwner, { name: "Cliente da Exporta" });
    const field = await call("POST", "/api/custom-fields", {
      cookie: tenantOwner.cookie,
      body: {
        entity: "customer",
        label: "Origem do lead",
        type: "select",
        options: [{ label: "Indicação" }],
      },
    });
    const { field: created } = (await field.json()) as { field: { id: string } };
    await call("PATCH", `/api/customers/${exported.id}`, {
      cookie: tenantOwner.cookie,
      body: { customFields: { [created.id]: "indicacao" } },
    });
  });

  it("cria o pedido e recusa um segundo pendente", async () => {
    const first = await call("POST", "/api/me/export", { cookie: tenantOwner.cookie });
    expect(first.status).toBe(202);
    exportId = ((await first.json()) as { exportId: string }).exportId;

    const second = await call("POST", "/api/me/export", { cookie: tenantOwner.cookie });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "EXPORT_PENDING" });

    expect((await call("POST", "/api/me/export")).status).toBe(401);
    expect(
      (await call("POST", "/api/me/export", { cookie: tenantOwner.cookie, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
  });

  it("o job gera o zip, guarda sob chave aleatória e envia o link por e-mail", async () => {
    expect(await processExport(exportId)).toBe("ready");
    // Idempotente: rodar de novo não refaz nada.
    expect(await processExport(exportId)).toBe("skipped");

    const [row] = await asPlatform(
      (tx) => tx<{ status: string; file_key: string; expires_at: Date }[]>`
        select status, file_key, expires_at from data_export where id = ${exportId}
      `,
    );
    expect(row?.status).toBe("ready");
    expect(row?.file_key).toMatch(/^exports\/[A-Za-z0-9_-]{32}$/);

    // 7 dias, com folga de relógio.
    const days = ((row?.expires_at.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(await readdir(path.join(storageDir, "exports"))).toHaveLength(1);

    expect(exportLink(tenantOwner.email).id).toBe(exportId);
    expect(mail.sent.filter(({ to }) => to === tenantOwner.email).at(-1)?.subject).toMatch(
      /exportação/i,
    );
  });

  it("o download exige a sessão do dono E a assinatura; o conteúdo é o esperado", async () => {
    const { path: link } = exportLink(tenantOwner.email);

    const ok = await call("GET", link, { cookie: tenantOwner.cookie });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/zip");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment;/);

    const files = unzip(Buffer.from(await ok.arrayBuffer()));
    expect([...files.keys()].sort()).toEqual(
      [
        "LEIA-ME.txt",
        "auditoria.json",
        "consentimentos.json",
        `clientes-${tenant.slug}.json`,
        "organizacoes-e-papeis.json",
        "perfil.json",
      ].sort(),
    );

    const profile = JSON.parse(text(files, "perfil.json"));
    expect(profile).toMatchObject({ id: tenantOwner.id, email: tenantOwner.email });
    expect(text(files, "perfil.json")).not.toMatch(/password|hash/i);

    expect(JSON.parse(text(files, "organizacoes-e-papeis.json"))).toEqual([
      expect.objectContaining({ tenantId: tenant.id, roles: "owner" }),
    ]);
    expect(JSON.parse(text(files, `clientes-${tenant.slug}.json`))).toEqual([
      expect.objectContaining({
        name: "Cliente da Exporta",
        // Rótulo e valor legíveis; o id do campo não sai.
        camposAdicionais: [{ rotulo: "Origem do lead", chave: "origem_do_lead", valor: "Indicação" }],
      }),
    ]);
    expect(text(files, `clientes-${tenant.slug}.json`)).not.toContain("customFields");

    const consents = JSON.parse(text(files, "consentimentos.json")) as Array<{ kind: string }>;
    expect(consents.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["terms", "privacy"]));

    const audit = JSON.parse(text(files, "auditoria.json")) as Array<{ action: string }>;
    expect(audit.some(({ action }) => action === "tenant.created")).toBe(true);
    // O hash de IP não sai: é identificador derivado do IP.
    expect(text(files, "auditoria.json")).not.toContain("ip_hash");
    expect(text(files, "auditoria.json")).not.toContain("ipHash");
  });

  it("recusa sem assinatura, inválida, expirada ou de outro pedido", async () => {
    const { path: link, id } = exportLink(tenantOwner.email);
    const bare = link.split("?")[0] ?? link;
    const cookie = tenantOwner.cookie;

    expect((await call("GET", bare, { cookie })).status).toBe(403);
    expect((await call("GET", `${bare}?sig=1.abc`, { cookie })).status).toBe(403);

    const expired = signExportLink(id, new Date(Date.now() - 1000));
    expect((await call("GET", `${bare}?sig=${expired}`, { cookie })).status).toBe(403);

    const foreign = signExportLink(randomUUID(), new Date(Date.now() + 86_400_000));
    expect((await call("GET", `${bare}?sig=${foreign}`, { cookie })).status).toBe(403);
  });

  it("assinatura válida não basta: sem sessão é 401, com a sessão de outra pessoa é 404", async () => {
    const { path: link } = exportLink(tenantOwner.email);

    expect((await call("GET", link)).status).toBe(401);
    expect((await call("GET", link, { cookie: colleague.cookie })).status).toBe(404);
  });

  it("a lista traz o link vigente só para o dono do pedido", async () => {
    const mine = await call("GET", "/api/me/export", { cookie: tenantOwner.cookie });
    const { exports } = (await mine.json()) as {
      exports: Array<{ id: string; status: string; downloadUrl: string | null }>;
    };

    expect(exports[0]).toMatchObject({ id: exportId, status: "ready" });
    expect(exports[0]?.downloadUrl).toContain(`/api/me/export/${exportId}/download?sig=`);

    const theirs = await call("GET", "/api/me/export", { cookie: colleague.cookie });
    expect(((await theirs.json()) as { exports: unknown[] }).exports).toEqual([]);
  });

  it("colaborador que não é owner não leva a lista de clientes", async () => {
    const created = await call("POST", "/api/me/export", { cookie: colleague.cookie });
    const { exportId: id } = (await created.json()) as { exportId: string };
    await processExport(id);

    const { path: link } = exportLink(colleague.email);
    const response = await call("GET", link, { cookie: colleague.cookie });
    const files = unzip(Buffer.from(await response.arrayBuffer()));

    expect([...files.keys()].some((name) => name.startsWith("clientes-"))).toBe(false);
  });

  it("pedido pendente há mais de 1 hora é de um job morto e libera um novo", async () => {
    const stuck = await createUser(owner);
    const first = await call("POST", "/api/me/export", { cookie: stuck.cookie });
    const { exportId: firstId } = (await first.json()) as { exportId: string };

    expect((await call("POST", "/api/me/export", { cookie: stuck.cookie })).status).toBe(409);

    await asPlatform(
      (tx) => tx`update data_export set created_at = now() - interval '2 hours' where id = ${firstId}`,
    );

    expect((await call("POST", "/api/me/export", { cookie: stuck.cookie })).status).toBe(202);
    const [old] = await asPlatform(
      (tx) => tx<{ status: string }[]>`select status from data_export where id = ${firstId}`,
    );
    expect(old?.status).toBe("failed");
  });
});

describe("exportação de dados do portal", () => {
  it("cliente exporta seus dados; a sessão da equipe não abre a rota do portal", async () => {
    const tenantOwner = await createUser(owner);
    await createTenant(tenantOwner, "Portal Exporta");
    const email = customerEmail();
    const record = await createCustomer(tenantOwner, { email, name: "Julia Cliente" });
    const cookie = await inviteAndEnter(tenantOwner, mail, record.id, email);

    expect((await call("POST", "/api/portal/me/export", { cookie: tenantOwner.cookie })).status).toBe(
      401,
    );

    const created = await call("POST", "/api/portal/me/export", { cookie });
    expect(created.status).toBe(202);
    const { exportId } = (await created.json()) as { exportId: string };
    expect((await call("POST", "/api/portal/me/export", { cookie })).status).toBe(409);

    expect(await processExport(exportId)).toBe("ready");

    const { path: link } = exportLink(email);
    expect(link).toContain("/api/portal/me/export/");

    // A rota da equipe não serve o pedido do portal, mesmo com a assinatura certa.
    const teamPath = link.replace("/api/portal/me/export/", "/api/me/export/");
    expect((await call("GET", teamPath, { cookie: tenantOwner.cookie })).status).toBe(404);

    const response = await call("GET", link, { cookie });
    expect(response.status).toBe(200);

    const files = unzip(Buffer.from(await response.arrayBuffer()));
    expect([...files.keys()].sort()).toEqual(
      [
        "LEIA-ME.txt",
        "auditoria.json",
        "cadastros-nas-organizacoes.json",
        "consentimentos.json",
        "perfil.json",
      ].sort(),
    );

    expect(JSON.parse(text(files, "cadastros-nas-organizacoes.json"))).toEqual([
      expect.objectContaining({ tenantName: "Portal Exporta", name: "Julia Cliente", email }),
    ]);
    expect(JSON.parse(text(files, "perfil.json"))).toMatchObject({ email });
  });
});
