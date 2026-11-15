import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import type { z } from "zod";
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
import { phoneValues } from "@/lib/phone/columns";
import {
  cancelUserPhoneChange,
  confirmPhoneVerificationByToken,
  confirmPhoneVerificationManually,
  listPhoneVerifications,
  requestUserPhoneChange,
  userPhoneOverview,
  userResendTarget,
} from "@/lib/phone/requests";
import { requestPhoneVerificationSend, sendLimitReached } from "@/lib/phone/dispatch";
import {
  phoneVerificationPageSchema,
  phoneVerificationResendSchema,
  phoneVerificationTokenSchema,
  userPhoneChangeSchema,
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

/**
 * "Reenviar" o link: 3 por hora **por cadastro** (contenção do envio frio, SPEC "Segurança"), além
 * do `authRateLimit` por IP. `key` diz qual é o cadastro (sempre da sessão).
 */
export const resendRateLimit = (name: string, key: (c: Context) => string) =>
  rateLimit({ name, limit: 3, windowMs: 60 * MINUTE, key });

/** O cadastro já recebeu o máximo de links da hora (`MAX_LINKS_PER_HOUR`). */
export const tooManyLinks = (c: Context) =>
  c.json(
    {
      error: "Já enviamos o máximo de links nesta hora. Tente mais tarde.",
      code: "PHONE_VERIFICATION_LIMIT",
    },
    429,
  );

/**
 * Corpo opcional: o reenvio também aceita `POST` sem corpo. JSON malformado ou campo a mais é
 * 400, como no `zValidator`.
 */
export async function optionalJson<T extends z.ZodType>(c: Context, schema: T) {
  const text = await c.req.text();
  let raw: unknown = {};
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { ok: false as const, response: c.json({ error: "Dados inválidos." }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false as const,
      response: c.json({ error: parsed.error.issues[0]?.message ?? "Dados inválidos." }, 400),
    };
  }
  return { ok: true as const, data: parsed.data as z.infer<T> };
}

const mine = new Hono<AuthEnv>();

mine.use("*", sameOrigin, jsonBodyLimit, authRateLimit, requireAuth);

/**
 * A situação do telefone: `pending` (o resumo de antes: algum pedido aberto, com link a caminho
 * ou na fila) e, por responsável, a plataforma e cada organização em que a pessoa é membro comum
 * (restrição (g) da T2b).
 */
mine.get("/", async (c) => c.json(await userPhoneOverview(c.get("user").id)));

/**
 * Pede o link de novo. A resposta é sempre 202: o envio é do job (`phone.verify`), que tenta o
 * próximo canal da ordem. `responsible` escolhe o pedido (a plataforma ou uma organização, D-12).
 */
mine.post(
  "/resend",
  resendRateLimit("phone-verification-resend", (c) => (c as Context<AuthEnv>).get("user").id),
  blockWhileImpersonating,
  async (c) => {
    const body = await optionalJson(c, phoneVerificationResendSchema);
    if (!body.ok) return body.response;

    const id = c.get("user").id;
    // O job não manda mais de 3 links por hora ao cadastro (o automático da abertura conta):
    // dizer agora, em vez de aceitar um reenvio que não vai sair.
    if (await sendLimitReached({ type: "user", id })) return tooManyLinks(c);
    const requestId = await userResendTarget(id, body.data.responsible, body.data.purpose);
    await requestPhoneVerificationSend(requestId, { type: "user", id }, "resend");

    return c.json({ ok: true }, 202);
  },
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

/**
 * Pedidos de troca de número por hora, por cadastro (além do limite de links do job). Pedir de novo
 * o mesmo número reenvia o link; pedir outro substitui a troca.
 */
export const phoneChangeRateLimit = (name: string, key: (c: Context) => string) =>
  rateLimit({ name, limit: 5, windowMs: 60 * MINUTE, key });

const change = new Hono<AuthEnv>();

change.use("*", sameOrigin, jsonBodyLimit, authRateLimit, requireAuth, blockWhileImpersonating);

/**
 * Troca do número da própria conta (bloco T, "Contratos"). O número novo vive no pedido e a conta
 * fica com o antigo, e com a confirmação dele, até o link do número novo ser confirmado na sessão
 * desta conta ou o responsável liberar. Liberada com o telefone pendente: é como a conta corrige um
 * número errado (`src/api/phone-gate.ts`). A resposta é 202 esteja o número livre ou não.
 */
change.post(
  "/",
  phoneChangeRateLimit("phone-change", (c) => (c as Context<AuthEnv>).get("user").id),
  zValidator("json", userPhoneChangeSchema, validationError),
  async (c) => {
    const id = c.get("user").id;
    const opened = await requestUserPhoneChange(
      id,
      phoneValues(c.req.valid("json").phone),
      c.get("activeOrganizationId"),
    );
    if (opened.reason === "resend" && (await sendLimitReached({ type: "user", id }))) {
      return tooManyLinks(c);
    }
    await requestPhoneVerificationSend(opened.requestId, { type: "user", id }, opened.reason);

    return c.json({ ok: true }, 202);
  },
);

/** Desiste da troca: a conta segue como estava (ela não tinha mudado). Sem troca aberta, também 204. */
change.delete("/", async (c) => {
  await cancelUserPhoneChange(c.get("user").id);
  return c.body(null, 204);
});

phoneVerificationRoutes.route("/api/me/phone-change", change);

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
