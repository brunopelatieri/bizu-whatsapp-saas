import { type MessageType, PREVIEW_MAX } from "@/lib/inbox/constants";

/**
 * Prévia da última mensagem na lista de conversas e da citação. Código puro: a ingestão, o envio
 * e as visões da API o usam sem puxar um ao outro.
 */

const PREVIEW_LABELS: Record<MessageType, string> = {
  text: "Mensagem",
  image: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contacts: "Contato",
  template: "Modelo de mensagem",
  interactive: "Resposta",
  unsupported: "Mensagem não suportada",
};

/** O texto (ou legenda), senão o tipo; até 120 caracteres. */
export function previewOf(type: MessageType, text: string | null) {
  const body = text?.replace(/\s+/g, " ").trim() || PREVIEW_LABELS[type];
  const chars = Array.from(body);

  return chars.length > PREVIEW_MAX ? `${chars.slice(0, PREVIEW_MAX - 1).join("")}…` : body;
}
