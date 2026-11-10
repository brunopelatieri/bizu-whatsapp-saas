import { capabilitiesFor } from "@/lib/channels/capabilities";
import { ChannelNotConfiguredError } from "@/lib/channels/errors";
import { pickRecord, pickString } from "@/lib/channels/payload";
import {
  type EvolutionConfig,
  EvolutionApiError,
  evolutionRequest,
  readEvolutionConfig,
  unwrap,
} from "@/lib/channels/providers/whatsapp_qr/client";
import {
  buildInstanceName,
  connectInstance,
  countRemoteInstances,
  createRemoteInstance,
  deleteRemoteInstance,
  disconnectInstance,
  fetchPairingCode,
  fetchQr,
  fetchStatus,
  logoutInstance,
  reconnectInstance,
  updateAdvancedSettings,
} from "@/lib/channels/providers/whatsapp_qr/instances";
import {
  externalizeEvolutionMedia,
  resolveEvolutionMedia,
} from "@/lib/channels/providers/whatsapp_qr/media";
import { normalizeEvolutionEvents } from "@/lib/channels/providers/whatsapp_qr/normalize";
import { verifyEvolutionWebhook } from "@/lib/channels/providers/whatsapp_qr/webhook";
import type { ChannelModule } from "@/lib/channels/registry";
import type {
  ChannelContext,
  ChannelProvider,
  PairingOperations,
  ProbeResult,
  SendResult,
} from "@/lib/channels/types";

/** O QR da Evolution vale 60 s (medido na origem); a tela conta a partir daí. */
export const QR_TTL_SECONDS = 60;

/** A Evolution quer só dígitos, sem `+` (mesma convenção do telefone canônico do projeto). */
function toNumber(to: string) {
  return to.replace(/\D/g, "");
}

function instanceToken(ctx: ChannelContext) {
  const token = ctx.credentials.instanceToken;

  if (!token) throw new EvolutionApiError("channel_auth_failed", 401, "Token da instância ausente.");
  return token;
}

/**
 * O id da mensagem vem em `Info.ID` (maiúsculo e aninhado): `{Info: {Chat, Sender, ID, ...},
 * Message: {...}}`. Procurar na raiz custou caro duas vezes na origem: toda mensagem era
 * gravada sem id, o recibo nunca casava e o eco do celular duplicava cada resposta.
 *
 * **Nunca lança**: roda depois do 200, a mensagem já saiu. Lançar viraria "falha de envio" e
 * o atendente reenviaria, e o cliente receberia duas vezes. Sem id, devolve vazio.
 */
export function extractProviderMessageId(data: Record<string, unknown>) {
  return (
    pickString(pickRecord(data, "Info"), "ID") ??
    pickString(pickRecord(data, "key"), "ID") ??
    pickString(data, "ID", "messageId") ??
    ""
  );
}

export function createEvolutionProvider(config: EvolutionConfig | null): ChannelProvider {
  const required = () => {
    if (!config) throw new ChannelNotConfiguredError("whatsapp_qr");
    return config;
  };

  async function send(
    ctx: ChannelContext,
    path: "/send/text" | "/send/media",
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<SendResult> {
    const data = unwrap(
      await evolutionRequest(required(), path, {
        method: "POST",
        key: instanceToken(ctx),
        body,
        timeoutMs,
      }),
    );

    return { providerMessageId: extractProviderMessageId(data) };
  }

  /** Segredo do webhook: sem ele não há endereço a registrar no servidor. */
  const webhookSecret = (ctx: ChannelContext) => {
    const secret = ctx.credentials.webhookSecret;

    if (!secret) throw new EvolutionApiError("channel_auth_failed", 401, "Segredo do webhook ausente.");
    return secret;
  };

  const remoteId = (ctx: ChannelContext) => {
    const id = ctx.credentials.remoteInstanceId;

    if (!id) throw new EvolutionApiError("not_found", 404, "Instância sem identificador no servidor.");
    return id;
  };

  const pairing: PairingOperations = {
    capacity: async () => ({
      used: await countRemoteInstances(required()),
      max: required().maxInstancesTotal,
    }),

    async createInstance(input) {
      const config = required();
      const created = await createRemoteInstance(config, {
        name: buildInstanceName(config.instancePrefix, input.scopeKey, input.label),
        token: input.instanceToken,
      });

      return { remoteInstanceId: created.id, remoteInstanceName: created.name };
    },

    async connect(ctx) {
      await connectInstance(required(), {
        instanceToken: instanceToken(ctx),
        webhookSecret: webhookSecret(ctx),
      });
    },

    async qr(ctx) {
      const result = await fetchQr(required(), instanceToken(ctx));

      return result.alreadyConnected
        ? result
        : { ...result, expiresInSeconds: QR_TTL_SECONDS };
    },

    pairingCode: (ctx, phone) =>
      fetchPairingCode(required(), { instanceToken: instanceToken(ctx), phone }),
    disconnect: (ctx) => disconnectInstance(required(), instanceToken(ctx)),
    logout: (ctx) => logoutInstance(required(), instanceToken(ctx)),
    reconnect: (ctx) => reconnectInstance(required(), instanceToken(ctx)),
    updateSettings: (ctx, settings) =>
      updateAdvancedSettings(required(), {
        remoteInstanceId: remoteId(ctx),
        instanceToken: instanceToken(ctx),
        settings,
      }),
  };

  return {
    type: "whatsapp_qr",
    capabilities: capabilitiesFor("whatsapp_qr"),
    pairing,

    externalizeInboundMedia: externalizeEvolutionMedia,
    // Sem configuração não há lista de origens: nada é baixado.
    resolveInboundMedia: (raw, store) =>
      config ? resolveEvolutionMedia(config, raw, store) : Promise.resolve({ outcome: "unchanged" }),

    verifyWebhook: verifyEvolutionWebhook,
    normalizeEvents: (raw) => normalizeEvolutionEvents(raw),

    sendText: (ctx, input) =>
      send(ctx, "/send/text", {
        number: toNumber(input.to),
        text: input.text,
        ...(input.quotedProviderMessageId
          ? { quoted: { messageId: input.quotedProviderMessageId } }
          : {}),
      }),

    sendMedia(ctx, input) {
      if (!input.url) {
        throw new EvolutionApiError("bad_request", 400, "A Evolution envia mídia por endereço.");
      }

      // A Evolution baixa `url` e sobe ao WhatsApp na mesma chamada: mais folga que o texto.
      return send(
        ctx,
        "/send/media",
        {
          number: toNumber(input.to),
          url: input.url,
          type: input.kind,
          ...(input.caption ? { caption: input.caption } : {}),
          ...(input.filename ? { filename: input.filename } : {}),
        },
        required().mediaTimeoutMs,
      );
    },

    async destroy(ctx) {
      const remoteInstanceId = ctx.credentials.remoteInstanceId;

      // Instância que nunca chegou a existir no servidor: nada a apagar.
      if (remoteInstanceId) await deleteRemoteInstance(required(), remoteInstanceId);
    },

    async probe(ctx): Promise<ProbeResult> {
      try {
        const status = await fetchStatus(required(), instanceToken(ctx));

        return {
          status: status.status,
          detail: status.status === "disconnected" ? "Desconectado." : null,
          identifier: status.phone,
        };
      } catch (error) {
        // 401 ou 403: token rotacionado ou instância apagada direto no servidor. 5xx e
        // timeout não mudam o estado: quem chama mantém o que já está gravado.
        if (error instanceof EvolutionApiError && error.isAuthFailure) {
          return { status: "error", detail: "O servidor Evolution recusou o token da instância." };
        }
        throw error;
      }
    },
  };
}

const channelModule: ChannelModule = {
  id: "whatsapp_qr",
  createProvider: (env) => createEvolutionProvider(readEvolutionConfig(env)),
};

export default channelModule;
