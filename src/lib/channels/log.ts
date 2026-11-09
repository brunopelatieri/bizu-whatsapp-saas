import { logError } from "@/api/log";
import { ProviderError } from "@/lib/channels/errors";
import { sanitizeError } from "@/lib/email/store";

/** Telefone e e-mail somem do texto de erro; ele vai à tela do admin e ao `channel_event`. */
export function sanitizeChannelError(error: unknown) {
  return sanitizeError(error).replace(/\d{8,}/g, "[número]");
}

/**
 * Log de erro de canal. A mensagem do provedor pode citar telefone, nome ou trecho de conversa,
 * e a da Evolution, o endereço interno do servidor: de `ProviderError` ficam só o tipo, o status
 * HTTP e o código. Nos demais erros a mensagem passa por `sanitizeChannelError`.
 */
export function logChannelError(context: string, error: unknown) {
  logError(
    context,
    error instanceof ProviderError
      ? new Error(`${error.name} status=${error.status} code=${error.code ?? "-"}`)
      : new Error(sanitizeChannelError(error)),
  );
}
