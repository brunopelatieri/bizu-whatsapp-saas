import type { ConversationStatus } from "@/lib/inbox/constants";

/** Rótulos da tela (puro, sem servidor): a situação da conversa. */
export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Aberta",
  pending: "Pendente",
  closed: "Encerrada",
};
