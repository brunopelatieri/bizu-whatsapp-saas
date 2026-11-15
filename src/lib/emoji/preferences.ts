import {
  defaultStorage,
  EMOJI_KEY_PREFIX,
  readItem,
  type StorageLike,
  writeItem,
} from "@/lib/emoji/storage";

/**
 * Preferências do seletor de emoji (X3): o tom de pele, **por usuário**, em `localStorage`
 * (`bizu:emoji:skin-tone:<id>`). Valor que não seja um dos seis conhecidos (corrompido, de uma versão
 * futura, editado à mão) vale como o padrão, sem exceção.
 */

/** Os tons que o seletor aceita (`none` é o amarelo padrão), na ordem do menu. */
export const SKIN_TONES = ["none", "light", "medium-light", "medium", "medium-dark", "dark"] as const;
export type SkinTone = (typeof SKIN_TONES)[number];

export const DEFAULT_SKIN_TONE: SkinTone = "none";

export const skinToneKey = (userId: string) => `${EMOJI_KEY_PREFIX}skin-tone:${userId}`;

export function isSkinTone(value: unknown): value is SkinTone {
  return typeof value === "string" && (SKIN_TONES as readonly string[]).includes(value);
}

/** O tom gravado, ou o padrão. Aceita o valor cru ou em JSON (`"dark"`), que é como o seletor grava. */
export function parseSkinTone(raw: string | null): SkinTone {
  if (!raw) return DEFAULT_SKIN_TONE;
  if (isSkinTone(raw)) return raw;

  try {
    const parsed: unknown = JSON.parse(raw);
    return isSkinTone(parsed) ? parsed : DEFAULT_SKIN_TONE;
  } catch {
    return DEFAULT_SKIN_TONE;
  }
}

export function loadSkinTone(userId: string | undefined, storage: StorageLike | null = defaultStorage()): SkinTone {
  return userId ? parseSkinTone(readItem(skinToneKey(userId), storage)) : DEFAULT_SKIN_TONE;
}

/** Grava a escolha; um valor inválido nem é gravado. */
export function saveSkinTone(
  userId: string | undefined,
  tone: string,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!userId || !isSkinTone(tone)) return false;
  return writeItem(skinToneKey(userId), tone, storage);
}
