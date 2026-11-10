import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  type ConversationChange,
  INBOX_SEND_KEY,
  inboxKeys,
  invalidateInboxChanges,
} from "@/components/inbox/inbox-api";
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
 *   Tentativa sem resposta em 10 s conta como falha.
 * - A cada abertura e ao voltar o foco, relê tudo da caixa (eventos podem ter se perdido no meio).
 * - Atribuição feita por outra pessoa (`a = eu`, `p ≠ eu`, `u ≠ eu`) vira toast.
 *
 * Montado uma vez no layout do `/app` (`InboxEvents`), para o ponto do menu andar em toda tela.
 */

export const INBOX_EVENTS_URL = "/api/inbox/events";
/** Reconexão depois de um fluxo que chegou a abrir. */
const RECONNECT_AFTER_OPEN_MS = 1_000;
/** Tentativa sem resposta: passado isto, conta como falha (o servidor espera até 3 s pela escuta). */
const OPEN_TIMEOUT_MS = 10_000;
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
  let openTimer: unknown;
  let failures = 0;
  let stopped = false;

  function schedule(ms: number) {
    if (stopped) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = undefined;
      open();
    }, ms);
  }

  function clearOpenTimer() {
    if (openTimer !== undefined) timers.clearTimeout(openTimer);
    openTimer = undefined;
  }

  function open() {
    if (stopped) return;
    const current = createSource(url);
    source = current;
    let opened = false;

    const fail = () => {
      clearOpenTimer();
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
    };

    // Tentativa que não abre nem falha (rede parada) conta como falha: sem isso o modo ficaria
    // `live` sem polling e a tela congelaria sem aviso.
    openTimer = timers.setTimeout(fail, OPEN_TIMEOUT_MS);

    current.addEventListener("open", () => {
      if (source !== current) return;
      clearOpenTimer();
      opened = true;
      failures = 0;
      options.onMode("live");
      // A cada abertura, inclusive a primeira: o que mudou entre a última leitura (carga da tela,
      // polling ou o fluxo anterior) e esta assinatura não vem em evento.
      options.onResync();
    });

    current.addEventListener("inbox", (event) => {
      if (source !== current) return;
      const data = parseInboxEvent(event.data);
      if (data) options.onEvent(data);
    });

    current.addEventListener("error", fail);
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
      clearOpenTimer();
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      source?.close();
      source = undefined;
    },
  };
}

/** Releitura acumulada de uma rajada de eventos. */
type PendingFlush = { lists: boolean; conversations: Map<string, ConversationChange> };

/**
 * O que cada tipo de aviso muda. `message`: lista (prévia, não lidas), detalhe e mensagens;
 * `conversation` (dono, situação, lida, contato): lista e detalhe; `status` de entrega e mídia: só as
 * mensagens.
 */
export function changeOf(kind: InboxEventData["k"]): { lists: boolean } & ConversationChange {
  if (kind === "status") return { lists: false, detail: false, messages: true };
  if (kind === "conversation") return { lists: true, detail: true, messages: false };
  return { lists: true, detail: true, messages: true };
}

/** Tudo da caixa do tenant (lista, contador, detalhes e mensagens): ao reconectar e ao voltar o foco. */
function resyncAll(queryClient: QueryClient, tenantId: string) {
  void queryClient.invalidateQueries({ queryKey: inboxKeys.all(tenantId) });
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

    const pending: PendingFlush = { lists: false, conversations: new Map() };
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      flushTimer = undefined;
      if (queryClient.isMutating({ mutationKey: INBOX_SEND_KEY }) > 0) {
        flushTimer = setTimeout(flush, SEND_WAIT_MS);
        return;
      }
      const changes = { lists: pending.lists, conversations: [...pending.conversations] };
      pending.lists = false;
      pending.conversations.clear();
      void invalidateInboxChanges(queryClient, tenantId, changes);
    };

    const connection = connectInboxEvents({
      onMode: setInboxRealtimeMode,
      onResync: () => resyncAll(queryClient, tenantId),
      onEvent: (event) => {
        const change = changeOf(event.k);
        const previous = pending.conversations.get(event.c);
        pending.lists ||= change.lists;
        pending.conversations.set(event.c, {
          detail: change.detail || Boolean(previous?.detail),
          messages: change.messages || Boolean(previous?.messages),
        });
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
      resyncAll(queryClient, tenantId);
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
