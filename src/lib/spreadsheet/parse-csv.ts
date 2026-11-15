import { tableFromRecords, type TableRecord } from "@/lib/spreadsheet/rows";
import {
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_IMPORT_ROWS,
  type ParsedTable,
  SpreadsheetParseError,
} from "@/lib/spreadsheet/types";

/**
 * Leitor de CSV (RFC 4180) escrito à mão, de um passo só e sem `eval` nem expressão regular sobre o
 * arquivo todo: lê caractere a caractere, então uma linha gigante, um arquivo de milhões de
 * delimitadores ou aspas por todo lado custam tempo linear e nunca travam por backtracking.
 *
 * O que ele faz: detecta o delimitador no cabeçalho (`,`, `;` ou tab); entende aspas envolventes, `""`
 * escapado e quebra de linha dentro de aspas; absorve o BOM; trata `\r\n`, `\n` e `\r`; **nunca remove
 * apóstrofo**; e **não interpreta nada**: uma célula que começa com `=`, `+`, `-` ou `@` é só texto.
 */

const CANDIDATES = [",", ";", "\t"] as const;

/** A primeira linha do arquivo, até a primeira quebra fora de aspas. */
function firstLine(text: string): string {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (char === "\n" || char === "\r")) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * O delimitador mais frequente **fora de aspas no cabeçalho** (só nele: é a linha que o autor da
 * planilha controla). Empate ou nenhum: vírgula. Olhar o corpo trocaria o delimitador por causa de
 * uma vírgula dentro de um nome de empresa.
 */
export function sniffDelimiter(header: string): string {
  let best: string = CANDIDATES[0];
  let bestCount = 0;

  for (const candidate of CANDIDATES) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < header.length; i++) {
      const char = header[i];
      if (char === '"') {
        if (inQuotes && header[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && char === candidate) {
        count++;
      }
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

export type CsvRecords = {
  delimiter: string;
  /** A primeira é o cabeçalho. Linhas só de células vazias são puladas. */
  records: TableRecord[];
};

/**
 * `maxRecords` corta cedo: passou dele, o arquivo é recusado sem ler o resto. O número da linha de
 * cada registro (`sourceRow`) é o da linha **física** em que ele começa, contando as quebras de
 * dentro de aspas, para bater com o que o editor de texto mostra.
 */
export function readCsvRecords(input: string, maxRecords = MAX_IMPORT_ROWS + 1): CsvRecords {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let line = 1;
  let delimiter: string | null = null;

  // A dica do Excel: `sep=;` na primeira linha diz o delimitador e não é dado.
  const hint = /^sep=(.)(?:\r\n|\n|\r)/i.exec(text);
  if (hint?.[1]) {
    delimiter = hint[1];
    text = text.slice(hint[0].length);
    line = 2;
  }
  delimiter ??= sniffDelimiter(firstLine(text));

  const records: TableRecord[] = [];
  let cells: string[] = [];
  let field = "";
  // Só espaço até aqui: aspas abrem um campo quando nada além de espaço veio antes delas (O(1), sem `trim`).
  let blank = true;
  let inQuotes = false;
  let quoteLine = line;
  let recordLine = line;

  const pushField = () => {
    if (cells.length < MAX_COLUMNS) cells.push(field);
    field = "";
    blank = true;
  };
  const endRecord = () => {
    pushField();
    if (cells.some((cell) => cell.trim() !== "")) {
      records.push({ cells, sourceRow: recordLine });
      if (records.length > maxRecords) return false;
    }
    cells = [];
    return true;
  };
  // Acima do teto o resto da célula não interessa: guarda `MAX_CELL_CHARS + 1` para provar o excesso.
  const append = (char: string) => {
    if (blank && char !== " " && char !== "\t") blank = false;
    if (field.length <= MAX_CELL_CHARS) field += char;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i++;
        } else {
          inQuotes = false;
        }
      } else if (char === "\r" || char === "\n") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        append("\n");
        line++;
      } else {
        append(char);
      }
      continue;
    }

    if (char === '"' && blank) {
      field = "";
      inQuotes = true;
      quoteLine = line;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (!endRecord()) return { delimiter, records };
      line++;
      recordLine = line;
    } else {
      append(char);
    }
  }

  if (inQuotes) {
    throw new SpreadsheetParseError(
      "unclosed_quote",
      `Há aspas que não fecham, a partir da linha ${quoteLine}. Feche as aspas ou remova-as e tente de novo.`,
    );
  }
  if (field !== "" || cells.length > 0) endRecord();

  return { delimiter, records };
}

/** Lê o texto de um CSV inteiro em linhas de cliente. */
export function parseCsv(text: string): ParsedTable {
  const { records } = readCsvRecords(text);
  const [header, ...data] = records;

  if (!header) {
    throw new SpreadsheetParseError("empty_file", "O arquivo está vazio.");
  }

  return tableFromRecords(header.cells, data);
}
