---
paths:
  - "src/lib/inbox/**"
  - "src/components/inbox/**"
  - "src/db/schema/inbox.ts"
  - "src/jobs/inbox.ts"
---

# Caixa de entrada (contatos, conversas, mensagens e ingestão)

- Só `src/lib/inbox/` consulta `chat_contact`, `chat_contact_identity`, `conversation` e `message`. Rota e tela passam pelo serviço; a partir da C2, toda leitura e escrita de conversa usa o predicado de visibilidade (`visibility.ts`, T13) e conversa fora dele responde 404.
- Serviços recebem `Scope` e rodam em `withScope`; `tenant_id` vem de `scopeTenantId(scope)`, nunca do aviso nem do corpo. A plataforma nunca consulta `customer` de tenant nem usa `withPlatformScope` no atendimento.
- Contato é achado pela `phone_key` (com e sem o 9º dígito). Telefone de provedor passa por `providerPhone` (normaliza com `+`). Vínculo automático com `user` ou `customer` só com correspondência única (`autoLinkContact`); o resto é manual.
- Gravar conversa e mensagem é `INSERT ... ON CONFLICT` em um comando, idempotente: repetir o aviso não muda nada. `unread_count` só por incremento atômico; `last_inbound_at` só avança (`GREATEST`) e só com mensagem recebida. Mensagem do contato em conversa encerrada a reabre **sem dono**.
- `conversation.channel_id` é imutável (gatilho) e `restrict`: trocar de número é outra conversa.
- Status de entrega sobe a escada `queued < sent < delivered < read` em um `UPDATE` condicional; `failed` só a partir de `queued` ou `sent`.
- Falar com o provedor (baixar mídia) vem antes da transação. O tipo da mídia é conferido pelo conteúdo (`inboundMime`), nunca só pelo que o provedor diz; mídia vai para `file` com `owner_type = 'message'`.
- Trabalho que não pode rodar antes do commit (enfileirar `inbox.media`, apagar objeto) vai para a lista `after` do aviso.
- Toda escrita chama `notifyInbox(tx, ...)` na mesma transação (só ids; o corpo é da C4).
- Conteúdo de mensagem, telefone e nome nunca vão a `logError`, `audit_log`, Sentry ou `channel_event.error`. Erro de provedor só por `logChannelError`.
- Dado pessoal novo entra na exportação e na anonimização (C7 cobre as conversas: até lá, `docs/context/lgpd.md` marca como pendente).
- Mudança aqui atualiza `docs/context/tech/30-caixa-de-entrada.md`.

Para entender este domínio, leia: docs/context/tech/30-caixa-de-entrada.md e docs/specs/caixa-de-entrada/spec.md
