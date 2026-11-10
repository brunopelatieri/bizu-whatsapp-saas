import postgres from "postgres";
import { getEnv } from "@/lib/env";
import { INBOX_CHANNEL, type InboxNotice } from "@/lib/inbox/notify";
import { getLogger } from "@/lib/logger";
import { describeError } from "@/lib/observability";

/**
 * Escuta do tempo real da caixa de entrada (SPEC, "Tempo real"; plano T11). **Uma** conexão
 * `LISTEN inbox` por processo web, aberta na primeira assinatura (o processo `--worker` nunca
 * assina, então nunca abre). Os avisos chegam de qualquer processo que grave, pelo `COMMIT`.
 *
 * - Conexão em `REALTIME_DATABASE_URL` (padrão `DATABASE_URL`): direta ou pooler em modo sessão.
 * - Caiu: avisa os assinantes (`lost`), que encerram o fluxo, e reconecta com backoff. Enquanto
 *   está fora, `realtimeAvailable()` é falso e `/api/inbox/events` responde 503 (a tela usa polling).
 * - Um `select 1` periódico acha a conexão meio aberta, que o TCP demoraria a notar.
 * - A carga é conferida aqui (`parseInboxNotice`); quem decide quem recebe é o SSE
 *   (`noticeVisibleTo`). Nada daqui vai a log além do estado da conexão.
 */

export type RealtimeState = "idle" | "connecting" | "up" | "down";

export type InboxSubscriber = {
  /** Aviso do escopo assinado; a visibilidade por pessoa é de quem assina. */
  notice(notice: InboxNotice): void;
  /** A conexão `LISTEN` caiu: avisos podem ter se perdido. */
  lost(): void;
};

/** Tempo entre conferências da conexão. */
const HEALTH_INTERVAL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_S = 10;
/** Backoff da reconexão: 1 s, 2 s, 4 s... até 30 s, com sorteio de até 20%. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set<InboxNotice["k"]>(["message", "status", "conversation"]);

const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isOwner = (value: unknown) => value === null || isId(value);

/**
 * Confere a carga recebida: só ids, só as chaves conhecidas. Qualquer outra coisa é descartada
 * (quem mais tiver acesso ao canal `inbox` não injeta texto no navegador de ninguém).
 */
export function parseInboxNotice(raw: string): InboxNotice | null {
  if (raw.length > 1024) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!["s", "c", "k", "m", "a", "p", "u"].includes(key)) return null;
  }
  if (!(data.s === null || isId(data.s))) return null;
  if (!isId(data.c)) return null;
  if (!KINDS.has(data.k as InboxNotice["k"])) return null;
  if ("m" in data && !isId(data.m)) return null;
  if ("a" in data && !isOwner(data.a)) return null;
  if ("p" in data && !isOwner(data.p)) return null;
  if ("u" in data && !isId(data.u)) return null;

  const notice: InboxNotice = { s: data.s as string | null, c: data.c, k: data.k as InboxNotice["k"] };
  if ("m" in data) notice.m = data.m as string;
  if ("a" in data) notice.a = data.a as string | null;
  if ("p" in data) notice.p = data.p as string | null;
  if ("u" in data) notice.u = data.u as string;
  return notice;
}

/** Chave do escopo nos assinantes: o tenant, ou `platform`. */
export const scopeKey = (tenantId: string | null) => tenantId ?? "platform";

type Hub = {
  state: RealtimeState;
  url: string;
  client: postgres.Sql | undefined;
  subscribers: Map<string, Set<InboxSubscriber>>;
  retries: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  healthTimer: ReturnType<typeof setInterval> | undefined;
  /** Quem espera a primeira conexão (`waitForRealtime`). */
  waiters: Set<(up: boolean) => void>;
  stopped: boolean;
};

let hub: Hub | undefined;

function dispatch(raw: string) {
  if (!hub) return;
  const notice = parseInboxNotice(raw);
  if (!notice) return;

  const subscribers = hub.subscribers.get(scopeKey(notice.s));
  if (!subscribers) return;
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.notice(notice);
    } catch {
      // Um assinante com defeito não derruba os outros.
    }
  }
}

function settleWaiters(target: Hub, up: boolean) {
  for (const resolve of target.waiters) resolve(up);
  target.waiters.clear();
}

function scheduleReconnect(target: Hub) {
  if (target.stopped || target.reconnectTimer) return;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** target.retries);
  const delay = Math.round(base * (1 + Math.random() * 0.2));
  target.retries += 1;
  target.reconnectTimer = setTimeout(() => {
    target.reconnectTimer = undefined;
    void connect(target);
  }, delay);
  target.reconnectTimer.unref?.();
}

/** A conexão caiu (ou não abriu): avisa os assinantes uma vez e agenda a próxima tentativa. */
function markLost(target: Hub, client: postgres.Sql, error?: unknown) {
  // Aviso atrasado de uma conexão que já foi trocada.
  if (target.client !== client) return;

  const wasUp = target.state === "up";
  target.client = undefined;
  target.state = "down";
  if (target.healthTimer) clearInterval(target.healthTimer);
  target.healthTimer = undefined;
  void client.end({ timeout: 0 }).catch(() => {});

  if (wasUp || target.retries === 0) {
    getLogger().warn(
      error ? { error: describeError(error) } : {},
      "Tempo real da caixa de entrada: conexão LISTEN perdida; reconectando",
    );
  }
  settleWaiters(target, false);

  for (const subscribers of target.subscribers.values()) {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.lost();
      } catch {
        // Idem.
      }
    }
  }
  scheduleReconnect(target);
}

async function connect(target: Hub) {
  if (target.stopped || target.client) return;
  target.state = "connecting";

  const client: postgres.Sql = postgres(target.url, {
    max: 1,
    // A conexão do `LISTEN` não pode expirar nem ser reciclada pelo pool.
    idle_timeout: 0,
    max_lifetime: null,
    connect_timeout: CONNECT_TIMEOUT_S,
    fetch_types: false,
    prepare: false,
    onnotice: () => {},
    onnotify: (channel, payload) => {
      if (channel === INBOX_CHANNEL && target.client === client) dispatch(payload);
    },
    onclose: () => markLost(target, client),
  });
  target.client = client;

  try {
    await client`listen ${client(INBOX_CHANNEL)}`;
  } catch (error) {
    markLost(target, client, error);
    return;
  }
  if (target.client !== client) return;

  target.state = "up";
  target.retries = 0;
  settleWaiters(target, true);
  getLogger().info("Tempo real da caixa de entrada: escutando");

  target.healthTimer = setInterval(() => void checkHealth(target, client), HEALTH_INTERVAL_MS);
  target.healthTimer.unref?.();
}

async function checkHealth(target: Hub, client: postgres.Sql) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("health check timeout")), HEALTH_TIMEOUT_MS);
  });

  try {
    await Promise.race([client`select 1`, timeout]);
  } catch (error) {
    markLost(target, client, error);
  } finally {
    clearTimeout(timer);
  }
}

/** Abre a escuta deste processo, se ainda não abriu. Idempotente. */
export function startRealtime(url?: string): void {
  if (hub && !hub.stopped) return;

  const env = getEnv();
  hub = {
    state: "idle",
    url: url ?? env.REALTIME_DATABASE_URL ?? env.DATABASE_URL,
    client: undefined,
    subscribers: new Map(),
    retries: 0,
    reconnectTimer: undefined,
    healthTimer: undefined,
    waiters: new Set(),
    stopped: false,
  };
  void connect(hub);
}

export function realtimeState(): RealtimeState {
  return hub?.state ?? "idle";
}

export const realtimeAvailable = () => hub?.state === "up";

/**
 * Espera a escuta ficar de pé, até `timeoutMs`. Serve à primeira assinatura do processo (a conexão
 * abre na hora); fora do ar, responde `false` logo na próxima tentativa que falhar.
 */
export async function waitForRealtime(timeoutMs: number): Promise<boolean> {
  startRealtime();
  const target = hub as Hub;
  if (target.state === "up") return true;
  // Já falhou e está esperando o backoff: não segura a requisição.
  if (target.state === "down") return false;

  return new Promise<boolean>((resolve) => {
    const done = (up: boolean) => {
      clearTimeout(timer);
      target.waiters.delete(done);
      resolve(up);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    target.waiters.add(done);
  });
}

/** Assina os avisos de um escopo. Devolve quem cancela. */
export function subscribeInbox(tenantId: string | null, subscriber: InboxSubscriber): () => void {
  startRealtime();
  const target = hub as Hub;
  const key = scopeKey(tenantId);
  let set = target.subscribers.get(key);
  if (!set) {
    set = new Set();
    target.subscribers.set(key, set);
  }
  set.add(subscriber);

  return () => {
    const current = target.subscribers.get(key);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) target.subscribers.delete(key);
  };
}

/** Encerra a escuta (desligamento do processo e testes). */
export async function stopRealtime(): Promise<void> {
  const target = hub;
  if (!target) return;
  hub = undefined;
  target.stopped = true;
  if (target.reconnectTimer) clearTimeout(target.reconnectTimer);
  if (target.healthTimer) clearInterval(target.healthTimer);
  settleWaiters(target, false);
  // Os fluxos abertos se encerram (e liberam a vaga) em vez de ficar esperando a vida máxima.
  for (const subscribers of target.subscribers.values()) {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber.lost();
      } catch {
        // Idem.
      }
    }
  }
  target.subscribers.clear();
  const client = target.client;
  target.client = undefined;
  target.state = "idle";
  if (client) await client.end({ timeout: 0 }).catch(() => {});
}

/**
 * Só para testes: derruba a conexão atual como se o banco a tivesse fechado, para exercitar a
 * queda e a volta.
 */
export async function dropRealtimeConnectionForTests(): Promise<void> {
  const client = hub?.client;
  if (!hub || !client) return;
  markLost(hub, client, new Error("queda simulada"));
}
