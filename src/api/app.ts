import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { adminRoutes } from "@/api/admin";
import { authRoutes } from "@/api/auth-ext";
import { billingRoutes } from "@/api/billing";
import { auditRoutes } from "@/api/audit-log";
import { channelRoutes } from "@/api/channels";
import { customFieldRoutes } from "@/api/custom-fields";
import { tagRoutes } from "@/api/tags";
import { customerRoutes } from "@/api/customers";
import { fileRoutes } from "@/api/files";
import { impersonationRoutes } from "@/api/impersonation";
import { invitationRoutes } from "@/api/invitations";
import { lgpdRoutes, portalLgpdRoutes } from "@/api/lgpd";
import { logError } from "@/api/log";
import { meRoutes } from "@/api/me";
import { portalRoutes } from "@/api/portal";
import { rateLimit } from "@/api/rate-limit";
import { checkReady } from "@/api/ready";
import { rolesRoutes } from "@/api/roles";
import {
  cspReportRoutes,
  csrfGuard,
  securityHeaders,
} from "@/api/security";
import { sessionRoutes } from "@/api/sessions";
import { teamRoutes } from "@/api/team";
import { tenantRoutes } from "@/api/tenant";
import { channelWebhooks } from "@/api/webhooks-channels";
import { emailWebhooks } from "@/api/webhooks-email";
import { paymentWebhooks } from "@/api/webhooks-payments";
import { getDb } from "@/db";
import { contactMessages } from "@/db/schema";
import { contactMessageSchema } from "@/lib/schemas/contact";

/**
 * App Hono com toda a lógica de negócio da API (/api/*).
 * É montado dentro do servidor SSR do React Router em src/server.ts,
 * rodando no mesmo processo Node — por isso não há mais necessidade de CORS
 * (front e API compartilham a mesma origem).
 *
 * Rota privada: use `requireAuth`, que coloca o usuário em `c.get("user")`. No portal,
 * `requirePortalAuth`, que coloca o cliente em `c.get("portalUser")`.
 */
export const api = new Hono();

// Em todas as rotas, inclusive as páginas SSR, que passam por este middleware e recebem
// aqui o nonce da CSP. Ordem: cabeçalhos e CSP, CSRF, rate limit, autenticação.
api.use("*", securityHeaders);

api.get("/api/health", (c) => c.json({ ok: true }));

// Prontidão (banco, fila e schema): o motivo da falha não vai na resposta.
api.get("/api/ready", async (c) => {
  const { ok, ...checks } = await checkReady();
  return c.json(checks, ok ? 200 : 503);
});

// Antes de tudo que lê o corpo: webhook é verificado sobre os bytes brutos.
api.route("/", emailWebhooks);
api.route("/", paymentWebhooks);
api.route("/", channelWebhooks);
api.route("/", cspReportRoutes);

// Depois dos webhooks e do relatório de CSP, que não vêm de uma página do app.
api.use("/api/*", csrfGuard);

// Better Auth em /api/auth/* e rotas próprias em /api/auth-ext/* (src/api/auth-ext.ts).
api.route("/", authRoutes);

// Better Auth do portal em /api/portal/auth/* e a API do cliente (src/api/portal.ts).
api.route("/", portalRoutes);

api.route("/", sessionRoutes);
api.route("/", meRoutes);
api.route("/", lgpdRoutes);
api.route("/", portalLgpdRoutes);
api.route("/", tenantRoutes);
api.route("/", teamRoutes);
api.route("/", fileRoutes);
api.route("/", customerRoutes);
api.route("/", channelRoutes);
api.route("/", tagRoutes);
api.route("/", customFieldRoutes);
api.route("/", rolesRoutes);
api.route("/", invitationRoutes);
api.route("/", billingRoutes);
api.route("/", auditRoutes);
// Antes de `adminRoutes`: a saída da personificação vem de quem não tem papel de plataforma.
api.route("/", impersonationRoutes);
api.route("/", adminRoutes);

api.post(
  "/api/contact",
  rateLimit({ name: "contact", limit: 5, windowMs: 10 * 60 * 1000 }),
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: "Mensagem muito grande." }, 413),
  }),
  zValidator("json", contactMessageSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error:
            result.error.issues[0]?.message ?? "Preencha todos os campos.",
        },
        400,
      );
    }
  }),
  async (c) => {
    const body = c.req.valid("json");

    try {
      await getDb().insert(contactMessages).values(body);
    } catch (error) {
      logError("Falha ao salvar mensagem de contato", error);
      return c.json(
        { error: "Não foi possível enviar agora. Tente novamente." },
        500,
      );
    }

    return c.json({ ok: true });
  },
);
