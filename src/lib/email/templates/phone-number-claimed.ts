import { assertAbsoluteUrl } from "@/lib/email/templates/format";
import { renderLayout } from "@/lib/email/templates/layout";

export type PhoneNumberClaimedInput = {
  name: string;
  /** Só os 4 últimos dígitos: o e-mail nunca leva o número inteiro. */
  phoneHint: string;
  url: string;
};

export const previewInput: PhoneNumberClaimedInput = {
  name: "Ana",
  phoneHint: "4321",
  url: "http://localhost:5173/app",
};

/**
 * Outra conta provou, pelo link no WhatsApp, que o número é dela agora (celular troca de dono):
 * esta conta perdeu a confirmação e precisa confirmar um número que seja seu.
 */
export function phoneNumberClaimedTemplate(input: PhoneNumberClaimedInput) {
  return renderLayout({
    subject: "Seu telefone deixou de estar confirmado",
    heading: `Olá, ${input.name}`,
    paragraphs: [
      `O WhatsApp de final ${input.phoneHint} foi confirmado por outra conta, que provou receber mensagens nesse número.`,
      "Sua conta segue ativa, mas o telefone dela voltou a pendente. Se o número ainda é seu, confirme-o de novo; se mudou de número, atualize o cadastro.",
      "Se você não reconhece essa mudança, fale com o suporte.",
    ],
    action: { label: "Abrir minha conta", url: assertAbsoluteUrl(input.url) },
  });
}
