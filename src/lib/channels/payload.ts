/**
 * Leitura tolerante de avisos de provedor (JSON que não controlamos). Nada aqui lança.
 *
 * A Evolution Go mistura três grafias no mesmo aviso (`Info`, `audioMessage`, `event`), então
 * `pickKey` procura sem diferenciar caixa. É seguro porque nenhum aviso traz duas chaves que
 * diferem só por maiúscula (o Go não permitiria dois campos assim).
 */

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Primeiro valor cujo nome bate com um dos `names`, ignorando a caixa. */
export function pickKey(obj: JsonRecord | null | undefined, ...names: string[]): unknown {
  if (!obj) return undefined;

  for (const name of names) {
    if (name in obj) return obj[name];
  }

  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return undefined;
}

/** String não vazia, ou `null`. Vazio é ausência: não vira bolha em branco lá na frente. */
export function pickString(obj: JsonRecord | null | undefined, ...names: string[]) {
  const value = pickKey(obj, ...names);
  return typeof value === "string" && value !== "" ? value : null;
}

export function pickRecord(obj: JsonRecord | null | undefined, ...names: string[]) {
  return asRecord(pickKey(obj, ...names));
}

export function pickArray(obj: JsonRecord | null | undefined, ...names: string[]) {
  const value = pickKey(obj, ...names);
  return Array.isArray(value) ? value : [];
}

/** `true`/`false` explícito, ou `null` quando o campo não veio (aceita `"true"`/`"false"`). */
export function pickBoolean(obj: JsonRecord | null | undefined, ...names: string[]) {
  const value = pickKey(obj, ...names);
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/** Segundos (Meta, whatsmeow) ou milissegundos, pela magnitude. `null` se não houver hora. */
export function parseTimestamp(value: unknown): Date | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))
        ? Number(value)
        : null;

  if (number !== null) return new Date(number > 1e12 ? number : number * 1000);

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}
