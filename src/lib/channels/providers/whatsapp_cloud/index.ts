import { capabilitiesFor } from "@/lib/channels/capabilities";
import { ProviderError } from "@/lib/channels/errors";
import {
  downloadMedia,
  getMediaUrl,
  MetaApiError,
  sendMedia,
  sendTemplate,
  sendText,
  verifyPhoneNumber,
} from "@/lib/channels/providers/whatsapp_cloud/graph";
import { normalizeCloudEvents } from "@/lib/channels/providers/whatsapp_cloud/normalize";
import { verifyCloudWebhook } from "@/lib/channels/providers/whatsapp_cloud/webhook";
import type { ChannelModule } from "@/lib/channels/registry";
import type { ChannelContext, ChannelProvider, ProbeResult } from "@/lib/channels/types";

/** Teto de uma mídia recebida (o WhatsApp aceita até 100 MB em documento). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * `credentials` leva o que o serviço decifra e monta: `phoneNumberId`, `wabaId`,
 * `accessToken`, `appSecret`, `verifyToken`. Falta algum → erro de configuração do canal,
 * nunca chamada sem token.
 */
function required(ctx: ChannelContext, ...keys: string[]) {
  const values: Record<string, string> = {};

  for (const key of keys) {
    const value = ctx.credentials[key];
    if (!value) throw new ProviderError(`Credencial "${key}" ausente no canal.`, 0, null);
    values[key] = value;
  }
  return values as Record<string, string>;
}

export function createCloudProvider(): ChannelProvider {
  return {
    type: "whatsapp_cloud",
    capabilities: capabilitiesFor("whatsapp_cloud"),

    verifyWebhook: verifyCloudWebhook,
    normalizeEvents: normalizeCloudEvents,

    async sendText(ctx, input) {
      const { phoneNumberId, accessToken } = required(ctx, "phoneNumberId", "accessToken");
      const { messageId } = await sendText({
        phoneNumberId,
        accessToken,
        to: input.to,
        text: input.text,
        contextMessageId: input.quotedProviderMessageId,
      });

      return { providerMessageId: messageId };
    },

    async sendMedia(ctx, input) {
      const { phoneNumberId, accessToken } = required(ctx, "phoneNumberId", "accessToken");
      const { messageId } = await sendMedia({
        phoneNumberId,
        accessToken,
        to: input.to,
        kind: input.kind,
        link: input.url,
        mediaId: input.providerMediaId,
        caption: input.caption,
        filename: input.filename,
        contextMessageId: input.quotedProviderMessageId,
      });

      return { providerMessageId: messageId };
    },

    async sendTemplate(ctx, input) {
      const { phoneNumberId, accessToken } = required(ctx, "phoneNumberId", "accessToken");
      const { messageId } = await sendTemplate({
        phoneNumberId,
        accessToken,
        to: input.to,
        name: input.name,
        language: input.language,
        components: input.components,
      });

      return { providerMessageId: messageId };
    },

    async fetchMedia(ctx, providerMediaId) {
      const { accessToken } = required(ctx, "accessToken");
      const { url, mime } = await getMediaUrl({ accessToken, mediaId: providerMediaId });
      const { body } = await downloadMedia({ accessToken, url, maxBytes: MAX_MEDIA_BYTES });

      return { body, mime };
    },

    async probe(ctx): Promise<ProbeResult> {
      const { phoneNumberId, accessToken } = required(ctx, "phoneNumberId", "accessToken");

      try {
        const info = await verifyPhoneNumber({ phoneNumberId, accessToken });
        return { status: "connected", detail: null, identifier: info.display_phone_number };
      } catch (error) {
        // 4xx da Meta (token expirado, número removido) marca o canal `error`; 5xx, 429 e
        // timeout não mudam o estado: quem chama mantém o que já está gravado.
        if (error instanceof MetaApiError && error.isRejection) {
          return { status: "error", detail: error.message };
        }
        throw error;
      }
    },
  };
}

const channelModule: ChannelModule = {
  id: "whatsapp_cloud",
  createProvider: () => createCloudProvider(),
};

export default channelModule;
