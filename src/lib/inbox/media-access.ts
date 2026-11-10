import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { scopeTenantId, withScope } from "@/db/rls";
import { conversation, file, message } from "@/db/schema";
import { logChannelError } from "@/lib/channels/log";
import { findVisibleMessage } from "@/lib/inbox/conversations";
import { enqueueInboxMedia, inboundMime } from "@/lib/inbox/media";
import { notifyInbox } from "@/lib/inbox/notify";
import { type InboxActor, visibleConversation } from "@/lib/inbox/visibility";
import { getStorage } from "@/lib/storage";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Mídia recebida servida à tela (SPEC, "Contratos" e "Segurança"). Nunca por URL pública do
 * armazenamento: a rota confere a visibilidade da conversa da mensagem. O tipo servido é o do
 * **conteúdo** (os primeiros bytes), não o gravado: a mídia da Evolution traz o tipo que o
 * remetente declarou (pendência da C1). `inline` só para a lista segura de imagem, áudio e vídeo;
 * o resto vai como anexo, sempre com `nosniff`.
 */

const MEDIA_NOT_FOUND = "Mídia não encontrada.";

/** Tipos que o navegador mostra sem executar nada. SVG e HTML nunca entram. */
export const INLINE_SAFE_MIME: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "audio/wav",
  "video/mp4",
  "video/3gpp",
  "video/webm",
  "video/quicktime",
]);

/** Bytes que a conferência pelo conteúdo lê (as assinaturas de `sniffMime` cabem com folga). */
const SNIFF_BYTES = 4096;

/** Lê o começo do fluxo e devolve um fluxo novo com tudo, do primeiro byte. */
async function peek(stream: Readable, bytes: number) {
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  const chunks: Buffer[] = [];
  let size = 0;

  while (size < bytes) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    chunks.push(chunk);
    size += chunk.length;
  }

  const head = Buffer.concat(chunks);
  async function* all() {
    yield head;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield Buffer.from(next.value);
    }
  }

  return { head, body: Readable.from(all(), { objectMode: false }) };
}

export type ServedMedia = {
  name: string;
  size: number;
  mime: string;
  inline: boolean;
  body: Readable;
};

export async function openMessageMedia(actor: InboxActor, messageId: string): Promise<ServedMedia> {
  const [found] = await withScope(actor.scope, (tx) =>
    tx
      .select({ key: file.key, name: file.name, mime: file.mime, size: file.size })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .innerJoin(file, eq(file.id, message.fileId))
      .where(
        and(
          eq(message.id, messageId),
          visibleConversation(actor),
          // O arquivo é o da própria mensagem: um `file_id` trocado não serve arquivo alheio.
          eq(file.ownerType, "message"),
          eq(file.ownerId, message.id),
        ),
      ),
  );
  if (!found) throw notFound(MEDIA_NOT_FOUND);

  const stream = await getStorage().get(found.key);
  if (!stream) {
    logChannelError("Mídia de mensagem ausente no armazenamento", new Error("objeto não encontrado"));
    throw notFound(MEDIA_NOT_FOUND);
  }

  const { head, body } = await peek(stream, SNIFF_BYTES);
  const mime = inboundMime(head, found.mime);

  return { name: found.name, size: found.size, mime, inline: INLINE_SAFE_MIME.has(mime), body };
}

/**
 * "Tentar de novo" na mídia que não baixou (ou que ficou `pending` porque enfileirar falhou, C1):
 * volta a `pending` e enfileira `inbox.media`. Só mídia que o provedor ainda pode entregar
 * (`provider_media_id`); a da Evolution já chega gravada ou falha na chegada.
 */
export async function retryMessageMedia(actor: InboxActor, messageId: string) {
  const job = await withScope(actor.scope, async (tx) => {
    const row = await findVisibleMessage(tx, actor, messageId);
    if (!row) throw notFound("Mensagem não encontrada.");

    const retryable =
      row.providerMediaId !== null && (row.mediaStatus === "failed" || row.mediaStatus === "pending");
    if (!retryable) {
      throw new TenantRuleError(
        409,
        "MEDIA_NOT_RETRYABLE",
        "Esta mídia não pode ser baixada de novo.",
      );
    }

    if (row.mediaStatus === "failed") {
      await tx.update(message).set({ mediaStatus: "pending" }).where(eq(message.id, row.id));
      await notifyInbox(tx, {
        s: scopeTenantId(actor.scope),
        c: row.conversationId,
        k: "message",
        m: row.id,
      });
    }
    return { messageId: row.id, tenantId: scopeTenantId(actor.scope) };
  });

  // Depois do commit: o job lê a mensagem já `pending`. `exclusive` evita dois jobs vivos.
  await enqueueInboxMedia(job);
}
