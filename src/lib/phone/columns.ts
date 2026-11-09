import { normalizePhone, type PhoneKind, type PhoneRejectReason } from "@/lib/phone/br";

/** Telefone recusado pelo normalizador, já no servidor (a API responde 400 `INVALID_PHONE`). */
export class InvalidPhoneError extends Error {
  constructor(readonly reason: PhoneRejectReason) {
    super("Telefone inválido.");
    this.name = "InvalidPhoneError";
  }
}

export type PhoneColumns = {
  /** O que a pessoa digitou, aparado. */
  phone: string;
  /** Canônico: dígitos com DDI, sem `+`. */
  phoneNormalized: string;
  /** Chave de comparação: igual com e sem o 9º dígito. */
  phoneKey: string;
  kind: PhoneKind;
};

/**
 * As três colunas de telefone de `customer`, `user` e `portal_user`, calculadas no servidor.
 * Nunca vêm do corpo da requisição. Lança `InvalidPhoneError` se o número não passar.
 */
export function phoneColumns(raw: string): PhoneColumns {
  const text = raw.trim();
  const result = normalizePhone(text);
  if (!result.ok) throw new InvalidPhoneError(result.reason);

  return { phone: text, phoneNormalized: result.phone, phoneKey: result.key, kind: result.kind };
}

/** As colunas que vão para o banco, sem o `kind` (que só serve à tela). */
export function phoneValues(raw: string) {
  const { phone, phoneNormalized, phoneKey } = phoneColumns(raw);
  return { phone, phoneNormalized, phoneKey };
}
