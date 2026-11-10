import { eq } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { conversation } from "@/db/schema";

/**
 * `true` quando há conversa no canal. O serviço de canais (`channelHasConversations`) usa para
 * decidir entre apagar o canal e desativá-lo: `conversation.channel_id` é `restrict`, e o
 * histórico não se perde ao remover um número.
 */
export async function channelHasConversations(tx: Tx, channelId: string) {
  const [row] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.channelId, channelId))
    .limit(1);

  return Boolean(row);
}
