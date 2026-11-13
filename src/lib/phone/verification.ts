/**
 * Como o telefone de um cadastro foi confirmado (`phone_verified_via`). Sem valor, o número é
 * só declarado: não atrai o vínculo automático da conversa nem conta na unicidade das contas
 * (`docs/specs/pre-producao/spec.md`, bloco T).
 *
 * - `whatsapp`: a pessoa clicou no link enviado ao número.
 * - `manual`: liberado pelo responsável (owner, ou o proprietário da plataforma).
 * - `team`: telefone de cliente informado pela equipe (cadastro ou importação).
 * - `inbound`: cliente salvo a partir de um contato que escreveu pelo WhatsApp.
 */
export const phoneVerifiedVia = ["whatsapp", "manual", "team", "inbound"] as const;
export type PhoneVerifiedVia = (typeof phoneVerifiedVia)[number];

/** As duas colunas, para marcar o número atual como confirmado. */
export function verifiedPhone(via: PhoneVerifiedVia, at = new Date()) {
  return { phoneVerifiedAt: at, phoneVerifiedVia: via };
}

/** As duas colunas, para o número que acabou de mudar e ainda não foi confirmado. */
export const UNVERIFIED_PHONE = { phoneVerifiedAt: null, phoneVerifiedVia: null } as const;
