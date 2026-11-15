import {
  EMOJI_KEY_PREFIX,
  readItem,
  type StorageLike,
  defaultStorage,
  writeItem,
} from "@/lib/emoji/storage";

/**
 * Emojis recentes (X3): os 16 mais recentes, **por usuário**, em `localStorage` (`bizu:emoji:recents:<id>`).
 * Outra pessoa no mesmo navegador não vê os recentes de quem saiu. Só o emoji vai guardado, nunca
 * texto de mensagem. O que vier de `localStorage` é tratado como não confiável: o que não parecer
 * emoji é descartado.
 */

export const RECENT_LIMIT = 16;

/** Mais que isso não é um emoji (a maior sequência ZWJ de família tem 11 unidades UTF-16). */
const EMOJI_MAX_LENGTH = 32;

const EMOJI_SHAPE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣/u;

export const recentsKey = (userId: string) => `${EMOJI_KEY_PREFIX}recents:${userId}`;

/** Parece um emoji: curto e com ao menos um pictograma, bandeira ou tecla. */
export function looksLikeEmoji(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= EMOJI_MAX_LENGTH && EMOJI_SHAPE.test(value);
}

/** O emoji vai para o início; repetido sobe (sem duplicar); o teto é `RECENT_LIMIT`. */
export function addRecent(list: readonly string[], emoji: string): string[] {
  return [emoji, ...list.filter((item) => item !== emoji)].slice(0, RECENT_LIMIT);
}

/** Lê o que foi gravado: JSON inválido, outro formato ou itens estranhos viram lista vazia ou são descartados. */
export function parseRecents(raw: string | null): string[] {
  if (!raw) return [];

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of data) {
    if (!looksLikeEmoji(item) || seen.has(item)) continue;
    seen.add(item);
    list.push(item);
    if (list.length === RECENT_LIMIT) break;
  }
  return list;
}

export function loadRecents(userId: string | undefined, storage: StorageLike | null = defaultStorage()): string[] {
  return userId ? parseRecents(readItem(recentsKey(userId), storage)) : [];
}

/** Registra o uso e devolve a lista nova (mesmo que a gravação falhe, a tela segue com ela). */
export function saveRecent(
  userId: string | undefined,
  emoji: string,
  storage: StorageLike | null = defaultStorage(),
): string[] {
  if (!userId || !looksLikeEmoji(emoji)) return loadRecents(userId, storage);

  const next = addRecent(loadRecents(userId, storage), emoji);
  writeItem(recentsKey(userId), JSON.stringify(next), storage);
  return next;
}
