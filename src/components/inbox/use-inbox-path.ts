import { useCallback } from "react";
import { useSearchParams } from "react-router";
import {
  CHANNEL_PARAM,
  inboxPath,
  parseChannelParam,
} from "@/components/inbox/channel-filter";
import { useInboxScope } from "@/components/inbox/inbox-scope";

/**
 * Caminho de uma tela do atendimento no escopo atual, levando adiante o filtro de número da URL
 * (`?canal=`, ver `channel-filter.ts`): abrir uma conversa, voltar à lista ou seguir para outra não
 * perdem o filtro. Só o id do canal é carregado; qualquer outro parâmetro da URL fica para trás.
 */
export function useInboxPath() {
  const { route } = useInboxScope();
  const [params] = useSearchParams();
  const channelId = parseChannelParam(params.get(CHANNEL_PARAM));

  return useCallback(
    /**
     * `moveFilterTo`: a conversa aberta é de **outro** número (X2). Com o filtro ligado, ele passa a
     * ser o desse número (senão a lista esconderia a conversa aberta); sem filtro, segue sem.
     */
    (conversationId?: string, moveFilterTo?: string) =>
      inboxPath(route, conversationId, channelId && moveFilterTo ? moveFilterTo : channelId),
    [route, channelId],
  );
}
