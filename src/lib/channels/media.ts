import { PermanentEventError } from "@/lib/channels/errors";
import { logChannelError } from "@/lib/channels/log";
import { asRecord } from "@/lib/channels/payload";
import type { StoredMedia, StoreInboundMedia } from "@/lib/channels/types";
import { getStorage, newStorageKey } from "@/lib/storage";
import { isSafeKey } from "@/lib/storage/keys";

/**
 * Mídia que chega em aviso de provedor (`docs/specs/whatsapp-canais/spec.md`, "Mídia no aviso
 * da Evolution"). O conteúdo vai para o `StorageProvider` sob `inbound/<chave aleatória>` e o
 * `channel_event.raw` guarda só `{ storageKey, mime, size }`: nunca base64.
 *
 * A chave é sempre gerada aqui. Nada do aviso (nome de arquivo, id, telefone) entra nela.
 */

export const INBOUND_PREFIX = "inbound";

/** Teto de uma mídia de entrada, igual ao do corpo do webhook: vale para base64 e `mediaUrl`. */
export const MAX_INBOUND_MEDIA_BYTES = 25 * 1024 * 1024;

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Tipos que o navegador executa se forem servidos como vieram: viram download genérico. */
const ACTIVE_MIME = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|(text|application)\/(x-)?(java|ecma)script)$/;

/**
 * Só `tipo/subtipo`, sem parâmetros: o valor vem de quem mandou a mensagem e vira `Content-Type`
 * do objeto. HTML, SVG, XML e script viram `application/octet-stream`, para a tela que um dia
 * servir o objeto não entregar conteúdo ativo de terceiros (XSS armazenado).
 */
export function safeMime(value: string | null | undefined) {
  const mime = value?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (!MIME.test(mime) || mime.length > 100) return null;
  return ACTIVE_MIME.test(mime) ? "application/octet-stream" : mime;
}

export const storeInboundMedia: StoreInboundMedia = async (body, mime) => {
  const storageKey = newStorageKey(INBOUND_PREFIX);
  const contentType = safeMime(mime);

  await getStorage().put(storageKey, body, contentType ? { contentType } : undefined);
  return { storageKey, mime: contentType, size: body.byteLength };
};

/** `true` para a referência que `storeInboundMedia` devolve (e só para chave sob `inbound/`). */
export function isStoredMedia(value: unknown): value is StoredMedia {
  const record = asRecord(value);
  const key = record?.storageKey;

  return (
    typeof key === "string" &&
    key.startsWith(`${INBOUND_PREFIX}/`) &&
    isSafeKey(key) &&
    typeof record?.size === "number"
  );
}

/** Todas as referências de mídia dentro de um `raw`, em qualquer profundidade. */
export function collectStorageKeys(raw: unknown, found: string[] = [], depth = 0): string[] {
  if (depth > 12 || !raw || typeof raw !== "object") return found;

  if (isStoredMedia(raw)) {
    found.push(raw.storageKey);
    return found;
  }

  for (const value of Array.isArray(raw) ? raw : Object.values(raw)) {
    collectStorageKeys(value, found, depth + 1);
  }
  return found;
}

/**
 * Apaga os objetos de um aviso que terminou `ignored` ou `failed` definitivo (ou que era
 * repetido). Falha ao apagar não derruba quem chama: vai ao log e o objeto fica órfão.
 */
export async function deleteInboundMedia(raw: unknown) {
  for (const key of collectStorageKeys(raw)) {
    try {
      await getStorage().delete(key);
    } catch (error) {
      logChannelError("Falha ao apagar mídia de aviso descartado", error);
    }
  }
}

/** Decodifica base64 (com ou sem prefixo `data:`). `null` se vazio ou acima do teto. */
export function decodeBase64Media(value: string, maxBytes = MAX_INBOUND_MEDIA_BYTES) {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const text = comma >= 0 ? value.slice(comma + 1) : value;

  // Tamanho estimado antes de alocar: 4 caracteres viram 3 bytes.
  if (text.length === 0 || (text.length / 4) * 3 > maxBytes + 3) return null;

  const body = Buffer.from(text, "base64");
  return body.byteLength > 0 && body.byteLength <= maxBytes ? body : null;
}

export type DownloadOptions = {
  timeoutMs: number;
  maxBytes?: number;
  fetchFn?: typeof fetch;
};

/**
 * Baixa uma mídia de endereço **já conferido** contra a lista de origens (quem chama confere).
 * Não segue redirecionamento (um 302 levaria a outra origem), respeita o timeout e corta no
 * teto de tamanho sem carregar o resto. 403 e 404 são definitivos: endereço vencido ou sem
 * acesso. Qualquer outra falha lança erro comum, e o job tenta de novo.
 */
export async function downloadMedia(url: string, options: DownloadOptions) {
  const maxBytes = options.maxBytes ?? MAX_INBOUND_MEDIA_BYTES;
  let response: Response;

  try {
    response = await (options.fetchFn ?? fetch)(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    // Sem a mensagem original: ela traz o endereço, que pode ter assinatura na query.
    throw new Error("O endereço da mídia não respondeu.");
  }

  if (response.status === 403 || response.status === 404) {
    throw new PermanentEventError(`Mídia indisponível no endereço informado (HTTP ${response.status}).`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new PermanentEventError("O endereço da mídia redirecionou; redirecionamento não é seguido.");
  }
  if (!response.ok) throw new Error(`Falha ao baixar a mídia (HTTP ${response.status}).`);

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new PermanentEventError("Mídia acima do tamanho permitido.");

  const chunks: Buffer[] = [];
  let total = 0;

  if (response.body) {
    const reader = response.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PermanentEventError("Mídia acima do tamanho permitido.");
      }
      chunks.push(Buffer.from(value));
    }
  }

  if (total === 0) throw new PermanentEventError("O endereço da mídia devolveu conteúdo vazio.");

  return { body: Buffer.concat(chunks), mime: safeMime(response.headers.get("content-type")) };
}
