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
import type { ConversationTab } from "@/lib/schemas/inbox";
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
  | {
      kind: "none";
      candidates: {
        customers: { id: string; name: string; phone: string | null }[];
        users: { id: string; name: string }[];
      };
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
  createdAt: string;
};

type Page<T> = { items: T[]; nextCursor: string | null };

export type ConversationFilters = {
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
  messages: (tenantId: TenantId, id: string) => [INBOX_KEY, tenantId, "messages", id] as const,
  unread: (tenantId: TenantId) => [INBOX_KEY, tenantId, "unread"] as const,
  assignees: (tenantId: TenantId) => [INBOX_KEY, tenantId, "assignees"] as const,
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

function conversationsPath(filters: ConversationFilters, cursor: string | undefined) {
  const search = new URLSearchParams({ tab: filters.tab, limit: String(PAGE_SIZE) });

  if (filters.status) search.set("status", filters.status);
  if (filters.unread) search.set("unread", "true");
  if (filters.channelId) search.set("channelId", filters.channelId);
  if (filters.tagIds && filters.tagIds.length > 0) search.set("tagIds", filters.tagIds.join(","));
  if (filters.assignedTo) search.set("assignedTo", filters.assignedTo);
  if (filters.q) search.set("q", filters.q);
  if (cursor) search.set("cursor", cursor);

  return `/api/inbox/conversations?${search}`;
}

/** Lista por cursor; cada página é lida de novo no polling, na ordem. */
export function useConversations(filters: ConversationFilters) {
  const { tenant } = useAuth();
  const interval = useInboxRefetchInterval();

  return useInfiniteQuery({
    queryKey: inboxKeys.conversations(tenant?.id, filters),
    queryFn: ({ pageParam }) =>
      apiFetch<Page<ConversationItem>>(conversationsPath(filters, pageParam)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(tenant),
    refetchInterval: interval,
    retry: false,
  });
}

export function useConversation(id: string | undefined) {
  const { tenant } = useAuth();
  // A janela de 24 h expira sem evento: o detalhe segue o ciclo da lista (60 s ao vivo).
  const interval = useInboxRefetchInterval("list");

  return useQuery({
    queryKey: inboxKeys.conversation(tenant?.id, id ?? ""),
    queryFn: () => apiFetch<ConversationResponse>(`/api/inbox/conversations/${id}`),
    enabled: Boolean(tenant && id),
    refetchInterval: interval,
    retry: false,
  });
}

/** Da mais nova para a mais antiga, por página; a tela inverte para ler de cima para baixo. */
export function useMessages(conversationId: string | undefined) {
  const { tenant } = useAuth();
  const interval = useInboxRefetchInterval("detail");

  return useInfiniteQuery({
    queryKey: inboxKeys.messages(tenant?.id, conversationId ?? ""),
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: "50" });
      if (pageParam) search.set("before", pageParam);
      return apiFetch<Page<MessageView>>(
        `/api/inbox/conversations/${conversationId}/messages?${search}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(tenant && conversationId),
    refetchInterval: interval,
    retry: false,
  });
}

/** Conversas com não lidas na fila e nas minhas (o ponto do menu); os eventos o invalidam. */
export function useInboxUnread(enabled = true) {
  const { tenant, permissions } = useAuth();
  const mode = useInboxRealtimeMode();

  return useQuery({
    queryKey: inboxKeys.unread(tenant?.id),
    queryFn: () => apiFetch<{ queue: number; mine: number }>("/api/inbox/unread"),
    enabled: enabled && Boolean(tenant) && permissions.includes("inbox:read"),
    refetchInterval: refetchIntervalFor(mode, "list"),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Membros que podem receber uma conversa (`inbox:assign`). */
export function useAssignees(enabled: boolean) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: inboxKeys.assignees(tenant?.id),
    queryFn: () =>
      apiFetch<{ users: { id: string; name: string }[] }>("/api/inbox/assignees").then(
        ({ users }) => users,
      ),
    enabled: enabled && Boolean(tenant),
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
  method: "POST" | "PATCH";
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
  const { tenant } = useAuth();

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
      invalidateInbox(queryClient, tenant?.id, {
        conversationId: options.conversationId,
        messages: options.messages,
      }),
  });
}

/** Mensagem que a tela mostra enquanto o envio não voltou (não existe na API). */
export type SendingMessage = { clientId: string; text: string; createdAt: string };

/** `crypto.randomUUID` sem hífens cabe no `clientIdSchema` (8 a 64, `[A-Za-z0-9_-]`). */
export function newClientId() {
  return globalThis.crypto.randomUUID();
}

export type SendResult = { message: MessageView };

export function useSendText(conversationId: string) {
  const queryClient = useQueryClient();
  const { tenant } = useAuth();

  return useMutation({
    mutationKey: INBOX_SEND_KEY,
    mutationFn: ({ text, clientId }: { text: string; clientId: string }) =>
      apiFetch<SendResult>(`/api/inbox/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ type: "text", text, clientId }),
      }),
    // A janela fechada e o número caído se corrigem relendo a conversa.
    onSettled: () => invalidateInbox(queryClient, tenant?.id, { conversationId }),
  });
}
