/**
 * Link do Google Planilhas (bloco I, fase I3). Módulo puro: a tela usa para avisar na hora e o
 * servidor usa de novo, porque a entrada nunca é confiável.
 *
 * O link digitado **nunca é buscado**. Daqui só saem dois identificadores, conferidos por formato
 * estrito (o da planilha e o da aba); quem busca (`google-sheets-fetch.server.ts`) monta ele mesmo
 * o endereço de exportação em `https://docs.google.com`, sem host, porta, caminho, consulta nem
 * credenciais do que a pessoa colou.
 */

/** O que basta para montar o endereço de exportação. */
export type GoogleSheetRef = {
  /** Identificador da planilha: letras, dígitos, `-` e `_` (hoje o Google usa 44 caracteres). */
  spreadsheetId: string;
  /** Identificador da aba (`gid`), só dígitos. Sem ele, o Google exporta a primeira aba. */
  gid?: string;
};

export type GoogleSheetLinkErrorCode =
  | "empty"
  | "too_long"
  | "invalid_url"
  | "not_https"
  | "not_google_sheets"
  | "published_link"
  | "other_google_product"
  | "invalid_id"
  | "invalid_gid";

export class GoogleSheetLinkError extends Error {
  readonly code: GoogleSheetLinkErrorCode;

  constructor(code: GoogleSheetLinkErrorCode, message: string) {
    super(message);
    this.name = "GoogleSheetLinkError";
    this.code = code;
  }
}

/** Um link de compartilhamento real tem uns 100 caracteres; o teto só corta o absurdo. */
export const MAX_GOOGLE_SHEET_LINK_CHARS = 2_048;

/** O único host aceito no link. O `URL` já converte maiúsculas e IDN (`xn--`), então é igualdade exata. */
const SHEETS_HOST = "docs.google.com";

/** Identificador da planilha. Sem `.`, `/`, `%` nem espaço: nada que mude o caminho montado depois. */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

/** `gid` da aba: inteiro de até 10 dígitos (o Google usa inteiros de 32 bits). */
const GID = /^\d{1,10}$/;

/**
 * Caminho de uma planilha: `/spreadsheets/d/<id>/...`, também na forma com a conta escolhida
 * (`/spreadsheets/u/0/d/<id>/...`). O que vem depois do id (`edit`, `view`, `htmlview`) não importa.
 */
/** Prefixo do link antigo do Google Workspace (`/a/<domínio>/spreadsheets/...`): sai antes de conferir. */
const WORKSPACE_PREFIX = /^\/a\/[A-Za-z0-9.-]{1,253}(?=\/)/;

const SHEET_PATH = /^\/spreadsheets\/(?:u\/\d{1,2}\/)?d\/([^/]+)(?:\/.*)?$/;

/** "Publicar na Web" (`/spreadsheets/d/e/2PACX-.../pubhtml`): outro identificador, fora desta fase. */
const PUBLISHED_PATH = /^\/spreadsheets\/(?:u\/\d{1,2}\/)?d\/e\//;

/** Outros produtos do Google que também moram em `docs.google.com`. */
const OTHER_PRODUCT_PATH = /^\/(?:document|presentation|forms|drawings|file)\//;

/** Controle (inclusive o nulo), espaço e os separadores invisíveis que fazem um link parecer outro. */
function hasUnsafeChar(text: string) {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code <= 0x20 ||
      (code >= 0x7f && code <= 0xa0) ||
      code === 0xad ||
      (code >= 0x2000 && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202f) ||
      (code >= 0x205f && code <= 0x206f) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

const MESSAGES = {
  empty: "Cole o link da planilha.",
  too_long: "Este link é longo demais para ser de uma planilha do Google.",
  invalid_url:
    "Isto não parece um link. Abra a planilha no Google Planilhas e copie o endereço (ou use Compartilhar > Copiar link).",
  not_https: "O link precisa começar com https://docs.google.com/spreadsheets/.",
  not_google_sheets:
    "Só links do Google Planilhas (https://docs.google.com/spreadsheets/...) são aceitos.",
  published_link:
    "Este é um link de \"Publicar na Web\". Use o link de compartilhamento: Compartilhar > Copiar link.",
  other_google_product:
    "Este link não é de uma planilha do Google Planilhas. Abra a planilha e copie o link dela.",
  invalid_id: "O identificador da planilha neste link não é válido. Copie o link de novo.",
  invalid_gid: "O identificador da aba neste link não é válido. Copie o link de novo com a aba aberta.",
} satisfies Record<GoogleSheetLinkErrorCode, string>;

const fail = (code: GoogleSheetLinkErrorCode): never => {
  throw new GoogleSheetLinkError(code, MESSAGES[code]);
};

/** A aba vem no fragmento (`#gid=123`, como o navegador mostra) ou na consulta (`?gid=123`). */
function gidOf(url: URL): string | undefined {
  const fromHash = url.hash ? new URLSearchParams(url.hash.slice(1)).getAll("gid") : [];
  const values = [...url.searchParams.getAll("gid"), ...fromHash];
  if (values.length === 0) return undefined;

  // Duas abas diferentes no mesmo link: ambíguo. Repetida igual, tudo bem.
  const unique = new Set(values);
  if (unique.size > 1) fail("invalid_gid");

  const [gid] = unique;
  if (!gid || !GID.test(gid)) fail("invalid_gid");
  return gid;
}

/**
 * Extrai e confere os identificadores de um link do Google Planilhas. Lança `GoogleSheetLinkError`
 * (com mensagem legível em português, sem eco do que foi colado) em qualquer outra coisa.
 */
export function parseGoogleSheetLink(input: string): GoogleSheetRef {
  const raw = input.trim();

  if (raw.length === 0) fail("empty");
  if (raw.length > MAX_GOOGLE_SHEET_LINK_CHARS) fail("too_long");
  if (hasUnsafeChar(raw)) fail("invalid_url");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Sem o esquema (`docs.google.com/spreadsheets/...`): diz o que falta em vez de "não é link".
    return fail(raw.toLowerCase().startsWith(`${SHEETS_HOST}/`) ? "not_https" : "invalid_url");
  }

  if (url.protocol !== "https:") fail(url.protocol === "http:" ? "not_https" : "invalid_url");
  // Credenciais e porta nunca fazem parte de um link de compartilhamento.
  if (url.username !== "" || url.password !== "" || url.port !== "") fail("not_google_sheets");
  if (url.hostname !== SHEETS_HOST) fail("not_google_sheets");

  // Só o identificador sai do caminho: o prefixo do Workspace (domínio) nunca é usado depois.
  const path = url.pathname.replace(WORKSPACE_PREFIX, "");
  if (PUBLISHED_PATH.test(path)) fail("published_link");
  if (OTHER_PRODUCT_PATH.test(path)) fail("other_google_product");

  const match = SHEET_PATH.exec(path);
  if (!match) fail("other_google_product");

  // O `URL` mantém o `%2f` codificado no caminho: o formato estrito recusa `%`, `.` e `/`.
  const spreadsheetId = match?.[1] ?? "";
  if (!SPREADSHEET_ID.test(spreadsheetId)) fail("invalid_id");

  const gid = gidOf(url);
  return gid === undefined ? { spreadsheetId } : { spreadsheetId, gid };
}

/**
 * O endereço de exportação em CSV, **montado só com os identificadores já conferidos**. É o único
 * endereço que o servidor busca primeiro; os saltos seguintes passam pela lista fechada de hosts.
 */
export function googleSheetExportUrl(ref: GoogleSheetRef): URL {
  // Confere de novo: quem chama pode ter montado a referência à mão.
  if (!SPREADSHEET_ID.test(ref.spreadsheetId)) fail("invalid_id");
  if (ref.gid !== undefined && !GID.test(ref.gid)) fail("invalid_gid");

  const url = new URL(`https://${SHEETS_HOST}/`);
  url.pathname = `/spreadsheets/d/${ref.spreadsheetId}/export`;
  url.searchParams.set("format", "csv");
  if (ref.gid !== undefined) url.searchParams.set("gid", ref.gid);
  return url;
}
