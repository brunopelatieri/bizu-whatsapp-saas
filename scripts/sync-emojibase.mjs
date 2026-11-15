#!/usr/bin/env node
// Copia os dados de emoji do pacote `emojibase-data` (devDependency) para `public/emojibase/<idioma>/`,
// de onde o seletor de emoji os lê (`emojibaseUrl="/emojibase"`). Nada é buscado fora do servidor em
// tempo de execução, e a CSP segue com `connect-src 'self'`.
//
//   npm run emoji:sync
//
// Rode de novo ao atualizar `emojibase-data` e commite o resultado: o build de produção não instala
// devDependencies, então os arquivos de `public/emojibase/` são versionados. Idempotente: só grava o
// que mudou.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Idiomas servidos. O seletor está em português do Brasil. */
export const LOCALES = ["pt"];

/** O que o seletor lê de cada idioma: os emojis e os nomes dos grupos. */
export const FILES = ["data.json", "messages.json"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Confere o formato mínimo que o seletor espera; arquivo de outra forma nunca chega à pasta pública. */
export function validate(file, json) {
  if (file === "data.json") {
    const ok =
      Array.isArray(json) &&
      json.length > 0 &&
      json.every((item) => item && typeof item.emoji === "string" && typeof item.label === "string");
    if (!ok) throw new Error("data.json: esperava uma lista de emojis com `emoji` e `label`.");
  } else if (file === "messages.json") {
    const ok = json && typeof json === "object" && Array.isArray(json.groups) && json.groups.length > 0;
    if (!ok) throw new Error("messages.json: esperava `groups`.");
  }
}

async function writeIfChanged(target, content) {
  try {
    if ((await readFile(target, "utf8")) === content) return false;
  } catch {
    // Ainda não existe.
  }
  await mkdir(path.dirname(target), { recursive: true });
  // Grava ao lado e renomeia: quem lê nunca vê o arquivo pela metade.
  const temporary = `${target}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, target);
  return true;
}

/**
 * @param {{ from?: string, to?: string, locales?: string[], version?: string }} [options]
 * @returns {Promise<{ written: string[], unchanged: string[] }>}
 */
export async function syncEmojibase(options = {}) {
  const from = options.from ?? path.join(root, "node_modules", "emojibase-data");
  const to = options.to ?? path.join(root, "public", "emojibase");
  const locales = options.locales ?? LOCALES;
  const written = [];
  const unchanged = [];

  for (const locale of locales) {
    // O idioma entra em caminho de arquivo: só letras, nada de `..` nem barras.
    if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(locale)) throw new Error(`Idioma inválido: ${locale}`);

    for (const file of FILES) {
      const content = await readFile(path.join(from, locale, file), "utf8");
      validate(file, JSON.parse(content));

      const relative = `${locale}/${file}`;
      ((await writeIfChanged(path.join(to, locale, file), content)) ? written : unchanged).push(relative);
    }
  }

  let version = options.version;
  if (!version) {
    try {
      version = JSON.parse(await readFile(path.join(from, "package.json"), "utf8")).version;
    } catch {
      version = "desconhecida";
    }
  }
  const note =
    `Dados de emoji copiados de emojibase-data@${version} (licença MIT) por scripts/sync-emojibase.mjs.\n` +
    "Não edite à mão: rode `npm run emoji:sync` ao atualizar o pacote.\n";
  ((await writeIfChanged(path.join(to, "README.txt"), note)) ? written : unchanged).push("README.txt");

  return { written, unchanged };
}

/** Mesmo arquivo, sem depender da caixa da letra da unidade no Windows. */
const sameFile = (a, b) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) {
  syncEmojibase()
    .then(({ written, unchanged }) => {
      console.log(`emojibase: ${written.length} gravado(s), ${unchanged.length} sem mudança.`);
    })
    .catch((error) => {
      console.error(`emojibase: ${error.message}`);
      process.exit(1);
    });
}
