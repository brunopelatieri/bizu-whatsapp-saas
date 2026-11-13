import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import { jsonBodyLimit, MINUTE, sameOrigin, validId } from "@/api/guards";
import { blockWhileImpersonating } from "@/api/impersonation";
import type { TenantEnv } from "@/api/permissions";
import { clientKey, rateLimit } from "@/api/rate-limit";
import { logError } from "@/api/log";
import { handleTenantError } from "@/api/tenant-errors";
import { audit } from "@/lib/audit";
import { roleLabel } from "@/lib/auth/permissions";
import { getAuth } from "@/lib/auth/server";
import { assertWithinLimit } from "@/lib/billing/limits";
import { requestPhoneVerificationSend } from "@/lib/phone/dispatch";
import { ensureUserVerification } from "@/lib/phone/requests";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";
import { activateTenant, findMembership } from "@/lib/tenant/membership";
import { findOpenInvitation } from "@/lib/tenant/team";
import { linkMemberCustomer } from "@/lib/tenant/team-customer";

const INVALID_INVITATION = "Convite inválido ou expirado.";

/**
 * Lado de quem recebe o convite. O GET nunca consome nada e serve scanners de e-mail sem
 * efeito; aceitar exige clique, sessão e e-mail verificado do próprio convidado.
 */
export const invitationRoutes = new Hono<TenantEnv>();

invitationRoutes.onError(handleTenantError);
invitationRoutes.use("/api/invitations/*", sameOrigin, jsonBodyLimit);

invitationRoutes.get(
  "/api/invitations/:id",
  rateLimit({ name: "invitation-read", limit: 30, windowMs: MINUTE }),
  validId,
  async (c) => {
    const invitation = await findOpenInvitation(c.req.valid("param").id);
    if (!invitation) throw notFound(INVALID_INVITATION);

    c.header("Cache-Control", "no-store");

    return c.json({
      invitation: {
        id: invitation.id,
        email: invitation.email,
        tenantName: invitation.tenantName,
        inviterName: invitation.inviterName,
        roleLabel: roleLabel(invitation.role),
        expiresAt: invitation.expiresAt,
      },
    });
  },
);

invitationRoutes.post(
  "/api/invitations/:id/accept",
  rateLimit({ name: "invitation-accept", limit: 10, windowMs: MINUTE }),
  requireAuth,
  blockWhileImpersonating,
  validId,
  async (c) => {
    const invitationId = c.req.valid("param").id;
    const user = c.get("user");
    const invitation = await findOpenInvitation(invitationId);

    if (!invitation) throw notFound(INVALID_INVITATION);

    // O plugin só descobriria na constraint, e responderia 500.
    if (await findMembership(user.id, invitation.tenantId)) {
      throw new TenantRuleError(
        409,
        "ALREADY_MEMBER",
        "Você já faz parte desta organização.",
      );
    }

    // O assento do próprio convite já estava reservado; o plano pode ter encolhido.
    await assertWithinLimit(invitation.tenantId, "members", {
      ignoreInvitationId: invitationId,
    });

    const { member } = await getAuth().api.acceptInvitation({
      headers: c.req.raw.headers,
      body: { invitationId },
    });

    await activateTenant(c.get("session").id, user.id, invitation.tenantId);
    // Quem já era cliente da organização segue com a ficha, agora ligada à conta da equipe.
    // Falha aqui não desfaz a entrada: a equipe liga a ficha depois.
    await linkMemberCustomer(invitation.tenantId, user.id).catch((error: unknown) =>
      logError("Falha ao ligar a ficha de cliente do membro", error),
    );
    // Telefone ainda pendente: quem responde por confirmá-lo agora é a organização.
    // O link sai pelos canais dela, se não há outro a caminho do mesmo número (`phone.verify`).
    await ensureUserVerification(user.id, {
      kind: "tenant",
      tenantId: invitation.tenantId,
    })
      .then((requestId) => requestPhoneVerificationSend(requestId, { type: "user", id: user.id }))
      .catch((error: unknown) =>
        logError("Falha ao passar o pedido de verificação à organização", error),
      );
    await audit("member.joined", {
      actor: { id: user.id },
      tenantId: invitation.tenantId,
      target: { type: "member", id: member.id },
      metadata: { invitationId, role: invitation.role },
      ip: clientKey(c),
    });

    return c.json({ tenant: { id: invitation.tenantId } });
  },
);
