/**
 * Filtro de número da lista do atendimento na URL (X1): `?canal=<id do canal>`. Código puro (sem
 * React): `channel-filter.test.ts` cobre. A URL leva **só** o id do canal; busca, situação, etiquetas
 * e o resto seguem em estado local (nome, telefone e etiqueta nunca vão para a barra de endereço).
 */

/** Nome do parâmetro de consulta. */
export const CHANNEL_PARAM = "canal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O id que o parâmetro traz, ou `undefined` se não for um id (vazio, texto qualquer, repetido).
 * Só o formato é conferido aqui: se o canal existe e é do escopo, quem diz é `resolveChannelFilter`.
 */
export function parseChannelParam(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && UUID.test(text) ? text.toLowerCase() : undefined;
}

/**
 * O filtro que vale: o id do parâmetro só se for de um número da lista do escopo. Canal inexistente,
 * de outro escopo ou lista ainda não lida (`channelIds` indefinido) caem em "todos" (`undefined`),
 * sem erro.
 */
export function resolveChannelFilter(
  param: string | undefined,
  channelIds: readonly string[] | undefined,
): string | undefined {
  if (!param || !channelIds) return undefined;
  return channelIds.includes(param) ? param : undefined;
}

/** O caminho de uma tela do atendimento, levando o filtro de número adiante (e mais nada). */
export function inboxPath(route: string, conversationId?: string, channelId?: string): string {
  const base = conversationId ? `${route}/${conversationId}` : route;
  return channelId ? `${base}?${CHANNEL_PARAM}=${encodeURIComponent(channelId)}` : base;
}
