import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChannelBadge } from "@/components/channels/channel-badge";
import { formatListTime } from "@/components/inbox/format";
import { useRelatedConversations } from "@/components/inbox/inbox-api";
import { CONVERSATION_STATUS_LABELS } from "@/components/inbox/labels";
import { useInboxPath } from "@/components/inbox/use-inbox-path";
import { Badge } from "@/components/ui/badge";

type RelatedConversationsProps = {
  conversationId: string;
  /**
   * Lugar da ação "Continuar por outro número" (X2, `continue-on-channel.tsx`): entra abaixo da lista.
   * A seção só existe quando há outra conversa visível do contato; a outra entrada da ação é a faixa
   * "Janela de 24 horas encerrada" do composer.
   */
  footer?: ReactNode;
};

/**
 * "Também neste contato": as outras conversas do mesmo contato, em outros números, com o selo do
 * número, a situação e a data; clicar abre a conversa. A lista vem do servidor já filtrada pela
 * visibilidade da pessoa (`GET .../conversations/:id/related`): o que ela não vê não aparece nem
 * entra na conta. Sem nenhuma outra conversa, a seção nem é desenhada. Serve aos dois escopos.
 */
export function RelatedConversations({ conversationId, footer }: RelatedConversationsProps) {
  const related = useRelatedConversations(conversationId);
  const pathOf = useInboxPath();
  const items = related.data ?? [];

  // Carregando, erro e vazio somem em silêncio: é um complemento, não a tela.
  if (items.length === 0) return null;

  return (
    <section className="space-y-2" aria-labelledby="related-conversations-title">
      <h3 id="related-conversations-title" className="text-sm font-semibold">
        Também neste contato
      </h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((item) => {
          const at = item.lastMessageAt ?? item.createdAt;

          return (
            <li key={item.id}>
              <Link
                to={pathOf(item.id)}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <ChannelBadge type={item.channel.type} name={item.channel.name} className="min-w-0 flex-1" />
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant={item.status === "open" ? "outline" : "secondary"}>
                    {CONVERSATION_STATUS_LABELS[item.status]}
                  </Badge>
                  <time dateTime={at}>{formatListTime(at)}</time>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {footer}
    </section>
  );
}
