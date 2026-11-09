import { type Scope, withScope } from "@/db/rls";
import { ProviderError } from "@/lib/channels/errors";
import { logChannelError } from "@/lib/channels/log";
import { getProvider } from "@/lib/channels/registry";
import { applyChannelStatus, contextFor, requireChannelRow } from "@/lib/channels/service";
import type {
  ChannelContext,
  ChannelProvider,
  SendMedia,
  SendResult,
  SendText,
} from "@/lib/channels/types";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * Envio por um canal do escopo. Confere o estado **antes** de chamar o provedor: canal que não
 * está `connected` responde 409 `CHANNEL_NOT_CONNECTED`, em vez de uma falha obscura do
 * provedor (na origem, o envio por QR Code não conferia). Quem chama é a caixa de entrada (C1).
 */

async function sendThrough(
  scope: Scope,
  channelId: string,
  send: (provider: ChannelProvider, ctx: ChannelContext) => Promise<SendResult>,
): Promise<SendResult> {
  const { row, ctx } = await withScope(scope, async (tx) => {
    const found = await requireChannelRow(tx, scope, channelId);

    return { row: found, ctx: await contextFor(tx, found) };
  });

  if (row.status !== "connected") {
    throw new TenantRuleError(
      409,
      "CHANNEL_NOT_CONNECTED",
      "Este número não está conectado. Reconecte para enviar mensagens.",
    );
  }

  try {
    return await send(getProvider(row.type), ctx);
  } catch (error) {
    // 401 ou 403: a credencial do canal não vale mais. O canal vai para `error`.
    if (error instanceof ProviderError && error.isAuthFailure) {
      await withScope(scope, (tx) =>
        applyChannelStatus(tx, row.id, {
          status: "error",
          detail: "O provedor recusou a credencial deste número.",
        }),
      ).catch((writeError) => logChannelError("Falha ao marcar canal com erro", writeError));
    }
    throw error;
  }
}

export const sendChannelText = (scope: Scope, channelId: string, input: SendText) =>
  sendThrough(scope, channelId, (provider, ctx) => provider.sendText(ctx, input));

export const sendChannelMedia = (scope: Scope, channelId: string, input: SendMedia) =>
  sendThrough(scope, channelId, (provider, ctx) => provider.sendMedia(ctx, input));
