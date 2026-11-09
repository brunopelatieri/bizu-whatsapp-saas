/**
 * Códigos de erro do Postgres. O postgres.js põe o `code` no erro, e o Drizzle o embrulha em
 * `cause`: os dois lugares contam.
 */
function pgCode(error: unknown) {
  const code = (e: unknown) => (e as { code?: unknown } | null)?.code;

  return code(error) ?? code((error as { cause?: unknown } | null)?.cause);
}

/** `23505`: índice único (e-mail, slug, preço por provedor e intervalo). */
export const isUniqueViolation = (error: unknown) => pgCode(error) === "23505";

/** `23503`: chave estrangeira (`restrict`) barrou o `DELETE` ou o `INSERT`. */
export const isForeignKeyViolation = (error: unknown) => pgCode(error) === "23503";

/** Nome do índice ou da restrição que o Postgres apontou (`constraint`), ou `undefined`. */
export function violatedConstraint(error: unknown) {
  const name = (e: unknown) => (e as { constraint?: unknown } | null)?.constraint;
  const value = name(error) ?? name((error as { cause?: unknown } | null)?.cause);

  return typeof value === "string" ? value : undefined;
}
