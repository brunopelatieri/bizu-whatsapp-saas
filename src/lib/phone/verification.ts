/**
 * Como o telefone de um cadastro foi confirmado (`phone_verified_via`). Sem valor, o número é
 * só declarado: não atrai o vínculo automático da conversa nem conta na unicidade das contas
 * (`docs/specs/pre-producao/spec.md`, bloco T).
 *
 * - `whatsapp`: a pessoa confirmou, na própria sessão, o link enviado ao número. É a única
 *   **prova de posse**.
 * - `manual`: liberado à mão. Na conta (`user`, `portal_user`), pelo proprietário da
 *   plataforma; na ficha de cliente, pelo owner da organização dela.
 * - `team`: telefone de cliente informado pela equipe (cadastro ou importação).
 * - `inbound`: cliente salvo a partir de um contato que escreveu pelo WhatsApp.
 *
 * **O que vale onde.** A conta é global e qualquer pessoa cria uma organização, então o que uma
 * organização atesta não pode valer fora dela. Por isso estas colunas, **na conta**, só guardam o
 * que vale no sistema inteiro: `whatsapp` e `manual` (plataforma). A liberação do owner de uma
 * organização sobre a conta de um membro não fica aqui: é uma linha em `phone_tenant_vouch`, por
 * par (conta, organização), e vale só naquela organização (`src/lib/phone/confirmed.ts`). A
 * ficha de cliente é da organização, e todas as formas dela são locais por natureza. A conta do
 * portal só recebe `whatsapp` ou `manual`: nunca herda `team` nem a liberação de uma
 * organização.
 */
export const phoneVerifiedVia = ["whatsapp", "manual", "team", "inbound"] as const;
export type PhoneVerifiedVia = (typeof phoneVerifiedVia)[number];

/** As duas colunas, para marcar o número atual como confirmado. */
export function verifiedPhone(via: PhoneVerifiedVia, at = new Date()) {
  return { phoneVerifiedAt: at, phoneVerifiedVia: via };
}

/** As duas colunas, para o número que acabou de mudar e ainda não foi confirmado. */
export const UNVERIFIED_PHONE = { phoneVerifiedAt: null, phoneVerifiedVia: null } as const;


/** De quem é o telefone de um pedido de confirmação (`phone_verification`). */
export const phoneVerificationSubjects = ["user", "customer"] as const;
export type PhoneVerificationSubject = (typeof phoneVerificationSubjects)[number];

/**
 * Situação do pedido: `sent` tem um link válido a caminho da pessoa; `awaiting_manual` espera a
 * liberação do responsável (sem canal para enviar, ou todos falharam); `confirmed` e `canceled`
 * estão encerrados.
 */
export const phoneVerificationStatuses = [
  "sent",
  "awaiting_manual",
  "confirmed",
  "canceled",
] as const;
export type PhoneVerificationStatus = (typeof phoneVerificationStatuses)[number];

/**
 * As formas de confirmação da FICHA de cliente que atraem, sozinhas, a conversa de quem tiver o
 * número e a ligação com a pessoa da equipe que o tem. `manual` fica de fora: é o número que o
 * próprio cliente declarou e o owner liberou sem prova de posse.
 */
export const AUTO_LINK_CUSTOMER_VIAS = ["whatsapp", "team", "inbound"] as const satisfies readonly PhoneVerifiedVia[];

export const attractsConversations = (via: PhoneVerifiedVia) =>
  (AUTO_LINK_CUSTOMER_VIAS as readonly PhoneVerifiedVia[]).includes(via);

/**
 * Uma tentativa de envio do link (`phone_verification.attempts`). Só ids, tipo, hora, resultado e
 * o código do erro: nunca o telefone, o texto da mensagem nem o token.
 *
 * - `sent`: o provedor aceitou a mensagem.
 * - `failed`: o provedor recusou na chamada, ou o aviso de status disse `failed` depois.
 * - `skipped`: o canal não estava apto (Cloud sem modelo de verificação, por exemplo).
 * - `limited`: o cadastro já recebeu o máximo de links da hora.
 */
export type PhoneDeliveryAttempt = {
  channelId: string | null;
  type: string | null;
  at: string;
  outcome: "sent" | "failed" | "skipped" | "limited";
  error?: string | null;
};
