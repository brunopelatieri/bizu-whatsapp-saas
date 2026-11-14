export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** Campos extras do corpo do erro (ex.: `assignedTo` em `ALREADY_ASSIGNED`). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Telas do portal que não pedem sessão: um 401 aqui não é sessão vencida. */
const PORTAL_PUBLIC_PATHS = [
  "/portal/login",
  "/portal/entrar",
  "/portal/confirmar",
  "/portal/cadastro",
  // A página trata o 401 sozinha: volta ao login levando o link (`verify-phone-page.tsx`).
  "/portal/verificar-telefone",
];

function signOutAt(path: string) {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch(() => {});
}

/**
 * Sessão recusada dentro de `/app`, `/admin` ou `/portal`: limpa os cookies antes de ir ao
 * login da área. Sem isso, o cache da sessão no cookie mandaria de volta, em ciclo.
 */
async function leaveExpiredSession() {
  if (typeof window === "undefined") return;

  const { pathname, search } = window.location;

  if (pathname === "/portal" || pathname.startsWith("/portal/")) {
    if (PORTAL_PUBLIC_PATHS.includes(pathname)) return;

    await signOutAt("/api/portal/auth/sign-out");
    window.location.assign("/portal/login");
    return;
  }

  if (!pathname.startsWith("/app") && !pathname.startsWith("/admin")) return;

  await signOutAt("/api/auth/sign-out");

  window.location.assign(
    `/login?next=${encodeURIComponent(pathname + search)}`,
  );
}

/**
 * O servidor recusou a sessão pelo telefone (403 `PHONE_UNVERIFIED`, T3): os providers relêem
 * `/api/me` (ou `/api/portal/me`) e a área autenticada passa a mostrar só "Confirme seu WhatsApp".
 * O bloqueio é do servidor; o evento só faz a tela acompanhar.
 */
export const PHONE_UNVERIFIED_EVENT = "bizu:phone-unverified";

function announcePhoneUnverified(path: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(PHONE_UNVERIFIED_EVENT, {
      detail: { area: path.startsWith("/api/portal/") ? "portal" : "team" },
    }),
  );
}

/** O corpo do erro sem `error` e `code`: o que a regra de negócio anexou. */
function extraDetails(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const { error: _error, code: _code, ...rest } = body as Record<string, unknown>;
  return rest;
}

function send(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);

  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  });
}

/** Erro da API (corpo JSON `{ error, code }`) como `ApiError`, com o tratamento de sessão e telefone. */
async function failWith(path: string, response: Response, body: unknown): Promise<never> {
  const parsed = (body && typeof body === "object" ? body : {}) as { error?: string; code?: string };

  if (response.status === 401) await leaveExpiredSession();
  if (response.status === 403 && parsed.code === "PHONE_UNVERIFIED") announcePhoneUnverified(path);

  throw new ApiError(
    parsed.error ?? "Não foi possível concluir a solicitação.",
    response.status,
    parsed.code,
    extraDetails(body),
  );
}

/** Chama a API do próprio app, com cookies, e padroniza os erros em `ApiError`. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  const body = await response.json().catch(() => null);

  if (!response.ok) return failWith(path, response, body);
  return body as T;
}

/**
 * Como `apiFetch`, para rota que responde com bytes (o CSV do Google Planilhas, I3). O erro continua
 * sendo JSON e vira `ApiError` do mesmo jeito.
 */
export async function apiFetchBytes(path: string, init?: RequestInit): Promise<Uint8Array> {
  const response = await send(path, init);

  if (!response.ok) return failWith(path, response, await response.json().catch(() => null));
  return new Uint8Array(await response.arrayBuffer());
}
