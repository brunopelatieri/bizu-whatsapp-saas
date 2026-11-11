# PRD: Caixa de entrada (chat e fila de atendimento)

- **Status:** aprovado
- **Data:** 2026-11-09
- **Responsável:** Bruno Pelatieri
- **Programa:** `docs/specs/whatsapp-crm/plano.md`

> O PRD responde **o quê** e **por quê**. Tabelas, endpoints e componentes ficam na SPEC.

## Problema

Com um número de WhatsApp conectado à conta, as mensagens precisam de um lugar para chegar e
ser respondidas por mais de uma pessoa. Sem isso, dois atendentes respondem o mesmo cliente,
uma conversa fica sem dono e ninguém sabe quem ainda espera resposta.

O atendente também precisa saber com quem está falando: se o número é de um cliente já
cadastrado, quais etiquetas ele tem, quais dados do cadastro importam.

## Objetivo e métrica de sucesso

- **Objetivo:** a equipe do owner atende pelo WhatsApp dentro do sistema, com uma fila de
  conversas sem dono, conversas atribuídas a cada pessoa e o cadastro do cliente ao lado do
  chat. O proprietário da plataforma atende owners e equipes numa caixa única, sem fila.
- **Métrica:** mensagem recebida aparece na tela de quem está com a caixa aberta em até 3
  segundos. Nenhuma conversa é assumida por duas pessoas. Com dois atendentes, o tempo até a
  primeira resposta de uma conversa na fila fica visível e cai em relação ao celular
  compartilhado (medida do owner).

## Usuários

| Perfil | Precisa conseguir |
|---|---|
| Membro do tenant | Ver a fila e as próprias conversas, assumir, responder, devolver à fila, encerrar e reabrir |
| Admin e owner do tenant | Tudo isso, mais ver as conversas de todos e transferir para outra pessoa |
| Proprietário e suporte da plataforma | Ver e responder todas as conversas da plataforma, sem fila (o suporte responde; só o proprietário configura canal, etiquetas e campos) |
| Cliente do owner, equipe do owner | Nada muda: continuam usando o WhatsApp normal |

## Escopo

**Dentro:**

- Lista de conversas com busca, filtros, não lidas e ordenação pela última mensagem.
- Conversa com texto, imagem, vídeo, áudio, documento, localização e modelo de mensagem.
- Envio de texto, anexo e modelo aprovado; resposta citando uma mensagem.
- Fila de atendimento: assumir, devolver, transferir, encerrar e reabrir.
- Painel do contato: quem é, vínculo com o cadastro, etiquetas e campos adicionais.
- Salvar um número desconhecido como cliente ou ligá-lo a um cliente existente.
- Iniciar conversa com um cliente ou membro que tem telefone.
- Atualização em tempo real e contador de não lidas no menu.
- Caixa da plataforma em `/admin`, sem fila.

**Fora:**

- Distribuição automática de conversas (rodízio), quadro de atribuição e supervisão "ver como".
- Respostas rápidas, mensagens interativas de saída, reações, apagar mensagem, favoritos.
- Gravação de áudio no navegador (dá para anexar um arquivo de áudio).
- Notas internas na conversa, resposta automática, IA, automações e disparos.
- Exportação de conversa e retenção automática de mensagens.
- Grupos do WhatsApp e status.
- Conversa da equipe entre si dentro do sistema (chat interno).
- A plataforma iniciar conversa com os clientes dos owners ou consultar o cadastro deles
  (decisão do proprietário: o cliente é do owner e a plataforma é operadora).

## Requisitos funcionais

| ID | Requisito | Prioridade |
|---|---|---|
| RF-01 | Toda mensagem recebida em um número conectado aparece numa conversa, uma por contato e por número | Must |
| RF-02 | A lista mostra nome ou telefone, prévia e hora da última mensagem, quantidade de não lidas, situação e etiquetas do cliente | Must |
| RF-03 | A lista filtra por situação (aberta, pendente, encerrada), não lidas, número e etiqueta, e busca por nome e telefone | Must |
| RF-04 | A caixa do tenant tem as visões "Fila" (sem dono) e "Minhas"; admin e owner têm também "Todas", com filtro por atendente | Must |
| RF-05 | Qualquer atendente assume uma conversa da fila; se outro assumiu antes, ele é avisado e nada muda | Must |
| RF-06 | Responder uma conversa da fila a assume; responder a conversa de outro atendente (admin) não a toma | Must |
| RF-07 | O atendente devolve a própria conversa à fila; só quem tem permissão transfere para outra pessoa | Must |
| RF-08 | Membro comum não vê as conversas de outros atendentes, nem por link direto | Must |
| RF-09 | A conversa pode ser marcada como pendente, encerrada ou reaberta; mensagem nova do contato reabre a conversa encerrada e a devolve à fila, sem dono. Reabrir à mão só muda a situação e mantém o dono | Must |
| RF-10 | A conversa mostra as mensagens em ordem, agrupadas por dia, carregando as antigas sob demanda | Must |
| RF-11 | Cada mensagem enviada mostra o estado: enviando, enviada, entregue, lida ou falhou, com o motivo da falha | Must |
| RF-12 | Mensagem que falhou continua na conversa e pode ser reenviada com um clique | Must |
| RF-13 | O atendente envia texto e anexos (imagem, vídeo, áudio, documento) de até 16 MB, com legenda | Must |
| RF-14 | Em número oficial, fora da janela de 24 horas, o campo de texto fica bloqueado com a explicação, e o atendente envia um modelo aprovado | Must |
| RF-15 | O atendente responde citando uma mensagem, e a citação recebida aparece | Should |
| RF-16 | Mídia recebida é guardada no sistema e abre na conversa; se o download falhar, há como tentar de novo | Must |
| RF-17 | Abrir a conversa zera as não lidas; o menu mostra um sinal quando há não lidas na fila ou nas minhas | Must |
| RF-18 | Mensagem nova, mudança de estado e mudança de dono aparecem sem recarregar a página | Must |
| RF-19 | O painel do contato mostra telefone, nome no WhatsApp e, quando há vínculo, o cadastro do cliente com etiquetas e campos adicionais, editáveis ali | Must |
| RF-20 | Número desconhecido aparece como "não identificado"; o atendente o salva como cliente ou o liga a um cliente existente | Must |
| RF-21 | Número que já é de um cliente ou de um membro da equipe é reconhecido sozinho na primeira mensagem | Must |
| RF-22 | O atendente inicia uma conversa a partir do cliente ou do membro, escolhendo o número de saída | Must |
| RF-23 | Mensagem enviada pelo celular (número por QR Code) aparece na conversa como enviada pela empresa | Should |
| RF-24 | Quando a conversa é atribuída a alguém por outra pessoa, o novo dono é avisado na tela | Should |
| RF-25 | Membro removido da equipe tem as conversas devolvidas à fila | Must |
| RF-26 | A caixa da plataforma mostra todas as conversas a quem é da plataforma, sem fila nem dono | Must |
| RF-27 | Na plataforma, o painel mostra a pessoa, as organizações a que pertence e as etiquetas e campos de cada organização | Must |
| RF-28 | A plataforma inicia conversa com owner e equipe de qualquer organização. Não inicia conversa com clientes dos owners nem consulta o cadastro deles | Must |
| RF-29 | Sessão de suporte personificando um usuário lê as conversas do tenant, mas não envia mensagem | Must |
| RF-30 | Assumir, transferir, devolver, encerrar e reabrir ficam registrados, com quem fez | Should |

## Requisitos não funcionais

- **Isolamento:** conversa e mídia de um tenant nunca aparecem em outro; as da plataforma, em
  nenhum.
- **Privacidade:** conteúdo de mensagem não vai para log nem para a auditoria. Exclusão LGPD
  de cliente e de organização apaga as conversas e as mídias.
- **Desempenho:** lista e conversa paginadas; abrir uma conversa com 10 mil mensagens carrega
  só a última página.
- **Responsividade:** em tela estreita, lista, conversa e painel viram telas empilhadas.
- **Resiliência:** sem conexão de tempo real, a tela continua funcionando com atualização
  periódica e mostra que está desatualizada.

## Critérios de aceite

- [x] Dado um número conectado, quando um número novo manda "oi", então nasce uma conversa na fila, com o contato "não identificado", em até 3 segundos na tela aberta.
  Evidência: `inbox-ingest.test.ts` ("número novo cria contato não identificado e conversa na fila") e `inbox-realtime.test.ts` (ingestão em outro processo chega ao SSE). **Os 3 s na tela aberta: só pelo smoke** (ver "Verificação" da SPEC).
- [x] Dado um cliente cadastrado com aquele telefone, quando ele escreve, então a conversa já mostra o nome e as etiquetas do cliente.
  Evidência: Nome: `inbox-ingest.test.ts` ("cliente reconhecido quando o provedor entrega o celular sem o 9º dígito") e `inbox-queue.test.ts` (detalhe com vínculo). **Etiquetas na lista: sem teste automatizado** (só a consulta `tagsOfCustomers` por página; conferir no smoke).
- [x] Dados dois atendentes clicando em "Assumir" ao mesmo tempo, quando as chamadas chegam, então um assume e o outro recebe o aviso de que já tem dono.
  Evidência: `inbox-queue.test.ts` ("dois cliques ao mesmo tempo: um assume, o outro recebe 409 com o nome do dono").
- [x] Dado um membro comum, quando abre o link de uma conversa atribuída a outro, então recebe "não encontrada".
  Evidência: `inbox-queue.test.ts` (matriz de visibilidade: 404 na conversa de outro membro).
- [x] Dado um membro comum, quando tenta transferir a própria conversa para um colega, então recebe 403.
  Evidência: `inbox-queue.test.ts` ("o membro devolve a própria à fila, mas não transfere (403)").
- [x] Dada uma conversa encerrada, quando o contato escreve, então ela volta a "aberta", sem dono, e aparece na fila (inclusive se o dono anterior ainda for da equipe).
  Evidência: `inbox-ingest.test.ts` ("encerrada reabre sem dono, na fila, mesmo com o dono anterior ainda na equipe").
- [x] Dado um número oficial e a última mensagem do contato há 25 horas, quando o atendente tenta enviar texto, então a tela bloqueia e a API responde 409; enviar modelo funciona.
  Evidência: API: `inbox-send.test.ts` ("janela de 24 h: Cloud ... há 25 h é 409") e `inbox-media-send.test.ts` ("com a janela fechada o modelo sai"). **O bloqueio na tela: sem teste de componente** (smoke da C5).
- [x] Dado um envio que o provedor recusa, quando a resposta chega, então a mensagem fica "falhou" com o motivo e o botão de reenviar.
  Evidência: `inbox-send.test.ts` ("recusa do provedor: 200 com a mensagem failed e o motivo; reenviar troca pela nova").
- [x] Dada uma imagem recebida, quando o atendente abre a conversa, então a imagem aparece; outro tenant com o endereço da mídia recebe 404.
  Evidência: `inbox-queue.test.ts` ("serve inline só o tipo seguro" e "mídia da conversa de outro membro ou de outro tenant é 404").
- [x] Dado um contato não identificado, quando o atendente clica em "Salvar como cliente" com o plano no limite, então recebe `PLAN_LIMIT_REACHED` e a conversa continua.
  Evidência: `inbox-contacts.test.ts` ("plano no limite: 403 PLAN_LIMIT_REACHED e a conversa continua").
- [x] Dado o mesmo aviso de entrega recebido fora de ordem (lida antes de entregue), quando os dois são aplicados, então a mensagem termina "lida".
  Evidência: `inbox-ingest.test.ts` ("fora de ordem (lida antes de entregue) termina lida") e `whatsapp_cloud/inbox.db.test.ts`.
- [x] Dado um membro removido da equipe, quando a remoção termina, então as conversas dele estão na fila.
  Evidência: `inbox-queue.test.ts` ("as conversas dele voltam à fila; trocar o papel ... também"); edição de papel: `inbox-lgpd.test.ts` (C7).
- [x] Dado o suporte personificando um membro, quando tenta enviar mensagem, então recebe 403.
  Evidência: `impersonation.test.ts` (`it.each` das escritas de `/api/inbox`) e `inbox-platform.test.ts` (personificação).
- [x] Dado o proprietário da plataforma, quando abre `/admin/atendimento`, então vê todas as conversas da plataforma e nenhuma de tenant.
  Evidência: `inbox-platform.test.ts` ("nenhuma conversa de tenant aparece na plataforma ... e vice-versa").
- [x] Dado o suporte da plataforma, quando responde uma conversa de `/admin/atendimento`, então a mensagem é enviada; quando tenta criar ou editar canal, etiqueta ou campo, então recebe 403.
  Evidência: `inbox-platform.test.ts` ("o suporte responde, mas não mexe em canal, etiqueta nem campo; o proprietário, sim").
- [x] Dado o telefone de um cliente de um owner que escreve para um número da plataforma, quando a mensagem chega, então a conversa aparece como "não identificado" (ou ligada a um `user`, se for o caso) e nenhum dado de `customer` de tenant é lido ou mostrado.
  Evidência: `inbox-ingest.test.ts` ("plataforma: vincula usuário ..., nunca consulta cliente de tenant") e `inbox-platform.test.ts` ("cliente de tenant com o mesmo telefone não aparece").
- [x] Dado o proprietário da plataforma, quando tenta iniciar conversa com um `customerId` pela API, então a rota não aceita o campo (400).
  Evidência: `inbox-platform.test.ts` ("... customerId é 400 ...").
- [x] Dado um membro comum, quando abre "Fila", então vê todas as conversas sem dono do tenant, de qualquer número.
  Evidência: `inbox-queue.test.ts` ("o membro vê a fila e as próprias"). **Parcial:** a matriz usa um número só; "de qualquer número" vem do predicado (`visibleConversation` não filtra por canal), sem teste com dois números.

Requisito não funcional de privacidade (LGPD das conversas, C7): `inbox-lgpd.test.ts` (exclusão e anonimização do
cliente, da pessoa e da organização, exportação, isolamento entre tenants).

**Sem evidência automatizada (só smoke):** os 3 s na tela aberta, as etiquetas na lista e o bloqueio do campo na tela
fora da janela de 24 h. O resultado do smoke da C7 está na seção "Verificação" da SPEC.

## Riscos e dependências

- **Volume:** conta com muitas conversas simultâneas exige paginação e índices desde o início;
  a origem carregava tudo de uma vez.
- **Tempo real sem serviço pronto:** depende de conexão direta com o Postgres; atrás de pooler
  em modo transaction não funciona (mesma restrição da fila de jobs).
- **Identificador oculto do WhatsApp (LID)** no canal por QR Code: mensagem de quem só tem LID
  conhecido não pode ser ligada a um telefone e é descartada.
- **Plataforma e clientes dos owners:** risco jurídico (LGPD) evitado por decisão: fora do
  escopo (ver o plano). Reabrir o tema exige base legal e cláusula nos termos.
- Depende de `crm-cadastro` (telefone, etiquetas, campos) e de `whatsapp-canais`.

## Decisões do proprietário (2026-11-09)

- **Nome no menu:** "Atendimento".
- **`platform_support` responde na caixa da plataforma:** sim (RF-26). Configurar canal,
  etiquetas e campos continua só com `platform_owner`.
- **Conversa encerrada que reabre por mensagem do contato:** volta para a fila, sem dono
  (RF-09). A reabertura manual mantém o dono, como na origem (`zap-crm-br-client`), onde mudar o
  status não mexe na atribuição.
- **Membro comum e a fila:** vê a fila inteira, de todos os números, e as próprias conversas
  (RF-04, RF-08).
- **Plataforma e clientes dos owners:** fora do escopo (RF-28).
