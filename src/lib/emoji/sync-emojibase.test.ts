import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILES, LOCALES, syncEmojibase, validate } from "../../../scripts/sync-emojibase.mjs";

/** O script que copia `emojibase-data` para `public/emojibase/`, com pastas temporárias. */

const DATA = [{ emoji: "😀", label: "rosto sorrindo", group: 0, order: 1 }];
const MESSAGES = { groups: [{ key: "smileys-emotion", message: "Carinhas e emoções", order: 0 }] };

let work: string;
let from: string;
let to: string;

async function source(locale: string, data: unknown = DATA, messages: unknown = MESSAGES) {
  await mkdir(path.join(from, locale), { recursive: true });
  await writeFile(path.join(from, locale, "data.json"), JSON.stringify(data));
  await writeFile(path.join(from, locale, "messages.json"), JSON.stringify(messages));
}

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "emojibase-"));
  from = path.join(work, "emojibase-data");
  to = path.join(work, "public", "emojibase");
  await mkdir(from, { recursive: true });
  await writeFile(path.join(from, "package.json"), JSON.stringify({ version: "9.9.9" }));
});

afterEach(() => rm(work, { recursive: true, force: true }));

describe("syncEmojibase", () => {
  it("serve só o português e lê os dois arquivos que o seletor usa", () => {
    expect(LOCALES).toEqual(["pt"]);
    expect(FILES).toEqual(["data.json", "messages.json"]);
  });

  it("copia os arquivos do idioma, byte a byte, e deixa um README com a versão", async () => {
    await source("pt");

    const result = await syncEmojibase({ from, to });

    expect(result.written.sort()).toEqual(["README.txt", "pt/data.json", "pt/messages.json"]);
    expect(await readFile(path.join(to, "pt", "data.json"), "utf8")).toBe(JSON.stringify(DATA));
    expect(await readFile(path.join(to, "pt", "messages.json"), "utf8")).toBe(JSON.stringify(MESSAGES));
    expect(await readFile(path.join(to, "README.txt"), "utf8")).toContain("emojibase-data@9.9.9");
  });

  it("é idempotente: repetir não regrava nada", async () => {
    await source("pt");
    await syncEmojibase({ from, to });

    const again = await syncEmojibase({ from, to });

    expect(again.written).toEqual([]);
    expect(again.unchanged.sort()).toEqual(["README.txt", "pt/data.json", "pt/messages.json"]);
  });

  it("regrava só o que mudou na origem", async () => {
    await source("pt");
    await syncEmojibase({ from, to });
    await source("pt", [...DATA, { emoji: "👍", label: "joinha", group: 1, order: 2 }]);

    const again = await syncEmojibase({ from, to });

    expect(again.written).toEqual(["pt/data.json"]);
  });

  it("não deixa arquivo temporário para trás", async () => {
    await source("pt");
    await syncEmojibase({ from, to });

    await expect(stat(path.join(to, "pt", "data.json.tmp"))).rejects.toThrow();
  });

  it("origem de formato errado não chega à pasta pública", async () => {
    await source("pt", { not: "uma lista" });

    await expect(syncEmojibase({ from, to })).rejects.toThrow(/data\.json/);
    await expect(stat(path.join(to, "pt", "data.json"))).rejects.toThrow();
  });

  it("idioma ou arquivo que não existe na origem falha com erro, sem gravar", async () => {
    await expect(syncEmojibase({ from, to })).rejects.toThrow();
    await expect(stat(path.join(to, "pt"))).rejects.toThrow();
  });

  it("aceita código com região ou escrita (en-gb, zh-hant): só falha por não existir na origem", async () => {
    for (const locale of ["en-gb", "zh-hant", "es-mx"]) {
      await expect(syncEmojibase({ from, to, locales: [locale] })).rejects.not.toThrow(/Idioma inválido/);
    }
  });

  it("idioma que sairia da pasta é recusado", async () => {
    for (const locale of ["../x", "pt/../..", "PT", "", "p t"]) {
      await expect(syncEmojibase({ from, to, locales: [locale] })).rejects.toThrow(/Idioma inválido/);
    }
  });
});

describe("validate", () => {
  it("aceita o formato do pacote e recusa o resto", () => {
    expect(() => validate("data.json", DATA)).not.toThrow();
    expect(() => validate("messages.json", MESSAGES)).not.toThrow();

    expect(() => validate("data.json", [])).toThrow();
    expect(() => validate("data.json", [{ emoji: "😀" }])).toThrow();
    expect(() => validate("data.json", null)).toThrow();
    expect(() => validate("messages.json", { groups: [] })).toThrow();
    expect(() => validate("messages.json", [])).toThrow();
  });
});
