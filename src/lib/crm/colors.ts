/**
 * Cor de etiqueta: sempre `#rrggbb` em minúsculas (o banco confere com `CHECK`). Puro: serve
 * o formulário e a API.
 */

/** `#abc`, `abc`, `AABBCC` e `#AABBCC` viram `#aabbcc`; qualquer outra coisa, `null`. */
export function normalizeHexColor(raw: string): string | null {
  const value = raw.trim().replace(/^#/, "").toLowerCase();

  if (/^[0-9a-f]{3}$/.test(value)) {
    return `#${[...value].map((digit) => digit + digit).join("")}`;
  }
  if (/^[0-9a-f]{6}$/.test(value)) return `#${value}`;

  return null;
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** Razão de contraste WCAG entre duas cores `#rrggbb` (de 1 a 21). */
export function contrastRatio(a: string, b: string) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** Abaixo disto o chip some contra a superfície do tema; a tela avisa e não bloqueia. */
export const MIN_TAG_CONTRAST = 2;
