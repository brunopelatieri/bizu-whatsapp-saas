import { describe, expect, it } from "vitest";
import { insertAtCursor } from "@/lib/emoji/insert-at-cursor";

describe("insertAtCursor", () => {
  it("no início", () => {
    expect(insertAtCursor("olá", "😀", { start: 0, end: 0 })).toEqual({ value: "😀olá", cursor: 2 });
  });

  it("no meio", () => {
    expect(insertAtCursor("olá mundo", "👍", { start: 3, end: 3 })).toEqual({
      value: "olá👍 mundo",
      cursor: 5,
    });
  });

  it("no fim", () => {
    expect(insertAtCursor("olá", "🎉", { start: 3, end: 3 })).toEqual({ value: "olá🎉", cursor: 5 });
  });

  it("sobre uma seleção: ela é substituída", () => {
    expect(insertAtCursor("oi fulano!", "😊", { start: 3, end: 9 })).toEqual({
      value: "oi 😊!",
      cursor: 5,
    });
    // Seleção feita da direita para a esquerda (início maior que o fim).
    expect(insertAtCursor("oi fulano!", "😊", { start: 9, end: 3 })).toEqual({
      value: "oi 😊!",
      cursor: 5,
    });
  });

  it("sem posição (campo que nunca teve foco) insere no fim", () => {
    expect(insertAtCursor("oi", "😀")).toEqual({ value: "oi😀", cursor: 4 });
    expect(insertAtCursor("oi", "😀", { start: undefined, end: undefined })).toEqual({
      value: "oi😀",
      cursor: 4,
    });
    expect(insertAtCursor("", "😀")).toEqual({ value: "😀", cursor: 2 });
  });

  it("posição fora do texto é limitada ao texto", () => {
    expect(insertAtCursor("oi", "😀", { start: 99, end: 120 })).toEqual({ value: "oi😀", cursor: 4 });
    expect(insertAtCursor("oi", "😀", { start: -5, end: -1 })).toEqual({ value: "😀oi", cursor: 2 });
  });

  it("emoji composto (família com ZWJ, bandeira e tom de pele) entra inteiro e o cursor fica depois dele", () => {
    const family = "👨‍👩‍👧";
    const flag = "🇧🇷";
    const wave = "👋🏽";

    expect(insertAtCursor("a b", family, { start: 1, end: 1 })).toEqual({
      value: `a${family} b`,
      cursor: 1 + family.length,
    });
    expect(insertAtCursor("", flag)?.cursor).toBe(flag.length);
    expect(insertAtCursor("", wave)?.cursor).toBe(wave.length);
  });

  it("não parte um emoji que já está no texto: posição no meio do par substituto recua ou avança", () => {
    // "😀" ocupa as posições 0 e 1; o cursor em 1 cairia no meio do par.
    expect(insertAtCursor("😀", "👍", { start: 1, end: 1 })).toEqual({ value: "👍😀", cursor: 2 });
    // Uma seleção que começa no meio de um par e termina no meio de outro engole os dois inteiros.
    expect(insertAtCursor("😀😀", "x", { start: 1, end: 3 })).toEqual({ value: "x", cursor: 1 });
  });

  it("respeita o teto do campo: o que passaria dele não é inserido", () => {
    expect(insertAtCursor("abcd", "😀", { start: 4, end: 4 }, 5)).toBeNull();
    expect(insertAtCursor("abc", "😀", { start: 3, end: 3 }, 5)).toEqual({ value: "abc😀", cursor: 5 });
    // A seleção substituída libera espaço.
    expect(insertAtCursor("abcd", "😀", { start: 0, end: 4 }, 2)).toEqual({ value: "😀", cursor: 2 });
  });

  it("emoji vazio não insere nada", () => {
    expect(insertAtCursor("oi", "", { start: 1, end: 1 })).toBeNull();
  });
});
