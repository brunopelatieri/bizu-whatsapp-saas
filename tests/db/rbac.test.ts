import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuth } from "@/lib/auth/server";
import {
  allPermissions,
  permissionsOf,
  staticRoleCatalog,
} from "@/lib/auth/permissions";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { makePlatformUser } from "./billing-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * Matriz papel × endpoint × esperado, gerada do catálogo: papel novo ou rota nova entra
 * aqui e a expectativa sai das permissões, não de uma tabela copiada.
 *
 * Ids inexistentes e corpos inválidos: quem pode recebe 404 ou 400 depois da checagem,
 * sem alterar nada; quem não pode recebe 403 antes.
 */

const CUSTOM_ROLE = "matriz";
const CUSTOM_PERMISSIONS = [
  "customer:read",
  "invitation:create",
  "member:update",
];

const anyId = randomUUID();

const endpoints = [
  ["PATCH", "/api/tenant", "organization:update"],
  ["DELETE", "/api/tenant", "organization:delete"],
  ["POST", "/api/files", "file:upload"],
  ["GET", `/api/files/${anyId}`, "file:read"],
  ["DELETE", `/api/files/${anyId}`, "file:delete"],
  ["GET", "/api/tenant/support-grant", "support:grant"],
  ["POST", "/api/tenant/support-grant", "support:grant"],
  ["DELETE", `/api/tenant/support-grant/${anyId}`, "support:grant"],
  ["GET", "/api/audit", "audit:read"],
  ["POST", "/api/team/invitations", "invitation:create"],
  ["POST", `/api/team/invitations/${anyId}/resend`, "invitation:create"],
  ["DELETE", `/api/team/invitations/${anyId}`, "invitation:cancel"],
  ["PATCH", `/api/team/members/${anyId}`, "member:update"],
  ["DELETE", `/api/team/members/${anyId}`, "member:delete"],
  ["GET", "/api/roles", "role:create"],
  ["POST", "/api/roles", "role:create"],
  ["PATCH", `/api/roles/${anyId}`, "role:update"],
  ["DELETE", `/api/roles/${anyId}`, "role:delete"],
  ["GET", "/api/customers", "customer:read"],
  ["POST", "/api/customers", "customer:create"],
  ["GET", `/api/customers/${anyId}`, "customer:read"],
  ["PATCH", `/api/customers/${anyId}`, "customer:update"],
  ["DELETE", `/api/customers/${anyId}`, "customer:delete"],
  ["POST", `/api/customers/${anyId}/invite`, "customer:invite"],
  ["GET", "/api/billing/plans", "billing:read"],
  ["GET", "/api/billing/subscription", "billing:read"],
  ["GET", "/api/billing/invoices", "billing:read"],
  ["GET", `/api/billing/invoices/${anyId}`, "billing:read"],
  ["PUT", "/api/billing/profile", "billing:manage"],
  ["POST", "/api/billing/checkout", "billing:manage"],
  ["POST", "/api/billing/cancel", "billing:manage"],
  ["POST", "/api/billing/reactivate", "billing:manage"],
  ["POST", "/api/billing/pause", "billing:manage"],
  ["POST", "/api/billing/change-plan", "billing:manage"],
  ["POST", "/api/billing/portal", "billing:manage"],
  ["GET", "/api/channels", "channel:read"],
  ["PATCH", `/api/channels/${anyId}`, "channel:manage"],
  ["POST", `/api/channels/${anyId}/default`, "channel:manage"],
  ["DELETE", `/api/channels/${anyId}`, "channel:manage"],
  ["POST", "/api/channels/whatsapp-qr", "channel:manage"],
  ["POST", `/api/channels/${anyId}/qr`, "channel:manage"],
  ["POST", `/api/channels/${anyId}/pair`, "channel:manage"],
  ["GET", `/api/channels/${anyId}/status`, "channel:read"],
  ["POST", `/api/channels/${anyId}/disconnect`, "channel:manage"],
  ["POST", `/api/channels/${anyId}/logout`, "channel:manage"],
  ["POST", `/api/channels/${anyId}/reconnect`, "channel:manage"],
  ["PATCH", `/api/channels/${anyId}/advanced-settings`, "channel:manage"],
  ["GET", "/api/tags", "customer:read"],
  ["POST", "/api/tags", "tag:manage"],
  ["PATCH", `/api/tags/${anyId}`, "tag:manage"],
  ["DELETE", `/api/tags/${anyId}`, "tag:manage"],
  ["PUT", `/api/customers/${anyId}/tags/${anyId}`, "customer:update"],
  ["DELETE", `/api/customers/${anyId}/tags/${anyId}`, "customer:update"],
  ["GET", "/api/custom-fields", "customer:read"],
  ["POST", "/api/custom-fields", "custom_field:manage"],
  ["PUT", "/api/custom-fields/order", "custom_field:manage"],
  ["PATCH", `/api/custom-fields/${anyId}`, "custom_field:manage"],
  ["DELETE", `/api/custom-fields/${anyId}`, "custom_field:manage"],
] as const;

const catalog = { ...staticRoleCatalog, [CUSTOM_ROLE]: CUSTOM_PERMISSIONS };
const roles = Object.keys(catalog);

const matrix = roles.flatMap((role) =>
  endpoints.map(([method, path, permission]) => {
    const allowed = permissionsOf(catalog, role).includes(permission);
    return { role, method, path, permission, allowed };
  }),
);

describe("RBAC", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  const users: Record<string, TestUser> = {};

  beforeAll(async () => {
    setEmailProviderForTests(createMemoryProvider());
    owner = connectOwner();

    const tenantOwner = await createUser(owner);
    tenantId = (await createTenant(tenantOwner)).id;
    users.owner = tenantOwner;

    await createRole(tenantOwner, CUSTOM_ROLE, CUSTOM_PERMISSIONS);

    for (const role of ["admin", "member", CUSTOM_ROLE]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, role);
      users[role] = user;
    }
  });

  afterAll(async () => {
    setEmailProviderForTests(undefined);
    await cleanUp(owner);
    await owner.end();
  });

  it.each(matrix)(
    "$role em $method $path: permitido = $allowed",
    async ({ role, method, path, allowed }) => {
      const response = await call(method, path, {
        cookie: users[role]?.cookie,
        body: method === "GET" || method === "DELETE" ? undefined : {},
      });
      const body = await response.clone().json();

      if (allowed) {
        expect(body.code).not.toBe("PERMISSION_DENIED");
        expect(response.status).toBeLessThan(500);
      } else {
        expect(response.status).toBe(403);
        expect(body.code).toBe("PERMISSION_DENIED");
      }
    },
  );

  it.each(endpoints)("%s %s exige sessão", async (method, path) => {
    const response = await call(method, path);

    expect(response.status).toBe(401);
  });

  /**
   * Rotas pessoais da LGPD não dependem de papel: qualquer sessão de equipe age sobre os
   * próprios dados, e a sessão do portal (outro cookie) nunca vale nelas, nem o contrário.
   */
  describe("rotas pessoais da LGPD", () => {
    const personal = [
      ["GET", "/api/me/export"],
      ["POST", "/api/me/export"],
      ["GET", `/api/me/export/${anyId}/download`],
      ["DELETE", "/api/me"],
      ["GET", "/api/me/deletion"],
      ["POST", "/api/me/deletion/cancel"],
      ["POST", "/api/me/consent"],
      ["GET", "/api/me/consent"],
      ["POST", "/api/tenant/deletion/cancel"],
    ] as const;
    const portal = [
      ["GET", "/api/portal/me/export"],
      ["POST", "/api/portal/me/export"],
      ["GET", `/api/portal/me/export/${anyId}/download`],
      ["DELETE", "/api/portal/me"],
      ["GET", "/api/portal/me/deletion"],
      ["POST", "/api/portal/me/deletion/cancel"],
      ["POST", "/api/portal/me/deletion/confirm"],
      ["POST", "/api/portal/me/consent"],
    ] as const;

    it.each([...personal, ...portal])("%s %s exige sessão", async (method, path) => {
      const response = await call(method, path, {
        body: method === "GET" ? undefined : {},
      });

      expect(response.status).toBe(401);
    });

    it.each(portal)("%s %s não aceita a sessão da equipe", async (method, path) => {
      const response = await call(method, path, {
        cookie: users.owner?.cookie,
        body: method === "GET" ? undefined : {},
      });

      expect(response.status).toBe(401);
    });

    it.each(roles)("%s lê as próprias exportações e exclusões, sem depender do papel", async (role) => {
      for (const path of ["/api/me/export", "/api/me/deletion", "/api/me/consent"]) {
        const response = await call("GET", path, { cookie: users[role]?.cookie });
        expect(response.status, path).toBe(200);
      }
    });
  });

  describe("personificação", () => {
    const body = { userId: anyId, tenantId: anyId };

    it("exige sessão", async () => {
      expect((await call("POST", "/api/admin/impersonate", { body })).status).toBe(401);
    });

    it.each(roles)("%s de tenant recebe PLATFORM_FORBIDDEN", async (role) => {
      const response = await call("POST", "/api/admin/impersonate", {
        cookie: users[role]?.cookie,
        body,
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "PLATFORM_FORBIDDEN" });
    });

    it.each(["platform_owner", "platform_support"] as const)(
      "%s passa da autorização",
      async (role) => {
        const staff = await makePlatformUser(owner, role);

        const response = await call("POST", "/api/admin/impersonate", {
          cookie: staff.cookie,
          body,
        });

        expect(response.status).toBe(404);
      },
    );

    it("corpo inválido responde 400", async () => {
      const staff = await makePlatformUser(owner, "platform_support");

      const response = await call("POST", "/api/admin/impersonate", {
        cookie: staff.cookie,
        body: { userId: "x" },
      });

      expect(response.status).toBe(400);
    });
  });

  describe("área da plataforma", () => {
    const reads = [
      ["GET", "/api/admin/webhooks"],
      ["GET", "/api/admin/channel-events"],
      ["GET", "/api/admin/subscriptions"],
      ["GET", "/api/admin/audit"],
    ] as const;
    const writes = [
      ["POST", `/api/admin/webhooks/${anyId}/reprocess`],
      ["POST", `/api/admin/channel-events/${anyId}/reprocess`],
      ["POST", `/api/admin/subscriptions/${anyId}/cancel`],
      ["POST", `/api/admin/subscriptions/${anyId}/sync`],
    ] as const;
    let platformOwner: TestUser;
    let support: TestUser;

    beforeAll(async () => {
      platformOwner = await makePlatformUser(owner, "platform_owner");
      support = await makePlatformUser(owner, "platform_support");
    });

    it.each([...reads, ...writes])("%s %s exige sessão", async (method, path) => {
      expect((await call(method, path)).status).toBe(401);
    });

    it.each([...reads, ...writes])(
      "%s %s recusa o owner de um tenant",
      async (method, path) => {
        const response = await call(method, path, { cookie: users.owner?.cookie });

        expect(response.status).toBe(403);
      },
    );

    it.each(reads)("%s %s abre para o suporte", async (method, path) => {
      const response = await call(method, path, { cookie: support.cookie });

      expect(response.status).toBe(200);
    });

    it.each(writes)("%s %s recusa o suporte", async (method, path) => {
      const response = await call(method, path, { cookie: support.cookie });

      expect(response.status).toBe(403);
    });

    it.each(writes)("%s %s abre para o proprietário", async (method, path) => {
      const response = await call(method, path, { cookie: platformOwner.cookie });

      expect(response.status).toBe(404);
    });
  });

  it("sem tenant ativo, as rotas de tenant respondem 403", async () => {
    const user = await createUser(owner);
    const response = await call("GET", "/api/team", { cookie: user.cookie });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("TENANT_REQUIRED");
  });

  it.each(roles)("/api/me de %s devolve as permissões do papel", async (role) => {
    const response = await call("GET", "/api/me", {
      cookie: users[role]?.cookie,
    });
    const body = await response.json();

    expect(new Set(body.permissions)).toEqual(
      new Set(permissionsOf(catalog, role)),
    );
    expect(body.user.activeTenant.id).toBe(tenantId);
    expect(body.user.activeTenant.permissions).toEqual(body.permissions);
    expect(body.tenants.map(({ id }: { id: string }) => id)).toEqual([tenantId]);
    // Features e limites vêm do plano padrão vigente (`tests/db/billing.test.ts`).
    expect(Array.isArray(body.features)).toBe(true);
    expect(typeof body.limits).toBe("object");
  });

  it.each(roles)(
    "o resultado de %s é o mesmo de hasPermission do plugin",
    async (role) => {
      const cookie = users[role]?.cookie ?? "";
      const expected = permissionsOf(catalog, role);

      for (const permission of allPermissions) {
        const [resource, action] = permission.split(":") as [string, string];
        const { success } = await getAuth().api.hasPermission({
          headers: new Headers({ Cookie: cookie }),
          body: {
            organizationId: tenantId,
            permissions: { [resource]: [action] },
          },
        });

        expect([permission, success]).toEqual([
          permission,
          expected.includes(permission),
        ]);
      }
    },
  );

  it("permissão nova de um papel personalizado vale na requisição seguinte", async () => {
    const role = await createRole(users.owner as TestUser, "muda", [
      "customer:read",
    ]);
    const user = await createUser(owner);
    await addMember(owner, tenantId, user, "muda");

    const before = await call("PATCH", "/api/tenant", {
      cookie: user.cookie,
      body: {},
    });
    await call("PATCH", `/api/roles/${role.id}`, {
      cookie: users.owner?.cookie,
      body: { permissions: ["organization:update"] },
    });
    const after = await call("PATCH", "/api/tenant", {
      cookie: user.cookie,
      body: {},
    });

    expect(before.status).toBe(403);
    expect(after.status).toBe(400);
  });
});
