# Changelog

Todas as mudanças relevantes deste projeto ficam aqui. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o versionamento segue o
[SemVer](https://semver.org/lang/pt-BR/). Em `0.x`, uma versão menor pode trazer mudança
incompatível: leia sempre a seção **Migração** antes de atualizar um projeto derivado
(`docs/context/atualizar-template.md`).

## [Não lançado]

### Adicionado

- **Telefone que já existe: `claim` do autocadastro do portal (bloco T de `docs/specs/pre-producao/spec.md`, P3, D-1)**.
  - O autocadastro com o número de uma ficha que já existe responde como sempre e abre o pedido `purpose = claim`, com os dados da
    ficha nova em `payload`. **Confirmado o link na sessão do portal de quem se cadastrou, a ficha antiga é apagada** (contatos,
    conversas, mensagens e arquivos) e a nova nasce com o número confirmado. Auditoria `customer.deleted_by_phone_claim` e e-mail
    `customer-deleted-by-phone-claim` aos owners.
  - Sem rota pública; a liberação à mão nunca fecha `claim` (409 `CLAIM_LINK_ONLY`); o link só sai pela Cloud, nunca pelo QR Code
    (nem no reenvio, nem depois de uma falha); o pedido vencido é encerrado pela manutenção e o `payload` some.
  - A equipe não pede `claim` (decisão do proprietário): continua com 409 `PHONE_IN_USE`, e o diálogo diz como trocar o número da
    ficha existente ou excluí-la. A fila de clientes mostra o `claim` sem "Liberar".
  - **Migração:** `0040_telefone_claim` (coluna `payload`, `purpose` com `claim`, dois `CHECK`s e um índice único parcial). Rode
    `npm run db:migrate`.
- **Ligar a ficha de cliente à pessoa da equipe, à mão (bloco T de `docs/specs/pre-producao/spec.md`, D-9)**.
  - `PUT /api/customers/:id/team-link` (`customer:update`, fora da personificação, auditada como `customer.team_linked` com
    `via: manual`): só pessoa da equipe desta organização (404 de outra), nunca a si mesmo (403 `SELF_LINK`), uma ficha por pessoa e
    uma pessoa por ficha (409 `TEAM_MEMBER_HAS_CUSTOMER` / `CUSTOMER_ALREADY_LINKED`). `GET /api/customers/:id/team-candidates`
    (`customer:read` + `customer:update`) lista id, nome, papel e se já tem ficha.
  - **A ligação decide o que a remoção apaga (D-11):** removida a pessoa da equipe, ou excluída a conta, a ficha ligada à mão sai
    como a ligada pelo telefone, e dela só os contatos do telefone confirmado da pessoa.
  - Tela: cartão "Pessoa da equipe" na ficha sem ligação, com o diálogo que avisa o que a ligação muda e mostra o papel de cada pessoa.
  - **Migração:** nenhuma.
- **Retenção de mensagens, fase R3b: tela do `/admin` (bloco R de `docs/specs/pre-producao/spec.md`)**; só tela sobre as rotas da R2, sem migration e
  **sem código que apague mensagem** (a limpeza continua só no job diário, com `MESSAGE_RETENTION_ENABLED=true`). Fecha o bloco R.
  - Cartão "Retenção de mensagens" em `/admin/tenants/:id` (`TenantRetentionCard`): para cada tipo de canal, o que vale em cada limite (mensagens, dias,
    favoritas) e de onde vem ("fixado para esta organização", "padrão do sistema" ou "nenhum limite definido"), o piso de idade e a última limpeza
    (quando rodou e as contagens, ou "Nunca rodou.").
  - Edição da política, só para o `platform_owner` (o suporte lê): cada limite tem três opções distintas, herdar o padrão (`null`), sem limite (`0`) ou um
    número de 1 até o teto (`RETENTION_LIMIT_MAX`); vazio e `0` em "definir" são recusados na tela. Com a retenção ligada, salvar um limite
    mais apertado pede confirmação, mostrando de quanto para quanto.
  - Prévia sob demanda do que a limpeza faria agora (idade, contagem, favoritas rebaixadas, arquivos, lote cortado): não apaga nada e usa a política já
    gravada. Aviso de estado: retenção desligada (política gravada, nada é apagado) ou ligada (roda uma vez por dia e apaga sem volta; favorita e piso não saem).
  - Cartão "Retenção de mensagens da plataforma" em `/admin/configuracoes`: só leitura, com os padrões do sistema e a prévia.
  - Arquivos novos: `src/lib/inbox/retention-format.ts` (módulo puro), `src/components/admin/retention-scope.tsx` e `retention-card.tsx`.
  - **Migração:** nenhuma.
- **Retenção de mensagens, fase R2 (bloco R de `docs/specs/pre-producao/spec.md`)**: a limpeza. **Com `MESSAGE_RETENTION_ENABLED=true`, mensagens são
  apagadas sem volta.**
  - Serviço `src/lib/inbox/retention.ts`: por organização (e plataforma) e tipo de canal, nas fases idade, contagem (o teto vale para o escopo
    inteiro) e favoritas acima do teto (perdem a estrela e só somem no ciclo seguinte), com o piso de idade nas três, `MESSAGE_RETENTION_BATCH_LIMIT`
    por fase e `truncated`. Apaga a mídia da mensagem (linha `file` e objeto depois do commit); a conversa esvaziada fica, e a prévia do texto sai sempre que a última mensagem da conversa é apagada.
  - Prévia (`dryRun`) pelo mesmo código da execução: conta o que seria apagado, sem alterar nada, mesmo com a retenção desligada.
  - Job diário `inbox.retention` (04:45 UTC, fila `exclusive` com `singletonKey`); uma organização que falha não impede as outras.
    `scheduleDefinitions` aceita `singletonKey`.
  - Rotas `/api/admin/retention/*`: política efetiva por organização e tipo de canal, gravar a política (só `platform_owner`, auditada como
    `admin.retention_policy_updated`), prévia e última execução. A tela é a R3b.
  - Texto de privacidade (seção 6): mensagens e arquivos passam a ter limpeza automática; contatos e conversas seguem sem prazo. `LEGAL_VERSIONS`
    continua `2026-11`.
  - **Migração:** nenhuma migration. Projeto derivado com `MESSAGE_RETENTION_ENABLED=true` (o padrão de `docker/.env.prod.example`) passa a apagar
    mensagens no primeiro ciclo: confira os limites `MESSAGE_RETENTION_*` (ou desligue) antes de atualizar, e use a prévia do `/admin` para ver o efeito.
- **Retenção de mensagens, fase R1 (bloco R de `docs/specs/pre-producao/spec.md`)**: só a base; **nenhuma mensagem é apagada ainda**
  (a limpeza é a R2).
  - Migration `0039_retencao_mensagens`: `message.is_favorite`, `favorited_at` e `favorited_by` (a estrela é da conversa); tabelas
    `retention_policy` (política por organização e tipo de canal: `max_messages`, `retention_days`, `max_favorites`; `NULL` herda, `0` é sem
    limite) e `message_retention_state` (última execução por escopo), ambas só da plataforma (`platformOnlyPolicy()` + `FORCE`); índices
    `message_favorite_idx`, `message_tenant_created_idx` e `message_favorited_by_idx`.
  - Variáveis novas: `MESSAGE_RETENTION_ENABLED` (padrão `false`; **ligada em `docker/.env.prod.example`**),
    `MESSAGE_RETENTION_WHATSAPP_QR_*` e `MESSAGE_RETENTION_WHATSAPP_CLOUD_*` (`MAX_MESSAGES`, `DAYS`, `MAX_FAVORITES`; ausente ou `0` = sem limite),
    `MESSAGE_RETENTION_MIN_AGE_HOURS` (piso, 24 a 8760, padrão 72) e `MESSAGE_RETENTION_BATCH_LIMIT` (padrão 5000). Valor torto derruba a subida.
  - Módulo puro `src/lib/inbox/retention-policy.ts`: precedência (linha da política, depois `.env`, depois sem limite) e piso de idade
    que vale sobre qualquer política; desligada ou sem configuração, nunca apaga.
  - Anonimizar a conta zera `message.favorited_by` (a estrela fica).
  - **Migração:** rodar `npm run db:migrate`. Projeto derivado que usa `docker/.env.prod.example` passa a ter a retenção **ligada** quando a R2
    existir; hoje a variável não tem efeito.
- **Retenção de mensagens, fase R3a: estrela e aviso da conversa esvaziada (bloco R de `docs/specs/pre-producao/spec.md`)**; sem migration e
  **sem código que apague mensagem** (a limpeza é a R2; a tela de retenção do `/admin` é a R3b).
  - `PUT /api/inbox/messages/:id/favorite` e `PUT /api/admin/inbox/messages/:id/favorite` (`{ favorite: boolean }`): liga ou desliga a estrela da
    mensagem, com `inbox:reply` (na plataforma, `platform_owner` e `platform_support`) e a visibilidade por pessoa (fora dela, 404). Idempotente;
    grava e zera `is_favorite`, `favorited_at` e `favorited_by` juntos. Auditada (`inbox.message_favorited` e `inbox.message_unfavorited`, só ids),
    bloqueada em personificação, com aviso em tempo real só com ids. O teto de favoritas não recusa: quem rebaixa é a limpeza.
  - A leitura das mensagens traz `isFavorite`. Na tela do atendimento, o selo de estrela na bolha (a estrela é da conversa) e o botão de marcar e
    desmarcar ao lado do "Responder", só para quem pode responder.
  - Conversa sem mensagem e com `last_message_at` mostra "Mensagens antigas removidas pela política de retenção" (sem coluna nova).
  - **Migração:** nenhuma. A ação `inbox.message_favorited|unfavorited` entra na auditoria; nada a configurar.
- **Pré-produção: senha forte, bloqueio de login e telefone verificado (blocos S, B e fase T1 de
  `docs/specs/pre-producao/spec.md`)**:
  - **Senha forte:** toda senha nova exige 10 a 128 caracteres, com maiúscula, minúscula, número e caractere especial,
    no formulário (com medidor ao vivo) e no servidor, inclusive em chamada direta às rotas do Better Auth. A senha é
    gravada normalizada (sem espaço nas pontas, em NFC) e o login normaliza igual.
  - **Bloqueio de login por tentativas:** depois de `LOGIN_MAX_ATTEMPTS` senhas erradas em
    `LOGIN_ATTEMPT_WINDOW_MINUTES`, o login do e-mail fica bloqueado por `LOGIN_LOCKOUT_MINUTES`, na equipe e no portal.
    `LOGIN_LOCKOUT_SCOPE` escolhe `email` (padrão), `email_ip` ou `off`. O `sign-in/email` passa a aceitar **só JSON**.
  - **Telefone verificado e único (T1):** `customer`, `user` e `portal_user` ganham o estado de verificação do telefone;
    o vínculo automático das conversas só usa telefone confirmado, com o cliente antes do membro; o cliente que troca o
    próprio telefone no portal volta a pendente; a conta da equipe só aceita número que recebe WhatsApp; quem é da equipe
    pode ser também cliente da organização (`customer.user_id`); permissão reservada `phone:confirm`.
  - **Pedido de verificação de telefone (T2a):** tabelas `phone_verification` (um pedido por cadastro e responsável) e
    `phone_tenant_vouch` (liberação de uma organização para um membro). Rotas novas: `/api/me/phone-verification` e
    `/api/portal/me/phone-verification` (estado e confirmação pelo link, só na sessão do próprio cadastro),
    `/api/phone-verifications` (fila do owner, `phone:confirm`) e `/api/admin/phone-verifications` (fila do
    proprietário da plataforma). O que a plataforma confirma vale no sistema inteiro; o que uma organização confirma, à
    mão ou pelo link dela, vale só nela.
  - **Envio do link de verificação (T2b):** job `phone.verify` com a cascata da ordem de `PHONE_VERIFICATION_CHANNELS`
    (Cloud com o modelo de verificação do número, depois QR Code, depois a liberação à mão), sempre pelos números do
    **responsável** do pedido (a plataforma ou a organização; o banco recusa canal de outro escopo). O aviso `failed`
    que chega pelo webhook passa ao próximo número. A plataforma só manda o link sozinha a owners, à equipe dela e a quem
    não é de organização nenhuma (D-12); um link por número; 3 links por hora por cadastro. Rotas novas:
    `POST /api/me/phone-verification/resend`, `POST /api/portal/me/phone-verification/resend` e
    `PUT /api/channels/:id/verification-template` (e a de `/api/admin/channels`, com a URL do botão conferida contra
    `APP_URL`). `GET /api/me/phone-verification` e a do portal dizem a situação por responsável (mantêm `pending`). Página
    `/verificar-telefone` (e `/portal/verificar-telefone`): o botão confirma na sessão do próprio cadastro. A confirmação
    do portal deixa de exigir organização ativa (o lead do autocadastro confirma). E-mails novos:
    `phone-verification-manual` (ao responsável) e `phone-number-claimed` (à conta que perdeu a confirmação). O envio não
    entra na caixa de entrada. As filas ganharam tela na T4 (abaixo); o modelo, ainda não.
  - **Bloqueio com telefone pendente (T3):** com `PHONE_VERIFICATION_REQUIRED=true` (padrão), a conta cujo WhatsApp
    não vale recebe 403 `PHONE_UNVERIFIED` em toda rota privada da equipe, da plataforma e do portal, menos na lista
    fechada do que confirma o número ou sai (`src/api/phone-gate.ts`): ler o estado, reenviar, confirmar, trocar a
    organização em uso, aceitar convite, encerrar a personificação, pedir a exclusão da própria conta (LGPD: pedir,
    ver e desistir, com a senha de sempre) e, no portal, corrigir o número. O membro comum
    passa na organização ativa que o liberou; owner e equipe da plataforma, só com a confirmação da plataforma; o
    portal avalia a ficha de cliente da organização em uso. As leituras de `/api/auth/admin/*` ganham o mesmo portão.
    A área autenticada mostra só "Confirme seu WhatsApp" (situação por responsável, reenviar, trocar de
    organização, sair). Com `false`, a pessoa entra e vê um aviso; `/api/me` e `/api/portal/me` trazem
    `phonePending`. Decisões a confirmar: T3-1 a T3-9 da SPEC.
  - **Migração:** migrations `0034` (tabela `login_throttle`), `0035` (colunas de verificação e `customer.user_id`) e
    `0036` (as duas tabelas da T2a e o `CHECK` que só aceita `whatsapp` e `manual` nas contas; conta com outra forma
    volta a pendente; as fichas de cliente que a `0035` marcou `manual` passam a `team`, para continuarem atraindo as
    conversas do número) e `0037` (envio do link: colunas `channel_id`, `provider_message_id`, `attempts` e
    `manual_notified_at` em `phone_verification`, o modelo de verificação em `channel_whatsapp_cloud` e o gatilho que
    recusa canal de outro escopo no pedido). Variáveis novas, com padrão: `PHONE_VERIFICATION_TTL_MINUTES` (30) e
    `PHONE_VERIFICATION_CHANNELS` (vazio: nenhum envio, como antes). O token do link passou a ter prefixo (`u.` ou
    `c.`): links emitidos antes da `0037` deixam de valer (só havia emissão em teste). Rode o worker, ou
    `JOBS_MODE=inline`, para a fila `phone.verify` andar.
    Demais variáveis novas, todas com padrão: `LOGIN_LOCKOUT_SCOPE`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_ATTEMPT_WINDOW_MINUTES`,
    `LOGIN_LOCKOUT_MINUTES`. Projeto derivado com dados reais: (1) a `0035` marca como **confirmado** (`manual`) todo
    telefone que já existe, inclusive o declarado em autocadastro e os fixos de contas da equipe, para ninguém perder o
    vínculo das conversas; revise os que não forem de confiança; (2) senha antiga com espaço nas pontas deixa de entrar e
    volta pelo "esqueci a senha"; (3) conta da equipe com telefone fixo continua existindo, mas não passa mais no cadastro
    nem na edição pelo `/admin`; (4) integração que fazia login por formulário (`application/x-www-form-urlencoded`)
    precisa enviar JSON; (5) a ordem do vínculo automático mudou: com cliente e membro no mesmo número, a conversa vai
    para o cliente; (6) a conta do portal criada por convite nasce com o telefone pendente, e a ficha de cliente liberada
    à mão pelo owner não atrai conversas sozinha (a equipe vincula no painel).
  - **Telas da liberação à mão (T4, parcial):** fila de pedidos na aba "Telefones" de `/admin/usuarios` (só o
    proprietário) e em `/app/equipe` e `/app/clientes` (`phone:confirm`), com confirmação, o aviso de que a liberação
    à mão não prova que o número é da pessoa e uma mensagem para cada recusa. Seção "Modelo de verificação de
    telefone" em "Gerenciar" do número Cloud (escolher entre os modelos aprovados sincronizados, tirar, sincronizar e
    ver o motivo do 422), em `/app` e `/admin`. A leitura do canal (`GET /api/channels` e `/api/admin/channels`)
    ganhou o campo `verificationTemplate` (`{ name, language }` ou `null`). Nenhuma rota nova, permissão ou
    migration. Texto da tela "Confirme seu WhatsApp" corrigido. **Pendentes:** modelo de verificação na tela do
    canal), troca de telefone e `claim`. Decisões a confirmar: T4-1 a T4-4.
  - **Troca de telefone pelo pedido (bloco T):** o cadastro mantém o número antigo, e a confirmação dele, até o link do
    número novo ser confirmado na sessão do próprio cadastro ou o responsável liberar. Rotas novas:
    `POST`/`DELETE /api/me/phone-change` (só WhatsApp; bloqueadas em personificação; passam pelo bloqueio de telefone),
    `POST`/`DELETE /api/portal/me/phone-change` e `POST`/`DELETE /api/customers/:id/phone-change` (`customer:update`).
    **Mudança de comportamento:** `PATCH /api/customers/:id` e `PATCH /api/portal/me` com outro número deixam de
    gravá-lo e abrem a troca (o do portal devolve `phoneChangePending`; a ficha segue com o antigo); a edição do telefone
    de uma conta em `/admin/usuarios/:id` passa pelo pedido, liberado à mão pelo proprietário na mesma transação; a troca
    do telefone de um cliente pedida pela equipe e liberada pelo owner deixa a ficha `team`, como no cadastro; com o
    telefone pendente, o portal corrige o número pela troca, e `PATCH /api/portal/me` fica bloqueado. A leitura ganhou
    `change` (`GET /api/me/phone-verification` e cada responsável do portal), `phoneChange` (`GET /api/customers/:id`) e
    `purpose` (filas). O reenvio aceita `{ purpose: "change" }`. Decisões a confirmar: TC-1 a TC-10.
  - **Migração da troca:** migration `0038` (`purpose`, `phone`, `requested_by_type` e `requested_by_id` em
    `phone_verification`, índices de pedido aberto por finalidade e uma troca aberta por cadastro). Integração que
    trocava o telefone da ficha pelo `PATCH` precisa confirmar a troca (link na sessão do portal da ficha, ou liberação do
    owner em `/app/clientes`).
  - **Perfil da equipe, API (bloco F, F1):** `PATCH /api/me { name }`; foto de perfil em `POST /api/me/avatar`
    (multipart, PNG, JPEG ou WebP conferidos pelo conteúdo, até `AVATAR_MAX_KB`) e `DELETE /api/me/avatar`, servida
    por `GET /api/avatars/:userId` só para quem divide organização com a pessoa, a equipe da plataforma e a própria
    pessoa. `GET /api/me` traz `user.avatarUrl`. A exportação LGPD da equipe inclui a foto, e a exclusão da conta a
    apaga. Escritas bloqueadas em personificação. A tela veio na F2 (abaixo).
  - **Telas do perfil (F2) e da troca de telefone:** página "Perfil" em `/app/perfil` e `/admin/perfil` (mesmo componente; item
    no menu do usuário): foto com recorte quadrado de 256 px no navegador, nome, e-mail (`ChangeEmailCard`, que saiu de
    `/app/configuracoes`), telefone (troca pelo pedido, com troca pendente, reenvio e cancelamento) e senha (cartão sobre
    `POST /api/auth/change-password`, com o medidor e as outras sessões encerradas); nada editável na personificação. A foto
    aparece no menu do usuário, na lista de membros e em quem atende. A troca de telefone também está na ficha do cliente
    (`/app/clientes/:id`), em `/portal/conta` e em "Confirme seu WhatsApp" (que deixou de mandar falar com a plataforma);
    as filas de liberação marcam a troca de número. Só tela: nenhuma rota, permissão ou migration mudou.
  - **Migração da F1:** sem migration. Variável nova `AVATAR_MAX_KB` (padrão 1024). **`POST /api/auth/update-user` do
    Better Auth foi desligado** (404): integração que trocava nome ou `image` por ali passa a usar `PATCH /api/me` e
    `/api/me/avatar`.
  - **Migração da T4:** nenhuma.
  - **Migração da T3:** nenhuma migration. Variável nova `PHONE_VERIFICATION_REQUIRED`, padrão **`true`**: quem tem o
    telefone pendente deixa de usar o sistema até confirmar. Antes de atualizar um projeto derivado, (1) promova o
    primeiro proprietário com o telefone confirmado (o comando de `tech/08-auth.md` mudou: `phone_verified_at` e
    `phone_verified_via` junto com o papel); (2) configure um número da plataforma para o link (ou libere à mão em
    `/admin`); (3) contas sem telefone (anteriores ao A1) ficam na tela de confirmação até o proprietário cadastrar o
    número. Para manter o comportamento anterior, defina `PHONE_VERIFICATION_REQUIRED=false`. Os testes de banco
    rodam com `false` (`vitest.db.config.ts`), menos `tests/db/phone-gate.test.ts`.

- **Exclusões (bloco E de `docs/specs/pre-producao/spec.md`)**: remover um membro da equipe apaga a **ficha de cliente
  ligada à própria pessoa** naquela organização, e excluir a conta apaga as fichas ligadas em todas (D-11), com as
  conversas, as mensagens e os arquivos do número **confirmado** da pessoa; os outros contatos ligados à ficha só
  perdem o vínculo, e nenhuma outra ficha, contato ou conversa é tocada. Nova rota `DELETE
  /api/customers/:id/team-link` desfaz a ligação (a ficha fica, `customer:update`, auditada, fora da
  personificação) e a ficha ganha o cartão "Também é da equipe". `GET /api/customers/:id` devolve
  `conversationCount`; `GET /api/team` (`customerRecord`, só a quem remove membros), `GET /api/me/deletion` e
  `GET /api/admin/users/:id` (`customerRecords`) alimentam os avisos. Os diálogos de excluir cliente, remover
  membro, excluir a conta e excluir o usuário no `/admin` dizem o que será apagado, com a contagem de conversas, e o
  cartão de exclusão da organização lista os números de WhatsApp ainda cadastrados e pede a remoção antes (o pedido
  não é bloqueado).
- **Texto legal com o WhatsApp (bloco L de `docs/specs/pre-producao/spec.md`)**: `/legal/privacidade` e `/legal/termos`
  passam a citar o telefone, o atendimento por WhatsApp (dados, operadores Meta e servidor Evolution, retenção, a
  confirmação do telefone por link, o que cada exclusão apaga), a responsabilidade do owner pelos números e pelas
  políticas da Meta, o canal por QR Code como conexão não oficial e a remoção dos números antes de excluir a
  organização. Revisão jurídica ainda pendente (os textos são modelos).
- **Caixa de entrada, fase C7 (LGPD e fechamento)**: excluir um cliente (`DELETE /api/customers/:id`) ou anonimizar a
  pessoa do portal apaga os contatos de WhatsApp vinculados a ele, com conversas, mensagens, arquivos e objetos do
  armazenamento; excluir a organização apaga toda a caixa de entrada do tenant e os avisos de canal (`channel_event`, com a
  mídia `inbound/` que citam); anonimizar a pessoa da equipe deixa as mensagens e anexos que ela enviou sem autor e desfaz os
  vínculos de contato dela (sem apagar conversa). A exportação de dados do portal ganha `conversas-whatsapp.json` (as
  conversas com os cadastros da pessoa; anexos por nome, tipo e tamanho; sem quem atendeu; até 20.000 mensagens); a da
  equipe não traz conversas (o vínculo com `user` vem de telefone declarado, sem verificação). Editar um papel personalizado tirando `inbox:reply` passa a devolver à fila as conversas de quem o
  tem. Skill `ctx-inbox`. **Migração:** nenhuma migration. Variável nova opcional `CHANNEL_EVENT_RETENTION_DAYS` (padrão
  30, o prazo que já valia). Projeto derivado com dados reais: excluir cliente agora apaga as conversas dele (avise a
  equipe); os canais de uma organização excluída continuam no banco e no provedor (apague os números antes).

- **Caixa de entrada, fase C6 (atendimento da plataforma)**: `/admin/atendimento` e `/api/admin/inbox/*` dão à plataforma a
  mesma caixa do tenant, **sem fila nem dono** (só a lista) e **sem acesso a clientes dos owners**: a plataforma fala com
  `user` (vínculo pelo telefone, e manual pela busca de usuários), `customerId` é recusado (400) e nenhuma consulta alcança
  `customer` de tenant (o cliente é do owner, controlador). Leitura para qualquer papel de plataforma; enviar (texto, anexo,
  modelo, citação), mudar a situação, iniciar conversa (por usuário ou telefone), vincular e renomear o contato para
  `platform_owner` **e `platform_support`** (única escrita do suporte em `/admin`; canal, etiqueta e campo seguem só do
  proprietário; a sessão personificada não passa). SSE próprio em `GET /api/admin/inbox/events`, ponto de não lidas no menu
  "Atendimento", painel com o usuário e as organizações dele (etiquetas e campos da plataforma, só leitura) e "Conversar" na
  lista de usuários. `GET /api/admin/users` ganha `phoneKind`. **Migração:** nenhuma migration nem variável nova.

- **Caixa de entrada, fase C5 (mídia de saída, modelos e resposta citada)**: o atendente anexa imagem, vídeo,
  áudio, PDF ou documento do Office (até 16 MB, tipo conferido pelo **conteúdo**, legenda, prévia), envia um
  **modelo de mensagem aprovado** do WABA do canal com as variáveis conferidas (a única forma de falar com a
  janela de 24 horas encerrada) e **cita** uma mensagem ao responder (texto e anexo). A Cloud API recebe o arquivo
  por `uploadMedia`; a Evolution baixa um endereço assinado de 5 minutos em `GET /api/inbox/media-out/:token`
  (a única rota do atendimento sem sessão: HMAC com `BETTER_AUTH_SECRET`, um arquivo, 5 minutos, só anexo enviado
  pela equipe). Reenviar vale para texto, anexo (reaproveita o arquivo) e modelo; o eco do aparelho de um anexo
  enviado por aqui deixa de sobrar arquivo. "Salvar como cliente" ganha o campo de telefone (o cadastro pode
  recusar o número do WhatsApp). Rota nova `GET /api/inbox/conversations/:id/templates`. **Migração:** nenhuma
  migration. O servidor Evolution precisa alcançar `EVOLUTION_WEBHOOK_PUBLIC_URL` (padrão `APP_URL`) também para
  baixar o anexo. O provedor ganha `SendMedia.content` e `sendChannelTemplate`; módulo de canal próprio deve
  aceitar `content` (ou ignorá-lo e usar `url`).

- **Caixa de entrada, fase C4 (tempo real)**: toda escrita de conversa e mensagem avisa por `pg_notify`
  no `COMMIT` (só ids), cada processo web escuta numa conexão `LISTEN` e `GET /api/inbox/events` (SSE)
  entrega a cada pessoa só os avisos das conversas que ela vê (a fila e as próprias; quem supervisiona,
  todas), inclusive quando a ingestão roda no `--worker`. A tela do atendimento e o ponto de não lidas do
  menu passam a se atualizar pelos eventos; sem SSE, voltam ao polling de 20 s com o aviso "Atualização em
  tempo real indisponível". Atribuição feita por outra pessoa vira aviso na tela. **Migração:** nenhuma
  migration. Variável nova opcional `REALTIME_DATABASE_URL` (padrão `DATABASE_URL`): se a `DATABASE_URL`
  passa por pooler em modo transaction, aponte esta para a conexão direta (ou pooler em modo sessão). Atrás
  de proxy, o SSE não pode ter buffer nem compressão: o `docker/caddy/Caddyfile` tira `/api/inbox/events`
  do `encode` (copie a linha `@compressible` se o seu Caddyfile for próprio).

- **Caixa de entrada, fase C2** (API do atendimento): `/api/inbox/*` com a visibilidade por pessoa em
  toda consulta (o membro vê a fila e as próprias; quem supervisiona vê todas; fora disso, 404), lista
  e mensagens paginadas por cursor, assumir (dois cliques ao mesmo tempo: um assume, o outro recebe
  409 `ALREADY_ASSIGNED`), transferir, devolver, encerrar, reabrir, marcar como lida, não lidas, mídia
  recebida servida pelo tipo do conteúdo, envio de texto (janela de 24 h conferida no servidor,
  `clientId` idempotente, recusa do provedor vira mensagem `failed`), reenvio, varredura
  `inbox.sweep`, vínculo do contato, "salvar como cliente" e iniciar conversa. Permissão nova `inbox`
  (`read`, `reply`, `assign`, `supervise`); owner e admin têm as quatro, member `read` e `reply`.
  Membro removido (ou com papel sem atendimento) tem as conversas devolvidas à fila. **Migração:** sem
  migration; papéis personalizados não ganham `inbox:*` sozinhos (o owner edita o papel). A fila
  `inbox.sweep` é criada na subida dos workers.

- **Caixa de entrada, fase C3 (tela do atendimento do tenant)**: `/app/atendimento` e
  `/app/atendimento/:conversationId` (lista com Fila, Minhas e Todas, filtros e busca; conversa com envio de
  texto, estados de entrega, reenvio e mídia recebida; painel do contato com "Salvar como cliente", vínculo,
  etiquetas e campos; "Nova conversa"), item "Atendimento" no menu com ponto de não lidas e "Conversar" no
  cliente e na equipe. Atualiza por polling de 20 s (o tempo real é a C4). `GET /api/team` passa a trazer
  `phoneKind` por membro (tipo do telefone, nunca o número). **Migração:** nenhuma.

- **Caixa de entrada, fase C1** (`docs/specs/caixa-de-entrada/spec.md`): tabelas `chat_contact`,
  `chat_contact_identity`, `conversation` e `message` (tenant e plataforma, `scopedPolicy()`), e a
  ingestão das mensagens e dos status de WhatsApp recebidos pelos canais: contato por telefone (com e
  sem o 9º dígito), vínculo automático com membro ou cliente só quando há um só, conversa encerrada
  que volta à fila sem dono, mensagem enviada pelo celular (canal por QR Code) e o job `inbox.media`,
  que baixa a mídia da Cloud API e confere o tipo pelo conteúdo. Ainda sem API nem tela (C2 e C3).
  **Migração:** `npm run db:migrate` (`0032` e `0033`); `file.tenant_id` passa a anulável com
  `scopedPolicy()`, e quem lia `file` fora de `withTenant` precisa filtrar o escopo. Quem desligava a
  caixa de entrada nos testes com `setInboxHandlers({})` segue igual; `undefined` agora liga a
  ingestão real.

- **WhatsApp Cloud (fase B2 de `docs/specs/whatsapp-canais/spec.md`)**: webhook por canal em
  `/api/webhooks/whatsapp/cloud/:key` (`GET` de verificação e `POST` assinado com o segredo do
  aplicativo daquele canal), rotas `POST /api/channels/whatsapp-cloud`, `PATCH /api/channels/:id`,
  `/:id/webhook`, `/:id/webhook/rotate`, `/:id/test`, `/:id/templates` e `/:id/templates/sync`, e a
  tela `/app/configuracoes/canais` com "Conectar número". Liga-se com `whatsapp_cloud` em
  `CHANNEL_PROVIDERS`; sem migration nova. Módulos de canal passam a declarar webhook, rotas e
  edição em `ChannelModule`. Falta o smoke com conta de teste da Meta.
- **Canais da plataforma** (`docs/specs/whatsapp-canais/spec.md`, fase B4): a plataforma passa a ter
  os próprios números de WhatsApp em `/admin/configuracoes/canais`, pelas mesmas rotas do tenant sob
  `/api/admin/channels/*` (`Scope = platform`). O suporte lê; só o proprietário conecta, altera e
  remove. Não há limite de plano, e o teto do servidor Evolution continua valendo. A tela mostra o
  nome das variáveis que faltam no servidor. Sem migration nova. **Para projetos derivados:** as
  rotas de QR Code saíram de `src/api/channels.ts` para `providers/whatsapp_qr/routes.ts`, e
  `ChannelManager` passou a exigir a prop `canManage`.
- **Avisos de canal no admin** (`docs/specs/whatsapp-canais/spec.md`, fase B4, parte): aba "Canais"
  em `/admin/webhooks` com os eventos de WhatsApp que falharam, de todas as organizações e da
  plataforma, e "Reprocessar" para o proprietário (`GET /api/admin/channel-events`,
  `POST /api/admin/channel-events/:id/reprocess`). A listagem nunca traz o conteúdo do aviso.
- **Cobrança manual como padrão** (`docs/specs/cobranca-manual/spec.md`): sem módulo de pagamento, o
  proprietário registra em `/admin/tenants/:id` quem pagou e quem não pagou
  (`POST /api/admin/subscriptions/:id/manual-payment` e `.../manual-unpaid`). Preço manual em
  `plan_price` (`provider = manual`), fatura manual em `invoice`, vencimento no job
  `billing.period_end` e carência no `billing.dunning`, com auditoria.
- **Limite de organizações por dono** no plano (`limits.organizations`), editável em
  `/admin/planos/:id` e conferido em `POST /api/tenant` (403 `PLAN_LIMIT_REACHED`). Trial, vencida e
  sem assinatura valem 1.
- **`EMAIL_VERIFICATION_REQUIRED`**: liga a verificação de e-mail. O padrão é desligada: o cadastro
  entra direto.
- Seed com preços manuais, limite de organizações e três tenants na cobrança manual (em dia, em
  atraso e vencido).
- **Canal de WhatsApp por QR Code (Evolution Go), servidor e diálogo** (`docs/specs/whatsapp-canais/spec.md`,
  fase B3; módulo opcional `whatsapp_qr` em `CHANNEL_PROVIDERS`): webhook
  `POST /api/webhooks/whatsapp/evolution/:secret` (cadeia de verificação, 401 sem detalhe, 25 MB),
  mídia de entrada gravada no `StorageProvider` sob `inbound/` (base64, ou `mediaUrl` só de
  `EVOLUTION_MEDIA_ORIGINS`), rotas `POST /api/channels/whatsapp-qr`, `/:id/qr`, `/:id/pair`,
  `GET /:id/status`, `/:id/disconnect`, `/logout`, `/reconnect` e `PATCH /:id/advanced-settings`,
  teto do servidor antes do limite do plano, readoção do canal antigo quando o mesmo número
  reconecta e o componente `QrChannelDialog`. Fixtures ainda simuladas: falta o smoke com o servidor
  real. A página da lista de canais chega com a fase B2.
- **Telefone obrigatório em todo cadastro de pessoa** (`docs/specs/crm-cadastro/spec.md`, fase A1):
  conta de equipe e do portal, perfil, `/admin` e cliente. Validação no Brasil (DDD, 9º dígito, fixo e
  celular antigo com aviso) e em E.164 para outros países, campo `PhoneField` com máscara e seletor de
  país, colunas `phone_normalized` e `phone_key` com `CHECK` no banco e telefone **único por tenant**
  no cliente (409 `PHONE_IN_USE`). O e-mail do cliente passa a ser opcional (sem e-mail, sem convite
  nem conta acessível).
- **Etiquetas do cliente** (`docs/specs/crm-cadastro/spec.md`, fase A2): catálogo por tenant com
  cor (`#rrggbb`), nome único sem diferenciar maiúsculas, até 100 por organização e 20 por cliente.
  Tela em `/app/configuracoes/etiquetas`, seletor no cliente, filtro e chips em `/app/clientes`,
  permissão `tag:manage` (owner e admin; colaborador aplica). A coluna de texto `customer.tags`
  sai, sem migração de dados (projeto novo).
- **Campos adicionais do cliente** (`docs/specs/crm-cadastro/spec.md`, fase A3): definições por tenant
  (`custom_field`) com seis tipos (texto, número, data, sim ou não, lista e lista múltipla), `key`
  estável, ordem, obrigatório e arquivar; valores em `customer.custom_fields` (jsonb por id do campo,
  mesclado por chave no `PATCH`). Até 12 campos ativos e 50 opções; excluir pede a `key` e limpa o
  valor dos clientes. Tela em `/app/configuracoes/campos`, seção no formulário e no detalhe do cliente,
  permissão `custom_field:manage` (owner e admin; colaborador preenche), exportação e anonimização LGPD.
  O portal não vê campos adicionais. Migrations `0027` e `0028`.
- **Etiquetas e campos da plataforma sobre as organizações** (`docs/specs/crm-cadastro/spec.md`, fase A4):
  `organization_tag` e `organization_profile` (sem `tenant_id`, `platformOnlyPolicy()`), catálogo em
  `/admin/configuracoes/etiquetas` e `/campos` (`/api/admin/crm/*`), anotação por organização
  (`PUT /api/admin/tenants/:id/profile`), filtro `?tags=` e chips em `/admin/tenants` e cartão "Etiquetas e
  campos" no detalhe. Escrita só do `platform_owner`; o suporte lê. O owner e a equipe do tenant nunca veem a
  anotação (nem na exportação LGPD, que não a inclui; a anonimização da organização a apaga). Auditoria
  `admin.tag_*`, `admin.custom_field_*` e `admin.tenant_profile_updated`, sem `tenant_id`. Migrations
  `0029` a `0031` (a `0031` passa o `audit_log` a `scopedPolicy()`).

### Alterado

- O cadastro nunca abre sessão (`autoSignIn: false`) e devolve `{ ok: true, verifyEmail }`.
- `GET /api/me/invitations` só lista convites com o e-mail verificado.
- Do gratuito para um plano pago, a troca de plano no `/admin` vence a cobrança na hora; trocar de
  plano anula as faturas manuais em aberto.
- O teto fixo de 3 organizações por usuário (`MAX_TENANTS_PER_USER`) sai: vale o do plano.

- **Node 24.19 ou superior** em `engines`, `Dockerfile` e CI, piso do `react-router-hono-server` 4.
- `.nvmrc` com a versão do Node (lida pelo CI via `node-version-file`) e `engine-strict=true` no
  `.npmrc`: `npm install` em Node antigo falha com `EBADENGINE` em vez de quebrar no dev server.
- **React Router 8**, `react-router-hono-server` 4, `@hono/node-server` 2, Vite 8 (Rolldown), React 19.3,
  TypeScript 7, postgres.js 4, dotenv 18 e `@hookform/resolvers` 7. `@types/node` fica no major do
  runtime (24), e o Dependabot deixa de propor majors dele.

### Removido

- `@vitejs/plugin-react`, que nada importava: o plugin do React Router já cuida do Fast Refresh.

### Segurança

- `npm audit` cai de 9 para 4 alertas moderados. Saem os de `serveStatic` e da cadeia do
  `react-router-hono-server`. Sobram os de `drizzle-kit`, sem efeito em produção
  (`docs/context/tech/16-bugs-riscos.md`, RISK-004).

### Migração

Cobrança manual e verificação opcional:

1. `npm run db:migrate` aplica `0020_cobranca_manual` (só colunas novas e nulas em `invoice`).
2. **A verificação de e-mail passa a ser desligada por padrão.** Para manter o comportamento antigo,
   ponha `EMAIL_VERIFICATION_REQUIRED=true` no `.env.local` e no `docker/.env.prod`.
3. Planos sem `limits.organizations` valem 1 organização por dono, como trial e vencida. Defina o
   valor em `/admin/planos/:id` (o seed preenche os planos dele).
4. Cadastre um preço `Manual` nos planos pagos para registrar pagamentos sem provedor.

Telefone obrigatório (migration `0024_telefone_email_opcional`):

1. A migration **aborta** se houver conta ou cliente já cadastrado (não há backfill de telefone). Em
   projeto novo, nada a fazer; em base de desenvolvimento, recrie o banco e rode `db:migrate` e
   `db:seed`. Em base com dados, preencha o telefone antes (decisão do projeto derivado).
2. `POST /api/auth/sign-up/email`, `/api/portal/auth-ext/sign-up` e `POST /api/customers` passam a
   exigir `phone`; o seed já traz telefone em todas as contas e clientes.
3. `customer.tags` (texto) foi removido (`0025_etiquetas`); `POST` e `PATCH /api/customers` trocam
   `tags: string[]` por `tagIds: uuid[]`.

Node e dependências (sem migration nem variável nova). Para projetos derivados:

1. **Node:** instale o Node 24.19+ antes de tudo, na máquina, no CI e em imagens próprias. Apague
   `node_modules` e rode `npm ci`.
2. **Load context:** `getLoadContext` passa a devolver um `RouterContextProvider`. Troque
   `declare module "react-router" { interface AppLoadContext }` por `createContext` do `react-router`
   e `context.chave` por `context.get(meuContexto)`. Veja `src/lib/csp-nonce.ts`.
3. **`meta`:** troque `({ data })` por `({ loaderData })`, também nos itens de `matches`.
4. **tsconfig:** remova `baseUrl`, que o TypeScript 7 recusa. `paths` continua igual. Código que
   usa a API do compilador (`import ts from "typescript"`) não funciona no pacote 7.
5. **SQL cru com postgres.js:** o servidor agora decide o tipo dos parâmetros. Um `Date` sem cast
   pode virar erro (`${data}::timestamptz` resolve) e o `PGSSLMODE` do ambiente passa a valer. Se
   você criou colunas `timestamp` sem fuso e escreve fora do Drizzle, leia o guia de atualização
   do postgres.js. `sql.array()` não existe mais.
6. **`overrides`:** mantenha o bloco do `package.json`; sem ele, voltam os alertas corrigidos.

## [0.1.0] - 2026-11-07

Primeira versão pública. O antigo Bizu Starter virou o **Bizu SaaS**, seguindo a spec
`docs/specs/saas-foundation/` (fases 0 a 11; a fase 7, módulo Asaas, ficou para depois).

### Adicionado

- **Plataforma:** React Router v7 (Framework Mode, SSR) e Hono em processo único, Drizzle sobre
  Postgres com dois papéis (`bizu_owner` para migrations, `bizu_app` no runtime, sem `BYPASSRLS`),
  variáveis validadas com Zod em `src/lib/env.ts`, logs JSON com `request_id` (pino).
- **Quatro níveis de acesso:** proprietário da plataforma (`/admin`), owner e colaboradores do
  tenant (`/app`) e clientes/leads (`/portal`), com Better Auth em duas instâncias (`auth` e
  `portalAuth`), verificação de e-mail de uso único, recuperação de senha, troca de e-mail e magic
  link no portal.
- **Multi-tenant e RBAC:** organizações com onboarding, equipe, convites, papéis personalizados,
  `requireTenant`, `requirePermission`, Row Level Security forçado com `withTenant` e `audit_log`.
- **Planos e trial:** planos, preços, trial configurável (inclusive gratuito), limites e features por
  plano, estados `read_only` e `locked`, job `billing.trial`, `/precos` público.
- **Cobrança em módulos:** `PaymentProvider` com registro por `PAYMENT_PROVIDERS` (vazio por
  padrão: só planos gratuitos e trial), máquina de estados, checkout, faturas, caixa de entrada de
  webhooks, dunning e reconciliação, e o módulo Stripe.
- **Portal do cliente:** `/app/clientes` com limite do plano, acesso por magic link ou senha, escolha
  de tenant para quem é cliente de mais de um.
- **Segurança:** 2FA (obrigatório para a conta de plataforma em produção), personificação com
  consentimento e auditoria dupla, CSRF, CSP com nonce (começa em report-only), rate limit em
  Postgres, credenciais de provedores cifradas (AES-256-GCM) com rotação de chave.
- **LGPD e arquivos:** registro de consentimento com re-aceite por versão, `/legal/termos` e
  `/legal/privacidade`, exportação dos dados em zip, exclusão de conta, de cliente e de organização
  com 30 dias de carência e anonimização, retenção (`maintenance.prune`), módulo de arquivos
  (`StorageProvider` `local` e `s3`).
- **E-mail e jobs:** fila `email.send` com retry e supressão, provedores `smtp`, `resend` e `memory`,
  14 templates, pg-boss no schema `pgboss` (`JOBS_MODE=inline|worker|off`), `/api/health` e
  `/api/ready`, Sentry opcional.
- **Operação:** `docker/compose.prod.yml` (app, worker, migrate, Postgres, Caddy com TLS e backup
  cifrado com `age`), `docker/.env.prod.example`, `npm run db:seed`, `npm run check:module-removal`.
- **Repositório público:** README em formato de tutorial, `CONTRIBUTING.md`, `SECURITY.md`,
  Dependabot, modelos de issue e de PR, `CODEOWNERS`, guia de atualização do template.

### Alterado

- `/dashboard` passou a `/app`. O projeto agora se chama `bizu-saas` (`package.json`) e os textos
  "Bizu Starter" foram trocados por "Bizu SaaS".
- `docker/postgres/init.sql` aceita as senhas dos papéis por variáveis do `psql` (padrão de
  desenvolvimento intacto) e cria o `bizu_backup` quando recebe `bizu_backup_password`.
- O estágio `build` do `Dockerfile` passou a levar `drizzle/` (antes excluído pelo
  `.dockerignore`), para o serviço `migrate` do compose de produção.

### Segurança

- Em produção, a subida é recusada com `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` ou
  `AUDIT_SALT` iguais aos exemplos, com `RATE_LIMIT_STORE=memory` ou com `EMAIL_PROVIDER=memory`.
- Nenhum token (verificação, reset, convite, magic link) é consumido em GET, e as respostas de
  cadastro, reenvio e reset não revelam se um e-mail existe.

### Migração

Esta é a primeira versão com migrations numeradas do SaaS. Para quem vinha do Bizu Starter ou de um
fork anterior:

1. **Banco:** crie os papéis com `docker/postgres/init.sql` (como superusuário) e rode
   `npm run db:migrate`, que aplica o journal inteiro (`0000` a `0018`), e depois
   `npm run jobs:install`. As migrations não criam papéis.
2. **Volume antigo do Starter:** o banco antigo se chamava `portal`. Em desenvolvimento, apague o
   volume (`docker compose down -v`); em produção, migre os dados à mão: o schema mudou por completo.
3. **Variáveis novas:** compare seu `.env` com `.env.example`. Passam a ser obrigatórias
   `DIRECT_URL`, `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` (32 bytes em base64) e
   `AUDIT_SALT`. Em produção também `RATE_LIMIT_STORE=postgres` e `TRUSTED_PROXY_HOPS=1` atrás de
   um proxy. Um `.env.local` antigo com `CREDENTIALS_ENCRYPTION_KEY` que não seja base64 de 32 bytes
   derruba a subida.
4. **Rotas:** `/dashboard` virou `/app`; ajuste links e favoritos.
5. **Antes de ir ao ar:** preencha o controlador em `src/lib/legal/termos.md` e `privacidade.md`,
   informe o e-mail do encarregado em `/admin/configuracoes`, ative o 2FA da conta do proprietário
   e passe `CSP_REPORT_ONLY` para `false` depois de validar.
6. **Compose:** em produção, use `docker/compose.prod.yml`; as migrations rodam no serviço `migrate`,
   nunca no start do app.

[Não lançado]: https://github.com/brunopelatieri/bizu-saas/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/brunopelatieri/bizu-saas/releases/tag/v0.1.0
