import { sql } from "drizzle-orm";

/**
 * `CHECK` de telefone obrigatório de `customer`, `user` e `portal_user`: só a linha
 * anonimizada pela LGPD (e-mail `deleted+<id>@invalid`) fica sem número. Com `coalesce`,
 * o cliente sem e-mail não passa pelo atalho: `NULL LIKE ...` é nulo, e `CHECK` aceita nulo.
 */
/**
 * `CHECK` do estado de verificação: `phone_verified_at` e `phone_verified_via` andam juntos, a
 * forma é uma das de `phoneVerifiedVia` (`src/lib/phone/verification.ts`), e não existe número
 * confirmado sem número. O `IS NOT NULL` explícito importa: `NULL IN (...)` é nulo, e `CHECK`
 * aceita nulo.
 */
export const phoneVerifiedConsistent = sql`(phone_verified_at IS NULL AND phone_verified_via IS NULL) OR (phone_verified_at IS NOT NULL AND phone_key IS NOT NULL AND phone_verified_via IS NOT NULL AND phone_verified_via IN ('whatsapp', 'manual', 'team', 'inbound'))`;

/**
 * Só nas contas (`user` e `portal_user`), que são globais: as colunas só guardam a prova de
 * posse (`whatsapp`) e a liberação da plataforma (`manual`). É disso que depende
 * `userPhoneConfirmedGlobally` (`src/lib/phone/confirmed.ts`), que olha só `phone_verified_at`:
 * `team` e `inbound` são formas da ficha de cliente.
 */
export const accountPhoneViaGlobal = sql`phone_verified_via IS NULL OR phone_verified_via IN ('whatsapp', 'manual')`;

export const phoneRequired = sql`(phone_normalized IS NOT NULL AND phone_key IS NOT NULL) OR coalesce(email, '') LIKE 'deleted+%@invalid'`;
