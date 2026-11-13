import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
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
import { requirePermission, requireTenant, type TenantEnv } from "@/api/permissions";
import { rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import {
  confirmPhoneVerificationByToken,
  confirmPhoneVerificationManually,
  listPhoneVerifications,
  ownPhoneVerification,
} from "@/lib/phone/requests";
import {
  phoneVerificationPageSchema,
  phoneVerificationTokenSchema,
} from "@/lib/schemas/phone";

/**
 * Verificação de telefone (`docs/specs/pre-producao/spec.md`, bloco T).
 *
 * - `/api/me/phone-verification`: o pedido da própria conta. O link que chega ao número só
 *   confirma **na sessão da conta**: o `POST .../confirm` recebe o token no corpo (nunca na URL,
 *   que vai para o log) e o cadastro vem da sessão. Quem recebe o link de outra pessoa e clica
 *   não confirma nada. A página do link renderiza e o botão faz a chamada: nada é consumido em
 *   GET. O equivalente do portal fica em `src/api/portal.ts`.
 * - `/api/phone-verifications`: a fila da organização, para a liberação à mão. Só quem tem
 *   `phone:confirm` (reservada ao owner). A fila da plataforma fica em `/api/admin/*`.
 */
export const phoneVerificationRoutes = new Hono<TenantEnv>();

phoneVerificationRoutes.onError(handleTenantError);

/** Por IP, além do `authRateLimit`: o token tem 256 bits, e o limite fecha a tentativa em volume. */
export const confirmRateLimit = (name: string) => rateLimit({ name, limit: 10, windowMs: MINUTE });

const mine = new Hono<AuthEnv>();

mine.use("*", sameOrigin, jsonBodyLimit, authRateLimit, requireAuth);

mine.get("/", async (c) =>
  c.json({ pending: await ownPhoneVerification({ type: "user", id: c.get("user").id }) }),
);

mine.post(
  "/confirm",
  confirmRateLimit("phone-verification-confirm"),
  blockWhileImpersonating,
  zValidator("json", phoneVerificationTokenSchema, validationError),
  async (c) => {
    await confirmPhoneVerificationByToken(c.req.valid("json").token, {
      type: "user",
      id: c.get("user").id,
    });

    return c.json({ ok: true });
  },
);

phoneVerificationRoutes.route("/api/me/phone-verification", mine);

phoneVerificationRoutes.use(
  "/api/phone-verifications/*",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
);

const canConfirm = requirePermission("phone", "confirm");

phoneVerificationRoutes.get(
  "/api/phone-verifications",
  canConfirm,
  zValidator("query", phoneVerificationPageSchema, validationError),
  async (c) =>
    c.json(
      await listPhoneVerifications(
        { kind: "tenant", tenantId: c.get("tenant").id },
        c.req.valid("query").page,
      ),
    ),
);

phoneVerificationRoutes.post(
  "/api/phone-verifications/:id/confirm",
  canConfirm,
  blockWhileImpersonating,
  validId,
  async (c) => {
    const { id } = c.req.valid("param");
    await confirmPhoneVerificationManually(
      { kind: "tenant", tenantId: c.get("tenant").id },
      id,
      c.get("user").id,
    );

    return c.json({ ok: true });
  },
);
