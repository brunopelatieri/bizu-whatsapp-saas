import type {
  ChannelCapabilities,
  ChannelCapability,
  ChannelType,
} from "@/lib/channels/types";

/**
 * Matriz declarativa: tela, serviço e jobs leem esta mesma fonte. `Record<ChannelType, ...>`
 * obriga o TypeScript a exigir uma linha nova sempre que `ChannelType` ganha um valor.
 *
 * Os valores da Evolution foram medidos na origem (`zap-crm-br-client`, SPEC 048): botões e
 * listas são recusados pelo WhatsApp numa conexão não oficial, então ficam fora daqui.
 */
export const CHANNEL_CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
  whatsapp_cloud: {
    templates: true,
    sessionWindow24h: true,
    deliveryFailure: true,
    deviceEcho: false,
    pairing: false,
  },
  whatsapp_qr: {
    templates: false,
    sessionWindow24h: false,
    deliveryFailure: false,
    deviceEcho: true,
    pairing: true,
  },
};

export function capabilitiesFor(type: ChannelType): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[type];
}

/** `can("whatsapp_cloud", "templates")`: o código pergunta à capacidade, nunca ao tipo. */
export function can(type: ChannelType, capability: ChannelCapability): boolean {
  return CHANNEL_CAPABILITIES[type][capability];
}
