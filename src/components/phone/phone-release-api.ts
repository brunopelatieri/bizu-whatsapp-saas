import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/api/client";
import { useAuth } from "@/providers/auth-provider";

/**
 * Fila de liberação de telefone (SPEC `pre-producao`, bloco T, T4). Os dois endereços são as
 * rotas da T2a: a da organização (`phone:confirm`) e a da plataforma (só o proprietário). A tela
 * não decide nada: a API confere quem pode, de quem é o pedido e se o número pode ser liberado.
 */

export const TENANT_PHONE_QUEUE_PATH = "/api/phone-verifications";
export const PLATFORM_PHONE_QUEUE_PATH = "/api/admin/phone-verifications";

/** Um pedido da fila, como `listPhoneVerifications` o devolve. `phone` é o número normalizado. */
export type PhoneRelease = {
  id: string;
  /** `sent`: link a caminho. `awaiting_manual`: ninguém conseguiu enviar; espera a liberação. */
  status: "sent" | "awaiting_manual";
  subjectType: "user" | "customer";
  subjectId: string;
  phone: string;
  name: string;
  createdAt: string;
};

export type PhoneReleasePage = { items: PhoneRelease[]; total: number; pageSize: number };

const TENANT_KEY = "phone-releases";

export function useTenantPhoneQueue(page: number) {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: [TENANT_KEY, tenant?.id, page],
    queryFn: () => apiFetch<PhoneReleasePage>(`${TENANT_PHONE_QUEUE_PATH}?page=${page}`),
    enabled: Boolean(tenant),
    retry: false,
  });
}

/** Libera à mão um pedido da organização. O erro vai à mensagem própria de cada código. */
export function useTenantPhoneRelease() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`${TENANT_PHONE_QUEUE_PATH}/${id}/confirm`, { method: "POST" }),
    onSuccess: async () => {
      toast.success("Telefone liberado.");
    },
    onError: (error) => toast.error(releaseErrorMessage(error)),
    // Sucesso ou erro: a lista relê (o pedido pode ter mudado ou saído da fila).
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: [TENANT_KEY] });
      // A ficha ou a equipe mostram o telefone como confirmado depois da liberação.
      await queryClient.invalidateQueries({ queryKey: ["customers"] });
      await queryClient.invalidateQueries({ queryKey: ["team"] });
    },
  });
}

/**
 * Uma mensagem para cada recusa da liberação. O texto vem da tela, não da API, para dizer o que
 * fazer em seguida; o que a API manda só entra quando o código é outro.
 */
export function releaseErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Não foi possível liberar o telefone.";
  }

  switch (error.code) {
    case "SELF_CONFIRMATION":
      return "Você não pode liberar o seu próprio telefone. Use o link de verificação.";
    case "PHONE_IN_USE":
      return "Outra conta já confirmou este número. A liberação à mão não prova que ele é desta pessoa, por isso não tira o número de quem já o tem.";
    case "PLATFORM_ONLY":
      return "Esta conta responde só à plataforma: o telefone dela não é liberado por uma organização. O pedido foi encaminhado ao proprietário da plataforma.";
    case "VERIFICATION_STALE":
      return "Este pedido não vale mais: o telefone ou a equipe mudou. A lista foi atualizada.";
    default:
      if (error.status === 404) {
        return "Pedido não encontrado: talvez já tenha sido liberado ou cancelado. A lista foi atualizada.";
      }
      return error.message;
  }
}
