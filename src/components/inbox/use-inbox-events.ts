import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { INBOX_SEND_KEY, inboxKeys } from "@/components/inbox/inbox-api";
import { setInboxRealtimeMode } from "@/components/inbox/realtime-mode";
import { useAuth } from "@/providers/auth-provider";

/**
 * Tempo real da caixa de entrada (SPEC, "Tempo real"; plano T11). Abre o SSE de
 * `/api/inbox/events`, que só traz ids, e **invalida** as queries do TanStack por eles: nunca escreve o
 * evento no cache, porque quem decide o que a pessoa vê é a API, de novo, na releitura.
 *
 * - SSE de pé: modo `live` (sem polling na conversa; lista e contador a cada 60 s).
 * - Falhou ao abrir (503 sem `LISTEN`, 429 com abas demais, rede): modo `polling` (20 s, com o
 *   aviso na tela) e nova tentativa com espera crescente, até 60 s.
 * - Caiu depois de aberto (o servidor encerra a cada 15 min): reconecta em 1 s, sem trocar de modo.
 * - Ao reconectar e ao voltar o foco, relê a lista e o contador (eventos podem ter se perdido).
 * - Atribuição feita por outra pessoa (`a = eu`, `p ≠ eu`, `u ≠ eu`) vira toast.
 *
 * Montado uma vez no layout do `/app` (`InboxEvents`), para o ponto do menu andar em toda tela.
 */

export const INBOX_EVENTS_URL = "/api/inbox/events";
/** Reconexão depois de um fluxo que chegou a abrir. */
const RECONNECT_AFTER_OPEN_MS = 1_000;
/** Espera entre tentativas que falharam ao abrir. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
/** Junta os eventos de uma rajada numa releitura só. */
const FLUSH_DELAY_MS = 250;
/** Com envio em andamento, as mensagens esperam (a releitura duplicaria a bolha otimista). */
const SEND_WAIT_MS = 500;

export type InboxEventData = {
  c: string;
  k: "message" | "status" | "conversation";
  m?: string;
  a?: string | null;
  p?: string | null;
  u?: string;
};

const KINDS = new Set(["message", "status", "conversation"]);

/** Lê o `data` de um evento `inbox`; o que não tiver a forma esperada é ignorado. */
export function parseInboxEvent(raw: unknown): InboxEventData | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    if (typeof value.c !== "string" || !KINDS.has(value.k as string)) return null;
    return value as InboxEventData;
  } catch {
    return null;
  }
}

/** Avisa "atribuída a você" só quando outra pessoa pôs a conversa com você. */
export function assignedToMeByOther(event: InboxEventData, me: string | undefined) {
  return (
    Boolean(me) &&
    event.k === "conversation" &&
    event.a === me &&
    event.p !== undefined &&
    event.p !== me &&
    event.u !== me
  );
}

/** O mínimo de `EventSource` que o controlador usa (o teste troca por um falso). */
export type EventSourceLike = {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
};

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type InboxEventsOptions = {
  url?: string;
  onEvent: (event: InboxEventData) => void;
  onMode: (mode: "live" | "polling") => void;
  /** Reabriu depois de uma queda: eventos podem ter se perdido no meio. */
  onResync: () => void;
  createSource?: (url: string) => EventSourceLike;
  timers?: Timers;
  random?: () => number;
};

/**
 * A conexão, sem React. Cuida sozinha da reconexão (fecha o `EventSource` no erro: o navegador
 * não reconecta depois de um 503 e, depois de um fluxo encerrado, reconectaria sem aviso).
 */
export function connectInboxEvents(options: InboxEventsOptions) {
  const url = options.url ?? INBOX_EVENTS_URL;
  const createSource = options.createSource ?? ((target) => new EventSource(target));
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  };
  const random = options.random ?? Math.random;

  let source: EventSourceLike | undefined;
  let timer: unknown;
  let failures = 0;
  let everOpened = false;
  let stopped = false;

  function schedule(ms: number) {
    if (stopped) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = undefined;
      open();
    }, ms);
  }

  function open() {
    if (stopped) return;
    const current = createSource(url);
    source = current;
    let opened = false;

    current.addEventListener("open", () => {
      if (source !== current) return;
      opened = true;
      failures = 0;
      options.onMode("live");
      if (everOpened) options.onResync();
      everOpened = true;
    });

    current.addEventListener("inbox", (event) => {
      if (source !== current) return;
      const data = parseInboxEvent(event.data);
      if (data) options.onEvent(data);
    });

    current.addEventListener("error", () => {
      current.close();
      if (source !== current) return;
      source = undefined;
      if (stopped) return;

      if (opened) {
        // Fim normal (15 min) ou queda: tenta logo; se falhar, cai no polling abaixo.
        schedule(RECONNECT_AFTER_OPEN_MS);
        return;
      }
      options.onMode("polling");
      const base = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] as number;
      failures += 1;
      schedule(Math.round(base * (1 + random() * 0.2)));
    });
  }

  open();

  return {
    /** Tenta já (foco de volta), se não está conectado. */
    retryNow() {
      if (stopped || source) return;
      schedule(0);
    },
    close() {
      stopped = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      source?.close();
      source = undefined;
    },
  };
}

/** Releitura acumulada de uma rajada de eventos. */
type PendingFlush = { conversations: Map<string, boolean> };

function flushInvalidation(queryClient: QueryClient, tenantId: string, pending: PendingFlush) {
  const keys: (readonly unknown[])[] = [inboxKeys.conversations(tenantId), inboxKeys.unread(tenantId)];

  for (const [conversationId, messages] of pending.conversations) {
    keys.push(inboxKeys.conversation(tenantId, conversationId));
    if (messages) keys.push(inboxKeys.messages(tenantId, conversationId));
  }
  pending.conversations.clear();

  for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
}

/** Lista e contador: o que se relê ao reconectar e ao voltar o foco. */
function resyncLists(queryClient: QueryClient, tenantId: string) {
  void queryClient.invalidateQueries({ queryKey: inboxKeys.conversations(tenantId) });
  void queryClient.invalidateQueries({ queryKey: inboxKeys.unread(tenantId) });
  // Detalhes abertos também: a conversa pode ter mudado de dono enquanto estava fora.
  void queryClient.invalidateQueries({ queryKey: [...inboxKeys.all(tenantId), "conversation"] });
}

export function useInboxEvents(enabled: boolean) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { tenant, user } = useAuth();
  const tenantId = tenant?.id;
  const me = user?.id;
  // O toast navega; a função muda a cada render, a conexão não deve.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (!enabled || !tenantId || typeof EventSource === "undefined") {
      setInboxRealtimeMode(enabled ? "polling" : "connecting");
      return;
    }

    const pending: PendingFlush = { conversations: new Map() };
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      flushTimer = undefined;
      if (queryClient.isMutating({ mutationKey: INBOX_SEND_KEY }) > 0) {
        flushTimer = setTimeout(flush, SEND_WAIT_MS);
        return;
      }
      flushInvalidation(queryClient, tenantId, pending);
    };

    const connection = connectInboxEvents({
      onMode: setInboxRealtimeMode,
      onResync: () => resyncLists(queryClient, tenantId),
      onEvent: (event) => {
        const messages = event.k !== "conversation";
        pending.conversations.set(event.c, (pending.conversations.get(event.c) ?? false) || messages);
        flushTimer ??= setTimeout(flush, FLUSH_DELAY_MS);

        if (assignedToMeByOther(event, me)) {
          toast.info("Uma conversa foi atribuída a você.", {
            action: {
              label: "Abrir",
              onClick: () => navigateRef.current(`/app/atendimento/${event.c}`),
            },
          });
        }
      },
    });

    // `focus` e `visibilitychange` chegam juntos na troca de aba: uma releitura só.
    let lastResync = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastResync < 2_000) return;
      lastResync = Date.now();
      resyncLists(queryClient, tenantId);
      connection.retryNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      connection.close();
      if (flushTimer) clearTimeout(flushTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      setInboxRealtimeMode("connecting");
    };
  }, [enabled, tenantId, me, queryClient]);
}

/** Monta o tempo real da caixa para quem lê o atendimento. Não desenha nada. */
export function InboxEvents() {
  const { tenant, permissions } = useAuth();
  useInboxEvents(Boolean(tenant) && permissions.includes("inbox:read"));
  return null;
}
