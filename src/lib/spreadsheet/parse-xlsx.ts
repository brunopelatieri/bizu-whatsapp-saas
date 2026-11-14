import { hasPhoneColumn } from "@/lib/spreadsheet/columns";
import { tableFromRecords, type TableRecord } from "@/lib/spreadsheet/rows";
import {
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_IMPORT_ROWS,
  type ParsedTable,
  SpreadsheetParseError,
} from "@/lib/spreadsheet/types";
import { assertXlsxIsNotABomb } from "@/lib/spreadsheet/zip-guard";

/** Uma célula como `read-excel-file` a entrega (com `parseNumber` devolvendo o texto do número). */
export type XlsxCell = string | number | boolean | Date | null | undefined;

export type XlsxSheet = { sheet: string; data: XlsxCell[][] };

/**
 * O telefone de uma planilha costuma ser **número**, e o Excel guarda número grande como `5.5E+12`.
 * Um número inteiro sai com todos os dígitos; o que não é número (ou tem expoente absurdo) sai vazio.
 * O zero à esquerda que o Excel já engoliu não volta (o normalizador de telefone trata o caso com e
 * sem o zero de tronco).
 */
function numberToText(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (!Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 1e21) return String(value);
  try {
    return BigInt(value).toString();
  } catch {
    return "";
  }
}

/** Texto cru de um número da planilha, que pode vir em notação científica (`5.511988887777E12`). */
function numberTextToString(raw: string): string {
  // Só texto que é inteiramente um número em notação científica; "phone" e "e-mail" ficam como estão.
  if (!/^\s*[+-]?\d+(?:\.\d+)?e[+-]?\d+\s*$/i.test(raw)) return raw.trim();
  return numberToText(Number(raw));
}

/** Qualquer célula no texto que o leitor de CSV também produziria. Fórmula chega como o valor calculado. */
export function cellToString(cell: XlsxCell): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return numberToText(cell);
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? "" : cell.toISOString().slice(0, 10);
  }
  return numberTextToString(String(cell)).slice(0, MAX_CELL_CHARS + 1);
}

function rowToCells(row: XlsxCell[] | undefined): string[] {
  return (row ?? []).slice(0, MAX_COLUMNS).map(cellToString);
}

const isBlank = (cells: readonly string[]) => cells.every((cell) => cell.trim() === "");

/**
 * Escolhe a aba: a pedida, se existir; senão a primeira que tem coluna de telefone no cabeçalho (uma
 * pasta de trabalho costuma abrir numa capa ou numa aba de instruções); senão a primeira.
 */
export function pickSheet(sheets: readonly XlsxSheet[], wanted?: string): XlsxSheet | null {
  if (sheets.length === 0) return null;

  const requested = wanted ? sheets.find(({ sheet }) => sheet === wanted) : undefined;
  if (requested) return requested;

  for (const sheet of sheets) {
    const header = sheet.data.map(rowToCells).find((cells) => !isBlank(cells));
    if (header && hasPhoneColumn(header)) return sheet;
  }

  return sheets[0] ?? null;
}

export type XlsxParseResult = ParsedTable & { sheetName: string; sheetNames: string[] };

/**
 * As abas já lidas em linhas de cliente. Separado da leitura do arquivo (`readXlsxBytes`) para
 * testar sem um `.xlsx` de verdade. A primeira linha que não está em branco é o cabeçalho, e
 * `sourceRow` é a linha da planilha (a que o Excel mostra), não o índice na lista.
 */
export function parseXlsxSheets(
  sheets: readonly XlsxSheet[],
  options: { sheetName?: string } = {},
): XlsxParseResult {
  const sheetNames = sheets.map(({ sheet }) => sheet);
  const target = pickSheet(sheets, options.sheetName);
  if (!target) {
    throw new SpreadsheetParseError("empty_file", "A planilha não tem abas.");
  }

  let headers: string[] | null = null;
  const records: TableRecord[] = [];

  for (let index = 0; index < target.data.length; index++) {
    const cells = rowToCells(target.data[index]);
    if (isBlank(cells)) continue;

    if (!headers) {
      headers = cells;
      continue;
    }
    records.push({ cells, sourceRow: index + 1 });
    if (records.length > MAX_IMPORT_ROWS) break;
  }

  if (!headers) {
    throw new SpreadsheetParseError("empty_file", "A aba está vazia.", sheetNames);
  }

  return { ...tableFromRecords(headers, records, sheetNames), sheetName: target.sheet, sheetNames };
}

/**
 * Lê os bytes de um `.xlsx` com `read-excel-file`, em import dinâmico: quem usa só CSV nunca baixa
 * essa biblioteca. A biblioteca descompacta e lê o XML em segundo plano (Web Worker), então uma
 * planilha grande não trava a aba. Os números chegam como texto, sem passar por ponto flutuante.
 */
export async function readXlsxBytes(
  bytes: Uint8Array,
  options: { sheetName?: string } = {},
): Promise<XlsxParseResult> {
  assertXlsxIsNotABomb(bytes);

  let sheets: XlsxSheet[];
  try {
    const { default: readXlsxFile } = await import("read-excel-file/browser");
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    sheets = (await readXlsxFile(buffer as ArrayBuffer, {
      parseNumber: (text: string) => text,
    })) as unknown as XlsxSheet[];
  } catch (error) {
    if (error instanceof SpreadsheetParseError) throw error;
    const code = (error as { code?: string } | null)?.code;
    if (code === "XLS_FILE_NOT_SUPPORTED") {
      throw new SpreadsheetParseError(
        "unsupported_format",
        "Este é um Excel antigo (.xls). Abra no Excel e salve como .xlsx ou .csv.",
      );
    }
    throw new SpreadsheetParseError(
      "unreadable",
      "Não consegui abrir este arquivo Excel. Confira se não está corrompido, ou salve como .csv.",
    );
  }

  return parseXlsxSheets(sheets, options);
}
