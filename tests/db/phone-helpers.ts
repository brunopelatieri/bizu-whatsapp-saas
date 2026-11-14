import { eq } from "drizzle-orm";
import { withPlatformScope } from "@/db/rls";
import { customer } from "@/db/schema";
import { phoneValues } from "@/lib/phone/columns";
import { requestPhoneVerificationSend } from "@/lib/phone/dispatch";
import { ensureCustomerVerification } from "@/lib/phone/requests";
import { UNVERIFIED_PHONE } from "@/lib/phone/verification";

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

/**
 * Deixa a ficha do cliente com um número só declarado e o pedido de cadastro da organização aberto,
 * como fica a do autocadastro do portal. Antes da troca pelo pedido (bloco T), os testes faziam isso
 * trocando o número no portal; agora a troca não mexe na ficha até a confirmação.
 */
export async function makeCustomerPhonePending(customerId: string, phone = uniquePhone()) {
  const requestId = await withPlatformScope("teste: ficha pendente", async (tx) => {
    const [row] = await tx
      .update(customer)
      .set({ ...phoneValues(phone), ...UNVERIFIED_PHONE })
      .where(eq(customer.id, customerId))
      .returning({ tenantId: customer.tenantId });
    if (!row) throw new Error("cliente não encontrado");
    return ensureCustomerVerification(tx, row.tenantId, customerId);
  });
  await requestPhoneVerificationSend(requestId, { type: "customer", id: customerId });

  return requestId;
}
