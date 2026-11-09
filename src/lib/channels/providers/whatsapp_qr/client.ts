import { ProviderError } from "@/lib/channels/errors";
import type { Env } from "@/lib/env";

/**
 * Cliente HTTP da Evolution Go. Tudo aqui segue o que foi **medido** contra um servidor real
 * na origem (`zap-crm-br-client`, SPEC 048 §1), não o que a documentação afirma:
 *
 * - Erro vem como `{"error":"not authorized"}` (texto plano em JSON) ou `text/plain` cru em
 *   404; nunca o envelope `{success, error: {code, message}}` da referência.
 * - Sucesso convive em três formatos (`{data, message}`, objeto cru, array cru): `unwrap`.
 * - O escopo da chave é **por endpoint**, não por prefixo: o mapa abaixo é explícito.
 *
 * O endereço do servidor vem só de variável de ambiente (`EVOLUTION_API_URL`): nenhum tenant
 * informa URL, então não há SSRF por aqui. A chave global só sai em `/instance/create`,
 * `/instance/delete` e `/instance/all`.
 */

export type EvolutionConfig = {
  /** Sem barra final. */
  apiUrl: string;
  globalApiKey: string;
  requestTimeoutMs: number;
  mediaTimeoutMs: number;
  /** Endereço do bizu que o servidor Evolution alcança, sem barra final. */
  webhookPublicUrl: string;
  instancePrefix: string;
  maxInstancesTotal: number;
  /** Origens aceitas para `mediaUrl`. Vazio = só base64. */
  mediaOrigins: string[];
  fetchFn?: typeof fetch;
};

/** `null` quando o módulo não está configurado. A falha é fechada: quem chama recusa. */
export function readEvolutionConfig(env: Env): EvolutionConfig | null {
  if (!env.EVOLUTION_API_URL || !env.EVOLUTION_GLOBAL_API_KEY) return null;

  return {
    apiUrl: env.EVOLUTION_API_URL.replace(/\/+$/, ""),
    globalApiKey: env.EVOLUTION_GLOBAL_API_KEY,
    requestTimeoutMs: env.EVOLUTION_REQUEST_TIMEOUT_MS,
    mediaTimeoutMs: env.EVOLUTION_MEDIA_TIMEOUT_MS,
    webhookPublicUrl: (env.EVOLUTION_WEBHOOK_PUBLIC_URL ?? env.APP_URL).replace(/\/+$/, ""),
    instancePrefix: env.EVOLUTION_INSTANCE_PREFIX,
    maxInstancesTotal: env.EVOLUTION_MAX_INSTANCES_TOTAL,
    mediaOrigins: env.EVOLUTION_MEDIA_ORIGINS,
  };
}

export type EvolutionKeyScope = "global" | "instance";

/** Escopo de chave por endpoint. Deduzir pelo prefixo dá 401 intermitente e difícil de achar. */
export const EVOLUTION_KEY_SCOPE = {
  "/instance/all": "global",
  "/instance/create": "global",
  "/instance/delete": "global",
  "/instance/connect": "instance",
  "/instance/qr": "instance",
  "/instance/pair": "instance",
  "/instance/status": "instance",
  "/instance/disconnect": "instance",
  "/instance/logout": "instance",
  "/instance/reconnect": "instance",
  "/send/text": "instance",
  "/send/media": "instance",
} as const satisfies Record<string, EvolutionKeyScope>;

/**
 * Escopo do endereço, com ou sem sufixo (`/instance/delete/<id>`). Endereço fora do mapa é
 * erro de programação: melhor falhar aqui do que mandar a chave errada ao servidor.
 */
export function keyScopeOf(path: string): EvolutionKeyScope | null {
  if (/^\/instance\/[^/]+\/advanced-settings$/.test(path)) return "instance";

  const base = Object.keys(EVOLUTION_KEY_SCOPE).find(
    (known) => path === known || path.startsWith(`${known}/`),
  ) as keyof typeof EVOLUTION_KEY_SCOPE | undefined;

  return base ? EVOLUTION_KEY_SCOPE[base] : null;
}

export type EvolutionErrorKind =
  | "channel_auth_failed"
  | "bad_request"
  | "not_found"
  | "channel_unavailable";

export class EvolutionApiError extends ProviderError {
  constructor(
    readonly kind: EvolutionErrorKind,
    status: number,
    message: string,
  ) {
    super(message, status, null);
    this.name = "EvolutionApiError";
  }
}

function kindForStatus(status: number): EvolutionErrorKind {
  if (status === 401 || status === 403) return "channel_auth_failed";
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  return "channel_unavailable";
}

/** Resposta embrulhada em `data` ou não. Array cru e primitivo viram `{}`. */
export function unwrap(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const data = record.data;

    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return record;
  }
  return {};
}

/** `GET /instance/qr` devolve 400 "session already logged in" quando já está pareada. */
export function isAlreadyLoggedInError(error: unknown) {
  return (
    error instanceof EvolutionApiError &&
    error.status === 400 &&
    /already logged in/i.test(error.message)
  );
}

export type EvolutionRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Chave a usar. No escopo `instance`, o token da instância **já decifrado**. */
  key: string;
  body?: unknown;
  timeoutMs?: number;
};

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * `path` pode ter sufixo (`/instance/delete/<id>`): só o caminho-base entra no mapa de
 * escopo, e o escopo esperado confere com a chave passada.
 */
export async function evolutionRequest(
  config: EvolutionConfig,
  path: string,
  { method = "GET", key, body, timeoutMs }: EvolutionRequestOptions,
): Promise<unknown> {
  // A chave global nunca vai a endpoint de instância (e o token da instância nunca vai a um
  // endpoint global): erro de programação, recusado antes de sair da máquina.
  const scope = keyScopeOf(path);
  if (!scope || (scope === "global") !== (key === config.globalApiKey)) {
    throw new Error(`Evolution: chave incompatível com o endereço ${path}.`);
  }

  let response: Response;

  try {
    response = await (config.fetchFn ?? fetch)(`${config.apiUrl}${path}`, {
      method,
      headers: {
        apikey: key,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs ?? config.requestTimeoutMs),
    });
  } catch {
    // Rede ou timeout. Sem a mensagem original: ela pode trazer a URL interna do servidor.
    throw new EvolutionApiError("channel_unavailable", 0, "O servidor Evolution não respondeu.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  const parsed = contentType.includes("application/json") && raw ? safeJson(raw) : null;

  if (!response.ok) {
    const record =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const nested = record?.error && typeof record.error === "object" ? record.error : null;
    const message =
      typeof record?.error === "string"
        ? record.error
        : typeof (nested as { message?: unknown } | null)?.message === "string"
          ? (nested as { message: string }).message
          : typeof record?.message === "string"
            ? record.message
            : raw.trim().slice(0, 200) || `HTTP ${response.status}`;

    throw new EvolutionApiError(kindForStatus(response.status), response.status, message);
  }

  return parsed ?? raw;
}
