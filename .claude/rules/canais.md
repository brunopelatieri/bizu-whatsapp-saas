---
paths:
  - "src/lib/channels/**"
  - "src/db/schema/channels.ts"
  - "src/api/channels.ts"
  - "src/api/webhooks-channels.ts"
  - "src/api/admin-channel-events.ts"
  - "src/jobs/channels.ts"
  - "src/lib/schemas/channels.ts"
---

# Canais de WhatsApp (módulos, caixa de avisos e segredos)

- Cada motor é um módulo em `src/lib/channels/providers/<id>/`, ligado por `CHANNEL_PROVIDERS`. O núcleo nunca importa a pasta de um módulo nem o nome dele; pergunte à capacidade (`can`), não ao tipo. Prova: `npm run check:module-removal -- whatsapp_cloud|whatsapp_qr`.
- Teste com banco de um módulo fica na pasta dele (`*.db.test.ts`); `tests/db/` não importa módulo.
- Serviços recebem `Scope` e abrem `withScope`; `tenant_id` vem do escopo, nunca do corpo. Canal de outro escopo responde 404.
- Segredo (`*_enc`) só entra por `sealSecret` e só se decifra em `credentials.ts`; nenhuma resposta, log ou auditoria o traz. `ChannelView` não tem coluna `_enc`.
- Webhook verifica sobre o corpo cru, grava em `channel_event` e enfileira `channel.inbound`; quem aplica é o job, com retry. Assinatura inválida: 401, sem gravar. Sem `app_secret`, não há canal Cloud (falha fechada).
- Roteamento por `phone_number_id` só entre os canais do escopo do canal verificado.
- Falar com o provedor vem antes da transação local. Erro de provedor vai a log só por `logChannelError` (sem a mensagem dele).
- Limite do plano: `assertChannelWithinLimit` com `lockScopeType` na mesma transação da criação.
- Mudança aqui atualiza `docs/context/tech/29-canais-whatsapp.md`.

Para entender este domínio, leia: docs/context/tech/29-canais-whatsapp.md
