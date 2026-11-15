import { type ColumnMap, IMPORT_COLUMNS, mapColumns } from "@/lib/spreadsheet/columns";
import {
  type ColumnKey,
  MAX_CELL_CHARS,
  MAX_IMPORT_ROWS,
  type ParsedTable,
  type RawImportRow,
  SpreadsheetParseError,
} from "@/lib/spreadsheet/types";

/** Uma linha da planilha já em células de texto (o CSV e o XLSX chegam aqui do mesmo jeito). */
export type TableRecord = { cells: string[]; sourceRow: number };

/**
 * Nomes de etiqueta de uma célula, sem repetição (maiúsculas e minúsculas contam como o mesmo).
 * Separam `;` (o recomendado: funciona nos três formatos sem aspas) e `,` (que num `.csv` só chega
 * aqui se a célula estiver entre aspas, senão a vírgula já separou a coluna). `|` e `/` não separam.
 */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[;,]/)) {
    const name = part.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

const TOO_LONG = `Uma célula tem mais de ${MAX_CELL_CHARS.toLocaleString("pt-BR")} caracteres.`;

function cellOf(cells: readonly string[], index: number): string | undefined {
  if (index < 0) return undefined;
  const value = cells[index]?.trim();
  return value ? value : undefined;
}

function rowFrom(record: TableRecord, map: ColumnMap): RawImportRow {
  const { cells, sourceRow } = record;
  const text = {} as Record<ColumnKey, string | undefined>;
  let problem: string | undefined;

  for (const { key } of IMPORT_COLUMNS) {
    const value = cellOf(cells, map[key]);
    // O leitor corta a célula em `MAX_CELL_CHARS + 1`: passar de `MAX_CELL_CHARS` é a prova de excesso.
    if (value && value.length > MAX_CELL_CHARS) problem = TOO_LONG;
    text[key] = value?.slice(0, MAX_CELL_CHARS);
  }

  return {
    sourceRow,
    // O apóstrofo de quem digitou `'11987654321` para o Excel guardar como texto: no telefone (e só nele) sai.
    phone: (text.phone ?? "").replace(/^'+|'+$/g, "").trim(),
    name: text.name,
    email: text.email,
    document: text.document,
    tags: parseTagCell(text.tags),
    notes: text.notes,
    ...(problem ? { problem } : {}),
  };
}

const IGNORED_LABEL_MAX = 60;
const IGNORED_MAX = 20;

/**
 * Cabeçalho + linhas de dados em `ParsedTable`. Sem coluna de telefone, é erro do arquivo; uma linha
 * sem telefone **não** some: sai com `phone: ""` para a tela e o servidor a relatarem com o número
 * da linha.
 */
export function tableFromRecords(
  headers: readonly string[],
  records: readonly TableRecord[],
  sheetNames?: string[],
): ParsedTable {
  const map = mapColumns(headers);

  if (map.phone === -1) {
    throw new SpreadsheetParseError(
      "missing_phone_column",
      "Não achei a coluna de telefone. Coloque na primeira linha o cabeçalho phone (ou telefone, celular, whatsapp, numero).",
      sheetNames,
    );
  }

  if (records.length === 0) {
    throw new SpreadsheetParseError(
      "empty_file",
      "O arquivo só tem o cabeçalho: não há linhas de clientes.",
      sheetNames,
    );
  }

  if (records.length > MAX_IMPORT_ROWS) {
    throw new SpreadsheetParseError(
      "too_many_rows",
      `A planilha tem mais de ${MAX_IMPORT_ROWS.toLocaleString("pt-BR")} linhas. Divida o arquivo em partes menores.`,
      sheetNames,
    );
  }

  const used = new Set(Object.values(map).filter((index) => index !== -1));
  const ignoredColumns = headers
    .map((header, index) => ({ header: header.trim(), index }))
    .filter(({ header, index }) => header !== "" && !used.has(index))
    .slice(0, IGNORED_MAX)
    .map(({ header }) => header.slice(0, IGNORED_LABEL_MAX));

  return {
    rows: records.map((record) => rowFrom(record, map)),
    columns: IMPORT_COLUMNS.filter(({ key }) => map[key] !== -1).map(({ key }) => key),
    ignoredColumns,
  };
}
