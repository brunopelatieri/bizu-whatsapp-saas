import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { getLogger } from "@/lib/logger";
import { isPublicIp } from "@/lib/net/public-ip";
import { type GoogleSheetRef, googleSheetExportUrl } from "@/lib/spreadsheet/google-sheets-link";
import { MAX_SPREADSHEET_BYTES } from "@/lib/spreadsheet/types";

/**
 * Baixa o CSV de uma planilha pública do Google Planilhas (bloco I, I3). É a única busca de saída do
 * projeto que nasce de algo que o usuário digitou, então é uma guarda de SSRF, em camadas:
 *
 * 1. O endereço inicial é **montado aqui** só com os identificadores conferidos
 *    (`googleSheetExportUrl`): nada do link colado entra na requisição.
 * 2. Redirecionamento é seguido **à mão**, um por vez, até `MAX_REDIRECTS`: cada salto precisa ser
 *    `https`, sem porta nem credenciais, com o host numa lista fechada e exata e o caminho esperado.
 *    O de login do Google (planilha privada) e qualquer outro encerram.
 * 3. O host é resolvido aqui, **todos** os IPs precisam ser públicos (`isPublicIp`), e a conexão usa
 *    só esses IPs (sem segunda resolução: o DNS não troca o destino entre a conferência e a conexão).
 * 4. Sem cookies, sem cabeçalho do usuário, sem credenciais; sem compressão; tempo limite para
 *    conectar e para o total; teto de tamanho aplicado **enquanto lê**, sem confiar no
 *    `Content-Length`; só resposta de CSV ou texto, e nunca binário.
 *
 * Nenhuma mensagem, log ou erro daqui carrega o identificador da planilha, o endereço nem conteúdo.
 */

/** Saltos de redirecionamento aceitos. Hoje a exportação faz um (`docs` → `googleusercontent`). */
export const MAX_REDIRECTS = 3;

/** Tempo para abrir a conexão (TCP e TLS) de cada salto. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** Tempo total, de resolver o primeiro host ao último byte. */
export const TOTAL_TIMEOUT_MS = 20_000;

/** Os únicos cabeçalhos enviados: agente genérico, sem nada do usuário, sem compressão. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": "Mozilla/5.0 (compatible; spreadsheet-import/1.0)",
  Accept: "text/csv, text/plain;q=0.9",
  "Accept-Encoding": "identity",
};

/** O host do endereço que este módulo monta. */
const EXPORT_HOST = "docs.google.com";

/**
 * O host para onde a exportação redireciona (observado em 2026-11-14: `doc-08-4o-sheets...`). Dois
 * grupos de dois caracteres, nada mais: o `googleusercontent.com` inteiro serve conteúdo de qualquer
 * usuário e **não** entra.
 */
const EXPORT_CONTENT_HOST = /^doc-[0-9a-z]{2}-[0-9a-z]{2}-sheets\.googleusercontent\.com$/;

/** Hosts e caminhos aceitos num salto de redirecionamento. */
function isAllowedHop(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.hostname === EXPORT_HOST) return url.pathname.startsWith("/spreadsheets/");
  if (EXPORT_CONTENT_HOST.test(url.hostname)) return url.pathname.startsWith("/export/");
  return false;
}

/** Redirecionamento para o login: a planilha não está compartilhada com "qualquer pessoa com o link". */
function isGoogleLogin(url: URL): boolean {
  return (
    url.hostname === "accounts.google.com" ||
    (url.hostname === EXPORT_HOST && /^\/(?:accounts|ServiceLogin)/i.test(url.pathname))
  );
}

export type SheetFetchErrorCode =
  | "not_shared"
  | "not_found"
  | "tab_not_found"
  | "too_large"
  | "not_csv"
  | "empty"
  | "timeout"
  | "google_rate_limited"
  | "unexpected_redirect"
  | "blocked_address"
  | "upstream";

const MESSAGES = {
  not_shared:
    "A planilha é privada. No Google Planilhas, clique em Compartilhar, mude o acesso geral para \"Qualquer pessoa com o link\" (Leitor) e cole o link de novo.",
  not_found:
    "Não encontrei a planilha. Confira o link e se ela está compartilhada como \"Qualquer pessoa com o link\".",
  tab_not_found:
    "O Google não encontrou esta aba. Abra a aba certa na planilha e copie o link de novo.",
  too_large: `A planilha passa de ${MAX_SPREADSHEET_BYTES / (1024 * 1024)} MB. Divida em partes menores ou baixe em .csv e envie o arquivo.`,
  not_csv:
    "O Google não devolveu esta planilha como texto. Confira se o link é de uma planilha do Google Planilhas, ou baixe em .csv e envie o arquivo.",
  empty: "A planilha está vazia.",
  timeout:
    "O Google demorou demais para responder. Tente de novo em instantes ou baixe a planilha em .csv e envie o arquivo.",
  google_rate_limited:
    "O Google limitou os downloads desta planilha agora. Tente de novo em alguns minutos.",
  unexpected_redirect:
    "O Google respondeu de um jeito inesperado. Baixe a planilha em .csv e envie o arquivo.",
  blocked_address:
    "Não foi possível baixar a planilha do Google. Baixe em .csv e envie o arquivo.",
  upstream:
    "Não consegui baixar a planilha do Google. Tente de novo em instantes ou baixe em .csv e envie o arquivo.",
} satisfies Record<SheetFetchErrorCode, string>;

/** Falha com código estável e mensagem **já legível**; nunca carrega o corpo da resposta do Google. */
export class SheetFetchError extends Error {
  readonly code: SheetFetchErrorCode;

  constructor(code: SheetFetchErrorCode) {
    super(MESSAGES[code]);
    this.name = "SheetFetchError";
    this.code = code;
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Resolve um host em todos os seus IPs. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** O pouco que este módulo lê de uma resposta. */
export type UpstreamResponse = {
  status: number;
  header(name: string): string | undefined;
  body: AsyncIterable<Uint8Array>;
  /** Fecha a conexão sem ler o resto. */
  close(): void;
};

export type TransportRequest = {
  url: URL;
  /** Os IPs já conferidos: a conexão usa só estes, sem resolver o nome de novo. */
  addresses: ResolvedAddress[];
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  connectTimeoutMs: number;
};

/** Faz um `GET` sem seguir redirecionamento. Injetável: os testes não dependem de rede. */
export type Transport = (request: TransportRequest) => Promise<UpstreamResponse>;

export type SheetFetchDeps = {
  resolve: Resolver;
  transport: Transport;
  totalTimeoutMs: number;
  connectTimeoutMs: number;
  maxBytes: number;
};

export const resolveWithDns: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));

/** `lookup` que entrega à conexão só os IPs já conferidos (e só para o host esperado). */
function pinnedLookup(hostname: string, addresses: ResolvedAddress[]): LookupFunction {
  return (requested, options, callback) => {
    const first = addresses[0];
    if (requested !== hostname || !first) {
      callback(new Error("Host inesperado na conexão."), "", 4);
      return;
    }
    if (options.all) {
      // biome-ignore lint/suspicious/noExplicitAny: a sobrecarga com `all` do Node pede a lista aqui.
      (callback as any)(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }
    callback(null, first.address, first.family);
  };
}

/** O `GET` real, com `node:https`: sem agente compartilhado (nem conexão reaproveitada), sem cookies. */
export const httpsTransport: Transport = ({ url, addresses, headers, signal, connectTimeoutMs }) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { ...headers },
      agent: false,
      servername: url.hostname,
      lookup: pinnedLookup(url.hostname, addresses),
      signal,
    });

    request.once("socket", (socket) => {
      const timer = setTimeout(
        () => request.destroy(new Error("Tempo para conectar esgotado.")),
        connectTimeoutMs,
      );
      socket.once("secureConnect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
    });
    // `on`, não `once`: um segundo erro (o sinal abortando depois de uma falha) sem ouvinte derrubaria o processo.
    request.on("error", reject);
    request.once("response", (response) => {
      resolve({
        status: response.statusCode ?? 0,
        header: (name) => {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value[0] : value;
        },
        body: response,
        close: () => {
          response.destroy();
          request.destroy();
        },
      });
    });
    request.end();
  });

export const defaultSheetFetchDeps: SheetFetchDeps = {
  resolve: resolveWithDns,
  transport: httpsTransport,
  totalTimeoutMs: TOTAL_TIMEOUT_MS,
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
  maxBytes: MAX_SPREADSHEET_BYTES,
};

let depsForTests: SheetFetchDeps | undefined;

/** Só para os testes da rota: troca a rede por um transporte falso (`undefined` volta ao real). */
export function setSheetFetchDepsForTests(next: SheetFetchDeps | undefined) {
  depsForTests = next;
}

/** Espera `promise`, mas desiste quando o sinal dispara (mesmo que quem a cumpre não o respeite). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SheetFetchError("timeout"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SheetFetchError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Sinal de ataque ou de mudança no Google: vai ao log, só com o código e o salto (sem endereço). */
function warn(code: SheetFetchErrorCode, hop: number, detail: Record<string, unknown> = {}) {
  getLogger().warn({ code, hop, ...detail }, "Importação do Google Planilhas: busca recusada pela guarda");
}

async function resolvePublic(hostname: string, deps: SheetFetchDeps, signal: AbortSignal, hop: number) {
  let addresses: ResolvedAddress[];
  try {
    addresses = await untilAborted(deps.resolve(hostname), signal);
  } catch (error) {
    if (error instanceof SheetFetchError) throw error;
    throw new SheetFetchError("upstream");
  }

  // Todos, não só o primeiro: com um IP interno na lista, a conexão poderia escolhê-lo.
  if (addresses.length === 0 || !addresses.every(({ address }) => isPublicIp(address))) {
    warn("blocked_address", hop);
    throw new SheetFetchError("blocked_address");
  }
  return addresses;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `text/csv` ou `text/plain`, com ou sem parâmetros. O Google manda `text/csv; charset=utf-8`. */
function isTextType(value: string | undefined) {
  const type = value?.split(";")[0]?.trim().toLowerCase();
  return type === "text/csv" || type === "text/plain";
}

function errorForStatus(status: number, url: URL): SheetFetchError {
  if (status === 401 || status === 403) return new SheetFetchError("not_shared");
  if (status === 404 || status === 410) return new SheetFetchError("not_found");
  // Observado: `gid` que não existe dá 400 no host do conteúdo. Um 400 em outro salto é outra coisa.
  if (status === 400 && EXPORT_CONTENT_HOST.test(url.hostname)) {
    return new SheetFetchError("tab_not_found");
  }
  if (status === 413) return new SheetFetchError("too_large");
  if (status === 429) return new SheetFetchError("google_rate_limited");
  return new SheetFetchError("upstream");
}

/** Lê o corpo até o fim, parando assim que passar do teto (sem esperar o resto chegar). */
async function readCapped(response: UpstreamResponse, deps: SheetFetchDeps, signal: AbortSignal) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = response.body[Symbol.asyncIterator]();

  for (;;) {
    let step: IteratorResult<Uint8Array>;
    try {
      step = await untilAborted(iterator.next(), signal);
    } catch (error) {
      response.close();
      if (error instanceof SheetFetchError) throw error;
      throw new SheetFetchError("upstream");
    }
    if (step.done) break;

    total += step.value.byteLength;
    if (total > deps.maxBytes) {
      response.close();
      throw new SheetFetchError("too_large");
    }
    chunks.push(step.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** `PK\x03\x04` (zip, `.xlsx`) ou byte nulo: não é a planilha em texto que foi pedida. */
function looksBinary(bytes: Uint8Array) {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  return zip || bytes.includes(0);
}

/**
 * Baixa o CSV da planilha. Devolve os bytes como vieram (UTF-8, do Google): quem decodifica e lê é
 * o navegador, pelo mesmo leitor do arquivo enviado. Lança `SheetFetchError` em qualquer falha.
 */
export async function fetchGoogleSheetCsv(
  ref: GoogleSheetRef,
  given?: SheetFetchDeps,
): Promise<Uint8Array> {
  const deps = given ?? depsForTests ?? defaultSheetFetchDeps;
  const signal = AbortSignal.timeout(deps.totalTimeoutMs);
  let url = googleSheetExportUrl(ref);

  for (let hop = 0; ; hop++) {
    // O primeiro endereço é o montado; os seguintes passaram por `isAllowedHop`. Confere de novo.
    if (!isAllowedHop(url)) {
      warn("unexpected_redirect", hop);
      throw new SheetFetchError("unexpected_redirect");
    }

    const addresses = await resolvePublic(url.hostname, deps, signal, hop);

    let response: UpstreamResponse;
    try {
      const pending = deps.transport({
        url,
        addresses,
        headers: REQUEST_HEADERS,
        signal,
        connectTimeoutMs: deps.connectTimeoutMs,
      });
      // Resposta que chega depois do tempo limite (transporte que não respeita o sinal) é fechada.
      pending.then(
        (late) => {
          if (signal.aborted) late.close();
        },
        () => undefined,
      );
      response = await untilAborted(pending, signal);
    } catch (error) {
      if (error instanceof SheetFetchError) throw error;
      // Sem a mensagem original: ela traz o endereço, que tem o identificador da planilha.
      throw new SheetFetchError(signal.aborted ? "timeout" : "upstream");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.header("location");
      response.close();

      if (hop >= MAX_REDIRECTS) {
        warn("unexpected_redirect", hop, { reason: "too_many" });
        throw new SheetFetchError("unexpected_redirect");
      }

      if (!location) throw new SheetFetchError("unexpected_redirect");
      let next: URL;
      try {
        // Relativo resolve contra o salto atual; o resultado passa pela mesma lista.
        next = new URL(location, url);
      } catch {
        throw new SheetFetchError("unexpected_redirect");
      }
      if (isGoogleLogin(next)) throw new SheetFetchError("not_shared");
      if (!isAllowedHop(next)) {
        warn("unexpected_redirect", hop, { reason: "host" });
        throw new SheetFetchError("unexpected_redirect");
      }

      url = next;
      continue;
    }

    if (response.status !== 200) {
      response.close();
      throw errorForStatus(response.status, url);
    }

    // A página de login às vezes vem com 200 em HTML: o tipo já a recusa.
    if (!isTextType(response.header("content-type"))) {
      response.close();
      throw new SheetFetchError("not_csv");
    }
    const encoding = response.header("content-encoding")?.trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      response.close();
      throw new SheetFetchError("upstream");
    }

    // Só para desistir cedo: o teto de verdade é o da leitura, que não confia neste número.
    const declared = Number(response.header("content-length"));
    if (Number.isFinite(declared) && declared > deps.maxBytes) {
      response.close();
      throw new SheetFetchError("too_large");
    }

    const bytes = await readCapped(response, deps, signal);
    if (bytes.byteLength === 0) throw new SheetFetchError("empty");
    if (looksBinary(bytes)) throw new SheetFetchError("not_csv");
    return bytes;
  }
}
