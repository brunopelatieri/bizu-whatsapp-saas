import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { ChannelStatus, ChannelType } from "@/lib/channels/types";
import type { TagRef } from "@/components/crm/tags-api";
import type {
  ConversationStatus,
  MediaStatus,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  MessageType,
} from "@/lib/inbox/constants";
import { type InboxRealtimeMode, useInboxRealtimeMode } from "@/components/inbox/realtime-mode";
import type { TransferOption } from "@/lib/inbox/transfer";
import type { ConversationTab } from "@/lib/schemas/inbox";
import { type InboxMode, type InboxScope, useInboxScope } from "@/components/inbox/inbox-scope";
import { useAuth } from "@/providers/auth-provider";

/**
 * Tipos e hooks de `/api/inbox/*` (`docs/specs/caixa-de-entrada/spec.md`). Os tipos espelham o que
 * a API devolve (datas em ISO); `src/lib/inbox/views.ts` é a fonte, e nada daqui importa código de
 * servidor.
 *
 * Atualização (C4): com o SSE de pé (`use-inbox-events.ts`), os eventos invalidam as queries pelos
 * ids e só a lista e o contador são relidos a cada `INBOX_LIVE_LIST_MS` (rede de segurança); a
 * conversa e as mensagens dependem só dos eventos. Sem SSE, polling de `INBOX_POLL_MS` em tudo.
 */

export const INBOX_POLL_MS = 20_000;
/** Releitura da lista e do contador com o SSE de pé (SPEC: "a cada 60 s refaz a lista"). */
export const INBOX_LIVE_LIST_MS = 60_000;
/** Raiz das chaves; `invalidateInbox` e a C4 invalidam por aqui. */
export const INBOX_KEY = "inbox";

export type TagView = TagRef;

export type ConversationItem = {
  id: string;
  status: ConversationStatus;
  channel: { id: string; name: string; type: ChannelType };
  contact: { id: string; displayName: string | null; phone: string; identified: boolean };
  assignedTo: { id: string; name: string } | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: MessageDirection | null;
  unreadCount: number;
  tags: TagView[];
};

export type ConversationDetail = Omit<ConversationItem, "channel"> & {
  channel: { id: string; name: string; type: ChannelType; status: ChannelStatus };
  closedAt: string | null;
  createdAt: string;
};

export type ContactView = {
  id: string;
  phone: string;
  name: string | null;
  waName: string | null;
  displayName: string | null;
  createdVia: "inbound" | "outbound" | "device";
  identified: boolean;
};

export type ContactLink =
  | {
      kind: "customer";
      customer: {
        id: string;
        /** `null` sem `customer:read`. */
        name: string | null;
        email?: string | null;
        phone?: string | null;
        status?: string;
      };
      tags: TagView[];
      customFields: Record<string, unknown>;
    }
  | { kind: "member"; user: { id: string; name: string } }
  /** Plataforma: o usuário vinculado e as organizações dele (nunca cliente de owner). */
  | { kind: "user"; user: { id: string; name: string }; organizations: PlatformOrganization[] }
  | {
      kind: "none";
      /** Ausente na plataforma (não há candidatos lá). */
      candidates?: {
        customers: { id: string; name: string; phone: string | null }[];
        users: { id: string; name: string }[];
      };
    };

export type PlatformOrganization = {
  id: string;
  name: string;
  role: string;
  tags: TagView[];
  /** Valores por id do campo; as definições vêm de `/api/admin/crm/custom-fields`. */
  customFields: Record<string, unknown>;
};

export type SessionWindow = { applies: boolean; open: boolean; expiresAt: string | null };

export type ConversationResponse = {
  conversation: ConversationDetail;
  contact: ContactView;
  link: ContactLink;
  window: SessionWindow;
};

export type MessageView = {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  senderType: MessageSenderType;
  sender: { id: string; name: string } | null;
  type: MessageType;
  text: string | null;
  /** Mensagem de modelo: o nome do modelo (o texto já preenchido está em `text`). */
  template: { name: string } | null;
  status: MessageStatus | null;
  error: { code: string | null; message: string | null } | null;
  media: {
    url: string;
    mime: string | null;
    size: number | null;
    name: string | null;
    status: MediaStatus;
  } | null;
  replyTo: { id: string; type: MessageType; preview: string; direction: MessageDirection } | null;
  /** Estrela da conversa (a mesma para quem tem acesso a ela); a limpeza de retenção poupa a favorita. */
  isFavorite: boolean;
  createdAt: string;
};

type Page<T> = { items: T[]; nextCursor: string | null };

export type ConversationFilters = {
  /** Na plataforma só existe a lista: o campo é ignorado (a API não tem aba). */
  tab: ConversationTab;
  status?: ConversationStatus;
  unread?: boolean;
  channelId?: string;
  tagIds?: string[];
  assignedTo?: string;
  q?: string;
};

const PAGE_SIZE = 30;

// ---------------------------------------------------------------------------
// Chaves
// ---------------------------------------------------------------------------

type TenantId = string | undefined;

export const inboxKeys = {
  all: (tenantId: TenantId) => [INBOX_KEY, tenantId] as const,
  conversations: (tenantId: TenantId, filters?: ConversationFilters) =>
    filters
      ? ([INBOX_KEY, tenantId, "conversations", filters] as const)
      : ([INBOX_KEY, tenantId, "conversations"] as const),
  conversation: (tenantId: TenantId, id: string) =>
    [INBOX_KEY, tenantId, "conversation", id] as const,
  /**
   * As outras conversas do contato. Mora sob `conversations` de propósito: qualquer mudança que releia
   * a lista (um aviso do SSE de outra conversa do mesmo contato, por exemplo) relê esta também.
   */
  related: (tenantId: TenantId, id: string) =>
    [INBOX_KEY, tenantId, "conversations", "related", id] as const,
  /** Os números para "Continuar por outro número" (X2). Sob `conversations`, como `related`. */
  transferChannels: (tenantId: TenantId, id: string) =>
    [INBOX_KEY, tenantId, "conversations", "transfer", id] as const,
  messages: (tenantId: TenantId, id: string) => [INBOX_KEY, tenantId, "messages", id] as const,
  unread: (tenantId: TenantId) => [INBOX_KEY, tenantId, "unread"] as const,
  assignees: (tenantId: TenantId) => [INBOX_KEY, tenantId, "assignees"] as const,
  templates: (tenantId: TenantId, id: string) => [INBOX_KEY, tenantId, "templates", id] as const,
};

/** O que uma mudança afeta em uma conversa: o detalhe e/ou as mensagens. */
export type ConversationChange = { detail: boolean; messages: boolean };

/**
 * Fonte única das chaves que uma mudança afeta. `lists` = lista e contador; por conversa, o detalhe e
 * as mensagens conforme `ConversationChange`. Usada pelas escritas da tela (`invalidateInbox`) e pelos
 * eventos do SSE (`use-inbox-events.ts`, que junta uma rajada numa chamada só).
 */
export function invalidateInboxChanges(
  queryClient: QueryClient,
  tenantId: TenantId,
  changes: { lists: boolean; conversations?: Iterable<[string, ConversationChange]> },
) {
  const keys: (readonly unknown[])[] = [];

  if (changes.lists) keys.push(inboxKeys.conversations(tenantId), inboxKeys.unread(tenantId));
  for (const [conversationId, change] of changes.conversations ?? []) {
    if (change.detail) keys.push(inboxKeys.conversation(tenantId, conversationId));
    if (change.messages) keys.push(inboxKeys.messages(tenantId, conversationId));
  }

  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/**
 * Invalida o que uma escrita da tela afeta: sempre a lista e o contador. Com `conversationId`, o detalhe
 * e (salvo `messages: false`) as mensagens daquela conversa; sem ele, o detalhe de todas e nenhuma
 * mensagem. Nunca escreve no cache.
 */
export function invalidateInbox(
  queryClient: QueryClient,
  tenantId: TenantId,
  scope: { conversationId?: string; messages?: boolean } = {},
) {
  const { conversationId, messages = true } = scope;

  if (!conversationId) {
    return Promise.all([
      invalidateInboxChanges(queryClient, tenantId, { lists: true }),
      queryClient.invalidateQueries({ queryKey: [INBOX_KEY, tenantId, "conversation"] }),
    ]);
  }
  return invalidateInboxChanges(queryClient, tenantId, {
    lists: true,
    conversations: [[conversationId, { detail: true, messages }]],
  });
}

/** Chave das mutações de envio: os eventos esperam o envio terminar para reler as mensagens. */
export const INBOX_SEND_KEY = [INBOX_KEY, "send"] as const;

/**
 * Intervalo pelo modo. `list`: lista, contador e o detalhe da conversa (que traz a janela de 24 h,
 * calculada no servidor e que expira sem evento); `detail`: as mensagens, que só mudam com evento.
 */
export function refetchIntervalFor(
  mode: InboxRealtimeMode,
  kind: "list" | "detail",
): number | false {
  if (mode === "live") return kind === "list" ? INBOX_LIVE_LIST_MS : false;
  return INBOX_POLL_MS;
}

/**
 * Intervalo de atualização das queries da caixa. Em pausa enquanto há envio em andamento (uma
 * releitura no meio do envio mostraria a mensagem `queued` do servidor ao lado da otimista).
 */
export function useInboxRefetchInterval(kind: "list" | "detail" = "list") {
  const sending = useIsMutating({ mutationKey: INBOX_SEND_KEY }) > 0;
  const mode = useInboxRealtimeMode();

  return sending ? false : refetchIntervalFor(mode, kind);
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

function conversationsPath(scope: InboxScope, filters: ConversationFilters, cursor: string | undefined) {
  const search = new URLSearchParams({ limit: String(PAGE_SIZE) });

  if (scope.mode === "tenant") search.set("tab", filters.tab);

  if (filters.status) search.set("status", filters.status);
  if (filters.unread) search.set("unread", "true");
  if (filters.channelId) search.set("channelId", filters.channelId);
  if (scope.mode === "tenant") {
    if (filters.tagIds && filters.tagIds.length > 0) search.set("tagIds", filters.tagIds.join(","));
    if (filters.assignedTo) search.set("assignedTo", filters.assignedTo);
  }
  if (filters.q) search.set("q", filters.q);
  if (cursor) search.set("cursor", cursor);

  return `${scope.api}/conversations?${search}`;
}

/** Lista por cursor; cada página é lida de novo no polling, na ordem. */
export function useConversations(filters: ConversationFilters, enabled = true) {
  const scope = useInboxScope();
  const interval = useInboxRefetchInterval();

  return useInfiniteQuery({
    queryKey: inboxKeys.conversations(scope.key, filters),
    queryFn: ({ pageParam }) =>
      apiFetch<Page<ConversationItem>>(conversationsPath(scope, filters, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && scope.ready,
    refetchInterval: interval,
    retry: false,
  });
}

export function useConversation(id: string | undefined) {
  const scope = useInboxScope();
  // A janela de 24 h expira sem evento: o detalhe segue o ciclo da lista (60 s ao vivo).
  const interval = useInboxRefetchInterval("list");

  return useQuery({
    queryKey: inboxKeys.conversation(scope.key, id ?? ""),
    queryFn: () => apiFetch<ConversationResponse>(`${scope.api}/conversations/${id}`),
    enabled: scope.ready && Boolean(id),
    refetchInterval: interval,
    retry: false,
  });
}

/** Uma conversa do mesmo contato em outro número ("Também neste contato"). */
export type RelatedConversation = {
  id: string;
  status: ConversationStatus;
  channel: { id: string; name: string; type: ChannelType };
  lastMessageAt: string | null;
  createdAt: string;
};

/** As outras conversas do contato que a pessoa pode ver; vazio = a seção não aparece. */
export function useRelatedConversations(conversationId: string | undefined) {
  const scope = useInboxScope();
  const interval = useInboxRefetchInterval("list");

  return useQuery({
    queryKey: inboxKeys.related(scope.key, conversationId ?? ""),
    queryFn: () =>
      apiFetch<{ items: RelatedConversation[] }>(
        `${scope.api}/conversations/${conversationId}/related`,
      ).then(({ items }) => items),
    enabled: scope.ready && Boolean(conversationId),
    refetchInterval: interval,
    retry: false,
  });
}

/**
 * Os outros números do escopo para seguir a conversa com o contato (X2), cada um elegível ou com o
 * motivo, como o servidor decidiu (`GET .../conversations/:id/transfer-channels`). A tela só mostra.
 */
export function useTransferChannels(conversationId: string | undefined, enabled = true) {
  const scope = useInboxScope();
  const interval = useInboxRefetchInterval("list");

  return useQuery({
    queryKey: inboxKeys.transferChannels(scope.key, conversationId ?? ""),
    queryFn: () =>
      apiFetch<{ items: TransferOption[] }>(
        `${scope.api}/conversations/${conversationId}/transfer-channels`,
      ).then(({ items }) => items),
    enabled: enabled && scope.ready && Boolean(conversationId),
    refetchInterval: interval,
    retry: false,
  });
}

/** Da mais nova para a mais antiga, por página; a tela inverte para ler de cima para baixo. */
export function useMessages(conversationId: string | undefined) {
  const scope = useInboxScope();
  const interval = useInboxRefetchInterval("detail");

  return useInfiniteQuery({
    queryKey: inboxKeys.messages(scope.key, conversationId ?? ""),
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: "50" });
      if (pageParam) search.set("before", pageParam);
      return apiFetch<Page<MessageView>>(
        `${scope.api}/conversations/${conversationId}/messages?${search}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: scope.ready && Boolean(conversationId),
    refetchInterval: interval,
    retry: false,
  });
}

/** Conversas com não lidas na fila e nas minhas (o ponto do menu); os eventos o invalidam. */
export function useInboxUnread(enabled = true, inboxMode?: InboxMode) {
  const scope = useInboxScope(inboxMode);
  const { permissions } = useAuth();
  const mode = useInboxRealtimeMode();

  return useQuery({
    queryKey: inboxKeys.unread(scope.key),
    queryFn: () => apiFetch<{ queue: number; mine: number }>(`${scope.api}/unread`),
    // Na plataforma, quem chega ao menu já é de plataforma (a API confere).
    enabled:
      enabled && scope.ready && (scope.mode === "platform" || permissions.includes("inbox:read")),
    refetchInterval: refetchIntervalFor(mode, "list"),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Membros que podem receber uma conversa (`inbox:assign`). */
export function useAssignees(enabled: boolean) {
  const scope = useInboxScope();

  return useQuery({
    queryKey: inboxKeys.assignees(scope.key),
    queryFn: () =>
      apiFetch<{ users: { id: string; name: string }[] }>("/api/inbox/assignees").then(
        ({ users }) => users,
      ),
    // Só o tenant tem dono e transferência.
    enabled: enabled && scope.mode === "tenant" && scope.ready,
    staleTime: 60_000,
    retry: false,
  });
}

/** Junta as páginas de mensagens em ordem cronológica (a API entrega da mais nova para a mais antiga). */
export function chronological(data: InfiniteData<Page<MessageView>> | undefined): MessageView[] {
  if (!data) return [];
  const seen = new Set<string>();
  const items: MessageView[] = [];

  for (const page of data.pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }

  return items.reverse();
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

type InboxRequest = {
  path: string;
  method: "POST" | "PATCH" | "PUT";
  body?: unknown;
};

/** Texto do erro da API para o toast; o que a regra de negócio explica já vem em português. */
export function errorText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "PLAN_LIMIT_REACHED") {
      return "O plano chegou ao limite de clientes. Faça upgrade em Assinatura para cadastrar mais.";
    }
    return error.message;
  }
  return "Não foi possível concluir. Tente novamente.";
}

/**
 * Escrita da caixa (assumir, devolver, situação, vínculo…): relê a caixa no fim e mostra o erro.
 * 409 `ALREADY_ASSIGNED` e 404 também releem, porque a tela estava desatualizada. `conversationId`
 * restringe a releitura àquela conversa (`messages: false` quando as mensagens não mudam).
 */
export function useInboxMutation<T = unknown>(
  options: { success?: string; silent?: boolean; conversationId?: string; messages?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const scope = useInboxScope();

  return useMutation({
    mutationFn: ({ path, method, body }: InboxRequest) =>
      apiFetch<T>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: () => {
      if (options.success) toast.success(options.success);
    },
    onError: (error) => {
      if (!options.silent) toast.error(errorText(error));
    },
    onSettled: () =>
      invalidateInbox(queryClient, scope.key, {
        conversationId: options.conversationId,
        messages: options.messages,
      }),
  });
}

/** O anexo de um envio em andamento: o nome e, se for imagem, a prévia local (revogada ao terminar). */
export type SendingAttachment = { name: string; previewUrl: string | null };

/** Mensagem que a tela mostra enquanto o envio não voltou (não existe na API). */
export type SendingMessage = {
  clientId: string;
  /** Texto, legenda ou o modelo já preenchido. */
  text: string;
  createdAt: string;
  attachment?: SendingAttachment;
  template?: { name: string };
};

/** `crypto.randomUUID` sem hífens cabe no `clientIdSchema` (8 a 64, `[A-Za-z0-9_-]`). */
export function newClientId() {
  return globalThis.crypto.randomUUID();
}

export type SendResult = { message: MessageView };

/** O que se envia: texto (com citação), anexo (com legenda e citação) ou modelo. */
export type SendPayload =
  | { kind: "text"; text: string; replyTo?: string }
  | { kind: "media"; file: File; caption?: string; replyTo?: string }
  | { kind: "template"; templateId: string; variables: string[] };

/**
 * Corpo da requisição: JSON para texto e modelo; `multipart/form-data` para o anexo. Sem
 * `Content-Type` à mão no multipart: o navegador acrescenta a fronteira.
 */
function sendRequest(scope: InboxScope, conversationId: string, clientId: string, payload: SendPayload) {
  const path = `${scope.api}/conversations/${conversationId}/messages`;

  if (payload.kind === "media") {
    const form = new FormData();
    form.set("file", payload.file);
    form.set("clientId", clientId);
    if (payload.caption) form.set("caption", payload.caption);
    if (payload.replyTo) form.set("replyTo", payload.replyTo);
    return apiFetch<SendResult>(path, { method: "POST", body: form });
  }

  const body =
    payload.kind === "text"
      ? { type: "text", text: payload.text, clientId, ...(payload.replyTo ? { replyTo: payload.replyTo } : {}) }
      : { type: "template", templateId: payload.templateId, variables: payload.variables, clientId };
  return apiFetch<SendResult>(path, { method: "POST", body: JSON.stringify(body) });
}

export function useSendMessage(conversationId: string) {
  const queryClient = useQueryClient();
  const scope = useInboxScope();

  return useMutation({
    mutationKey: INBOX_SEND_KEY,
    mutationFn: ({ clientId, ...payload }: { clientId: string } & SendPayload) =>
      sendRequest(scope, conversationId, clientId, payload),
    // A janela fechada e o número caído se corrigem relendo a conversa.
    onSettled: () => invalidateInbox(queryClient, scope.key, { conversationId }),
  });
}

export type ContinueResult = { conversationId: string; message: MessageView };

/**
 * "Continuar por outro número" (X2): acha ou cria a conversa do contato no número escolhido e envia o
 * texto por ele. `clientId` como no envio: repetir o mesmo pedido não manda duas vezes.
 */
export function useContinueOnChannel(conversationId: string) {
  const queryClient = useQueryClient();
  const scope = useInboxScope();

  return useMutation({
    mutationFn: (body: { channelId: string; text: string; clientId: string }) =>
      apiFetch<ContinueResult>(`${scope.api}/conversations/${conversationId}/transfer`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // A conversa de destino pode já estar em cache (com as mensagens de antes). Sem devolver a promessa:
    // a tela segue para a conversa sem esperar as releituras.
    onSuccess: (result) => {
      void invalidateInbox(queryClient, scope.key, { conversationId: result.conversationId });
    },
    // Recusa (número caiu, janela fechou, outro atendente assumiu): a lista de números é relida.
    onError: () => {
      void invalidateInbox(queryClient, scope.key);
    },
  });
}

/** Modelo aprovado do WABA do canal da conversa, já analisado pelo servidor (`send-template.ts`). */
export type ConversationTemplate = {
  id: string;
  name: string;
  language: string;
  category: string | null;
  /** `false`: listado, mas desabilitado (`reason` explica). */
  supported: boolean;
  reason: string | null;
  slots: { component: "header" | "body"; name: string }[];
  positional: boolean;
  header: string | null;
  body: string | null;
  footer: string | null;
};

export function useConversationTemplates(conversationId: string, enabled: boolean) {
  const scope = useInboxScope();

  return useQuery({
    queryKey: inboxKeys.templates(scope.key, conversationId),
    queryFn: () =>
      apiFetch<{ templates: ConversationTemplate[] }>(
        `${scope.api}/conversations/${conversationId}/templates`,
      ).then(({ templates }) => templates),
    enabled: enabled && scope.ready,
    staleTime: 60_000,
    retry: false,
  });
}
