import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import { logError } from "@/api/log";
import {
  authRateLimit,
  jsonBodyLimit,
  sameOrigin,
  validationError,
  validId,
} from "@/api/guards";
import {
  requirePermission,
  requireTenant,
  type TenantEnv,
  teamActor,
} from "@/api/permissions";
import { blockMutationsWhileImpersonating } from "@/api/impersonation";
import { handleTenantError } from "@/api/tenant-errors";
import { audit } from "@/lib/audit";
import { toStatements } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/server";
import { assertWithinLimit } from "@/lib/billing/limits";
import { releaseAssignmentsWithoutReply } from "@/lib/inbox/assignment";
import { roleSchema, updateRoleSchema } from "@/lib/schemas/roles";
import { ROLE_IN_USE } from "@/lib/tenant/errors";
import {
  countRoleUsage,
  findCustomRole,
  listCustomRoles,
  loadRoleCatalog,
} from "@/lib/tenant/roles";

/**
 * Papéis personalizados. O plugin não tem hook para isso: `roleSchema` recusa as
 * permissões reservadas aqui, e as rotas HTTP dele ficam bloqueadas (`auth-ext.ts`).
 */
export const rolesRoutes = new Hono<TenantEnv>();

rolesRoutes.onError(handleTenantError);
rolesRoutes.use(
  "/api/roles/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
  blockMutationsWhileImpersonating,
);

// O catálogo não tem `role:read`: `role:*` é tudo ou nada.
rolesRoutes.get("/api/roles", requirePermission("role", "create"), async (c) =>
  c.json({ roles: await listCustomRoles(c.get("tenant").id) }),
);

rolesRoutes.post(
  "/api/roles",
  requirePermission("role", "create"),
  zValidator("json", roleSchema, validationError),
  async (c) => {
    const { name, description, permissions } = c.req.valid("json");
    const { id: organizationId } = c.get("tenant");
    const actor = teamActor(c);

    await assertWithinLimit(organizationId, "custom_roles");

    const { roleData } = await getAuth().api.createOrgRole({
      headers: c.req.raw.headers,
      body: {
        organizationId,
        role: name,
        permission: toStatements(permissions),
        additionalFields: { description },
      },
    });

    await audit("role.created", {
      actor: { id: actor.userId },
      tenantId: organizationId,
      target: { type: "role", id: roleData.id },
      ip: actor.ip,
    });

    return c.json(
      { role: { id: roleData.id, name, description, permissions } },
      201,
    );
  },
);

rolesRoutes.patch(
  "/api/roles/:id",
  requirePermission("role", "update"),
  validId,
  zValidator("json", updateRoleSchema, validationError),
  async (c) => {
    const { name, description, permissions } = c.req.valid("json");
    const { id: organizationId } = c.get("tenant");
    const actor = teamActor(c);
    const role = await findCustomRole(organizationId, c.req.valid("param").id);
    const renaming = name !== undefined && name !== role.name;

    // `member.role` guarda o nome: quem tem o papel perderia as permissões.
    if (renaming && (await countRoleUsage(organizationId, role.name)) > 0) {
      throw ROLE_IN_USE;
    }

    await getAuth().api.updateOrgRole({
      headers: c.req.raw.headers,
      body: {
        organizationId,
        roleId: role.id,
        data: {
          ...(renaming ? { roleName: name } : {}),
          ...(description === undefined ? {} : { description }),
          ...(permissions ? { permission: toStatements(permissions) } : {}),
        },
      },
    });
    await audit("role.updated", {
      actor: { id: actor.userId },
      tenantId: organizationId,
      target: { type: "role", id: role.id },
      ip: actor.ip,
    });
    // Papel que perdeu `inbox:reply`: as conversas de quem o tem voltam à fila (caixa de entrada).
    // O papel já foi gravado: uma falha aqui vai ao log e não vira 500 de uma edição que valeu.
    if (permissions) {
      await releaseAssignmentsWithoutReply(organizationId, await loadRoleCatalog(organizationId)).catch(
        (error) => logError("Falha ao devolver à fila as conversas do papel editado", error),
      );
    }

    return c.json({
      role: {
        ...role,
        name: name ?? role.name,
        description: description ?? role.description,
        permissions: permissions ?? role.permissions,
      },
    });
  },
);

rolesRoutes.delete(
  "/api/roles/:id",
  requirePermission("role", "delete"),
  validId,
  async (c) => {
    const { id: organizationId } = c.get("tenant");
    const actor = teamActor(c);
    const role = await findCustomRole(organizationId, c.req.valid("param").id);

    if ((await countRoleUsage(organizationId, role.name)) > 0) throw ROLE_IN_USE;

    await getAuth().api.deleteOrgRole({
      headers: c.req.raw.headers,
      body: { organizationId, roleId: role.id },
    });
    await audit("role.deleted", {
      actor: { id: actor.userId },
      tenantId: organizationId,
      target: { type: "role", id: role.id },
      ip: actor.ip,
    });

    return c.json({ ok: true });
  },
);
