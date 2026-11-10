import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api/client";
import type { ChannelStatus, ChannelType } from "@/lib/channels/types";
import { useAuth } from "@/providers/auth-provider";

/** `ChannelView` como chega ao navegador (datas em ISO). Nunca traz segredo. */
export type Channel = {
  id: string;
  type: ChannelType;
  name: string;
  identifier: string | null;
  status: ChannelStatus;
  statusDetail: string | null;
  isDefault: boolean;
  connectedAt: string | null;
  lastSeenAt: string | null;
  hasConversations: boolean;
  // Cloud
  phoneNumberId?: string;
  wabaId?: string;
  appId?: string | null;
  verifiedName?: string | null;
  qualityRating?: string | null;
  accessTokenHint?: string | null;
  webhookVerifiedAt?: string | null;
  // QR Code
  connectedPhone?: string | null;
};

export type ChannelLimit = { limit: number | null; used: number; allowed: boolean };

export type ChannelsResponse = {
  channels: Channel[];
  /** `missing` (nomes de variáveis que faltam no servidor) só vem em `/api/admin/channels`. */
  providers: Record<ChannelType, { enabled: boolean; missing?: string[] }>;
  limits: Record<ChannelType, ChannelLimit>;
};

export const CHANNELS_KEY = "channels";

export const TENANT_CHANNELS_PATH = "/api/channels";
export const PLATFORM_CHANNELS_PATH = "/api/admin/channels";

/**
 * Números do escopo, módulos ativos e uso do plano (`GET <basePath>`). A base decide o escopo:
 * a do tenant espera a organização ativa; a da plataforma não depende dela.
 */
export function useChannels(basePath: string = TENANT_CHANNELS_PATH) {
  const { tenant } = useAuth();
  const tenantScoped = basePath === TENANT_CHANNELS_PATH;

  return useQuery({
    queryKey: [CHANNELS_KEY, basePath, tenantScoped ? tenant?.id : null],
    queryFn: () => apiFetch<ChannelsResponse>(basePath),
    enabled: !tenantScoped || Boolean(tenant),
    retry: false,
  });
}

type ChannelRequest = {
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

/** Escrita de canal: avisa e recarrega a lista. O erro vai ao toast, salvo `silent`. */
export function useChannelMutation<T = unknown>(
  successMessage?: string,
  options: { silent?: boolean } = {},
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ path, method, body }: ChannelRequest) =>
      apiFetch<T>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    onSuccess: async () => {
      if (successMessage) toast.success(successMessage);
      await queryClient.invalidateQueries({ queryKey: [CHANNELS_KEY] });
    },
    onError: (error) => {
      if (!options.silent) toast.error(error.message);
    },
  });
}
