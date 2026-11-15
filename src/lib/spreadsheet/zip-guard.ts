import {
  MAX_XLSX_ENTRIES,
  MAX_XLSX_UNCOMPRESSED_BYTES,
  SpreadsheetParseError,
} from "@/lib/spreadsheet/types";

/**
 * Confere o `.xlsx` (um `.zip`) pelo **diretório central**, sem descomprimir nada: a soma dos
 * tamanhos que ele declara e o número de entradas. Pega a "bomba de zip" antes de a biblioteca
 * inflar. O tamanho declarado pode mentir para menos, mas o descompressor para no tamanho declarado
 * (o dado sai truncado, nunca maior), então mentir só estraga o próprio arquivo.
 *
 * Não valida o zip: arquivo que não é zip ou está corrompido passa por aqui e a leitura o recusa.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64 = 0xffffffff;

export function assertXlsxIsNotABomb(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // O fim do diretório fica nos últimos 22 bytes mais um comentário de até 65.535.
  let eocd = -1;
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return;

  const entries = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  if (entries > MAX_XLSX_ENTRIES) {
    throw new SpreadsheetParseError("unreadable", "O arquivo Excel está fora do formato esperado.");
  }
  // ZIP64 (arquivo ou diretório gigante) nunca é um `.xlsx` de planilha de clientes.
  if (entries === 0xffff || directoryOffset === ZIP64) {
    throw new SpreadsheetParseError("file_too_large", "O arquivo Excel é grande demais.");
  }

  let offset = directoryOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) return;

    const uncompressed = view.getUint32(offset + 24, true);
    if (uncompressed === ZIP64) {
      throw new SpreadsheetParseError("file_too_large", "O arquivo Excel é grande demais.");
    }
    total += uncompressed;
    if (total > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new SpreadsheetParseError(
        "file_too_large",
        "O arquivo Excel é grande demais depois de aberto. Salve só as colunas e linhas necessárias, ou use .csv.",
      );
    }

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}
