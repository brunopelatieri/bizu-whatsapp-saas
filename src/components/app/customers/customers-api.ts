import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api/client";
import type { CustomerStatus } from "@/lib/tenant/customer-constants";
import { useAuth } from "@/providers/auth-provider";
import type { TagRef } from "@/components/crm/tags-api";

export type Customer = {
  id: string;
  name: string;
  /** Opcional: sem e-mail o cliente existe, mas não tem conta acessível. */
  email: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  document: string | null;
  status: CustomerStatus;
  tags: TagRef[];
  notes: string | null;
  invitedAt: string | null;
  lastLoginAt: string | null;
  hasPortalAccess: boolean;
  createdAt: string;
};

type CustomerPage = { items: Customer[]; total: number; pageSize: number };

export type CustomerFilters = {
  q?: string;
  status?: CustomerStatus;
  /** Ids de etiqueta: clientes com qualquer uma delas. */
  tags?: string[];
  page: number;
};

export function useCustomers(filters: CustomerFilters, enabled = true) {
  const { tenant } = useAuth();
  const search = new URLSearchParams({ page: String(filters.page) });

  if (filters.q) search.set("q", filters.q);
  if (filters.status) search.set("status", filters.status);
  if (filters.tags && filters.tags.length > 0) search.set("tags", filters.tags.join(","));

  return useQuery({
    queryKey: ["customers", tenant?.id, filters],
    queryFn: () => apiFetch<CustomerPage>(`/api/customers?${search}`),
    enabled: enabled && Boolean(tenant),
    retry: false,
  });
}

export function useCustomer(id: string) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: ["customers", tenant?.id, "detail", id],
    queryFn: () => apiFetch<{ customer: Customer }>(`/api/customers/${id}`),
    enabled: Boolean(tenant),
    retry: false,
  });
}

type CustomerRequest = {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

/** Escrita: avisa o resultado, recarrega as telas de clientes e mostra o erro da API. */
export function useCustomerMutation(successMessage: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: CustomerRequest) =>
      apiFetch(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success(successMessage);
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (error) => toast.error(error.message),
  });
}

export function formatDateTime(value: string | null) {
  if (!value) return "Nunca";

  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
