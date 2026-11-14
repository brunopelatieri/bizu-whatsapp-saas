import type {
  ImportBatchResponse,
  ImportRowInput,
  ImportRowResult,
} from "@/lib/schemas/customer-import";
import { IMPORT_BATCH_MAX } from "@/lib/schemas/customer-import";
import { prepareRow } from "@/lib/spreadsheet/prepare-row";
import type { RawImportRow } from "@/lib/spreadsheet/types";

/**
 * O que a tela faz com as linhas lidas, sem React: separar o que vale enviar do que já se sabe
 * recusado (e contar), e enviar em lotes. Puro e testável; o servidor decide tudo de novo.
 */

export const DUPLICATE_IN_FILE = "Telefone repetido no arquivo.";

export type ImportPlan = {
  /** As linhas a enviar: válidas e sem telefone repetido antes delas no arquivo. */
  send: ImportRowInput[];
  /** As que já se sabe recusadas, com o motivo (inválidas e repetidas no arquivo). */
  rejected: ImportRowResult[];
  counts: { read: number; valid: number; duplicate: number; invalid: number };
};

/** O que vai ao servidor: só os campos do contrato (`problem` nunca vai). */
export function toBatchRow(row: RawImportRow): ImportRowInput {
  return {
    sourceRow: row.sourceRow,
    phone: row.phone,
    ...(row.name !== undefined ? { name: row.name } : {}),
    ...(row.email !== undefined ? { email: row.email } : {}),
    ...(row.document !== undefined ? { document: row.document } : {}),
    tags: row.tags,
    ...(row.notes !== undefined ? { notes: row.notes } : {}),
  };
}

export function planImport(rows: readonly RawImportRow[]): ImportPlan {
  const send: ImportRowInput[] = [];
  const rejected: ImportRowResult[] = [];
  const seenPhones = new Set<string>();
  const counts = { read: rows.length, valid: 0, duplicate: 0, invalid: 0 };

  for (const row of rows) {
    // Célula grande demais: o valor foi cortado na leitura, então a linha não pode ser enviada.
    if (row.problem) {
      counts.invalid += 1;
      rejected.push({ sourceRow: row.sourceRow, status: "invalid", reason: row.problem });
      continue;
    }

    const input = toBatchRow(row);
    const prepared = prepareRow(input);
    if (!prepared.ok) {
      counts.invalid += 1;
      rejected.push({ sourceRow: row.sourceRow, status: "invalid", reason: prepared.reason });
    } else if (seenPhones.has(prepared.row.phone.phoneKey)) {
      counts.duplicate += 1;
      rejected.push({ sourceRow: row.sourceRow, status: "duplicate", reason: DUPLICATE_IN_FILE });
    } else {
      seenPhones.add(prepared.row.phone.phoneKey);
      counts.valid += 1;
      send.push(input);
    }
  }

  return { send, rejected, counts };
}

export type ImportRun = {
  results: ImportRowResult[];
  tags: { created: number; ignored: number; ignoredReason: "no_permission" | "tag_limit" | null };
  /** Pedidos concluídos / total. */
  batchesDone: number;
  batchesTotal: number;
  /** Parou antes do fim (a pessoa cancelou ou um pedido falhou); o que já entrou ficou. */
  stopped: "canceled" | "error" | null;
  error?: unknown;
};

/**
 * Envia em lotes, um depois do outro (nunca em paralelo: a ordem do arquivo decide quem fica
 * dentro das vagas do plano). Cada lote concluído é definitivo; se um falha, os seguintes não
 * são enviados e o que já entrou fica registrado em `results`.
 */
export async function runImport(
  rows: readonly ImportRowInput[],
  post: (batch: ImportRowInput[]) => Promise<ImportBatchResponse>,
  options: {
    batchSize?: number;
    onProgress?: (run: ImportRun) => void;
    shouldStop?: () => boolean;
  } = {},
): Promise<ImportRun> {
  const size = Math.min(options.batchSize ?? IMPORT_BATCH_MAX, IMPORT_BATCH_MAX);
  const batchesTotal = Math.ceil(rows.length / size);
  const run: ImportRun = {
    results: [],
    tags: { created: 0, ignored: 0, ignoredReason: null },
    batchesDone: 0,
    batchesTotal,
    stopped: null,
  };

  for (let start = 0; start < rows.length; start += size) {
    if (options.shouldStop?.()) {
      run.stopped = "canceled";
      break;
    }

    try {
      const response = await post(rows.slice(start, start + size));
      run.results.push(...response.results);
      run.tags.created += response.tags.created;
      run.tags.ignored += response.tags.ignored;
      run.tags.ignoredReason ??= response.tags.ignoredReason;
      run.batchesDone += 1;
      options.onProgress?.({ ...run });
    } catch (error) {
      run.stopped = "error";
      run.error = error;
      break;
    }
  }

  return run;
}
