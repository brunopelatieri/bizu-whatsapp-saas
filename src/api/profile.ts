import { Readable } from "node:stream";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuthEnv, requireAuth } from "@/api/auth";
import { authRateLimit, jsonBodyLimit, MINUTE, sameOrigin, validationError } from "@/api/guards";
import { blockWhileImpersonating } from "@/api/impersonation";
import { clientKey, rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { withPlatformScope } from "@/db/rls";
import { user } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { dispositionHeader } from "@/lib/files/types";
import { avatarMaxBytes, avatarUrl, openAvatar, removeAvatar, uploadAvatar } from "@/lib/profile/avatar";
import { avatarParamSchema, profileNameSchema } from "@/lib/schemas/profile";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Perfil da própria conta da equipe (`docs/specs/pre-producao/spec.md`, bloco F, F1): nome e foto.
 * O e-mail segue pelo `change-email` do Better Auth, a senha pelo `change-password` e o telefone pela
 * troca (`/api/me/phone-change`). Toda escrita é bloqueada na personificação. Nenhuma rota daqui está
 * na lista do bloqueio de telefone: com o telefone pendente, nada do perfil abre.
 */
export const profileRoutes = new Hono<AuthEnv>();

profileRoutes.onError(handleTenantError);

const profileRateLimit = rateLimit({ name: "profile-update", limit: 20, windowMs: 10 * MINUTE });

/** `PATCH /api/me`: o nome da conta (2 a 120 caracteres). Auditado sem o nome. */
profileRoutes.patch(
  "/api/me",
  sameOrigin,
  jsonBodyLimit,
  authRateLimit,
  profileRateLimit,
  requireAuth,
  blockWhileImpersonating,
  zValidator("json", profileNameSchema, validationError),
  async (c) => {
    const { name } = c.req.valid("json");
    const id = c.get("user").id;

    const updated = await withPlatformScope("perfil: troca o nome", async (tx) => {
      const [row] = await tx
        .update(user)
        .set({ name })
        .where(eq(user.id, id))
        .returning({ id: user.id, name: user.name });
      if (!row) throw notFound("Usuário não encontrado.");

      await auditInTransaction(tx, "user.profile_updated", {
        actor: { id },
        target: { type: "user", id },
        // O nome é dado pessoal: a auditoria só diz o que mudou.
        metadata: { name: true },
        ip: clientKey(c),
      });
      return row;
    });

    return c.json({ user: updated });
  },
);

/** Pedidos de foto por pessoa: a imagem é pequena, mas cada envio grava no armazenamento. */
const avatarRateLimit = rateLimit({
  name: "avatar-upload",
  limit: 10,
  windowMs: 10 * MINUTE,
});

/**
 * `POST /api/me/avatar` (multipart, campo `file`): PNG, JPEG ou WebP pela assinatura, até
 * `AVATAR_MAX_KB`. A foto anterior é apagada. O limite de corpo vem antes da sessão: corpo grande
 * demais nem é lido.
 */
profileRoutes.post(
  "/api/me/avatar",
  sameOrigin,
  authRateLimit,
  avatarRateLimit,
  (c, next) =>
    bodyLimit({
      maxSize: avatarMaxBytes() + 16 * 1024,
      onError: (ctx) => ctx.json({ error: "Imagem grande demais.", code: "FILE_TOO_LARGE" }, 413),
    })(c, next),
  requireAuth,
  blockWhileImpersonating,
  async (c) => {
    const form = await c.req.parseBody().catch(() => null);
    const upload = form?.file;
    if (!(upload instanceof File)) {
      throw new TenantRuleError(400, "FILE_REQUIRED", "Envie a imagem no campo file.");
    }
    if (upload.size > avatarMaxBytes()) {
      throw new TenantRuleError(413, "FILE_TOO_LARGE", "Imagem grande demais.");
    }

    const id = c.get("user").id;
    const saved = await uploadAvatar(Buffer.from(await upload.arrayBuffer()), {
      userId: id,
      ip: clientKey(c),
    });

    return c.json({ avatar: { ...saved, url: avatarUrl(id, saved.id) } }, 201);
  },
);

/** `DELETE /api/me/avatar`: tira a foto (204, também sem foto). */
profileRoutes.delete(
  "/api/me/avatar",
  sameOrigin,
  authRateLimit,
  requireAuth,
  blockWhileImpersonating,
  async (c) => {
    await removeAvatar({ userId: c.get("user").id, ip: clientKey(c) });
    return c.body(null, 204);
  },
);

const avatarParam = zValidator("param", avatarParamSchema, (result, c) => {
  if (!result.success) return c.json({ error: "Não encontrado." }, 404);
});

/**
 * `GET /api/avatars/:userId`: a foto, só para a sessão da equipe que divide uma organização com a
 * pessoa, para a equipe da plataforma e para a própria pessoa. Fora disso, ou sem foto, 404. Sai com
 * o tipo do registro (só PNG, JPEG ou WebP), `nosniff`, `inline` e cache privado; nunca por URL
 * pública do armazenamento.
 */
profileRoutes.get("/api/avatars/:userId", authRateLimit, requireAuth, avatarParam, async (c) => {
  const viewer = c.get("user");
  const { record, stream } = await openAvatar(
    {
      id: viewer.id,
      platformStaff: viewer.platformRole === "platform_owner" || viewer.platformRole === "platform_support",
    },
    c.req.valid("param").userId,
  );

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": record.mime,
      "Content-Length": String(record.size),
      "Content-Disposition": dispositionHeader(record.name, "inline"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
      // A imagem não roda nada; se alguém a abrir como documento, também não.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
