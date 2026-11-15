/** "1 conversa" ou "3 conversas". */
export const conversationsLabel = (count: number) =>
  `${count} ${count === 1 ? "conversa" : "conversas"}`;

/** "será apagada" só quando é uma ficha e nenhuma conversa; senão "serão apagadas". */
export const deletedVerb = (customers: number, conversations: number) =>
  customers === 1 && conversations === 0 ? "será apagada" : "serão apagadas";

/**
 * O aviso da exclusão da própria conta (equipe, D-11): as fichas de cliente ligadas à pessoa saem
 * junto com a conta, em todas as organizações. `null` quando não há ficha ligada.
 */
export function accountRecordsWarning(
  records: { customers: number; conversationCount: number } | undefined,
): string | null {
  if (!records || records.customers === 0) return null;

  const one = records.customers === 1;
  const where = one ? "uma organização" : `${records.customers} organizações`;
  const what = one ? "a ficha de cliente ligada a você" : "as fichas de cliente ligadas a você";
  const chats =
    records.conversationCount > 0
      ? ` e ${conversationsLabel(records.conversationCount)} de WhatsApp do seu número`
      : "";

  return `Você também é cliente de ${where}: ${what}${chats} ${deletedVerb(records.customers, records.conversationCount)}, sem volta, junto com a conta. A equipe de cada organização pode desfazer a ligação antes, para manter a ficha.`;
}
