import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api/client";
import { useAuth } from "@/providers/auth-provider";

export type Tag = { id: string; name: string; color: string; usage: number };
/** O que a lista e o detalhe do cliente trazem de cada etiqueta. */
export type TagRef = Pick<Tag, "id" | "name" | "color">;

/**
 * Qual API serve o catálogo: a do tenant (`/api/tags`) ou a da plataforma
 * (`/api/admin/crm/tags`). Os componentes de etiqueta recebem isto por props; nenhum deles sabe
 * de que escopo é a etiqueta.
 */
export type TagsApi = {
  scope: "tenant" | "platform";
  path: string;
  /** Substantivo do que recebe a etiqueta, para a contagem de uso ("3 clientes"). */
  subject: { one: string; many: string };
};

export const tenantTagsApi: TagsApi = {
  scope: "tenant",
  path: "/api/tags",
  subject: { one: "cliente", many: "clientes" },
};

export const platformTagsApi: TagsApi = {
  scope: "platform",
  path: "/api/admin/crm/tags",
  subject: { one: "organização", many: "organizações" },
};

/**
 * Etiquetas do escopo (`GET`, por nome). Padrão: as do tenant. A chave da plataforma fica sob
 * `["admin"]`: toda escrita do `/admin` já invalida essa árvore.
 */
export function useTags(enabled = true, api: TagsApi = tenantTagsApi) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: api.scope === "tenant" ? ["tags", tenant?.id] : ["admin", "crm-tags"],
    queryFn: () => apiFetch<{ tags: Tag[] }>(api.path).then(({ tags }) => tags),
    enabled: enabled && (api.scope === "platform" || Boolean(tenant)),
    retry: false,
  });
}

type TagRequest = {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

/** Escrita de etiqueta: avisa, recarrega etiquetas e quem as carrega (clientes ou organizações). */
export function useTagMutation(successMessage?: string, api: TagsApi = tenantTagsApi) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: TagRequest) =>
      apiFetch<{ tag?: Tag; removedFrom?: number }>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      if (successMessage) toast.success(successMessage);
      await Promise.all(
        (api.scope === "tenant" ? [["tags"], ["customers"]] : [["admin"]]).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
    onError: (error) => toast.error(error.message),
  });
}
