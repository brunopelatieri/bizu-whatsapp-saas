import type { Tx } from "@/db/rls";

/**
 * Aviso de mudança na caixa de entrada (SPEC, "Tempo real"). Carga só com ids: quem recebe relê
 * pela API, que aplica a visibilidade (T11). Nunca leva texto, telefone ou nome.
 */
export type InboxNotice = {
  /** Tenant, ou `null` na plataforma. */
  s: string | null;
  /** Conversa. */
  c: string;
  k: "message" | "status" | "conversation";
  /** Mensagem, quando há. */
  m?: string;
  /** Dono depois da mudança. */
  a?: string | null;
  /** Dono antes da mudança. */
  p?: string | null;
};

/**
 * Ponto de extensão da fase C4: lá, `pg_notify('inbox', json)` dentro da transação (sai no
 * `COMMIT`, também a partir do processo `--worker`). Até lá não faz nada; quem grava já chama
 * aqui, na mesma transação, para a C4 só trocar o corpo.
 */
export async function notifyInbox(_tx: Tx, _notice: InboxNotice): Promise<void> {}
