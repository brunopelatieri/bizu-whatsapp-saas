import { scopeTenantId, withScope } from "@/db/rls";
import { logChannelError } from "@/lib/channels/log";
import { assertStorageAvailable } from "@/lib/files";
import { sanitizeFileName } from "@/lib/files/types";
import { permissionDenied } from "@/lib/inbox/conversations";
import { classifyOutbound, MAX_OUTBOUND_MEDIA_BYTES } from "@/lib/inbox/media";
import { dispatch, queueMessage, type SendOutcome } from "@/lib/inbox/send";
import type { InboxActor } from "@/lib/inbox/visibility";
import type { SendMediaFormInput } from "@/lib/schemas/inbox";
import { getStorage, newStorageKey } from "@/lib/storage";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * Anexo de saída (SPEC, "Envio"): `multipart/form-data` com `file`, `caption?`, `clientId`.
 *
 * Ordem, para que a recusa nunca grave nada: permissão, tamanho, tipo **pelo conteúdo** (o que o
 * navegador declarou não decide) e cota do plano, tudo antes de tocar o armazenamento. Só então o objeto
 * é gravado, e a linha de `file` nasce na transação da mensagem (`queueMessage`). Se essa transação
 * recusar (janela de 24 h, número desconectado, citação inválida) ou o `clientId` já existir, o objeto é
 * apagado: não sobra arquivo sem mensagem.
 */

export type UploadedFile = { name: string; declaredMime: string | null; body: Buffer };

async function discard(key: string) {
  await getStorage()
    .delete(key)
    .catch((error) => logChannelError("Falha ao apagar anexo não usado", error));
}

export async function sendMedia(
  actor: InboxActor,
  conversationId: string,
  upload: UploadedFile,
  input: SendMediaFormInput,
): Promise<SendOutcome> {
  if (!actor.can.reply) throw permissionDenied();

  const size = upload.body.byteLength;
  if (size === 0) throw new TenantRuleError(400, "FILE_REQUIRED", "O arquivo está vazio.");
  if (size > MAX_OUTBOUND_MEDIA_BYTES) {
    throw new TenantRuleError(413, "FILE_TOO_LARGE", "Arquivo grande demais. O máximo é 16 MB.");
  }

  const detected = classifyOutbound(upload.body, upload.declaredMime);
  if (!detected) {
    throw new TenantRuleError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Tipo de arquivo não suportado. Envie imagem (JPEG, PNG, WebP), vídeo (MP4, 3GP), áudio (OGG, MP3, M4A, AAC, AMR), PDF ou documento do Office.",
    );
  }
  // O WhatsApp não aceita legenda em áudio.
  if (detected.kind === "audio" && input.caption) {
    throw new TenantRuleError(400, "CAPTION_NOT_ALLOWED", "Áudio não aceita legenda.");
  }

  const tenantId = scopeTenantId(actor.scope);
  if (tenantId) await assertStorageAvailable(tenantId, size);

  const name = sanitizeFileName(upload.name);
  const key = newStorageKey(`inbox/${tenantId ?? "platform"}`);
  await getStorage().put(key, upload.body, { contentType: detected.mime });

  let prepared: Awaited<ReturnType<typeof queueMessage>>;
  try {
    prepared = await withScope(actor.scope, (tx) =>
      queueMessage(tx, actor, conversationId, {
        clientId: input.clientId,
        replyTo: input.replyTo,
        requiresWindow: true,
        build: () => ({
          type: detected.kind,
          text: input.caption ?? null,
          newFile: { key, name, size, mime: detected.mime },
          delivery: (fileId) => ({
            kind: "media",
            mediaKind: detected.kind,
            fileId: fileId as string,
            key,
            name,
            mime: detected.mime,
            caption: input.caption ?? null,
          }),
        }),
      }),
    );
  } catch (error) {
    await discard(key);
    throw error;
  }

  // `clientId` repetido: a mensagem original já tem o arquivo dela; este objeto não é de ninguém.
  if (!prepared.created) await discard(key);

  return dispatch(actor, prepared);
}
