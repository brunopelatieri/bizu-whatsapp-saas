import { decodeBase64Media, downloadMedia } from "@/lib/channels/media";
import { asRecord, type JsonRecord, pickRecord, pickString } from "@/lib/channels/payload";
import type { EvolutionConfig } from "@/lib/channels/providers/whatsapp_qr/client";
import { isEncryptedWhatsappUrl, MEDIA_KEYS } from "@/lib/channels/providers/whatsapp_qr/normalize";
import { isAllowedMediaUrl } from "@/lib/channels/providers/whatsapp_qr/webhook";
import type { ResolvedInboundMedia, StoreInboundMedia } from "@/lib/channels/types";

/**
 * Mídia do aviso da Evolution. Dois caminhos, os dois terminam em `{ storageKey, mime, size }`
 * no lugar onde o `normalize.ts` procura o conteúdo:
 *
 * - **base64** (padrão): sai do aviso no webhook, antes de o `raw` ser gravado.
 * - **`mediaUrl`** (servidor Evolution gravando em S3): baixada pelo job, só de origem listada
 *   em `EVOLUTION_MEDIA_ORIGINS`.
 */

/** Nome real da chave no objeto, ignorando a caixa (o aviso mistura três grafias). */
function keyOf(obj: JsonRecord, name: string) {
  if (name in obj) return name;

  return Object.keys(obj).find((key) => key.toLowerCase() === name.toLowerCase()) ?? null;
}

function mediaProto(message: JsonRecord | null) {
  for (const [key] of MEDIA_KEYS) {
    const proto = pickRecord(message, key);
    if (proto) return proto;
  }
  return null;
}

/**
 * Troca cada base64 por `{ storageKey, mime, size }`. O base64 pode ser irmão do proto dentro
 * de `Message`, estar dentro do proto ou em `data.base64`. Conteúdo que não decodifica ou passa
 * do teto é descartado (`null`): em nenhum caso o texto base64 fica no `raw`.
 */
export async function externalizeEvolutionMedia(raw: unknown, store: StoreInboundMedia) {
  const data = pickRecord(asRecord(raw), "data");
  const message = pickRecord(data, "Message");
  const proto = mediaProto(message);
  const mime = pickString(proto, "mimetype", "mimeType");

  for (const holder of [proto, message, data]) {
    if (!holder) continue;

    const key = keyOf(holder, "base64");
    if (!key || typeof holder[key] !== "string") continue;

    const body = decodeBase64Media(holder[key] as string);
    holder[key] = body ? await store(body, mime) : null;
  }

  return raw;
}

/** Endereço em claro que o aviso traz, quando não há conteúdo embutido nem já gravado. */
function plainMediaUrl(message: JsonRecord | null, data: JsonRecord | null) {
  const proto = mediaProto(message);
  if (!proto) return null;

  for (const holder of [proto, message, data]) {
    const key = holder ? keyOf(holder, "base64") : null;
    // Conteúdo já gravado no armazenamento: não há o que baixar.
    if (holder && key && holder[key] != null) return null;
  }

  const plain = pickString(proto, "mediaUrl", "fileUrl");
  if (plain && !isEncryptedWhatsappUrl(plain)) return plain;

  const cdn = pickString(proto, "URL", "url");
  return cdn && !isEncryptedWhatsappUrl(cdn) ? cdn : null;
}

/**
 * A URL vem de um aviso e nunca é confiável (SSRF): só é baixada se a origem dela estiver em
 * `EVOLUTION_MEDIA_ORIGINS`. Fora da lista (ou com a lista vazia), o aviso é `ignored`.
 */
export async function resolveEvolutionMedia(
  config: Pick<EvolutionConfig, "mediaOrigins" | "mediaTimeoutMs" | "fetchFn">,
  raw: unknown,
  store: StoreInboundMedia,
): Promise<ResolvedInboundMedia> {
  const copy = structuredClone(raw);
  const data = pickRecord(asRecord(copy), "data");
  const message = pickRecord(data, "Message");
  const url = plainMediaUrl(message, data);

  if (!url || !message) return { outcome: "unchanged" };

  if (!isAllowedMediaUrl(url, config.mediaOrigins)) {
    return { outcome: "ignored", reason: "origem da mídia fora da lista permitida" };
  }

  const downloaded = await downloadMedia(url, {
    timeoutMs: config.mediaTimeoutMs,
    fetchFn: config.fetchFn,
  });
  const mime = pickString(mediaProto(message), "mimetype", "mimeType") ?? downloaded.mime;

  // Mesmo lugar e mesmo formato do caminho base64: o `normalize.ts` lê um só.
  message[keyOf(message, "base64") ?? "base64"] = await store(downloaded.body, mime);
  return { outcome: "stored", raw: copy };
}
