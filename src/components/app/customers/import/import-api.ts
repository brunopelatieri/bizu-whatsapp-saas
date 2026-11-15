import { useQuery } from "@tanstack/react-query";
import { apiFetch, apiFetchBytes } from "@/lib/api/client";
import type {
  ImportBatchResponse,
  ImportQuota,
  ImportRowInput,
} from "@/lib/schemas/customer-import";
import { useAuth } from "@/providers/auth-provider";

/**
 * As vagas do plano para novos clientes. A chave começa em `customers`: toda escrita de cliente (e a
 * própria importação) já invalida esta árvore. É só um aviso: quem para no limite é o servidor.
 */
export function useImportQuota(enabled: boolean) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: ["customers", tenant?.id, "import-quota"],
    queryFn: () => apiFetch<ImportQuota>("/api/customers/import/quota"),
    enabled: enabled && Boolean(tenant),
    retry: false,
    staleTime: 0,
  });
}

/** Um lote (até `IMPORT_BATCH_MAX` linhas). O servidor devolve um resultado por linha. */
export function postImportBatch(rows: ImportRowInput[]) {
  return apiFetch<ImportBatchResponse>("/api/customers/import", {
    method: "POST",
    body: JSON.stringify({ rows }),
  });
}

/** Nome do arquivo que a tela mostra para a planilha baixada do Google (o conteúdo é CSV). */
export const GOOGLE_SHEET_FILENAME = "Google Planilhas.csv";

/**
 * Baixa, pelo servidor, o CSV de uma planilha pública do Google Planilhas (I3) e o entrega como um
 * `File`: a tela segue pelo mesmo `readSpreadsheetFile`, prévia e lotes do arquivo enviado.
 */
export async function fetchGoogleSheetFile(url: string) {
  const bytes = await apiFetchBytes("/api/customers/import/google-sheets", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  return new File([bytes as Uint8Array<ArrayBuffer>], GOOGLE_SHEET_FILENAME, { type: "text/csv" });
}
