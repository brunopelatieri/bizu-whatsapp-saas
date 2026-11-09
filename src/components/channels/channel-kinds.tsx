import { BadgeCheck, type LucideIcon, QrCode } from "lucide-react";
import type { ChannelType } from "@/lib/channels/types";

/**
 * O que a tela sabe de cada tipo de número: rótulo, ícone e o texto da escolha em "Conectar
 * número". `Record<ChannelType, ...>` obriga uma linha nova quando `ChannelType` ganha valor.
 *
 * O diálogo de cada tipo é ligado em `channel-dialogs.tsx` (um tipo sem diálogo não aparece
 * na escolha).
 */
export type ChannelKind = {
  label: string;
  /** Uma frase para quem está escolhendo o tipo. */
  description: string;
  icon: LucideIcon;
};

export const CHANNEL_KINDS: Record<ChannelType, ChannelKind> = {
  whatsapp_cloud: {
    label: "WhatsApp oficial",
    description:
      "API oficial da Meta (Cloud API). Usa as credenciais do seu aplicativo da Meta; indicado para volume e modelos de mensagem.",
    icon: BadgeCheck,
  },
  whatsapp_qr: {
    label: "WhatsApp por QR Code",
    description:
      "Conecta um celular lendo um QR Code. Não é oficial: o número pode ser bloqueado pelo WhatsApp.",
    icon: QrCode,
  },
};
