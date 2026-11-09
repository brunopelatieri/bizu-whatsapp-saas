import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api/client";
import type { ImpersonationPolicy } from "@/lib/billing/constants";
import type { BillingState } from "@/lib/billing/state";
import { useAuth } from "@/providers/auth-provider";

/** Leitura em `/api/admin/*`. A chave começa com `admin` para o `invalidate` pegar tudo. */
export function useAdminQuery<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  enabled = true,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const query = search.size ? `?${search}` : "";

  return useQuery({
    queryKey: ["admin", path, params ?? {}],
    queryFn: () => apiFetch<T>(`${path}${query}`),
    enabled,
    retry: false,
  });
}

type AdminRequest = {
  path: string;
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
};

/** Escrita: avisa o resultado, recarrega as telas do admin e relê `/api/me`. */
export function useAdminMutation<T = unknown>(successMessage: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: AdminRequest) =>
      apiFetch<T>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success(successMessage);
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) => toast.error(error.message),
  });
}

/** Só o proprietário da plataforma escreve; o suporte lê. A API decide de qualquer forma. */
export function useIsPlatformOwner() {
  return useAuth().user?.platformRole === "platform_owner";
}

export type Page<T> = { items: T[]; total: number; pageSize: number };

export type AdminTenant = {
  id: string;
  name: string;
  slug: string;
  state: BillingState;
  status: string;
  planName: string | null;
  trialEndsAt: string | null;
  members: number;
  createdAt: string;
  /** Etiquetas que a plataforma aplicou (só `/api/admin/*` as devolve). */
  tags: Array<{ id: string; name: string; color: string }>;
};

export type AdminPlanPrice = {
  id: string;
  provider: string;
  interval: "month" | "year";
  amountCents: number;
  currency: string;
  providerPriceRef: string | null;
  active: boolean;
};

export type AdminPlan = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  limits: Record<string, number | null | undefined>;
  features: string[];
  isFree: boolean;
  active: boolean;
  sortOrder: number;
  prices: AdminPlanPrice[];
  tenants: number;
  // admin-crud A: as primeiras organizações do plano e quantas faltam.
  organizations: { id: string; name: string }[];
  more: number;
};

export type AdminSettings = {
  trialPlanId: string | null;
  trialDays: number;
  graceDays: number;
  impersonationPolicy: ImpersonationPolicy;
  dpoEmail: string | null;
  auditRetentionDays: number;
};
