import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimit,
  MINUTE,
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
import { rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { audit } from "@/lib/audit";
import { roleLabel } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/server";
import { withinLimit } from "@/lib/billing/limits";
import { changeRoleSchema, inviteSchema } from "@/lib/schemas/team";
import {
  assertCanGrant,
  assertCanReplaceInvitation,
  assertKnownRole,
  changeMemberRole,
  findManageableInvitation,
  listInvitations,
  listMembers,
  removeMember,
} from "@/lib/tenant/team";

export const teamRoutes = new Hono<TenantEnv>();

teamRoutes.onError(handleTenantError);
teamRoutes.use(
  "/api/team/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
  // Convite também: com ele, quem personifica o owner deixaria um acesso para depois.
  blockMutationsWhileImpersonating,
);

/** Convite dispara e-mail: o limite segura quem tentaria usar o app para enviar spam. */
const inviteRateLimit = rateLimit({
  name: "team-invite",
  limit: 20,
  windowMs: 10 * MINUTE,
});

teamRoutes.get("/api/team", async (c) => {
  const { id } = c.get("tenant");

  return c.json({
    members: await listMembers(id, {
      withCustomerRecord: c.get("permissions").includes("member:delete"),
    }),
    invitations: await listInvitations(id, teamActor(c)),
    roles: Object.keys(c.get("roleCatalog")).map((name) => ({
      name,
      label: roleLabel(name),
    })),
  });
});

teamRoutes.post(
  "/api/team/invitations",
  requirePermission("invitation", "create"),
  inviteRateLimit,
  zValidator("json", inviteSchema, validationError),
  async (c) => {
    const { email, role } = c.req.valid("json");
    const { id: organizationId } = c.get("tenant");
    const actor = teamActor(c);

    assertKnownRole(actor.catalog, role);
    assertCanGrant(actor, role);
    await assertCanReplaceInvitation(organizationId, email, actor);
    // O convite reserva um assento: reconvidar o mesmo e-mail não reserva outro. A conferência e
    // a gravação do convite correm sob a trava de `members` (`withinLimit`): dois convites
    // simultâneos não passam juntos pela última vaga.
    const invitation = await withinLimit(
      organizationId,
      "members",
      { ignoreInvitationEmail: email },
      () =>
        getAuth().api.createInvitation({
          headers: c.req.raw.headers,
          body: { email, role: role as "member", organizationId },
        }),
    );

    await audit("member.invited", {
      actor: { id: actor.userId },
      tenantId: organizationId,
      target: { type: "invitation", id: invitation.id },
      metadata: { role },
      ip: actor.ip,
    });

    return c.json(
      {
        invitation: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        },
      },
      201,
    );
  },
);

/** Mantém o link e renova o prazo. Convite vencido sai da lista e pede um novo. */
teamRoutes.post(
  "/api/team/invitations/:id/resend",
  requirePermission("invitation", "create"),
  inviteRateLimit,
  validId,
  async (c) => {
    const { id: organizationId } = c.get("tenant");
    const invitation = await findManageableInvitation(
      organizationId,
      c.req.valid("param").id,
      teamActor(c),
    );

    await getAuth().api.createInvitation({
      headers: c.req.raw.headers,
      body: {
        email: invitation.email,
        role: invitation.role as "member",
        organizationId,
        resend: true,
      },
    });

    return c.json({ ok: true });
  },
);

teamRoutes.delete(
  "/api/team/invitations/:id",
  requirePermission("invitation", "cancel"),
  validId,
  async (c) => {
    const { id: organizationId } = c.get("tenant");
    const actor = teamActor(c);
    const invitation = await findManageableInvitation(
      organizationId,
      c.req.valid("param").id,
      actor,
    );

    await getAuth().api.cancelInvitation({
      headers: c.req.raw.headers,
      body: { invitationId: invitation.id },
    });
    await audit("member.invitation_canceled", {
      actor: { id: actor.userId },
      tenantId: organizationId,
      target: { type: "invitation", id: invitation.id },
      ip: actor.ip,
    });

    return c.json({ ok: true });
  },
);

teamRoutes.patch(
  "/api/team/members/:id",
  requirePermission("member", "update"),
  validId,
  zValidator("json", changeRoleSchema, validationError),
  async (c) => {
    const actor = teamActor(c);
    const { role } = c.req.valid("json");

    assertKnownRole(actor.catalog, role);

    const member = await changeMemberRole(
      c.get("tenant").id,
      c.req.valid("param").id,
      role,
      actor,
    );

    return c.json({ member });
  },
);

teamRoutes.delete(
  "/api/team/members/:id",
  requirePermission("member", "delete"),
  validId,
  async (c) => {
    await removeMember(
      c.get("tenant").id,
      c.req.valid("param").id,
      teamActor(c),
    );

    return c.json({ ok: true });
  },
);
