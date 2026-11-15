import { setPhoneVerifyQueueForTests } from "@/lib/phone/dispatch";

/**
 * Padrão de todos os arquivos de `test:db`: o envio do link de verificação de telefone
 * (`phone.verify`) não vai ao pg-boss. Abrir pedido (cadastro, convite, portal) só registra o
 * pedido, como antes da T2b; quem testa o envio instala a própria fila
 * (`tests/db/phone-delivery.test.ts`) e chama o job direto.
 */
setPhoneVerifyQueueForTests(async () => {});
