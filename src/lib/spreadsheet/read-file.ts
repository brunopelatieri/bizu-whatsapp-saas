import { parseCsv } from "@/lib/spreadsheet/parse-csv";
import { readXlsxBytes } from "@/lib/spreadsheet/parse-xlsx";
import {
  MAX_SPREADSHEET_BYTES,
  type SpreadsheetReadResult,
  SpreadsheetParseError,
} from "@/lib/spreadsheet/types";

/** Entrada mínima: o `File` do navegador e o teste (`new File(...)`) cabem aqui. */
export type SpreadsheetFile = {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

const startsWith = (bytes: Uint8Array, ...prefix: number[]) =>
  prefix.every((value, index) => bytes[index] === value);

/** `PK\x03\x04`: o cabeçalho de um zip, que é o que um `.xlsx` é. */
const isZip = (bytes: Uint8Array) => startsWith(bytes, 0x50, 0x4b, 0x03, 0x04);

/** O formato binário antigo do Excel (`.xls`). */
const isOleExcel = (bytes: Uint8Array) =>
  startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

/**
 * Texto do CSV, em três tentativas: UTF-16 se há marca de ordem (o "Texto Unicode" do Excel); UTF-8
 * estrito; e, se não for UTF-8 válido, Windows-1252, que é o que o Excel em português grava em
 * "CSV (separado por vírgulas)". Arquivo com byte nulo não é texto.
 */
export function decodeSpreadsheetText(bytes: Uint8Array): string {
  if (startsWith(bytes, 0xff, 0xfe)) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (startsWith(bytes, 0xfe, 0xff)) return new TextDecoder("utf-16be").decode(bytes.subarray(2));

  // Byte nulo em qualquer ponto: não é texto (e o banco não o guardaria).
  if (bytes.includes(0)) {
    throw new SpreadsheetParseError(
      "unsupported_format",
      "Este arquivo não é uma planilha de texto. Envie um .csv ou um .xlsx.",
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Mesma leitura do arquivo para o navegador (a tela) e para o teste. Nada aqui executa o arquivo. */
export async function readSpreadsheetFile(
  file: SpreadsheetFile,
  options: { sheetName?: string } = {},
): Promise<SpreadsheetReadResult> {
  // Antes de ler: arquivo grande demais não ocupa a memória que o teto existe para proteger.
  if (file.size > MAX_SPREADSHEET_BYTES) {
    throw new SpreadsheetParseError(
      "file_too_large",
      `O arquivo passa de ${MAX_SPREADSHEET_BYTES / (1024 * 1024)} MB. Divida em partes menores.`,
    );
  }

  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (extension !== "csv" && extension !== "xlsx") {
    throw new SpreadsheetParseError(
      "unsupported_format",
      extension === "xls"
        ? "Este é um Excel antigo (.xls). Abra no Excel e salve como .xlsx ou .csv."
        : "Formato não aceito. Envie um arquivo .csv ou .xlsx.",
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new SpreadsheetParseError("unreadable", "Não consegui ler o arquivo.");
  }
  // O tamanho declarado do `File` não é prova: o teto vale também para os bytes lidos.
  if (bytes.length > MAX_SPREADSHEET_BYTES) {
    throw new SpreadsheetParseError("file_too_large", "O arquivo passa de 10 MB.");
  }
  if (bytes.length === 0) {
    throw new SpreadsheetParseError("empty_file", "O arquivo está vazio.");
  }

  // O conteúdo manda, não a extensão: um `.xlsx` renomeado para `.csv` (ou o contrário) ainda abre.
  if (isOleExcel(bytes)) {
    throw new SpreadsheetParseError(
      "unsupported_format",
      "Este é um Excel antigo (.xls). Abra no Excel e salve como .xlsx ou .csv.",
    );
  }
  if (isZip(bytes)) {
    return { ...(await readXlsxBytes(bytes, options)), format: "xlsx" };
  }
  if (extension === "xlsx") {
    throw new SpreadsheetParseError(
      "unreadable",
      "Este arquivo não é um Excel (.xlsx) válido. Confira se não está corrompido.",
    );
  }

  return { ...parseCsv(decodeSpreadsheetText(bytes)), format: "csv" };
}
