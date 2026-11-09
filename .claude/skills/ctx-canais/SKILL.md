---
name: ctx-canais
description: Use ao mexer em canais de WhatsApp (Cloud API, Evolution Go), webhooks de canal, channel_event ou limites de canal por plano.
---

Leia `docs/context/tech/29-canais-whatsapp.md` e a SPEC `docs/specs/whatsapp-canais/spec.md` antes de planejar ou implementar.

Lembre: segredo só cifrado e só decifrado em `src/lib/channels/credentials.ts`; o núcleo nunca importa a pasta de um módulo; webhook grava e enfileira, quem aplica é o job; nenhum segredo, telefone ou corpo de aviso em log.

Se a mudança alterar o que esse arquivo descreve, atualize-o no mesmo trabalho.
