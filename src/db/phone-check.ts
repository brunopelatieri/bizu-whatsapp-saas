import { sql } from "drizzle-orm";

/**
 * `CHECK` de telefone obrigatório de `customer`, `user` e `portal_user`: só a linha
 * anonimizada pela LGPD (e-mail `deleted+<id>@invalid`) fica sem número. Com `coalesce`,
 * o cliente sem e-mail não passa pelo atalho: `NULL LIKE ...` é nulo, e `CHECK` aceita nulo.
 */
export const phoneRequired = sql`(phone_normalized IS NOT NULL AND phone_key IS NOT NULL) OR coalesce(email, '') LIKE 'deleted+%@invalid'`;
