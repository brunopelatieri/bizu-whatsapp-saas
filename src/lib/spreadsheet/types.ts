/**
 * Tipos e tetos da leitura de planilha (bloco I, fase I1). Módulo puro: roda no navegador (a leitura
 * do arquivo acontece lá) e no servidor (o teste e, na I2, o schema da rota). Nada aqui conhece
 * banco, sessão nem organização.
 */

/** Tamanho máximo do arquivo, conferido **antes** de ler o conteúdo. */
export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;

/** Linhas de dados por importação (o cabeçalho e as linhas em branco não contam). */
export const MAX_IMPORT_ROWS = 10_000;

/** Caracteres de uma célula lida: o que passa disso vira motivo de recusa da linha. */
export const MAX_CELL_CHARS = 2_000;

/** Colunas lidas por linha. Planilha com mais colunas perde as últimas, que nada aqui usa. */
export const MAX_COLUMNS = 100;

/**
 * Soma dos tamanhos descompactados que o `.xlsx` declara. Um `.xlsx` de 10 MB com 10.000 linhas
 * passa de 10 MB descompactado por pouco; este teto só pega a "bomba de zip" (poucos KB que
 * viram gigabytes), antes de qualquer descompressão.
 */
export const MAX_XLSX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Entradas do `.xlsx` (um arquivo comum tem algumas dezenas). */
export const MAX_XLSX_ENTRIES = 2_000;

export type ParseErrorCode =
  | "file_too_large"
  | "too_many_rows"
  | "missing_phone_column"
  | "empty_file"
  | "unreadable"
  | "unsupported_format"
  | "unclosed_quote";

/**
 * Erro de leitura com código estável e mensagem **já legível em português**: a tela a mostra como
 * está. A mensagem nunca traz conteúdo do arquivo (nem nome de aba nem célula).
 */
export class SpreadsheetParseError extends Error {
  readonly code: ParseErrorCode;
  /** Abas já conhecidas quando o erro ocorreu (só `.xlsx`): a tela ainda deixa trocar de aba. */
  readonly sheetNames?: string[];

  constructor(code: ParseErrorCode, message: string, sheetNames?: string[]) {
    super(message);
    this.name = "SpreadsheetParseError";
    this.code = code;
    this.sheetNames = sheetNames;
  }
}

/** Uma linha de dados como veio da planilha, antes de qualquer validação de cadastro. */
export type RawImportRow = {
  /** Número da linha na planilha, contando o cabeçalho (a linha 2 é a primeira de dados). */
  sourceRow: number;
  /** Vazio quando a célula faltou: a linha é relatada como inválida, nunca descartada em silêncio. */
  phone: string;
  name?: string;
  email?: string;
  document?: string;
  /** Nomes de etiqueta, sem repetição (sem diferenciar maiúsculas). */
  tags: string[];
  notes?: string;
  /** A linha já nasce recusada: o texto é o motivo (célula grande demais). */
  problem?: string;
};

export type ColumnKey = "phone" | "name" | "email" | "document" | "tags" | "notes";

/** A planilha lida: as linhas e o que a leitura achou no cabeçalho. */
export type ParsedTable = {
  rows: RawImportRow[];
  /** As colunas reconhecidas, na ordem canônica. */
  columns: ColumnKey[];
  /** Cabeçalhos que o sistema não conhece (ignorados), cortados a 60 caracteres. */
  ignoredColumns: string[];
};

export type SpreadsheetReadResult = ParsedTable & {
  format: "csv" | "xlsx";
  /** Só `.xlsx`: a aba lida e todas as abas, para o seletor da tela. */
  sheetName?: string;
  sheetNames?: string[];
};
