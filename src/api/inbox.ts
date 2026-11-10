import { Readable } from "node:stream";
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { requireAuth } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimit,
  MINUTE,
  sameOrigin,
  validationError,
  validId,
} from "@/api/guards";
import { blockMutationsWhileImpersonating } from "@/api/impersonation";
import { streamInboxEvents } from "@/api/inbox-events";
import { requirePermission, requireTenant, type TenantEnv } from "@/api/permissions";
import { clientKey, rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { TenantRuleError } from "@/lib/tenant/errors";
import { dispositionHeader } from "@/lib/files/types";
import {
  assignConversation,
  claimConversation,
  listAssignees,
  markConversationRead,
  setConversationStatus,
} from "@/lib/inbox/assignment";
import {
  contactCandidates,
  linkContact,
  saveContactAsCustomer,
  startConversation,
  updateContact,
} from "@/lib/inbox/contact-actions";
import {
  getConversation,
  listConversations,
  listMessages,
  unreadCounts,
} from "@/lib/inbox/conversations";
import { openMessageMedia, retryMessageMedia } from "@/lib/inbox/media-access";
import { MAX_OUTBOUND_MEDIA_BYTES } from "@/lib/inbox/media";
import { retryMessage, sendText } from "@/lib/inbox/send";
import { sendMedia } from "@/lib/inbox/send-media";
import { listConversationTemplates, sendTemplate } from "@/lib/inbox/send-template";
import { type InboxActor, inboxCapabilities } from "@/lib/inbox/visibility";
import {
  assignSchema,
  conversationStatusSchema,
  conversationsQuerySchema,
  linkContactSchema,
  messagesQuerySchema,
  saveContactAsCustomerSchema,
  sendMediaFormSchema,
  sendMessageSchema,
  startConversationSchema,
  updateContactSchema,
} from "@/lib/schemas/inbox";

/**
 * `/api/inbox/*`: caixa de entrada do tenant (`docs/specs/caixa-de-entrada/spec.md`). A rota
 * só monta o ator (tenant da sessão, permissões do papel) e valida a entrada; quem decide o que a
 * pessoa vê é `visibleConversation` (`src/lib/inbox/visibility.ts`), em toda consulta.
 *
 * Escritas: `blockMutationsWhileImpersonating` (a sessão personificada lê, mas não envia, não
 * assume nem marca como lida) e, pela regra geral de `requireTenant`, recusadas em `read_only`.
 */
export const inboxRoutes = new Hono<TenantEnv>();

/** Envio de anexo: `POST /api/inbox/conversations/:id/messages` com `multipart/form-data`. */
const isMediaUpload = (c: Context) =>
  c.req.method === "POST" &&
  /^\/api\/inbox\/conversations\/[^/]+\/messages$/.test(c.req.path) &&
  (c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");

const limitUpload = bodyLimit({
  // O arquivo (16 MB) mais os campos de texto e as fronteiras do multipart.
  maxSize: MAX_OUTBOUND_MEDIA_BYTES + 64 * 1024,
  onError: (c) =>
    c.json({ error: "Arquivo grande demais. O máximo é 16 MB.", code: "FILE_TOO_LARGE" }, 413),
});

/** 16 KB para JSON; no envio de anexo, o limite do arquivo. Sem corpo declarado, não há o que limitar. */
const inboxBodyLimit = createMiddleware(async (c, next) => {
  if (!isMediaUpload(c)) return jsonBodyLimit(c, next);
  if (!c.req.header("content-length") && !c.req.header("transfer-encoding")) return next();
  return limitUpload(c, next);
});

inboxRoutes.onError(handleTenantError);
inboxRoutes.use(
  "/api/inbox/*",
  sameOrigin,
  // 16 KB: 4096 unidades UTF-16 de texto dão no máximo ~12 KB em UTF-8. O envio de anexo (multipart) tem o
  // limite do arquivo (`inboxBodyLimit`).
  inboxBodyLimit,
  authRateLimit,
  requireAuth,
  requireTenant,
  blockMutationsWhileImpersonating,
);

export function inboxActor(c: Context<TenantEnv>): InboxActor {
  const permissions = c.get("permissions");

  return {
    scope: { kind: "tenant", tenantId: c.get("tenant").id },
    userId: c.get("user").id,
    can: inboxCapabilities(permissions),
    permissions,
    catalog: c.get("roleCatalog"),
    ip: clientKey(c),
  };
}

const userKey = (c: Context) => (c as Context<TenantEnv>).get("user").id;
const perUser = (name: string, limit: number) =>
  rateLimit({ name, limit, windowMs: MINUTE, key: userKey });

/** Assumir, transferir, situação e lida: 60 por minuto por pessoa. */
const queueLimit = perUser("inbox-queue", 60);
const mediaRetryLimit = perUser("inbox-media-retry", 20);
/** Envio e reenvio: 60 por minuto por pessoa (SPEC, "Contratos"). */
const sendLimit = perUser("inbox-send", 60);
/** Anexos (até 16 MB cada) pesam mais que texto: 20 por minuto por pessoa, além do limite de envio. */
const uploadRate = perUser("inbox-upload", 20);
const uploadLimit = createMiddleware(async (c, next) =>
  isMediaUpload(c) ? uploadRate(c, next) : next(),
);
/** Iniciar conversa: 20 por minuto por pessoa. */
const startLimit = perUser("inbox-start", 20);

const canRead = requirePermission("inbox", "read");
const canReply = requirePermission("inbox", "reply");

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

inboxRoutes.get(
  "/api/inbox/conversations",
  canRead,
  zValidator("query", conversationsQuerySchema, validationError),
  async (c) => c.json(await listConversations(inboxActor(c), c.req.valid("query"))),
);

inboxRoutes.get("/api/inbox/conversations/:id", canRead, validId, async (c) =>
  c.json(await getConversation(inboxActor(c), c.req.valid("param").id)),
);

inboxRoutes.get(
  "/api/inbox/conversations/:id/messages",
  canRead,
  validId,
  zValidator("query", messagesQuerySchema, validationError),
  async (c) =>
    c.json(await listMessages(inboxActor(c), c.req.valid("param").id, c.req.valid("query"))),
);

inboxRoutes.get("/api/inbox/unread", canRead, async (c) => c.json(await unreadCounts(inboxActor(c))));

/** SSE só com ids, filtrado por pessoa no servidor (`src/api/inbox-events.ts`). */
inboxRoutes.get("/api/inbox/events", canRead, (c) => streamInboxEvents(c, inboxActor(c)));

inboxRoutes.get("/api/inbox/assignees", requirePermission("inbox", "assign"), async (c) =>
  c.json({ users: await listAssignees(inboxActor(c)) }),
);

inboxRoutes.get("/api/inbox/messages/:id/media", canRead, validId, async (c) => {
  const media = await openMessageMedia(inboxActor(c), c.req.valid("param").id);

  return new Response(Readable.toWeb(media.body) as ReadableStream, {
    headers: {
      "Content-Type": media.mime,
      "Content-Length": String(media.size),
      "Content-Disposition": dispositionHeader(media.name, media.inline ? "inline" : "attachment"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
    },
  });
});

// ---------------------------------------------------------------------------
// Fila e situação
// ---------------------------------------------------------------------------

inboxRoutes.post("/api/inbox/conversations/:id/claim", canReply, queueLimit, validId, async (c) =>
  c.json({ conversation: await claimConversation(inboxActor(c), c.req.valid("param").id) }),
);

/** `null` na própria conversa pede `inbox:reply`; o resto, `inbox:assign` (conferido no serviço). */
inboxRoutes.post(
  "/api/inbox/conversations/:id/assign",
  canRead,
  queueLimit,
  validId,
  zValidator("json", assignSchema, validationError),
  async (c) =>
    c.json({
      conversation: await assignConversation(
        inboxActor(c),
        c.req.valid("param").id,
        c.req.valid("json").userId,
      ),
    }),
);

inboxRoutes.post(
  "/api/inbox/conversations/:id/status",
  canReply,
  queueLimit,
  validId,
  zValidator("json", conversationStatusSchema, validationError),
  async (c) =>
    c.json({
      conversation: await setConversationStatus(
        inboxActor(c),
        c.req.valid("param").id,
        c.req.valid("json").status,
      ),
    }),
);

inboxRoutes.post("/api/inbox/conversations/:id/read", canRead, queueLimit, validId, async (c) => {
  await markConversationRead(inboxActor(c), c.req.valid("param").id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/**
 * JSON (`type: "text"` com `replyTo`, ou `type: "template"`) ou `multipart/form-data` (anexo com
 * `file`, `caption?`, `replyTo?`, `clientId`). Enviada ou ainda sem resposta do provedor: 201. Recusada
 * pelo provedor: 200 com a mensagem `failed` e o motivo (a falha é dado, não erro de API; SPEC, "Envio").
 */
inboxRoutes.post(
  "/api/inbox/conversations/:id/messages",
  canReply,
  sendLimit,
  uploadLimit,
  validId,
  async (c) => {
    const actor = inboxActor(c);
    const conversationId = c.req.valid("param").id;

    const outcome = isMediaUpload(c)
      ? await sendMediaFrom(c, actor, conversationId)
      : await sendJsonFrom(c, actor, conversationId);

    return c.json({ message: outcome.message }, outcome.failed ? 200 : 201);
  },
);

async function sendJsonFrom(c: Context<TenantEnv>, actor: InboxActor, conversationId: string) {
  const parsed = sendMessageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new TenantRuleError(400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Dados inválidos.");
  }

  return parsed.data.type === "template"
    ? sendTemplate(actor, conversationId, parsed.data)
    : sendText(actor, conversationId, parsed.data);
}

async function sendMediaFrom(c: Context<TenantEnv>, actor: InboxActor, conversationId: string) {
  const form = await c.req.parseBody().catch(() => null);
  const upload = form?.file;
  if (!(upload instanceof File)) {
    throw new TenantRuleError(400, "FILE_REQUIRED", "Envie o arquivo no campo file.");
  }
  // Antes de ler o arquivo para a memória.
  if (upload.size > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new TenantRuleError(413, "FILE_TOO_LARGE", "Arquivo grande demais. O máximo é 16 MB.");
  }

  const fields = sendMediaFormSchema.safeParse({
    caption: form?.caption,
    replyTo: form?.replyTo,
    clientId: form?.clientId,
  });
  if (!fields.success) {
    throw new TenantRuleError(400, "VALIDATION_ERROR", fields.error.issues[0]?.message ?? "Dados inválidos.");
  }

  return sendMedia(
    actor,
    conversationId,
    {
      name: upload.name,
      declaredMime: upload.type || null,
      body: Buffer.from(await upload.arrayBuffer()),
    },
    fields.data,
  );
}

/** Modelos aprovados do WABA do canal da conversa (para o `template-dialog`). */
inboxRoutes.get("/api/inbox/conversations/:id/templates", canReply, validId, async (c) =>
  c.json(await listConversationTemplates(inboxActor(c), c.req.valid("param").id)),
);

inboxRoutes.post("/api/inbox/messages/:id/retry", canReply, sendLimit, validId, async (c) => {
  const { message, failed } = await retryMessage(inboxActor(c), c.req.valid("param").id);
  return c.json({ message }, failed ? 200 : 201);
});

// ---------------------------------------------------------------------------
// Contato e início de conversa
// ---------------------------------------------------------------------------

/** Acha ou cria; não envia nada. 201 quando nasceu agora. */
inboxRoutes.post(
  "/api/inbox/conversations",
  canReply,
  startLimit,
  zValidator("json", startConversationSchema, validationError),
  async (c) => {
    const { conversation, created } = await startConversation(inboxActor(c), c.req.valid("json"));
    return c.json({ conversation }, created ? 201 : 200);
  },
);

inboxRoutes.patch(
  "/api/inbox/contacts/:id",
  canReply,
  queueLimit,
  validId,
  zValidator("json", updateContactSchema, validationError),
  async (c) =>
    c.json(await updateContact(inboxActor(c), c.req.valid("param").id, c.req.valid("json").name)),
);

inboxRoutes.get("/api/inbox/contacts/:id/candidates", canReply, validId, async (c) =>
  c.json(await contactCandidates(inboxActor(c), c.req.valid("param").id)),
);

/** Com `customerId`, também `customer:update` (conferido no serviço). */
inboxRoutes.post(
  "/api/inbox/contacts/:id/link",
  canReply,
  queueLimit,
  validId,
  zValidator("json", linkContactSchema, validationError),
  async (c) =>
    c.json(await linkContact(inboxActor(c), c.req.valid("param").id, c.req.valid("json"))),
);

inboxRoutes.post(
  "/api/inbox/contacts/:id/customer",
  canReply,
  requirePermission("customer", "create"),
  queueLimit,
  validId,
  zValidator("json", saveContactAsCustomerSchema, validationError),
  async (c) => {
    const customer = await saveContactAsCustomer(
      inboxActor(c),
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    return c.json({ customer }, 201);
  },
);

inboxRoutes.post(
  "/api/inbox/messages/:id/media/retry",
  canRead,
  mediaRetryLimit,
  validId,
  async (c) => {
    await retryMessageMedia(inboxActor(c), c.req.valid("param").id);
    return c.json({ ok: true }, 202);
  },
);
