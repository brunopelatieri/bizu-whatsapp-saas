---
name: ctx-inbox
description: Use ao mexer na caixa de entrada (atendimento por WhatsApp): chat_contact, conversas, mensagens, fila, envio, SSE, mídia, /app/atendimento, /admin/atendimento ou a LGPD das conversas.
---

Leia `docs/context/tech/30-caixa-de-entrada.md` e a SPEC `docs/specs/caixa-de-entrada/spec.md` antes de planejar ou implementar. A configuração dos números é de `tech/29-canais-whatsapp.md` (skill `ctx-canais`).

Lembre: só `src/lib/inbox/` consulta as tabelas da caixa; toda leitura e escrita passa por `visibleConversation(actor)` e o que está fora dele é 404; o SSE leva só ids e a tela relê pela API; conteúdo de mensagem, telefone e nome nunca vão a log, auditoria ou Sentry; a plataforma nunca consulta `customer` de tenant; dado pessoal novo entra na exportação e na exclusão (`src/lib/inbox/privacy.ts`).

Se a mudança alterar o que esse arquivo descreve, atualize-o no mesmo trabalho.
