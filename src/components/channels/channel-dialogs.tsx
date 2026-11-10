import { useQueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { CHANNELS_KEY, type Channel } from "@/components/channels/channels-api";
import { CloudChannelDialog } from "@/components/channels/cloud-channel-dialog";
import { QrChannelDialog } from "@/components/channels/qr-channel-dialog";
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

/** O diálogo de QR Code é autocontido (B3); aqui ele só ganha o contrato comum e recarrega a lista. */
function QrDialog({ open, channel, onClose }: ChannelDialogProps) {
  const queryClient = useQueryClient();

  return (
    <QrChannelDialog
      open={open}
      channel={channel ? { id: channel.id, name: channel.name } : null}
      onOpenChange={(next) => !next && onClose()}
      onChanged={() => void queryClient.invalidateQueries({ queryKey: [CHANNELS_KEY] })}
    />
  );
}

export const CHANNEL_DIALOGS: Partial<Record<ChannelType, ComponentType<ChannelDialogProps>>> = {
  whatsapp_cloud: CloudChannelDialog,
  whatsapp_qr: QrDialog,
};
