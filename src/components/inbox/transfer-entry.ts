import type { TransferOption, TransferRefusal } from "@/lib/inbox/transfer";

/**
 * A entrada "Continuar por outro número" (X2) a partir do que o servidor devolveu. Código puro (sem
 * React): `transfer-entry.test.ts` cobre. A tela só antecipa; o envio é revalidado no servidor.
 */

/** O motivo de um número não servir agora, como aparece ao lado dele no diálogo. */
export const TRANSFER_REFUSAL_TEXT: Record<TransferRefusal, string> = {
  disconnected: "Número desconectado.",
  assigned_to_other: "Outra pessoa já atende este contato por este número.",
  window_closed: "Janela de 24 horas encerrada neste número: por ele, só um modelo aprovado.",
};

export type TransferEntry =
  /** Sem outro número que sirva: o botão não aparece. */
  | { kind: "hidden" }
  | { kind: "enabled" }
  /** Só há número oficial com a janela fechada: o botão aparece desabilitado, apontando o modelo. */
  | { kind: "disabled"; reason: string };

/**
 * O botão só aparece com número elegível. A exceção da SPEC: quando o que falta é a janela de 24 h do
 * número oficial de destino, a ação aparece desabilitada com o motivo. Número desconectado ou conversa
 * de outro atendente, sozinhos, não desenham nada.
 */
export function transferEntry(options: readonly TransferOption[] | undefined): TransferEntry {
  if (!options || options.length === 0) return { kind: "hidden" };
  if (options.some((option) => option.eligible)) return { kind: "enabled" };

  const closed = options.find((option) => option.reason === "window_closed");
  if (!closed) return { kind: "hidden" };

  return {
    kind: "disabled",
    reason: `Pelo número ${closed.channel.name} a janela de 24 horas está encerrada: abra a conversa por ele e envie um modelo aprovado.`,
  };
}
