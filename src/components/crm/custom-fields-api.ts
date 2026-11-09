import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api/client";
import type { CustomFieldEntity, CustomFieldType } from "@/lib/crm/constants";
import type { CustomFieldDef } from "@/lib/crm/values";
import { useAuth } from "@/providers/auth-provider";

/** O que `GET /api/custom-fields` devolve de cada campo. */
export type CustomField = CustomFieldDef & {
  entity: CustomFieldEntity;
  type: CustomFieldType;
  position: number;
  archived: boolean;
  /** Quantos cadastros têm valor neste campo. */
  usage: number;
};

/**
 * Definições de campo do tenant, por posição. Sem `archived`, só as ativas (o formulário e o
 * detalhe do cliente); o gestor pede `all`.
 */
export function useCustomFields(archived: "false" | "all" = "false", enabled = true) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: ["custom-fields", tenant?.id, "customer", archived],
    queryFn: () =>
      apiFetch<{ fields: CustomField[] }>(
        `/api/custom-fields?entity=customer&archived=${archived}`,
      ).then(({ fields }) => fields),
    enabled: enabled && Boolean(tenant),
    retry: false,
  });
}

type FieldRequest = {
  path: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
};

/** Escrita de definição: avisa, recarrega as definições e os clientes (que levam os valores). */
export function useCustomFieldMutation(successMessage?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: FieldRequest) =>
      apiFetch<{ field?: CustomField; clearedFrom?: number }>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      if (successMessage) toast.success(successMessage);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["custom-fields"] }),
        queryClient.invalidateQueries({ queryKey: ["customers"] }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
}
