import type { ChannelStatus, ChannelType } from "@/lib/channels/types";
import { sessionWindow } from "@/lib/inbox/window";

/**
 * "Continuar por outro número" (X2): por quais outros números do escopo a conversa com um contato pode
 * seguir. Código puro (sem banco): o serviço (`transfer-actions.ts`) lê os números e as conversas do
 * contato e passa por aqui tanto para listar quanto para **revalidar** o envio; a tela só mostra o que
 * o servidor devolve.
 */

/** Por que um número não serve agora. A ordem é a da conferência (`refusalOf`). */
export const transferRefusals = ["disconnected", "assigned_to_other", "window_closed"] as const;
export type TransferRefusal = (typeof transferRefusals)[number];

export type TransferChannel = {
  id: string;
  /** `null` = número da plataforma. Conferido contra o escopo: o RLS já isola, esta é a segunda trava. */
  tenantId: string | null;
  name: string;
  type: ChannelType;
  status: ChannelStatus;
};

/** A conversa que o contato já tem naquele número, se tiver. */
export type TransferDestination = {
  /** O ator a alcança (`visibleConversation`). Fora do alcance, nada dela é revelado além de existir. */
  visible: boolean;
  lastInboundAt: Date | null;
};

export type TransferOption = {
  channel: { id: string; name: string; type: ChannelType };
  eligible: boolean;
  reason: TransferRefusal | null;
};

function refusalOf(
  channel: TransferChannel,
  destination: TransferDestination | undefined,
  now: Date,
): TransferRefusal | null {
  if (channel.status !== "connected") return "disconnected";
  // Antes da janela: de conversa fora do alcance não se diz nem se o contato escreveu há pouco.
  if (destination && !destination.visible) return "assigned_to_other";
  // Número com janela de 24 h (Cloud): só com a janela aberta **naquela** conversa de destino. Sem
  // conversa lá, o contato nunca escreveu para o número e só um modelo aprovado começa a conversa.
  if (!sessionWindow(channel.type, destination?.lastInboundAt ?? null, now).open) return "window_closed";
  return null;
}

/**
 * Os outros números do escopo, na ordem recebida, cada um com `eligible` e o motivo da recusa. Ficam
 * de fora, sem motivo: o número da conversa atual, o de outro escopo e o desativado (`disabled`).
 */
export function eligibleTransferChannels(input: {
  /** Tenant do escopo, ou `null` na plataforma. */
  scopeTenantId: string | null;
  currentChannelId: string;
  channels: readonly TransferChannel[];
  /** Conversa do **mesmo contato** por id do número (há no máximo uma por contato e número). */
  destinations: ReadonlyMap<string, TransferDestination>;
  now?: Date;
}): TransferOption[] {
  const now = input.now ?? new Date();

  return input.channels
    .filter(
      (channel) =>
        channel.tenantId === input.scopeTenantId &&
        channel.id !== input.currentChannelId &&
        channel.status !== "disabled",
    )
    .map((channel) => {
      const reason = refusalOf(channel, input.destinations.get(channel.id), now);

      return {
        channel: { id: channel.id, name: channel.name, type: channel.type },
        eligible: reason === null,
        reason,
      };
    });
}
