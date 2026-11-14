import { z } from "zod";
import { conversationStatuses } from "@/lib/inbox/constants";
import { customFieldValuesSchema, tagFilterSchema, tagIdsSchema } from "@/lib/schemas/crm";

/**
 * Contratos de `/api/inbox/*` (`docs/specs/caixa-de-entrada/spec.md`, "Contratos"). Servem à API
 * e, na C3, à tela.
 */

export const CONVERSATION_PAGE_DEFAULT = 30;
export const CONVERSATION_PAGE_MAX = 50;
export const MESSAGE_PAGE_DEFAULT = 50;
export const MESSAGE_PAGE_MAX = 100;
/** Teto de texto de uma mensagem do WhatsApp. */
export const MESSAGE_TEXT_MAX = 4096;

export const conversationTabs = ["queue", "mine", "all"] as const;
export type ConversationTab = (typeof conversationTabs)[number];

/** Cursor opaco (base64url); o conteúdo é conferido no servidor (`src/lib/inbox/cursor.ts`). */
const cursorSchema = z.string().trim().min(1).max(200);

const booleanQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const conversationsQuerySchema = z.object({
  tab: z.enum(conversationTabs).default("queue"),
  status: z.enum(conversationStatuses).optional(),
  unread: booleanQuery.optional(),
  channelId: z.uuid("Número inválido.").optional(),
  /** `tagIds=<id>,<id>`: conversa cujo cliente vinculado tem qualquer uma delas. */
  tagIds: tagFilterSchema.optional(),
  /** Só com `inbox:supervise`: as conversas de um atendente. */
  assignedTo: z.uuid("Atendente inválido.").optional(),
  q: z.string().trim().max(100).optional(),
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(CONVERSATION_PAGE_MAX).default(CONVERSATION_PAGE_DEFAULT),
});
export type ConversationsQuery = z.infer<typeof conversationsQuerySchema>;

export const messagesQuerySchema = z.object({
  before: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).default(MESSAGE_PAGE_DEFAULT),
});
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;

/** `PUT /api/inbox/messages/:id/favorite`: liga ou desliga a estrela da mensagem (idempotente). */
export const favoriteMessageSchema = z.object({ favorite: z.boolean("Informe se é favorita.") });
export type FavoriteMessageInput = z.infer<typeof favoriteMessageSchema>;

/** Gerado pela tela a cada envio: repetir o envio com o mesmo id devolve a mesma mensagem. */
export const clientIdSchema = z
  .string()
  .trim()
  .min(8, "Identificador do envio inválido.")
  .max(64, "Identificador do envio inválido.")
  .regex(/^[A-Za-z0-9_-]+$/, "Identificador do envio inválido.");

/** Legenda de mídia do WhatsApp. */
export const MEDIA_CAPTION_MAX = 1024;
/** Variáveis de um modelo (cabeçalho e corpo somam, no máximo). */
export const TEMPLATE_VARIABLES_MAX = 20;

/**
 * Envio por JSON: texto (com citação opcional) ou modelo aprovado. O anexo vai por `multipart`
 * (`sendMediaFormSchema`). Corpo de outro tipo é 400.
 */
export const sendMessageSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("text"),
      text: z
        .string()
        .trim()
        .min(1, "Escreva a mensagem.")
        .max(MESSAGE_TEXT_MAX, "Mensagem muito longa."),
      replyTo: z.uuid("Mensagem citada inválida.").optional(),
      clientId: clientIdSchema,
    }),
    z.object({
      type: z.literal("template"),
      templateId: z.uuid("Modelo inválido."),
      /** Na ordem das variáveis que o modelo pede (cabeçalho, depois corpo); o servidor confere. */
      variables: z
        .array(z.string().max(1100, "Uma variável está muito longa."))
        .max(TEMPLATE_VARIABLES_MAX, "Variáveis demais.")
        .default([]),
      clientId: clientIdSchema,
    }),
  ],
  { error: "Tipo de mensagem não suportado." },
);
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type SendTextInput = Extract<SendMessageInput, { type: "text" }>;
export type SendTemplateInput = Extract<SendMessageInput, { type: "template" }>;

const emptyToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);

/** Campos de texto do `multipart` do anexo (o campo `file` é conferido à parte, pelo conteúdo). */
export const sendMediaFormSchema = z.object({
  caption: z.preprocess(
    emptyToUndefined,
    z.string().trim().max(MEDIA_CAPTION_MAX, "Legenda muito longa.").optional(),
  ),
  replyTo: z.preprocess(emptyToUndefined, z.uuid("Mensagem citada inválida.").optional()),
  clientId: clientIdSchema,
});
export type SendMediaFormInput = z.infer<typeof sendMediaFormSchema>;

export const assignSchema = z.object({
  /** `null` devolve à fila. */
  userId: z.uuid("Atendente inválido.").nullable(),
});
export type AssignInput = z.infer<typeof assignSchema>;

export const conversationStatusSchema = z.object({
  status: z.enum(conversationStatuses, { error: "Situação inválida." }),
});

/** Iniciar conversa: um e só um destino, mais o número de saída. Não envia nada. */
export const startConversationSchema = z
  .object({
    channelId: z.uuid("Número inválido."),
    customerId: z.uuid("Cliente inválido.").optional(),
    userId: z.uuid("Membro inválido.").optional(),
    phone: z.string().trim().min(1).max(30).optional(),
  })
  .refine(
    (input) =>
      [input.customerId, input.userId, input.phone].filter((value) => value !== undefined)
        .length === 1,
    { message: "Informe um cliente, um membro ou um telefone." },
  );
export type StartConversationInput = z.infer<typeof startConversationSchema>;

export const updateContactSchema = z.object({
  /** Nome dado pela equipe; vazio ou `null` apaga (volta a valer o nome do WhatsApp). */
  name: z
    .string()
    .trim()
    .max(120, "Nome muito longo.")
    .nullable()
    .transform((value) => (value === "" ? null : value)),
});
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

/** Vincular a um cliente, a um membro, ou desfazer (os dois nulos). */
export const linkContactSchema = z.union([
  z.object({ customerId: z.uuid("Cliente inválido."), userId: z.undefined().optional() }).strict(),
  z.object({ userId: z.uuid("Membro inválido."), customerId: z.undefined().optional() }).strict(),
  z.object({ customerId: z.null(), userId: z.null() }).strict(),
], { error: "Informe o cliente, o membro, ou os dois nulos para desvincular." });
export type LinkContactInput = z.infer<typeof linkContactSchema>;

/**
 * "Salvar como cliente": o telefone é o do contato, como o WhatsApp entregou, salvo se o atendente o
 * corrigir (`phone`, validado pela regra do cadastro). O contato continua guardando o número do provedor.
 */
export const saveContactAsCustomerSchema = z.object({
  phone: z.preprocess(emptyToUndefined, z.string().trim().max(30, "Telefone inválido.").optional()),
  name: z.string().trim().min(2, "Informe o nome.").max(120, "Nome muito longo."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, "E-mail muito longo.")
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value))
    .refine((value) => !value || z.email().safeParse(value).success, "Informe um e-mail válido."),
  tagIds: tagIdsSchema.optional(),
  customFields: customFieldValuesSchema.optional(),
});
export type SaveContactAsCustomerInput = z.infer<typeof saveContactAsCustomerSchema>;

// ---------------------------------------------------------------------------
// Plataforma (`/api/admin/inbox/*`): só a lista, sem fila, dono nem cliente de owner
// ---------------------------------------------------------------------------

/** Sem `tab` (só existe a lista), `tagIds` (etiqueta é de cliente) e `assignedTo` (sem dono). */
export const platformConversationsQuerySchema = conversationsQuerySchema.omit({
  tab: true,
  tagIds: true,
  assignedTo: true,
});
export type PlatformConversationsQuery = z.infer<typeof platformConversationsQuerySchema>;

/**
 * Iniciar conversa na plataforma: um usuário ou um telefone. `.strict()` recusa `customerId` (400):
 * o cliente é do owner e a plataforma não o alcança (decisão do proprietário).
 */
export const platformStartConversationSchema = z
  .object({
    channelId: z.uuid("Número inválido."),
    userId: z.uuid("Usuário inválido.").optional(),
    phone: z.string().trim().min(1).max(30).optional(),
  })
  .strict()
  .refine((input) => [input.userId, input.phone].filter((value) => value !== undefined).length === 1, {
    message: "Informe um usuário ou um telefone.",
  });
export type PlatformStartConversationInput = z.infer<typeof platformStartConversationSchema>;

/** Vincular a um usuário, ou desfazer (`null`). Sem `customerId`. */
export const platformLinkContactSchema = z
  .object({ userId: z.uuid("Usuário inválido.").nullable() })
  .strict();
export type PlatformLinkContactInput = z.infer<typeof platformLinkContactSchema>;
