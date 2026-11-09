import type { ComponentType } from "react";
import type { Channel } from "@/components/channels/channels-api";
import { CloudChannelDialog } from "@/components/channels/cloud-channel-dialog";
import type { ChannelType } from "@/lib/channels/types";

/**
 * Diálogo de cada tipo de número, para conectar (sem `channel`) e para gerenciar (com ele).
 * Um tipo novo entra com **uma linha** aqui; sem diálogo, o tipo não aparece em "Conectar
 * número" e o canal dele só renomeia, vira padrão e é removido pela lista.
 */
export type ChannelDialogProps = {
  open: boolean;
  /** Ausente: conectar um número novo. */
  channel?: Channel;
  onClose: () => void;
};

export const CHANNEL_DIALOGS: Partial<Record<ChannelType, ComponentType<ChannelDialogProps>>> = {
  whatsapp_cloud: CloudChannelDialog,
};
