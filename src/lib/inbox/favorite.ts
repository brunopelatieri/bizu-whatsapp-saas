import { and, eq, ne, sql } from "drizzle-orm";
import { scopeTenantId, withScope } from "@/db/rls";
import { message } from "@/db/schema";
import { auditInbox } from "@/lib/inbox/assignment";
import {
  findVisibleMessage,
  messageView,
  permissionDenied,
} from "@/lib/inbox/conversations";
import { notifyInbox } from "@/lib/inbox/notify";
import type { InboxActor } from "@/lib/inbox/visibility";
import { notFound } from "@/lib/tenant/errors";

/**
 * Estrela da mensagem (SPEC pré-produção, bloco R, fase R3a). A estrela é **da conversa**, não da
 * pessoa: quem tem acesso à conversa vê a mesma marca. Favoritar grava os três campos juntos
 * (`is_favorite`, `favorited_at`, `favorited_by`); desfavoritar zera os três (o `CHECK
 * message_favorite_stamp` exige). A favorita é a que a limpeza de retenção (R2) poupa.
 *
 * O teto de favoritas do escopo **não** recusa aqui: quem rebaixa a favorita acima do teto é a
 * limpeza, no ciclo seguinte. Mensagem de conversa fora do alcance de quem pede responde 404,
 * igual a id inexistente (`findVisibleMessage` aplica `visibleConversation`).
 */
export async function setMessageFavorite(actor: InboxActor, messageId: string, favorite: boolean) {
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    const found = await findVisibleMessage(tx, actor, messageId);
    if (!found) throw notFound("Mensagem não encontrada.");

    // O `WHERE is_favorite <> alvo` torna o pedido idempotente e atômico: repetir não troca quem
    // marcou nem a data, e dois pedidos ao mesmo tempo gravam uma vez só (auditoria e aviso também).
    const [changed] = await tx
      .update(message)
      .set(
        favorite
          ? { isFavorite: true, favoritedAt: sql`now()`, favoritedBy: actor.userId }
          : { isFavorite: false, favoritedAt: null, favoritedBy: null },
      )
      .where(and(eq(message.id, messageId), ne(message.isFavorite, favorite)))
      .returning({ id: message.id });

    if (changed) {
      await auditInbox(
        tx,
        actor,
        favorite ? "inbox.message_favorited" : "inbox.message_unfavorited",
        { type: "message", id: messageId },
        { conversationId: found.conversationId },
      );
      // `status` relê só as mensagens da conversa (a lista e o detalhe não mudam com a estrela).
      await notifyInbox(tx, {
        s: scopeTenantId(actor.scope),
        c: found.conversationId,
        k: "status",
        m: messageId,
      });
    }

    return messageView(tx, actor.scope, messageId);
  });
}
