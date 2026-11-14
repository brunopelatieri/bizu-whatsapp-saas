import { formatPhoneForDisplay, normalizePhone } from "@/lib/phone/br";
import type { RawImportRow } from "@/lib/spreadsheet/types";

/**
 * Os campos de cadastro de uma linha, prontos para `customerSchema` (que faz a validação de verdade,
 * no servidor). A regra que mora aqui é a do nome: **sem `name`, o telefone formatado vira o nome**
 * (`+55 (11) 98765-4321`). Telefone que não passa fica como veio: a linha é recusada pelo telefone.
 * A tela usa a mesma função na prévia, para mostrar o nome que o servidor vai gravar.
 */
export function customerFieldsFromRow(row: RawImportRow) {
  let name = row.name;
  if (!name && row.phone) {
    const phone = normalizePhone(row.phone);
    name = phone.ok ? formatPhoneForDisplay(phone.phone) : row.phone.trim();
  }

  return {
    name: name ?? "",
    email: row.email,
    phone: row.phone,
    document: row.document,
    notes: row.notes,
  };
}
