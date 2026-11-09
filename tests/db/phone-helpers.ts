import { phoneValues } from "@/lib/phone/columns";

/**
 * Telefones de teste. O telefone é obrigatório em toda conta e todo cliente, e único por
 * tenant (`phone_key`): cenários que criam vários clientes no mesmo tenant precisam de
 * números distintos. Celular válido: DDD 11 + 9 + 8 dígitos.
 */

let sequence = Date.now() % 90_000_000;

export function uniquePhone() {
  sequence = (sequence + 1) % 90_000_000;
  return `119${String(10_000_000 + sequence)}`;
}

/** As três colunas (`phone`, `phoneNormalized`, `phoneKey`) para um `INSERT` direto. */
export function phoneRow(phone = uniquePhone()) {
  return phoneValues(phone);
}

/** Um telefone fixo qualquer, para contas (que podem repetir número). */
export const ACCOUNT_PHONE = "11987654321";
