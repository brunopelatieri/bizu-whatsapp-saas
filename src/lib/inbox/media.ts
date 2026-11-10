import { and, eq, TransactionRollbackError } from "drizzle-orm";
import { type Scope, scopeTenantId, type Tx, withScope } from "@/db/rls";
import { channel, file, message } from "@/db/schema";
import { getBoss } from "@/jobs/boss";
import { type InboxMediaJob, QUEUE } from "@/jobs/queues";
import {
  ChannelNotConfiguredError,
  PermanentEventError,
  ProviderError,
} from "@/lib/channels/errors";
import { logChannelError } from "@/lib/channels/log";
import { isStoredMedia, MAX_INBOUND_MEDIA_BYTES, safeMime } from "@/lib/channels/media";
import { findProvider } from "@/lib/channels/registry";
import { contextFor } from "@/lib/channels/service";
import type { NormalizedMedia } from "@/lib/channels/types";
import { sanitizeFileName } from "@/lib/files/types";
import { MAX_OUTBOUND_MEDIA_BYTES, OUTBOUND_MIME, type OutboundKind } from "@/lib/inbox/constants";
import { notifyInbox } from "@/lib/inbox/notify";
import { getStorage, newStorageKey } from "@/lib/storage";

/**
 * Mídia da caixa de entrada: **entrada** (C1) e a lista de tipos do **envio** (C5, `classifyOutbound`).
 * O token assinado da Evolution está em `media-out.ts`.
 *
 * - Evolution: o conteúdo já está no `StorageProvider` (o webhook ou o `channel.inbound` o
 *   gravou sob `inbound/`); a ingestão só cria a linha de `file` (`storedMediaFile`).
 * - Cloud: a mensagem nasce `media_status = pending` com `provider_media_id`, e o job
 *   `inbox.media` baixa pelo provedor, confere tamanho e tipo **pelo conteúdo** e grava.
 */

export type MessageRow = typeof message.$inferSelect;

/** O que a ingestão guarda em `message.payload.media` para o job dar nome ao arquivo. */
export type PendingMediaInfo = { filename: string | null; mime: string | null };

const DEFAULT_NAMES: Record<NormalizedMedia["kind"], string> = {
  image: "imagem",
  video: "video",
  audio: "audio",
  document: "documento",
  sticker: "figurinha",
};

export function mediaFileName(kind: NormalizedMedia["kind"], filename: string | null) {
  return sanitizeFileName(filename ?? DEFAULT_NAMES[kind]);
}

// ---------------------------------------------------------------------------
// Tipo pelo conteúdo
// ---------------------------------------------------------------------------

const OFFICE_ZIP = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const OFFICE_OLE = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
]);
const PLAIN_TEXT = new Set(["text/plain", "text/csv"]);
/** Marcas `ftyp` de imagem HEIF (fotos de iPhone): não são vídeo. */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);

const at = (bytes: Buffer, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Buffer, start: number, end: number) =>
  bytes.subarray(start, end).toString("latin1");

/** Tipo reconhecido pela assinatura dos primeiros bytes; `null` quando não há assinatura. */
export function sniffMime(bytes: Buffer): string | null {
  if (at(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF") {
    const kind = ascii(bytes, 8, 12);
    if (kind === "WEBP") return "image/webp";
    if (kind === "WAVE") return "audio/wav";
  }
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand.startsWith("3gp")) return "video/3gpp";
    if (brand.startsWith("M4A") || brand.startsWith("M4B")) return "audio/mp4";
    if (HEIF_BRANDS.has(brand)) return "image/heic";
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (at(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 5) === "#!AMR") return "audio/amr";
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf0) === 0xf0) {
    // Cabeçalho ADTS (camada 0) é AAC; os demais quadros sincronizados são MPEG.
    return ((bytes[1] ?? 0) & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  }
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "%PDF") return "application/pdf";
  if (at(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (at(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "application/x-ole-storage";
  return null;
}

/**
 * O tipo gravado no `file`: o do conteúdo, nunca só o que o provedor diz. O declarado só refina
 * quando o conteúdo confirma a família (documento do Office dentro de ZIP ou OLE; áudio MP4;
 * texto sem bytes nulos). O resto vira `application/octet-stream` e é servido como anexo.
 */
export function inboundMime(body: Buffer, declared: string | null | undefined): string {
  const sniffed = sniffMime(body);
  const claimed = safeMime(declared);

  if (sniffed === "application/zip") return claimed && OFFICE_ZIP.has(claimed) ? claimed : sniffed;
  if (sniffed === "application/x-ole-storage") {
    return claimed && OFFICE_OLE.has(claimed) ? claimed : "application/octet-stream";
  }
  if (sniffed === "video/mp4" && claimed === "audio/mp4") return claimed;
  if (sniffed) return sniffed;
  if (claimed && PLAIN_TEXT.has(claimed) && !body.subarray(0, 1024).includes(0)) return claimed;
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Anexo de saída (C5)
// ---------------------------------------------------------------------------

// A lista e o teto moram em `constants.ts` (código puro, a tela os lê para o `accept` do seletor).
export { MAX_OUTBOUND_MEDIA_BYTES, OUTBOUND_MIME, type OutboundKind };

/** Pasta que todo arquivo OOXML tem dentro do ZIP: um ZIP qualquer com nome de `.docx` não passa. */
const OOXML_FOLDER: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word/",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xl/",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ppt/",
};

/**
 * O tipo do anexo **pelo conteúdo** (`inboundMime`: o declarado só refina quando o conteúdo confirma a
 * família), e o tipo de mensagem. `null` = fora da lista (415). O que o navegador declarou nunca decide.
 */
export function classifyOutbound(
  body: Buffer,
  declared: string | null | undefined,
): { mime: string; kind: OutboundKind } | null {
  const mime = inboundMime(body, declared);
  const kind = OUTBOUND_MIME[mime];
  if (!kind) return null;

  const folder = OOXML_FOLDER[mime];
  if (folder && !body.includes(folder, 0, "latin1")) return null;

  return { mime, kind };
}

// ---------------------------------------------------------------------------
// Evolution: o objeto já está gravado
// ---------------------------------------------------------------------------

/**
 * Linha de `file` para a mídia que já está no armazenamento (`inbound/<chave>`). A chave vem do
 * aviso, então é conferida (`isStoredMedia`: prefixo e formato) antes de virar referência. O
 * tipo é o que o webhook gravou (`safeMime`); a rota que servir (C2) confere pelo conteúdo.
 */
export async function storedMediaFile(
  tx: Tx,
  scope: Scope,
  messageId: string,
  media: NormalizedMedia,
) {
  const stored = media.storage;
  if (!stored || !isStoredMedia(stored)) return null;

  const [created] = await tx
    .insert(file)
    .values({
      tenantId: scopeTenantId(scope),
      ownerType: "message",
      ownerId: messageId,
      key: stored.storageKey,
      name: mediaFileName(media.kind, media.filename),
      size: stored.size,
      mime: safeMime(stored.mime ?? media.mime) ?? "application/octet-stream",
      provider: getStorage().id,
    })
    .returning({ id: file.id });

  return created ?? null;
}

// ---------------------------------------------------------------------------
// Cloud: job `inbox.media`
// ---------------------------------------------------------------------------

type Enqueue = (job: InboxMediaJob) => Promise<void>;

const enqueueWithBoss: Enqueue = async (job) => {
  const boss = await getBoss();
  // `exclusive`: um job vivo por mensagem.
  await boss.send(QUEUE.inboxMedia, job, { singletonKey: job.messageId });
};

let enqueue: Enqueue = enqueueWithBoss;

export const enqueueInboxMedia: Enqueue = (job) => enqueue(job);

/** Sem pg-boss nos testes de fluxo: eles chamam o job direto. `undefined` restaura. */
export function setInboxMediaQueueForTests(next: Enqueue | undefined) {
  enqueue = next ?? enqueueWithBoss;
}

const scopeOfJob = (job: InboxMediaJob): Scope =>
  job.tenantId ? { kind: "tenant", tenantId: job.tenantId } : { kind: "platform" };

/** Falha que repetir não resolve: mídia vencida, recusada, vazia ou grande demais. */
function isPermanent(error: unknown) {
  return (
    error instanceof PermanentEventError || (error instanceof ProviderError && error.isRejection)
  );
}

async function markFailed(scope: Scope, messageId: string) {
  await withScope(scope, async (tx) => {
    const [row] = await tx
      .update(message)
      .set({ mediaStatus: "failed" })
      .where(and(eq(message.id, messageId), eq(message.mediaStatus, "pending")))
      .returning({ id: message.id, conversationId: message.conversationId });

    if (row) {
      await notifyInbox(tx, { s: scopeTenantId(scope), c: row.conversationId, k: "message", m: row.id });
    }
  });
}

export type InboxMediaOutcome = "ready" | "failed" | "skipped";

/**
 * Baixa a mídia de uma mensagem `pending`. Falar com o provedor e gravar o objeto vêm antes da
 * transação local; se a mensagem deixou de estar `pending` enquanto baixávamos, o objeto é
 * apagado. Falha comum lança (o pg-boss repete); a definitiva, ou a última tentativa, marca
 * `failed`. Nada da mensagem vai a log.
 */
export async function processInboxMedia(
  job: InboxMediaJob,
  options: { lastAttempt?: boolean } = {},
): Promise<InboxMediaOutcome> {
  const scope = scopeOfJob(job);
  let storedKey: string | null = null;

  try {
    // Dentro do `try`: falha ao carregar (banco, credencial) também conta para a última tentativa.
    const loaded = await withScope(scope, async (tx) => {
      const [row] = await tx.select().from(message).where(eq(message.id, job.messageId));
      if (row?.mediaStatus !== "pending" || !row.providerMediaId) return null;

      const [target] = await tx.select().from(channel).where(eq(channel.id, row.channelId));
      if (!target) return null;

      return { row, target, ctx: await contextFor(tx, target) };
    });
    if (!loaded) return "skipped";

    const { row, target, ctx } = loaded;
    // Módulo fora de `CHANNEL_PROVIDERS` é configuração: repete, e só a última tentativa desiste.
    const provider = findProvider(target.type);
    if (!provider) throw new ChannelNotConfiguredError(target.type);
    if (!provider.fetchMedia) throw new PermanentEventError("O canal não baixa mídia.");

    const { body, mime: declared } = await provider.fetchMedia(ctx, row.providerMediaId as string);
    if (body.byteLength === 0) throw new PermanentEventError("Mídia vazia.");
    if (body.byteLength > MAX_INBOUND_MEDIA_BYTES) {
      throw new PermanentEventError("Mídia acima do tamanho permitido.");
    }

    const info = (row.payload?.media ?? {}) as Partial<PendingMediaInfo>;
    const mime = inboundMime(body, declared ?? info.mime);
    const storage = getStorage();
    const key = newStorageKey(`inbox/${job.tenantId ?? "platform"}`);
    await storage.put(key, body, { contentType: mime });
    storedKey = key;

    const kind = (row.type in DEFAULT_NAMES ? row.type : "document") as NormalizedMedia["kind"];
    const saved = await withScope(scope, async (tx) => {
      const [created] = await tx
        .insert(file)
        .values({
          tenantId: scopeTenantId(scope),
          ownerType: "message",
          ownerId: row.id,
          key,
          name: mediaFileName(kind, info.filename ?? null),
          size: body.byteLength,
          mime,
          provider: storage.id,
        })
        .returning({ id: file.id });
      if (!created) throw new Error("Arquivo não gravado.");

      const updated = await tx
        .update(message)
        .set({ fileId: created.id, mediaStatus: "ready" })
        .where(and(eq(message.id, row.id), eq(message.mediaStatus, "pending")))
        .returning({ id: message.id });
      // Outro job terminou antes: desfaz o `file` e apaga o objeto abaixo.
      if (updated.length === 0) {
        tx.rollback();
      }

      await notifyInbox(tx, { s: scopeTenantId(scope), c: row.conversationId, k: "message", m: row.id });
      return true;
    }).catch((error: unknown) => {
      if (error instanceof TransactionRollbackError) return false;
      throw error;
    });

    if (!saved) {
      await storage.delete(key).catch((error) => logChannelError("Falha ao apagar mídia repetida", error));
      return "skipped";
    }
    return "ready";
  } catch (error) {
    if (storedKey) {
      await getStorage()
        .delete(storedKey)
        .catch((cleanup) => logChannelError("Falha ao apagar mídia órfã", cleanup));
    }

    const permanent = isPermanent(error);
    if (permanent || options.lastAttempt) {
      await markFailed(scope, job.messageId);
      logChannelError("Mídia de mensagem não baixada", error);
      return "failed";
    }
    throw error;
  }
}
