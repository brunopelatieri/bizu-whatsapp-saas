/**
 * Inserir um emoji no texto de um campo, na posição do cursor ou sobre a seleção (X3). Puro: o
 * componente lê `selectionStart` e `selectionEnd` do `<textarea>`, chama aqui e devolve o cursor ao
 * campo. As posições são em unidades UTF-16, como as do DOM e como `maxLength` conta.
 */

export type Selection = { start: number | null | undefined; end: number | null | undefined };

export type Insertion = {
  /** O texto depois de inserir. */
  value: string;
  /** Onde o cursor fica: logo depois do que foi inserido. */
  cursor: number;
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Posição dentro dos limites do texto e nunca no meio de um par substituto (emoji fora do plano básico). */
function snap(value: string, position: number, direction: "back" | "forward") {
  const clamped = Math.min(Math.max(Math.trunc(position), 0), value.length);
  if (clamped > 0 && clamped < value.length) {
    const before = value.charCodeAt(clamped - 1);
    const at = value.charCodeAt(clamped);
    if (isHigh(before) && isLow(at)) return direction === "back" ? clamped - 1 : clamped + 1;
  }
  return clamped;
}

/**
 * `selection` sem valor (campo que nunca teve foco) insere no fim. Com seleção, ela é substituída.
 * Com `maxLength`, o que passaria do teto **não é inserido** (`null`): cortar no meio de um emoji
 * composto deixaria um pedaço quebrado, e o envio recusaria o texto de qualquer forma.
 */
export function insertAtCursor(
  value: string,
  insert: string,
  selection: Selection = { start: null, end: null },
  maxLength?: number,
): Insertion | null {
  if (insert === "") return null;

  const rawStart = selection.start ?? value.length;
  const rawEnd = selection.end ?? rawStart;
  const first = Math.min(rawStart, rawEnd);
  const last = Math.max(rawStart, rawEnd);
  const start = snap(value, first, "back");
  // Cursor sem seleção: os dois lados recuam juntos e nada é substituído.
  const end = first === last ? start : snap(value, last, "forward");

  const next = value.slice(0, start) + insert + value.slice(end);
  if (maxLength !== undefined && next.length > maxLength) return null;

  return { value: next, cursor: start + insert.length };
}
