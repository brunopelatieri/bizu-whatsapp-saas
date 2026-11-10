import { Loader2 } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { QueryState } from "@/components/admin/query-state";
import { dayKey, formatDayLabel } from "@/components/inbox/format";
import {
  chronological,
  type SendingMessage,
  useMessages,
} from "@/components/inbox/inbox-api";
import { MessageBubble, SendingBubble } from "@/components/inbox/message-bubble";
import { Button } from "@/components/ui/button";

/** Quanto do fim ainda conta como "estar no fim" (px). */
const BOTTOM_SLACK = 80;
/** Perto do topo, as mensagens anteriores são buscadas sozinhas (px). */
const TOP_TRIGGER = 120;

type MessageThreadProps = {
  conversationId: string;
  canReply: boolean;
  /** Envios que ainda não voltaram do servidor. */
  sending: SendingMessage[];
};

/**
 * Mensagens de uma conversa, de cima para baixo, com separador por dia. Carrega as anteriores ao
 * rolar para cima sem perder a posição; rola para o fim só se já estava no fim (ou na primeira
 * carga).
 */
export function MessageThread({ conversationId, canReply, sending }: MessageThreadProps) {
  const query = useMessages(conversationId);
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const messages = useMemo(() => chronological(data), [data]);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const initial = useRef(true);
  const firstId = useRef<string | undefined>(undefined);
  const sendingCount = useRef(0);
  const snapshot = useRef<{ height: number; top: number } | null>(null);

  // Outra conversa: volta ao estado de primeira carga.
  // biome-ignore lint/correctness/useExhaustiveDependencies: o id é o gatilho
  useEffect(() => {
    initial.current = true;
    atBottom.current = true;
    firstId.current = undefined;
    snapshot.current = null;
  }, [conversationId]);

  const loadOlder = useCallback(() => {
    const element = scroller.current;
    if (!element || !hasNextPage || isFetchingNextPage) return;
    snapshot.current = { height: element.scrollHeight, top: element.scrollTop };
    void fetchNextPage().catch(() => {
      snapshot.current = null;
    });
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || messages.length === 0) return;

    // Quem acabou de enviar quer ver o resultado, mesmo que estivesse lendo mensagens antigas.
    if (sending.length > sendingCount.current) atBottom.current = true;
    sendingCount.current = sending.length;

    const first = messages[0]?.id;
    const prepended = firstId.current !== undefined && first !== firstId.current;
    firstId.current = first;

    if (initial.current) {
      element.scrollTop = element.scrollHeight;
      initial.current = false;
      atBottom.current = true;
    } else if (prepended && snapshot.current) {
      element.scrollTop = snapshot.current.top + (element.scrollHeight - snapshot.current.height);
      snapshot.current = null;
    } else if (atBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, sending.length]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;

    atBottom.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
    if (element.scrollTop < TOP_TRIGGER) loadOlder();
  }

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-label="Mensagens da conversa"
      className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-muted/30 px-3 py-4 sm:px-4"
    >
      <QueryState {...query} isError={query.isError && !query.data}>
        {hasNextPage ? (
          <div className="flex justify-center pb-2">
            <Button variant="outline" size="sm" disabled={isFetchingNextPage} onClick={loadOlder}>
              {isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
              Carregar mensagens anteriores
            </Button>
          </div>
        ) : null}

        {messages.length === 0 && sending.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nenhuma mensagem ainda. Escreva a primeira abaixo.
          </p>
        ) : null}

        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);

          return (
            <Fragment key={message.id}>
              {newDay ? (
                <div className="flex justify-center py-1">
                  <span className="rounded-full bg-background px-3 py-0.5 text-xs text-muted-foreground shadow-xs">
                    {formatDayLabel(message.createdAt)}
                  </span>
                </div>
              ) : null}
              <MessageBubble message={message} canReply={canReply} />
            </Fragment>
          );
        })}

        {sending.map((item) => (
          <SendingBubble key={item.clientId} text={item.text} createdAt={item.createdAt} />
        ))}
      </QueryState>
    </div>
  );
}
