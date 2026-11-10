import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { conversation } from "@/db/schema";

/** Canal do `LISTEN`/`NOTIFY` da caixa de entrada (`realtime.ts` escuta aqui). */
export const INBOX_CHANNEL = "inbox";

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
  /**
   * Dono depois da mudança. Quem grava pode omitir (status de entrega, varredura): `notifyInbox`
   * lê o dono atual na mesma transação. Aviso que chega sem `a` só vai a quem supervisiona.
   */
  a?: string | null;
  /** Dono antes da mudança; omitido quando o dono não mudou (vale o `a`). */
  p?: string | null;
  /**
   * Quem fez a mudança, quando foi uma pessoa (assumir, transferir, responder, iniciar). A tela
   * usa para não avisar "atribuída a você" a quem assumiu a própria conversa.
   */
  u?: string;
};

/** Monta a carga sem chaves vazias: `undefined` some do JSON, `null` fica (fila). */
export function noticePayload(notice: InboxNotice): string {
  const payload: InboxNotice = { s: notice.s, c: notice.c, k: notice.k };
  if (notice.m !== undefined) payload.m = notice.m;
  if (notice.a !== undefined) payload.a = notice.a;
  if (notice.p !== undefined) payload.p = notice.p;
  if (notice.u !== undefined) payload.u = notice.u;
  return JSON.stringify(payload);
}

/**
 * `pg_notify('inbox', json)` dentro da transação de quem gravou: o Postgres só entrega no `COMMIT`
 * (rollback não avisa ninguém) e entrega a todo processo que escuta, inclusive quando quem grava é
 * o processo `--worker` (`JOBS_MODE=worker`). Avisos idênticos na mesma transação chegam uma vez.
 *
 * Sem `a`, lê o dono atual da conversa na mesma transação (o RLS do escopo já vale aqui). Se não
 * achar, o aviso sai sem `a` e o filtro do SSE o entrega só a quem supervisiona: falha fechada.
 */
export async function notifyInbox(tx: Tx, notice: InboxNotice): Promise<void> {
  let full = notice;

  if (notice.a === undefined) {
    const [row] = await tx
      .select({ assignedUserId: conversation.assignedUserId })
      .from(conversation)
      .where(eq(conversation.id, notice.c));
    if (row) full = { ...notice, a: row.assignedUserId };
  }

  await tx.execute(sql`select pg_notify(${INBOX_CHANNEL}, ${noticePayload(full)})`);
}
