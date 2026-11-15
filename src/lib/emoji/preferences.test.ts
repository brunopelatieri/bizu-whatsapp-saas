import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKIN_TONE,
  isSkinTone,
  loadSkinTone,
  parseSkinTone,
  SKIN_TONES,
  saveSkinTone,
  skinToneKey,
} from "@/lib/emoji/preferences";
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

describe("tom de pele", () => {
  it("o padrão é o amarelo (`none`) e os seis tons são conhecidos", () => {
    expect(DEFAULT_SKIN_TONE).toBe("none");
    expect(SKIN_TONES).toEqual(["none", "light", "medium-light", "medium", "medium-dark", "dark"]);
    for (const tone of SKIN_TONES) expect(isSkinTone(tone)).toBe(true);
  });

  it("valor inválido, de outro tipo ou vazio vale como o padrão", () => {
    for (const raw of [null, "", "roxo", "DARK", "{", "42", '"roxo"', "null", '{"tone":"dark"}']) {
      expect(parseSkinTone(raw)).toBe("none");
    }
    for (const value of [undefined, null, 3, {}, "Dark"]) expect(isSkinTone(value)).toBe(false);
  });

  it("lê o valor cru e o valor em JSON", () => {
    expect(parseSkinTone("medium-dark")).toBe("medium-dark");
    expect(parseSkinTone('"light"')).toBe("light");
  });

  it("é por usuário", () => {
    const storage = memory();

    expect(saveSkinTone("u1", "dark", storage)).toBe(true);
    expect(saveSkinTone("u2", "light", storage)).toBe(true);

    expect(loadSkinTone("u1", storage)).toBe("dark");
    expect(loadSkinTone("u2", storage)).toBe("light");
    expect(loadSkinTone("u3", storage)).toBe("none");
    expect(skinToneKey("u1")).toBe("bizu:emoji:skin-tone:u1");
  });

  it("não grava tom inválido nem sem usuário", () => {
    const storage = memory();

    expect(saveSkinTone("u1", "roxo", storage)).toBe(false);
    expect(saveSkinTone(undefined, "dark", storage)).toBe(false);
    expect(storage.data.size).toBe(0);
    expect(loadSkinTone(undefined, storage)).toBe("none");
  });

  it("armazenamento corrompido ou indisponível não quebra", () => {
    expect(loadSkinTone("u1", memory({ [skinToneKey("u1")]: "\u0000\u0001lixo" }))).toBe("none");
    expect(loadSkinTone("u1", broken)).toBe("none");
    expect(saveSkinTone("u1", "dark", broken)).toBe(false);
    expect(loadSkinTone("u1", null)).toBe("none");
    expect(saveSkinTone("u1", "dark", null)).toBe(false);
  });
});
