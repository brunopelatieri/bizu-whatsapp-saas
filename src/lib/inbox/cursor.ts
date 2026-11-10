import { type AnyColumn, and, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * Cursor das listas paginadas (SPEC, "Contratos"): `(last_message_at, id)` nas conversas e
 * `(created_at, id)` nas mensagens, opaco em base64url. O instante vai com a precisão do Postgres
 * (microssegundos, em UTC): um `Date` do JavaScript cortaria para milissegundos e pularia ou
 * repetiria linhas do mesmo milissegundo.
 */

export type Cursor = { at: string | null; id: string };

const UTC_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INVALID = new TenantRuleError(400, "INVALID_CURSOR", "Página inválida. Recarregue a lista.");

/** O instante em texto UTC com microssegundos: vira o cursor sem perder precisão. */
export const cursorTime = (column: AnyColumn) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

export function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw INVALID;

    const [at, id] = parsed as unknown[];
    const atOk = at === null || (typeof at === "string" && UTC_MICROS.test(at));
    if (!atOk || typeof id !== "string" || !UUID.test(id)) throw INVALID;

    return { at: at as string | null, id };
  } catch {
    throw INVALID;
  }
}

/**
 * Linhas depois do cursor, na ordem `instante DESC NULLS LAST, id DESC`. Instante nulo (conversa
 * sem mensagem) fica no fim.
 */
export function afterCursor(cursor: Cursor, at: AnyColumn, id: AnyColumn): SQL {
  if (cursor.at === null) return and(isNull(at), lt(id, cursor.id)) as SQL;

  const instant = sql`(${cursor.at}::timestamp at time zone 'UTC')`;
  return or(
    sql`${at} < ${instant}`,
    and(sql`${at} = ${instant}`, lt(id, cursor.id)),
    isNull(at),
  ) as SQL;
}
