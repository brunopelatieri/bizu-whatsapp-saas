/**
 * Tipos aceitos em `POST /api/files`. Só conteúdo passivo: nada de HTML, SVG ou script, que o
 * navegador executaria se alguém abrisse o arquivo. Projeto derivado amplia a lista aqui.
 */
export const ALLOWED_UPLOAD_MIME = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
] as const;

export type AllowedMime = (typeof ALLOWED_UPLOAD_MIME)[number];

export function isAllowedMime(mime: string): mime is AllowedMime {
  return (ALLOWED_UPLOAD_MIME as readonly string[]).includes(mime);
}

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

/** Assinaturas conferidas: o tipo declarado pelo cliente não basta para os binários. */
const SIGNATURES: Partial<Record<AllowedMime, (bytes: Buffer) => boolean>> = {
  "image/png": (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => b.subarray(0, 6).toString("latin1").startsWith("GIF8"),
  "image/webp": (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  "application/pdf": (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]),
};

/** `true` se o conteúdo bate com o tipo; tipos de texto não têm assinatura e passam. */
export function matchesSignature(mime: AllowedMime, bytes: Buffer) {
  const check = SIGNATURES[mime];
  return check ? check(bytes) : true;
}

const MAX_NAME_LENGTH = 200;

/** Nome para exibir e baixar: sem caminho, sem controle, com tamanho limitado. */
export function sanitizeFileName(raw: string) {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: tira controles do nome
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();

  return (clean || "arquivo").slice(0, MAX_NAME_LENGTH);
}

/** `Content-Disposition` seguro para qualquer nome (RFC 5987). `inline` só para tipo passivo. */
export function dispositionHeader(name: string, kind: "attachment" | "inline") {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");

  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** `Content-Disposition: attachment` seguro para qualquer nome (RFC 5987). */
export function attachmentHeader(name: string) {
  return dispositionHeader(name, "attachment");
}
