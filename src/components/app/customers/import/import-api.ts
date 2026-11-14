import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
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
