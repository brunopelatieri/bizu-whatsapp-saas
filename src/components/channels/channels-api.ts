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
  providers: Record<ChannelType, { enabled: boolean }>;
  limits: Record<ChannelType, ChannelLimit>;
};

export const CHANNELS_KEY = "channels";

/** Números do tenant, módulos ativos e uso do plano (`GET /api/channels`). */
export function useChannels() {
  const { tenant } = useAuth();

  return useQuery({
    queryKey: [CHANNELS_KEY, tenant?.id],
    queryFn: () => apiFetch<ChannelsResponse>("/api/channels"),
    enabled: Boolean(tenant),
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
