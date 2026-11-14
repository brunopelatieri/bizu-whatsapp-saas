import { describe, expect, it } from "vitest";
import {
  addRecent,
  looksLikeEmoji,
  loadRecents,
  parseRecents,
  RECENT_LIMIT,
  recentsKey,
  saveRecent,
} from "@/lib/emoji/recents";
import type { StorageLike } from "@/lib/emoji/storage";

function memory(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const broken: StorageLike = {
  getItem: () => {
    throw new Error("indisponível");
  },
  setItem: () => {
    throw new Error("cota cheia");
  },
  removeItem: () => {
    throw new Error("indisponível");
  },
};

const many = (count: number) => Array.from({ length: count }, (_, index) => String.fromCodePoint(0x1f600 + index));

describe("addRecent", () => {
  it("o novo vai para o início", () => {
    expect(addRecent(["😀", "👍"], "🎉")).toEqual(["🎉", "😀", "👍"]);
  });

  it("repetido sobe e não duplica", () => {
    expect(addRecent(["😀", "👍", "🎉"], "🎉")).toEqual(["🎉", "😀", "👍"]);
    expect(addRecent(["😀"], "😀")).toEqual(["😀"]);
  });

  it("guarda no máximo 16, descartando o mais antigo", () => {
    const full = many(RECENT_LIMIT);
    expect(RECENT_LIMIT).toBe(16);

    const next = addRecent(full, "🎉");
    expect(next).toHaveLength(16);
    expect(next[0]).toBe("🎉");
    expect(next).not.toContain(full[15]);
    expect(addRecent(full, full[7] as string)).toHaveLength(16);
  });

  it("não altera a lista de entrada", () => {
    const list = ["😀"];
    addRecent(list, "👍");
    expect(list).toEqual(["😀"]);
  });
});

describe("looksLikeEmoji", () => {
  it("aceita emoji simples, composto, bandeira e tecla", () => {
    for (const value of ["😀", "👨‍👩‍👧", "🇧🇷", "👋🏽", "1️⃣", "❤️"]) expect(looksLikeEmoji(value)).toBe(true);
  });

  it("recusa texto, vazio, longo demais e o que não é texto", () => {
    for (const value of ["", "abc", "<script>", "😀".repeat(20), 42, null, undefined, {}]) {
      expect(looksLikeEmoji(value)).toBe(false);
    }
  });
});

describe("parseRecents", () => {
  it("lê uma lista gravada", () => {
    expect(parseRecents(JSON.stringify(["😀", "👍"]))).toEqual(["😀", "👍"]);
  });

  it("valor ausente, JSON inválido ou de outro formato é lista vazia", () => {
    for (const raw of [null, "", "{", "isto não é JSON", '{"a":1}', '"😀"', "42", "null"]) {
      expect(parseRecents(raw)).toEqual([]);
    }
  });

  it("descarta item que não é emoji, repetido e o que passa do teto", () => {
    const raw = JSON.stringify(["😀", "texto", 7, null, "😀", "👍", ...many(30)]);
    const list = parseRecents(raw);

    expect(list.slice(0, 2)).toEqual(["😀", "👍"]);
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBe(16);
    expect(list.every((item) => looksLikeEmoji(item))).toBe(true);
  });
});

describe("loadRecents e saveRecent", () => {
  it("são por usuário", () => {
    const storage = memory();

    saveRecent("u1", "😀", storage);
    saveRecent("u1", "👍", storage);
    saveRecent("u2", "🎉", storage);

    expect(loadRecents("u1", storage)).toEqual(["👍", "😀"]);
    expect(loadRecents("u2", storage)).toEqual(["🎉"]);
    expect(storage.data.has(recentsKey("u1"))).toBe(true);
    expect(recentsKey("u1")).toBe("bizu:emoji:recents:u1");
  });

  it("sem usuário não lê nem grava", () => {
    const storage = memory();

    expect(loadRecents(undefined, storage)).toEqual([]);
    expect(saveRecent(undefined, "😀", storage)).toEqual([]);
    expect(storage.data.size).toBe(0);
  });

  it("não grava o que não é emoji", () => {
    const storage = memory();

    expect(saveRecent("u1", "texto qualquer", storage)).toEqual([]);
    expect(storage.data.size).toBe(0);
  });

  it("repetido sobe e o teto vale na gravação", () => {
    const storage = memory({ [recentsKey("u1")]: JSON.stringify(many(16)) });

    const after = saveRecent("u1", many(16)[9] as string, storage);

    expect(after).toHaveLength(16);
    expect(after[0]).toBe(many(16)[9]);
    expect(loadRecents("u1", storage)).toEqual(after);
  });

  it("valor corrompido no armazenamento não quebra: recomeça do zero", () => {
    const storage = memory({ [recentsKey("u1")]: "{corrompido" });

    expect(loadRecents("u1", storage)).toEqual([]);
    expect(saveRecent("u1", "😀", storage)).toEqual(["😀"]);
    expect(loadRecents("u1", storage)).toEqual(["😀"]);
  });

  it("armazenamento indisponível (leitura e gravação lançam) não quebra e a tela segue com a lista", () => {
    expect(loadRecents("u1", broken)).toEqual([]);
    expect(saveRecent("u1", "😀", broken)).toEqual(["😀"]);
  });

  it("sem armazenamento algum (null) também não quebra", () => {
    expect(loadRecents("u1", null)).toEqual([]);
    expect(saveRecent("u1", "😀", null)).toEqual(["😀"]);
  });
});
