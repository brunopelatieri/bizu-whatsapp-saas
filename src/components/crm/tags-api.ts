import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/providers/auth-provider";

export type Tag = { id: string; name: string; color: string; usage: number };
/** O que a lista e o detalhe do cliente trazem de cada etiqueta. */
export type TagRef = Pick<Tag, "id" | "name" | "color">;

/** Etiquetas do tenant (`GET /api/tags`, por nome). */
export function useTags(enabled = true) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: ["tags", tenant?.id],
    queryFn: () => apiFetch<{ tags: Tag[] }>("/api/tags").then(({ tags }) => tags),
    enabled: enabled && Boolean(tenant),
    retry: false,
  });
}

type TagRequest = {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

/** Escrita de etiqueta: avisa, recarrega etiquetas e clientes (que levam as etiquetas). */
export function useTagMutation(successMessage?: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: TagRequest) =>
      apiFetch<{ tag?: Tag; removedFrom?: number }>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      if (successMessage) toast.success(successMessage);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tags"] }),
        queryClient.invalidateQueries({ queryKey: ["customers"] }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });
}
