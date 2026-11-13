import { assertAbsoluteUrl } from "@/lib/email/templates/format";
import { renderLayout } from "@/lib/email/templates/layout";

export type PhoneVerificationManualInput = {
  /** Quem libera: o owner da organização ou o proprietário da plataforma. */
  name: string;
  /** Nome do cadastro que espera (a pessoa da equipe ou o cliente). */
  personName: string;
  /** Só os 4 últimos dígitos: o e-mail nunca leva o número inteiro. */
  phoneHint: string;
  /** "na equipe de Acme Ltda", "nos clientes de Acme Ltda" ou "na plataforma". */
  where: string;
  url: string;
};

export const previewInput: PhoneVerificationManualInput = {
  name: "Ana",
  personName: "Carlos Souza",
  phoneHint: "4321",
  where: "na equipe de Acme Ltda",
  url: "http://localhost:5173/app/equipe",
};

/**
 * O link de verificação não saiu (nenhum número de WhatsApp apto, ou todos falharam): o
 * responsável libera à mão, depois de conferir o número por outro meio.
 */
export function phoneVerificationManualTemplate(input: PhoneVerificationManualInput) {
  return renderLayout({
    subject: `Telefone aguardando liberação: ${input.personName}`,
    heading: `Olá, ${input.name}`,
    paragraphs: [
      `Não conseguimos enviar o link de confirmação do WhatsApp de ${input.personName} (final ${input.phoneHint}), ${input.where}.`,
      "Confira o número com a pessoa por outro meio antes de liberar. A liberação à mão não prova que o número é dela.",
    ],
    action: { label: "Ver pedidos de liberação", url: assertAbsoluteUrl(input.url) },
  });
}
