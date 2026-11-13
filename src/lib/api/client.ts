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

/** O corpo do erro sem `error` e `code`: o que a regra de negócio anexou. */
function extraDetails(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const { error: _error, code: _code, ...rest } = body as Record<string, unknown>;
  return rest;
}

/** Chama a API do próprio app, com cookies, e padroniza os erros em `ApiError`. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401) await leaveExpiredSession();

    throw new ApiError(
      body?.error ?? "Não foi possível concluir a solicitação.",
      response.status,
      body?.code,
      extraDetails(body),
    );
  }

  return body as T;
}
