/**
 * Mascara os dígitos do meio de um telefone para citar em log ou diagnóstico:
 * `55 11 98765-4321` → `55 11 9****-4321`. Mantém os 5 primeiros e os 4 últimos
 * dígitos e a pontuação. Opera sobre a string como veio, sem normalizar. Telefone
 * é dado pessoal: nunca vai inteiro para `logError`, Sentry ou auditoria.
 */
export function maskPhoneForLog(raw: string | null | undefined): string {
  if (!raw) return "—";

  const chars = raw.split("");
  const positions: number[] = [];
  chars.forEach((ch, index) => {
    if (/\d/.test(ch)) positions.push(index);
  });

  const total = positions.length;
  if (total <= 8) return raw.replace(/\d/g, "*");

  positions.forEach((charIndex, digitIndex) => {
    if (digitIndex >= 5 && digitIndex < total - 4) chars[charIndex] = "*";
  });
  return chars.join("");
}
