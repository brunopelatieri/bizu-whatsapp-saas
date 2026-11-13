import { Readable } from "node:stream";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { type AuthEnv, requireAuth } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimit,
  MINUTE,
  sameOrigin,
  validationError,
  validId,
} from "@/api/guards";
import { blockWhileImpersonating } from "@/api/impersonation";
import { logError } from "@/api/log";
import { type PortalAuthEnv, requirePortalAuth } from "@/api/portal-auth";
import { clientKey, rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import {
  type ExportSubject,
  findReadyExport,
  listExports,
  requestExport,
} from "@/lib/lgpd/export";
import { verifyExportSignature } from "@/lib/lgpd/link";
import { isOwner } from "@/lib/auth/permissions";
import { confirmIdentity } from "@/lib/lgpd/identity";
import {
  cancelDeletion,
  confirmPortalDeletion,
  listPendingDeletions,
  requestPortalDeletion,
  requestUserDeletion,
} from "@/lib/lgpd/deletion";
import { confirmIdentitySchema, portalDeleteSchema } from "@/lib/schemas/lgpd";
import { portalTokenSchema } from "@/lib/schemas/portal";
import { hasPortalPassword } from "@/lib/portal/profile";
import { getStorage } from "@/lib/storage";
import { listMemberships } from "@/lib/tenant/membership";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Exportação e exclusão de dados pessoais (LGPD). Tudo é da própria pessoa: o sujeito vem
 * sempre da sessão, nunca da requisição. O suporte, durante a personificação, não exporta
 * nem exclui nada em nome de ninguém.
 */

const EXPORT_LIMIT = { limit: 3, windowMs: 60 * MINUTE };
/** Quem erra a senha ou o código três vezes espera: é o freio de força bruta destas rotas. */
const IDENTITY_LIMIT = { limit: 5, windowMs: 15 * MINUTE };
const INVALID_LINK = "Link inválido ou expirado.";

/** O arquivo, sob dupla prova: a assinatura do link e a sessão de quem é dono do pedido. */
async function serveExport(c: Context, subject: ExportSubject, exportId: string) {
  const check = verifyExportSignature(exportId, c.req.query("sig"));
  if (check !== "ok") throw new TenantRuleError(403, "INVALID_LINK", INVALID_LINK);

  const key = await findReadyExport(subject, exportId);
  if (!key) throw notFound("Exportação não encontrada.");

  const stream = await getStorage().get(key);
  if (!stream) {
    logError("Exportação pronta sem arquivo", new Error("objeto ausente"));
    throw notFound("Exportação não encontrada.");
  }

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="meus-dados.zip"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export const lgpdRoutes = new Hono<AuthEnv>();

lgpdRoutes.onError(handleTenantError);
lgpdRoutes.use("/api/me/export/*", sameOrigin, jsonBodyLimit);
lgpdRoutes.use("/api/me/deletion/*", sameOrigin, jsonBodyLimit);

lgpdRoutes.post(
  "/api/me/export",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  rateLimit({
    name: "lgpd-export",
    ...EXPORT_LIMIT,
    key: (c) => c.get("user").id,
  }),
  async (c) => {
    const { exportId } = await requestExport(
      { type: "user", id: c.get("user").id },
      clientKey(c),
    );

    return c.json({ exportId }, 202);
  },
);

lgpdRoutes.get(
  "/api/me/export",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  async (c) =>
    c.json({ exports: await listExports({ type: "user", id: c.get("user").id }) }),
);

lgpdRoutes.get(
  "/api/me/export/:id/download",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  validId,
  (c) =>
    serveExport(c, { type: "user", id: c.get("user").id }, c.req.valid("param").id),
);

/** Exclusão da conta: senha e, com 2FA, o código. Agenda 30 dias de carência. */
lgpdRoutes.delete(
  "/api/me",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  rateLimit({
    name: "lgpd-delete",
    ...IDENTITY_LIMIT,
    key: (c) => c.get("user").id,
  }),
  zValidator("json", confirmIdentitySchema, validationError),
  async (c) => {
    const current = c.get("user");

    await confirmIdentity(current, c.req.valid("json"));

    const { scheduledFor } = await requestUserDeletion(
      current,
      c.get("session").id,
      clientKey(c),
    );

    return c.json({ scheduledFor });
  },
);

/** A conta e as organizações que a pessoa possui, para a tela de privacidade. */
lgpdRoutes.get(
  "/api/me/deletion",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  async (c) => {
    const current = c.get("user");
    const owned = (await listMemberships(current.id))
      .filter(({ role }) => isOwner(role))
      .map(({ id }) => id);

    return c.json(
      await listPendingDeletions({ type: "user", id: current.id }, owned),
    );
  },
);

lgpdRoutes.post(
  "/api/me/deletion/cancel",
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  async (c) => {
    const current = c.get("user");

    await cancelDeletion(
      { type: "user", id: current.id },
      { type: "user", id: current.id },
      clientKey(c),
    );

    return c.json({ ok: true });
  },
);

export const portalLgpdRoutes = new Hono<PortalAuthEnv>();

portalLgpdRoutes.onError(handleTenantError);
portalLgpdRoutes.use("/api/portal/me/export/*", sameOrigin, jsonBodyLimit);

portalLgpdRoutes.post(
  "/api/portal/me/export",
  authRateLimit,
  requirePortalAuth,
  rateLimit({
    name: "lgpd-portal-export",
    ...EXPORT_LIMIT,
    key: (c) => c.get("portalUser").id,
  }),
  async (c) => {
    const { exportId } = await requestExport(
      { type: "portal_user", id: c.get("portalUser").id },
      clientKey(c),
    );

    return c.json({ exportId }, 202);
  },
);

portalLgpdRoutes.get("/api/portal/me/export", authRateLimit, requirePortalAuth, async (c) =>
  c.json({
    exports: await listExports({ type: "portal_user", id: c.get("portalUser").id }),
  }),
);

portalLgpdRoutes.get(
  "/api/portal/me/export/:id/download",
  authRateLimit,
  requirePortalAuth,
  validId,
  (c) =>
    serveExport(
      c,
      { type: "portal_user", id: c.get("portalUser").id },
      c.req.valid("param").id,
    ),
);

portalLgpdRoutes.use("/api/portal/me/deletion/*", sameOrigin, jsonBodyLimit);

const portalPerson = (c: Context<PortalAuthEnv>) => {
  const { id, name, email } = c.get("portalUser");
  return { id, name, email };
};

/**
 * Exclusão da conta do portal. Com senha: confirma e agenda. Sem senha: envia o link de
 * confirmação por e-mail (`202`), que só vale com o clique em `/deletion/confirm`.
 */
portalLgpdRoutes.delete(
  "/api/portal/me",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requirePortalAuth,
  rateLimit({
    name: "lgpd-portal-delete",
    ...IDENTITY_LIMIT,
    key: (c) => c.get("portalUser").id,
  }),
  zValidator("json", portalDeleteSchema, validationError),
  async (c) => {
    const result = await requestPortalDeletion(
      portalPerson(c),
      c.get("portalSession").id,
      c.req.valid("json").password,
      clientKey(c),
    );

    return result.status === "scheduled"
      ? c.json({ scheduledFor: result.scheduledFor })
      : c.json({ confirmationSent: true }, 202);
  },
);

portalLgpdRoutes.post(
  "/api/portal/me/deletion/confirm",
  authRateLimit,
  requirePortalAuth,
  rateLimit({
    name: "lgpd-portal-delete-confirm",
    ...IDENTITY_LIMIT,
    key: (c) => c.get("portalUser").id,
  }),
  zValidator("json", portalTokenSchema.pick({ token: true }), validationError),
  async (c) => {
    const { scheduledFor } = await confirmPortalDeletion(
      portalPerson(c),
      c.get("portalSession").id,
      c.req.valid("json").token,
      clientKey(c),
    );

    return c.json({ scheduledFor });
  },
);

/**
 * `needsPassword` diz como a pessoa confirma o pedido (a senha, ou o link por e-mail de quem não
 * tem senha). Vem daqui porque a tela "Confirme seu WhatsApp" não lê `/api/portal/me`, que fica
 * atrás do portão de telefone, e esta rota passa por ele (T3-7).
 */
portalLgpdRoutes.get("/api/portal/me/deletion", authRateLimit, requirePortalAuth, async (c) => {
  const { id } = c.get("portalUser");
  const [pending, needsPassword] = await Promise.all([
    listPendingDeletions({ type: "portal_user", id }),
    hasPortalPassword(id),
  ]);

  return c.json({ ...pending, needsPassword });
});

portalLgpdRoutes.post(
  "/api/portal/me/deletion/cancel",
  authRateLimit,
  requirePortalAuth,
  async (c) => {
    const { id } = c.get("portalUser");

    await cancelDeletion(
      { type: "portal_user", id },
      { type: "portal_user", id },
      clientKey(c),
    );

    return c.json({ ok: true });
  },
);
