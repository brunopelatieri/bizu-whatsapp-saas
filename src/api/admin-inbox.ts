import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { type AuthEnv, requireAuth, requirePlatform } from "@/api/auth";
import { authRateLimit, MINUTE, sameOrigin, validationError, validId } from "@/api/guards";
import { blockMutationsWhileImpersonating } from "@/api/impersonation";
import { streamInboxEvents } from "@/api/inbox-events";
import {
  inboxBodyLimit,
  isMediaUpload,
  mediaResponse,
  sendJsonFrom,
  sendMediaFrom,
} from "@/api/inbox-shared";
import { clientKey, rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import { markConversationRead, setConversationStatus } from "@/lib/inbox/assignment";
import { updateContact } from "@/lib/inbox/contact-actions";
import {
  getConversation,
  listConversations,
  listMessages,
  listRelatedConversations,
  unreadCounts,
} from "@/lib/inbox/conversations";
import { openMessageMedia, retryMessageMedia } from "@/lib/inbox/media-access";
import {
  linkPlatformContact,
  PLATFORM_REPLY_ROLES,
  platformActor,
  startPlatformConversation,
} from "@/lib/inbox/platform";
import { setMessageFavorite } from "@/lib/inbox/favorite";
import { retryMessage } from "@/lib/inbox/send";
import { listConversationTemplates } from "@/lib/inbox/send-template";
import type { InboxActor } from "@/lib/inbox/visibility";
import {
  conversationStatusSchema,
  favoriteMessageSchema,
  messagesQuerySchema,
  platformConversationsQuerySchema,
  platformLinkContactSchema,
  platformStartConversationSchema,
  updateContactSchema,
} from "@/lib/schemas/inbox";

/**
 * `/api/admin/inbox/*`: atendimento da **plataforma** (`tenant_id` nulo), a versão de `/api/inbox` com
 * `Scope = platform` (SPEC da caixa de entrada, "Plataforma"). Só existe a lista: não há fila, dono,
 * `claim`, `assign`, `assignees`, `candidates`, `customer` nem `customerId`, e **nada** daqui lê
 * `customer` de tenant nem usa `withPlatformScope` (decisão do proprietário: o cliente é do owner).
 *
 * - Leitura: qualquer papel de plataforma. Enviar, mudar a situação, iniciar conversa, vincular e
 *   renomear o contato: `PLATFORM_REPLY_ROLES` (`platform_owner` e `platform_support`; decisão do
 *   proprietário). É a única escrita do suporte em `/admin`: canal, etiqueta e campo seguem só com o
 *   `platform_owner`.
 * - Toda escrita passa por `blockMutationsWhileImpersonating` (a sessão personificada não envia).
 *
 * Traz a própria cadeia de guardas e é montado **antes** de `adminRoutes` em `app.ts`, como
 * `admin-channels.ts`: a cadeia de `/api/admin/*` não roda duas vezes.
 */
export const adminInboxRoutes = new Hono<AuthEnv>();

adminInboxRoutes.onError(handleTenantError);
adminInboxRoutes.use(
  "/api/admin/inbox/*",
  sameOrigin,
  inboxBodyLimit,
  authRateLimit,
  requireAuth,
  requirePlatform(),
  blockMutationsWhileImpersonating,
);

/** O escopo é fixo: nada da requisição escolhe o tenant. */
const actorOf = (c: Context<AuthEnv>): InboxActor => platformActor(c.get("user"), clientKey(c));

const userKey = (c: Context) => (c as Context<AuthEnv>).get("user").id;
const perUser = (name: string, limit: number) =>
  rateLimit({ name, limit, windowMs: MINUTE, key: userKey });

const queueLimit = perUser("admin-inbox-queue", 60);
const mediaRetryLimit = perUser("admin-inbox-media-retry", 20);
const sendLimit = perUser("admin-inbox-send", 60);
const uploadRate = perUser("admin-inbox-upload", 20);
const uploadLimit = createMiddleware(async (c, next) =>
  isMediaUpload(c) ? uploadRate(c, next) : next(),
);
const startLimit = perUser("admin-inbox-start", 20);

/** Quem responde. O serviço confere de novo (`actor.can.reply`). */
const canReply = requirePlatform([...PLATFORM_REPLY_ROLES]);

// ---------------------------------------------------------------------------
// Leitura (qualquer papel de plataforma)
// ---------------------------------------------------------------------------

adminInboxRoutes.get(
  "/api/admin/inbox/conversations",
  zValidator("query", platformConversationsQuerySchema, validationError),
  // Só existe a lista: `tab = all` não pede supervisão na plataforma.
  async (c) =>
    c.json(await listConversations(actorOf(c), { ...c.req.valid("query"), tab: "all" })),
);

adminInboxRoutes.get("/api/admin/inbox/conversations/:id", validId, async (c) =>
  c.json(await getConversation(actorOf(c), c.req.valid("param").id)),
);

adminInboxRoutes.get(
  "/api/admin/inbox/conversations/:id/messages",
  validId,
  zValidator("query", messagesQuerySchema, validationError),
  async (c) =>
    c.json(await listMessages(actorOf(c), c.req.valid("param").id, c.req.valid("query"))),
);

/** As outras conversas do contato, só as da plataforma (nenhuma de tenant). */
adminInboxRoutes.get("/api/admin/inbox/conversations/:id/related", validId, async (c) =>
  c.json(await listRelatedConversations(actorOf(c), c.req.valid("param").id)),
);

adminInboxRoutes.get("/api/admin/inbox/unread", async (c) => c.json(await unreadCounts(actorOf(c))));

/** SSE só com ids, do escopo da plataforma (`src/api/inbox-events.ts`). */
adminInboxRoutes.get("/api/admin/inbox/events", (c) => streamInboxEvents(c, actorOf(c)));

adminInboxRoutes.get("/api/admin/inbox/messages/:id/media", validId, async (c) =>
  mediaResponse(await openMessageMedia(actorOf(c), c.req.valid("param").id)),
);

// ---------------------------------------------------------------------------
// Situação e leitura
// ---------------------------------------------------------------------------

adminInboxRoutes.post(
  "/api/admin/inbox/conversations/:id/status",
  canReply,
  queueLimit,
  validId,
  zValidator("json", conversationStatusSchema, validationError),
  async (c) =>
    c.json({
      conversation: await setConversationStatus(
        actorOf(c),
        c.req.valid("param").id,
        c.req.valid("json").status,
      ),
    }),
);

/** Marcar como lida zera o contador de todos: quem responde. */
adminInboxRoutes.post(
  "/api/admin/inbox/conversations/:id/read",
  canReply,
  queueLimit,
  validId,
  async (c) => {
    await markConversationRead(actorOf(c), c.req.valid("param").id);
    return c.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/** JSON (`text` com `replyTo`, ou `template`) ou `multipart/form-data` (anexo); igual ao do tenant. */
adminInboxRoutes.post(
  "/api/admin/inbox/conversations/:id/messages",
  canReply,
  sendLimit,
  uploadLimit,
  validId,
  async (c) => {
    const actor = actorOf(c);
    const conversationId = c.req.valid("param").id;

    const outcome = isMediaUpload(c)
      ? await sendMediaFrom(c, actor, conversationId)
      : await sendJsonFrom(c, actor, conversationId);

    return c.json({ message: outcome.message }, outcome.failed ? 200 : 201);
  },
);

adminInboxRoutes.get("/api/admin/inbox/conversations/:id/templates", canReply, validId, async (c) =>
  c.json(await listConversationTemplates(actorOf(c), c.req.valid("param").id)),
);

adminInboxRoutes.post(
  "/api/admin/inbox/messages/:id/retry",
  canReply,
  sendLimit,
  validId,
  async (c) => {
    const { message, failed } = await retryMessage(actorOf(c), c.req.valid("param").id);
    return c.json({ message }, failed ? 200 : 201);
  },
);

adminInboxRoutes.post(
  "/api/admin/inbox/messages/:id/media/retry",
  canReply,
  mediaRetryLimit,
  validId,
  async (c) => {
    await retryMessageMedia(actorOf(c), c.req.valid("param").id);
    return c.json({ ok: true }, 202);
  },
);

/**
 * Estrela da mensagem (retenção, R3a), igual à do tenant, no escopo da plataforma: a limpeza também
 * poda `tenant_id` nulo (padrões do `.env`), então quem atende ali também precisa poupar a mensagem.
 */
adminInboxRoutes.put(
  "/api/admin/inbox/messages/:id/favorite",
  canReply,
  queueLimit,
  validId,
  zValidator("json", favoriteMessageSchema, validationError),
  async (c) =>
    c.json({
      message: await setMessageFavorite(
        actorOf(c),
        c.req.valid("param").id,
        c.req.valid("json").favorite,
      ),
    }),
);

// ---------------------------------------------------------------------------
// Contato e início de conversa
// ---------------------------------------------------------------------------

/** Acha ou cria; não envia nada. `{ channelId, userId | phone }`; `customerId` é 400. */
adminInboxRoutes.post(
  "/api/admin/inbox/conversations",
  canReply,
  startLimit,
  zValidator("json", platformStartConversationSchema, validationError),
  async (c) => {
    const { conversation, created } = await startPlatformConversation(
      actorOf(c),
      c.req.valid("json"),
    );
    return c.json({ conversation }, created ? 201 : 200);
  },
);

adminInboxRoutes.patch(
  "/api/admin/inbox/contacts/:id",
  canReply,
  queueLimit,
  validId,
  zValidator("json", updateContactSchema, validationError),
  async (c) =>
    c.json(await updateContact(actorOf(c), c.req.valid("param").id, c.req.valid("json").name)),
);

/** Só `userId` ou `null`: o cliente do owner não é alcançável. */
adminInboxRoutes.post(
  "/api/admin/inbox/contacts/:id/link",
  canReply,
  queueLimit,
  validId,
  zValidator("json", platformLinkContactSchema, validationError),
  async (c) =>
    c.json(await linkPlatformContact(actorOf(c), c.req.valid("param").id, c.req.valid("json"))),
);
