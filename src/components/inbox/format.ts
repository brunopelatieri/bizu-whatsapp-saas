import { displayPhone } from "@/lib/phone/br";

/**
 * Formatação da caixa de entrada: nomes, horas, dias e texto com links. Código puro (sem React):
 * `format.test.ts` cobre.
 */

type ContactNames = { displayName: string | null; phone: string };

/** Nome a mostrar; sem nome, o telefone no formato de exibição. */
export function contactLabel(contact: ContactNames) {
  return contact.displayName?.trim() || displayPhone(`+${contact.phone}`) || contact.phone;
}

/** Duas letras para o avatar; telefone (sem letras) vira `#`. */
export function initialsOf(label: string) {
  const words = label.split(/\s+/).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return "#";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

const SAME_DAY = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const timeFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const longDate = new Intl.DateTimeFormat("pt-BR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function formatTime(iso: string) {
  return timeFormat.format(new Date(iso));
}

/** Hora do dia de hoje, "Ontem" ou `dd/mm`: o canto da linha da lista. */
export function formatListTime(iso: string | null, now = new Date()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (SAME_DAY(date, now)) return timeFormat.format(date);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (SAME_DAY(date, yesterday)) return "Ontem";

  return shortDate.format(date);
}

/** Rótulo do separador por dia: "Hoje", "Ontem" ou a data por extenso. */
export function formatDayLabel(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (SAME_DAY(date, now)) return "Hoje";

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (SAME_DAY(date, yesterday)) return "Ontem";

  return longDate.format(date);
}

/** Chave do dia local (agrupar mensagens). */
export function dayKey(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function formatFileSize(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type TextPart = { kind: "text"; value: string } | { kind: "link"; value: string; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
/** Pontuação que fecha a frase e não faz parte do endereço. */
const TRAILING = /[.,;:!?)\]}]+$/;

/**
 * Parte o texto em trechos e links. Só `http` e `https` viram link (nunca `javascript:`, `data:`…),
 * e o `href` é o que `URL` normaliza. O resto é texto, renderizado como texto pelo React.
 */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let candidate = match[0];
    const trailing = TRAILING.exec(candidate)?.[0] ?? "";
    candidate = candidate.slice(0, candidate.length - trailing.length);

    const href = safeHref(candidate);
    if (!href) continue;

    if (start > last) parts.push({ kind: "text", value: text.slice(last, start) });
    parts.push({ kind: "link", value: candidate, href });
    last = start + candidate.length;
  }

  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

export function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Aviso neutro da conversa esvaziada pela retenção: sem números (SPEC, bloco R, R3a). */
export const RETENTION_EMPTY_NOTICE = "Mensagens antigas removidas pela política de retenção";

/**
 * A conversa foi esvaziada pela limpeza de retenção: não há nenhuma mensagem (nem envio em andamento)
 * e ela já teve movimento (`last_message_at` preenchido). Conversa recém-criada, sem nada trocado,
 * tem `last_message_at` nulo e segue com o convite "escreva a primeira". Sem coluna nova: a limpeza
 * mantém `last_message_at` de propósito.
 */
export function emptiedByRetention(visibleMessages: number, lastMessageAt: string | null) {
  return visibleMessages === 0 && lastMessageAt !== null;
}
