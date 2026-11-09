import { readFileSync } from "node:fs";
import path from "node:path";

/** Só para testes: carrega `tests/fixtures/channels/<nome>.json`. Nada do app importa isto. */
const root = path.resolve(import.meta.dirname, "../../../tests/fixtures/channels");

export function fixtureText(name: string) {
  return readFileSync(path.join(root, `${name}.json`), "utf8");
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

/** `Response` de uma fixture, para o `fetch` simulado. */
export function jsonResponse(name: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(fixtureText(name), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
