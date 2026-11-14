/**
 * Acesso ao `localStorage` do seletor de emoji (X3): nunca quebra a tela. Valor corrompido, armazenamento
 * indisponível (janela privada, política do navegador, SSR) ou cota cheia viram "sem dado" e "não
 * gravou", sem exceção. Tudo fica sob `bizu:emoji:*`; nada daqui sai do navegador.
 */

export const EMOJI_KEY_PREFIX = "bizu:emoji:";

/** O pedaço do `Storage` que o módulo usa (os testes passam um objeto simples). */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** O `localStorage`, ou `null` quando nem o acesso à propriedade é permitido. */
export function defaultStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readItem(key: string, storage: StorageLike | null = defaultStorage()): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

export function writeItem(key: string, value: string, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(key: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Sem armazenamento, não há o que apagar.
  }
}
