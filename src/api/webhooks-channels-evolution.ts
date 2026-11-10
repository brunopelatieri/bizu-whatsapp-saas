import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MINUTE } from "@/api/guards";
import { logError } from "@/api/log";
import { clientKey, failureLimit } from "@/api/rate-limit";
import { receivePairingWebhook } from "@/lib/channels/inbound-pairing";
import { logChannelError } from "@/lib/channels/log";

/**
 * `POST /api/webhooks/whatsapp/evolution/:secret`: porta de entrada do servidor Evolution Go
 * (`docs/specs/whatsapp-canais/spec.md`, "Webhooks"). Fica fora de `sameOrigin` e do CSRF, como
 * `/api/webhooks/payments/*`: quem chama é um servidor, não uma página do app.
 *
 * - 413 acima de 25 MB (a mídia vem em base64 dentro do aviso).
 * - 401 **sem detalhe** em qualquer falha da cadeia de verificação; nada é gravado.
 * - O limite por IP conta só as falhas (20 por minuto) e é checado depois delas: o servidor
 *   legítimo manda volume.
 * - Canal `disabled` responde 200 e descarta.
 *
 * Sub-router próprio para o merge com o fluxo comum (`webhooks-channels.ts`) ser uma linha.
 */
export const evolutionWebhooks = new Hono();

export const EVOLUTION_WEBHOOK_MAX_BYTES = 25 * 1024 * 1024;

const rejectedLimit = failureLimit({ limit: 20, windowMs: MINUTE });

evolutionWebhooks.post(
  "/api/webhooks/whatsapp/evolution/:secret",
  bodyLimit({
    maxSize: EVOLUTION_WEBHOOK_MAX_BYTES,
    onError: (c) => c.json({ error: "Corpo muito grande." }, 413),
  }),
  async (c) => {
    let outcome: Awaited<ReturnType<typeof receivePairingWebhook>>;

    try {
      outcome = await receivePairingWebhook({
        pathSecret: c.req.param("secret"),
        readBody: () => c.req.text(),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      });
    } catch (error) {
      // Sem o corpo, sem o segredo do caminho: só o tipo do erro.
      logChannelError("Falha ao receber webhook de canal", error);
      // 5xx faz a Evolution reenviar; o reenvio cai na única e só reenfileira o que parou.
      return c.json({ error: "Não foi possível processar agora." }, 500);
    }

    if (outcome === "unauthorized") {
      const ip = clientKey(c);

      if (rejectedLimit.blocked(ip)) {
        return c.json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
      }
      rejectedLimit.hit(ip);
      logError("Webhook de canal recusado", new Error("cadeia de verificação falhou"));
      return c.json({ error: "Não autorizado." }, 401);
    }

    if (outcome === "unavailable") return c.json({ error: "Indisponível." }, 503);

    return c.json({ received: true, ...(outcome === "duplicate" ? { status: "duplicate" } : {}) });
  },
);
