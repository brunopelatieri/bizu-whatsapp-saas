import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api/client";
import type { PhoneKind } from "@/lib/phone/br";
import { useAuth } from "@/providers/auth-provider";

export type TeamMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  /** Tipo do telefone do membro (`null` sem telefone); o número não sai da API. */
  phoneKind: PhoneKind | null;
};

export type TeamInvitation = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
};

export type RoleOption = { name: string; label: string };

type TeamResponse = {
  members: TeamMember[];
  invitations: TeamInvitation[];
  roles: RoleOption[];
};

export function useTeam() {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: ["team", tenant?.id],
    queryFn: () => apiFetch<TeamResponse>("/api/team"),
    enabled: Boolean(tenant),
    retry: false,
  });
}

type TeamRequest = {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

/** Mutação da equipe: recarrega a tela no sucesso e mostra o erro da API. */
export function useTeamMutation(successMessage: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: TeamRequest) =>
      apiFetch(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success(successMessage);
      await queryClient.invalidateQueries({ queryKey: ["team"] });
    },
    onError: (error) => toast.error(error.message),
  });
}
