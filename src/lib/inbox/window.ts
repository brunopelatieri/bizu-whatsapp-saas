import { can } from "@/lib/channels/capabilities";
import type { ChannelType } from "@/lib/channels/types";

/**
 * Janela de 24 h da Cloud API (SPEC, "Envio"): canal com `sessionWindow24h` só aceita texto livre
 * até 24 h depois da última mensagem **do contato** (`last_inbound_at`). Calculada no servidor; a
 * tela só antecipa.
 */

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SessionWindow = {
  /** O canal tem janela (Cloud). Sem janela, `open` é sempre `true`. */
  applies: boolean;
  open: boolean;
  /** Quando fecha; `null` sem janela ou sem mensagem do contato. */
  expiresAt: Date | null;
};

export function sessionWindow(
  channelType: ChannelType,
  lastInboundAt: Date | null,
  now = new Date(),
): SessionWindow {
  if (!can(channelType, "sessionWindow24h")) return { applies: false, open: true, expiresAt: null };
  if (!lastInboundAt) return { applies: true, open: false, expiresAt: null };

  const expiresAt = new Date(lastInboundAt.getTime() + SESSION_WINDOW_MS);
  return { applies: true, open: expiresAt.getTime() > now.getTime(), expiresAt };
}
