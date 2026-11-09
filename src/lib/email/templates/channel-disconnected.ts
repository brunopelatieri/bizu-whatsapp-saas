import { assertAbsoluteUrl } from "@/lib/email/templates/format";
import { renderLayout } from "@/lib/email/templates/layout";

export type ChannelDisconnectedInput = {
  name: string;
  tenantName: string;
  channelName: string;
  /** Texto curto do estado ("Desconectado no celular."). Sem telefone nem dado do cliente. */
  reason: string | null;
  url: string;
};

export const previewInput: ChannelDisconnectedInput = {
  name: "Ana",
  tenantName: "Acme Ltda",
  channelName: "Vendas",
  reason: "Desconectado no celular.",
  url: "http://localhost:5173/app/configuracoes/canais",
};

export function channelDisconnectedTemplate(input: ChannelDisconnectedInput) {
  return renderLayout({
    subject: `O número ${input.channelName} de ${input.tenantName} saiu do ar`,
    heading: `Olá, ${input.name}`,
    paragraphs: [
      `O número de WhatsApp "${input.channelName}" de ${input.tenantName} não está mais conectado, e as mensagens dele não chegam nem saem até você reconectá-lo.`,
      ...(input.reason ? [`Motivo informado: ${input.reason}`] : []),
    ],
    action: { label: "Ver números de WhatsApp", url: assertAbsoluteUrl(input.url) },
  });
}
