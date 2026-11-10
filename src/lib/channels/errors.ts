import type { ChannelCapability } from "@/lib/channels/types";

/** Módulo de canal não está em `CHANNEL_PROVIDERS` ou falta variável. Falha fechada. */
export class ChannelNotConfiguredError extends Error {
  constructor(readonly channelType: string) {
    super(`Canal "${channelType}" não está configurado neste servidor.`);
    this.name = "ChannelNotConfiguredError";
  }
}

/** O código pediu algo que o tipo de canal não faz. A tela devia ter escondido a ação. */
export class ChannelCapabilityError extends Error {
  constructor(
    readonly channelType: string,
    readonly capability: ChannelCapability,
  ) {
    super(`O canal "${channelType}" não suporta "${capability}".`);
    this.name = "ChannelCapabilityError";
  }
}

/**
 * Falha na chamada ao provedor. `status` é o HTTP (0 = rede ou timeout) e `code` o código do
 * provedor. A `message` é o texto do provedor e **pode citar dado do cliente**: vai à tela
 * do dono do canal (`META_REJECTED`), nunca a log nem a Sentry sem passar por `sanitizeError`.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | string | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** 4xx (menos 429): credencial ou pedido recusado, não indisponibilidade passageira. */
  get isRejection() {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }

  /** 401 ou 403: token inválido ou sem permissão. */
  get isAuthFailure() {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Falha que não adianta repetir (mídia vencida, endereço sem acesso): o aviso vira `failed`
 * na hora, sem retry. A `message` vai ao `channel_event.error`: nunca ponha nela telefone,
 * endereço ou trecho de conversa.
 */
export class PermanentEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEventError";
  }
}
