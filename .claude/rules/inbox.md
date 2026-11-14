---
paths:
  - "src/lib/inbox/**"
  - "src/components/inbox/**"
  - "src/db/schema/inbox.ts"
  - "src/jobs/inbox.ts"
  - "src/api/inbox-events.ts"
  - "src/api/inbox-media-out.ts"
  - "src/api/inbox.ts"
  - "src/api/inbox-shared.ts"
  - "src/api/admin-inbox.ts"
  - "src/lib/schemas/inbox.ts"
---

# Caixa de entrada (contatos, conversas, mensagens e ingestão)

- Só `src/lib/inbox/` consulta `chat_contact`, `chat_contact_identity`, `conversation` e `message`. Rota e tela passam pelo serviço; toda leitura e escrita de conversa, mensagem, mídia e contato usa `visibleConversation(actor)` (`visibility.ts`, T13) e o que está fora dele responde 404, igual a id inexistente. Gancho de fora chama o serviço, nunca a tabela: remoção de membro, troca e edição de papel usam `releaseAssignments`/`releaseAssignmentsWithoutReply`; LGPD e exclusão de cliente usam `privacy.ts`.
- A rota (`src/api/inbox.ts`) só monta o `InboxActor` (`inboxActor(c)`) e valida com `src/lib/schemas/inbox.ts`; regra de permissão fina (`reply` × `assign`, `customer:read`) fica no serviço. Toda escrita passa por `blockMutationsWhileImpersonating`; rota nova entra em `rbac.test.ts` e, se escreve, no `it.each` de `impersonation.test.ts`.
- Assumir é `UPDATE ... WHERE assigned_user_id IS NULL` (nunca ler e depois gravar); responder a da fila a assume, responder a de outro (supervisor) não troca o dono; mudar a situação à mão não mexe no dono.
- Envio: mensagem `queued` gravada antes de falar com o provedor, `clientId` idempotente, janela de 24 h conferida no servidor (`window.ts`), provedor fora da transação; recusa vira `failed` com o motivo, sem resposta fica `queued` para o `inbox.sweep`.
- Envio (C5): texto, anexo e modelo passam por `queueMessage` + `dispatch` (`send.ts`; `send-media.ts`, `send-template.ts`). Anexo: `multipart`, tipo decidido pelo **conteúdo** (`classifyOutbound`, lista `OUTBOUND_MIME`), 16 MB conferidos antes de gravar, nada gravado em qualquer recusa, objeto apagado se a transação recusar; reenvio reaproveita o `file`. Modelo: só aprovado do WABA do canal, variáveis conferidas por `templates.ts` (a mesma função serve à prévia da tela); é a única forma com a janela fechada. `GET /api/inbox/media-out/:token` é a **única rota sem sessão** do atendimento: token HMAC de 5 min de um arquivo, só anexo enviado pela equipe, 404 igual para qualquer recusa; nunca ampliar o que ele serve.
- Mídia servida só pela rota autenticada, com o tipo decidido pelo conteúdo (`inboundMime` sobre os primeiros bytes), `inline` só para `INLINE_SAFE_MIME`, sempre `nosniff`.
- Serviços recebem `Scope` e rodam em `withScope`; `tenant_id` vem de `scopeTenantId(scope)`, nunca do aviso nem do corpo. A plataforma nunca consulta `customer` de tenant nem usa `withPlatformScope` no atendimento.
- Contato é achado pela `phone_key` (com e sem o 9º dígito). Telefone de provedor passa por `providerPhone` (normaliza com `+`). Vínculo automático com `customer` ou `user` só com correspondência única e telefone confirmado, o cliente antes do membro (`autoLinkContact`); o resto é manual. "Confirmado" na ficha é `team`, `whatsapp` ou `inbound` (a liberada à mão, `manual`, não atrai conversa); no membro é `userPhoneConfirmed(scope)` (`src/lib/phone/confirmed.ts`).
- Gravar conversa e mensagem é `INSERT ... ON CONFLICT` em um comando, idempotente: repetir o aviso não muda nada. `unread_count` só por incremento atômico; `last_inbound_at` só avança (`GREATEST`) e só com mensagem recebida. Mensagem do contato em conversa encerrada a reabre **sem dono**.
- `conversation.channel_id` é imutável (gatilho) e `restrict`: trocar de número é outra conversa.
- Status de entrega sobe a escada `queued < sent < delivered < read` em um `UPDATE` condicional; `failed` só a partir de `queued` ou `sent`.
- Falar com o provedor (baixar mídia) vem antes da transação. O tipo da mídia é conferido pelo conteúdo (`inboundMime`), nunca só pelo que o provedor diz; mídia vai para `file` com `owner_type = 'message'`.
- Trabalho que não pode rodar antes do commit (enfileirar `inbox.media`, apagar objeto) vai para a lista `after` do aviso.
- Toda escrita chama `notifyInbox(tx, ...)` na mesma transação: `pg_notify('inbox')` no `COMMIT`, carga só de ids (`s, c, k, m, a, p, u`; nunca texto, telefone ou nome). Quem muda o dono informa `a` e `p`; quem não sabe o dono omite `a` e o `notifyInbox` o lê.
- Tempo real (C4): uma conexão `LISTEN` por processo web (`realtime.ts`); o SSE (`src/api/inbox-events.ts`) filtra por pessoa com `noticeVisibleTo` (mesmo `reachOf` de `visibleConversation`; nunca outra regra à mão) e o cliente (`use-inbox-events.ts`) só **invalida** queries pelos ids, nunca escreve o evento no cache.
- Conteúdo de mensagem, telefone e nome nunca vão a `logError`, `audit_log`, Sentry ou `channel_event.error`. Erro de provedor só por `logChannelError`.
- LGPD (C7, `privacy.ts`): excluir ou anonimizar `customer` apaga os contatos vinculados (`purgeCustomerContacts`), excluir a organização apaga tudo do tenant e os `channel_event` (`purgeTenantInbox`, `purgeTenantChannelEvents`), anonimizar `user` só tira o autor e o vínculo, sem apagar conversa (`detachUserFromInbox`); a linha `file` e a chave saem na mesma transação e o objeto **depois do commit**. A exportação (`conversationsForExport`, só no portal) traz as conversas dos cadastros do titular, sem quem atendeu nem `payload`. Nunca exporte nem apague por vínculo com `user` (`chat_contact.user_id`): ele vem de telefone declarado, sem verificação. Única exceção (D-11): a ficha de cliente **ligada à pessoa da equipe** (`customer.user_id`) é apagada com a remoção do membro (naquela organização) e com a anonimização da conta (em todas), e só os contatos cujo `phone_key` é o do telefone **confirmado** da pessoa saem com ela (`purgeTeamCustomerContacts`); os demais perdem o vínculo e ficam. A equipe mantém a ficha desfazendo a ligação (`DELETE /api/customers/:id/team-link`). Dado pessoal novo entra aqui e em `docs/context/lgpd.md`.
- Tela (C3, `src/components/inbox/`): client-only, só pela API com TanStack Query (`inbox-api.ts`: chaves em `["inbox", tenantId, …]`, SSE com modo polling de reserva em `realtime-mode.ts`); o cliente só esconde botões, o servidor decide; texto de mensagem sempre como texto, links só `http(s)` com `rel="noopener noreferrer"`; conteúdo de mensagem nunca em `console.*` nem em log.
- Plataforma (C6, `src/api/admin-inbox.ts`, `platform.ts`, `platform-link.ts`): `Scope = platform` sempre em `withPlatformData`; só a lista (sem fila, dono, `claim`, `assign`, `assignees`, `candidates`, `customer`); `platformCapabilities(role)` decide `read` (qualquer papel de plataforma) e `reply` (`platform_owner` e `platform_support`, a única escrita do suporte em `/admin`; canal, etiqueta e campo seguem `ownerOnly`). **Nunca** `customer` de tenant, `customerId` nem `withPlatformScope` no atendimento da plataforma (`selectConversationRows(tx, scope)` não junta `customer` ali; `tests/db/inbox-platform.test.ts` e `platform.test.ts` guardam). Tela: componentes só leem o escopo de `inbox-scope.tsx` (`useInboxScope`, `useInboxCan`); nunca `/api/inbox` ou `/app/atendimento` à mão.
- Mudança aqui atualiza `docs/context/tech/30-caixa-de-entrada.md`.

Para entender este domínio, leia: docs/context/tech/30-caixa-de-entrada.md e docs/specs/caixa-de-entrada/spec.md
