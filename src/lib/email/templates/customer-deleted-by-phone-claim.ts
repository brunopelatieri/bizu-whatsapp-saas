import { assertAbsoluteUrl } from "@/lib/email/templates/format";
import { renderLayout } from "@/lib/email/templates/layout";

export type CustomerDeletedByPhoneClaimInput = {
  name: string;
  tenantName: string;
  /** Só os 4 últimos dígitos: o e-mail nunca leva o número inteiro. */
  phoneHint: string;
  /** A ficha nova, em `/app/clientes/:id`. */
  url: string;
};

export const previewInput: CustomerDeletedByPhoneClaimInput = {
  name: "Ana",
  tenantName: "Clínica Exemplo",
  phoneHint: "4321",
  url: "http://localhost:5173/app/clientes/00000000-0000-0000-0000-000000000000",
};

/**
 * Aviso ao owner (SPEC `pre-producao`, "Telefone que já existe", D-1): alguém se cadastrou no portal
 * com um número que já era de uma ficha, provou pelo link no WhatsApp que o número é dele, e a ficha
 * antiga foi apagada com as conversas. Sem o nome da ficha apagada: ela não existe mais.
 */
export function customerDeletedByPhoneClaimTemplate(input: CustomerDeletedByPhoneClaimInput) {
  return renderLayout({
    subject: "Uma ficha de cliente foi substituída pelo dono do número",
    heading: `Olá, ${input.name}`,
    paragraphs: [
      `Uma pessoa se cadastrou no portal de ${input.tenantName} com o WhatsApp de final ${input.phoneHint} e confirmou pelo link enviado a esse número que ele é dela.`,
      "A ficha de cliente que tinha esse número foi apagada, com as conversas, as mensagens e os arquivos do atendimento ligados a ela, e uma ficha nova foi criada para quem confirmou.",
      "Se você não reconhece essa mudança, confira a auditoria da organização.",
    ],
    action: { label: "Abrir a ficha nova", url: assertAbsoluteUrl(input.url) },
  });
}
