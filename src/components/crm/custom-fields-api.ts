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
 * Qual API e qual entidade servem as definições: o cliente do tenant (`/api/custom-fields`) ou a
 * organização da plataforma (`/api/admin/crm/custom-fields`). Os componentes de campo recebem
 * isto por props.
 */
export type CustomFieldsApi = {
  scope: "tenant" | "platform";
  path: string;
  entity: CustomFieldEntity;
  /** Substantivo de quem tem o valor, para a contagem de uso ("3 clientes"). */
  subject: { one: string; many: string; form: string };
};

export const tenantFieldsApi: CustomFieldsApi = {
  scope: "tenant",
  path: "/api/custom-fields",
  entity: "customer",
  subject: { one: "cliente", many: "clientes", form: "formulário do cliente" },
};

export const platformFieldsApi: CustomFieldsApi = {
  scope: "platform",
  path: "/api/admin/crm/custom-fields",
  entity: "organization",
  subject: { one: "organização", many: "organizações", form: "cartão da organização" },
};

/**
 * Definições de campo do escopo, por posição. Sem `archived`, só as ativas (o formulário e o
 * detalhe); o gestor pede `all`. Padrão: o cliente do tenant.
 */
export function useCustomFields(
  archived: "false" | "all" = "false",
  enabled = true,
  api: CustomFieldsApi = tenantFieldsApi,
) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey:
      api.scope === "tenant"
        ? ["custom-fields", tenant?.id, "customer", archived]
        : ["admin", "crm-custom-fields", archived],
    queryFn: () =>
      apiFetch<{ fields: CustomField[] }>(
        // Só o gestor (`all`) precisa da contagem de uso.
        `${api.path}?entity=${api.entity}&archived=${archived}${archived === "all" ? "&usage=true" : ""}`,
      ).then(({ fields }) => fields),
    enabled: enabled && (api.scope === "platform" || Boolean(tenant)),
    retry: false,
  });
}

type FieldRequest = {
  path: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
};

/** Escrita de definição: avisa, recarrega as definições e quem leva os valores. */
export function useCustomFieldMutation(
  successMessage?: string,
  api: CustomFieldsApi = tenantFieldsApi,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: FieldRequest) =>
      apiFetch<{ field?: CustomField; clearedFrom?: number }>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      if (successMessage) toast.success(successMessage);
      await Promise.all(
        (api.scope === "tenant" ? [["custom-fields"], ["customers"]] : [["admin"]]).map(
          (queryKey) => queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
    onError: (error) => toast.error(error.message),
  });
}
