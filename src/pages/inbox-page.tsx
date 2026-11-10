import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { QueryState } from "@/components/admin/query-state";
import { useCan } from "@/components/auth/can";
import { Composer } from "@/components/inbox/composer";
import { ContactPanel } from "@/components/inbox/contact-panel";
import { ConversationHeader } from "@/components/inbox/conversation-header";
import { ConversationList } from "@/components/inbox/conversation-list";
import {
  type SendingMessage,
  useConversation,
  useInboxMutation,
} from "@/components/inbox/inbox-api";
import { MessageThread } from "@/components/inbox/message-thread";
import { NewConversationDialog } from "@/components/inbox/new-conversation-dialog";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/**
 * Atendimento do tenant: lista, conversa e painel do contato. Em tela larga as três colunas
 * aparecem juntas (o painel a partir de `xl`); em tela estreita, uma de cada vez (lista → conversa
 * → painel), com "voltar". Sem `loader`: tudo vem pela API, com polling de 20 s (a C4 troca por SSE).
 */
export function InboxPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [panelOpen, setPanelOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // Outra conversa: o painel (tela à parte, abaixo de xl) fecha.
  // biome-ignore lint/correctness/useExhaustiveDependencies: o id é o gatilho
  useEffect(() => setPanelOpen(false), [conversationId]);

  return (
    <div className="flex h-full min-h-0 bg-background">
      <ConversationList
        selectedId={conversationId}
        onNewConversation={() => setCreating(true)}
        className={cn(
          "w-full shrink-0 border-r border-border lg:w-80 xl:w-96",
          // Tela estreita: com conversa aberta, a lista dá lugar a ela.
          conversationId ? "hidden lg:flex" : "flex",
        )}
      />

      {conversationId ? (
        <ConversationView
          key={conversationId}
          conversationId={conversationId}
          panelOpen={panelOpen}
          onOpenPanel={() => setPanelOpen(true)}
          onClosePanel={() => setPanelOpen(false)}
          onBack={() => navigate("/app/atendimento")}
        />
      ) : (
        <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-muted/30 text-center text-muted-foreground lg:flex">
          <MessageSquare className="size-10" aria-hidden />
          <p className="text-sm">Escolha uma conversa na lista para começar.</p>
        </div>
      )}

      <NewConversationDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

type ConversationViewProps = {
  conversationId: string;
  panelOpen: boolean;
  onOpenPanel: () => void;
  onClosePanel: () => void;
  onBack: () => void;
};

function ConversationView({
  conversationId,
  panelOpen,
  onOpenPanel,
  onClosePanel,
  onBack,
}: ConversationViewProps) {
  const can = useCan();
  const query = useConversation(conversationId);
  const [sending, setSending] = useState<SendingMessage[]>([]);
  const detail = query.data;
  const unread = detail?.conversation.unreadCount ?? 0;

  const sendStart = useCallback(
    (item: SendingMessage) => setSending((current) => [...current, item]),
    [],
  );
  const sendEnd = useCallback(
    (clientId: string) => setSending((current) => current.filter((item) => item.clientId !== clientId)),
    [],
  );

  // Abrir a conversa zera as não lidas (e a que chega com ela aberta). Falha (somente leitura,
  // sessão de suporte) é silenciosa e não repete para o mesmo valor.
  const read = useInboxMutation({ silent: true, conversationId, messages: false });
  const lastRead = useRef<string | null>(null);
  const { mutate: markRead } = read;
  useEffect(() => {
    if (unread === 0) {
      lastRead.current = null;
      return;
    }
    const marker = `${conversationId}:${unread}`;
    if (lastRead.current === marker) return;
    lastRead.current = marker;
    markRead({ path: `/api/inbox/conversations/${conversationId}/read`, method: "POST" });
  }, [conversationId, unread, markRead]);

  // Só o erro sem dados troca a tela: uma releitura que falha no polling mantém o que já está aberto.
  if (query.isError && !detail) {
    const missing = query.error instanceof ApiError && query.error.status === 404;

    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className={missing ? "text-foreground" : "text-destructive"}>
          {missing ? "Conversa não encontrada." : query.error.message}
        </p>
        <div className="flex gap-3">
          {missing ? null : (
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="font-medium text-primary hover:underline"
            >
              Tentar novamente
            </button>
          )}
          <Link to="/app/atendimento" className="font-medium text-primary hover:underline">
            Voltar ao atendimento
          </Link>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="min-w-0 flex-1 p-4">
        <QueryState {...query}>{null}</QueryState>
      </div>
    );
  }

  return (
    <>
      <section
        className={cn(
          "min-w-0 flex-1 flex-col",
          // Abaixo de xl o painel toma o lugar da conversa.
          panelOpen ? "hidden xl:flex" : "flex",
        )}
        aria-label="Conversa"
      >
        <ConversationHeader detail={detail} onBack={onBack} onOpenPanel={onOpenPanel} />
        <MessageThread
          conversationId={conversationId}
          canReply={can("inbox", "reply")}
          sending={sending}
        />
        <Composer
          conversationId={conversationId}
          detail={detail}
          onSendStart={sendStart}
          onSendEnd={sendEnd}
        />
      </section>

      <div
        className={cn(
          "min-h-0 w-full shrink-0 border-l border-border lg:w-80 xl:flex",
          panelOpen ? "flex" : "hidden",
        )}
      >
        <ContactPanel detail={detail} onBack={onClosePanel} />
      </div>
    </>
  );
}
