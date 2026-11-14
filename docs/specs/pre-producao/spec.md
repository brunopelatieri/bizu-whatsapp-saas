# SPEC: correções e complementos antes da produção

- **Status:** aprovada em 2026-11-11 (decisões de produto e leituras C-1 a C-3 confirmadas pelo proprietário); em implementação: blocos S e B, as fases T1 a T4 do bloco T (T4 parcial) e a troca de telefone pelo pedido (decisões T3-1 a T3-9, T4-1 a T4-4 e TC-1 a TC-10 a confirmar)
- **Data:** 2026-11-11
- **PRD:** não há. As decisões de produto vieram do proprietário em 2026-11-11 e estão
  registradas em "Decisões do proprietário". Os blocos I, X e Q portam recursos do
  `zap-crm-br-client` (SPECs 049, 052, 054, 056, 059, 060 e 066 da origem).
- **Contexto carregado:** `tech/08-auth.md`, `tech/23-billing-planos.md`, `tech/25-portal-clientes.md`,
  `tech/26-seguranca.md`, `tech/27-lgpd-arquivos.md`, `tech/28-crm-cadastro.md`,
  `tech/29-canais-whatsapp.md`, `tech/30-caixa-de-entrada.md`, `docs/specs/whatsapp-crm/plano.md`.

> Esta SPEC tem dez blocos. Cada bloco tem estado atual (conferido no código),
> desenho e fases próprias. A seção "Ordem e portão de produção" diz o que segura o deploy.

## Decisões do proprietário (2026-11-11)

| # | Tema | Decisão |
|---|---|---|
| P1 | Vínculo conversa × cliente | Continua pelo **id do cliente**. O controle é sobre o **telefone**: trocar o número exige clicar num link de verificação enviado por WhatsApp ao número novo |
| P2 | Unicidade | Telefone não se repete na mesma organização **dentro de cada grupo** (clientes entre si; equipe entre si). A leitura inicial, "entre clientes e equipe", foi substituída por D-9 |
| P3 | Telefone já existente | Quem cadastra um telefone que já existe na organização dispara um link; verificado, o cadastro é liberado |
| P4 | Retenção | Segue a SPEC 060 da origem |
| P5 | Texto legal | Acrescentar o WhatsApp. Não há cliente real; o projeto está em desenvolvimento |
| P6 | Canais na exclusão da organização | Fica como está: o owner apaga os números antes |
| P7 | Exclusão de cliente | Apaga as conversas dele, com aviso à equipe. **Remover membro da equipe nunca apaga cliente**, com uma exceção (D-11): a ficha de cliente da própria pessoa |
| P8 | Senha | Regra de senha forte da SPEC 054 da origem em todo formulário que define senha |
| P9 | Login | Bloqueio por tentativas, com quantidade e tempo em variáveis de ambiente |
| P10 | Importação | Importar clientes (nome, e-mail, telefone...) como na SPEC 052 da origem |
| P11 | Atendimento | Verificar os recursos das SPECs 049, 056 e 066 da origem |
| P12 | Planos | Verificar os recursos da SPEC 059 da origem |
| P13 | Telefone do owner | Não se repete entre owners no SaaS inteiro |
| P14 | Telefone da equipe | Membros e admins não repetem telefone na mesma organização |
| P15 | Telefone do cliente | Não se repete na mesma organização |
| P16 | Verificação do owner | O cadastro do owner sempre tem link de verificação. Sem canal Cloud ou QR Code da plataforma, só o proprietário da plataforma libera |
| P17 | Verificação de membros, admins e clientes | O mesmo procedimento, com o owner no papel de quem libera |
| P18 | Telefone de owner e equipe | Só número de WhatsApp, verificado |
| D-2 | Acesso com telefone pendente | Configurável: `PHONE_VERIFICATION_REQUIRED` bloqueia até a confirmação |
| D-3 | Por onde o link sai | Configurável: Cloud, depois QR Code, depois liberação manual. Cloud sem modelo ou sem crédito cai no QR Code |
| D-4 | Bloqueio de login | Configurável: o e-mail pode não ser bloqueado (`LOGIN_LOCKOUT_SCOPE`) |
| D-8 | Perfil | Owner e equipe editam foto, nome, e-mail (com verificação) e telefone (WhatsApp, com verificação) |
| D-1 | Telefone já existente | Quem verifica fica com o número; a ficha de cliente que ficou sem número é apagada |
| D-5 | Continuar por outro canal | Liberado sem opt-out nem teto de envio frio, e **sem aviso de "número não oficial"**: é só mais um número da organização |
| D-6 | Arquivo na retenção | A limpeza apaga o arquivo da mensagem |
| D-7 | Padrões de retenção | Valores baixos, para proteger o servidor |
| D-10 | Bloqueio de login | Padrão `LOGIN_LOCKOUT_SCOPE=email` |
| D-11 | Conversa de quem é equipe e cliente | Fica na ficha de cliente. Apagada a pessoa da equipe (ou o owner), a ficha ligada e o conteúdo dela são apagados, e só nesse caso |
| D-12 | Quem recebe o link da plataforma | Só owners, a equipe da plataforma e quem não é de organização nenhuma. O membro comum recebe o link da organização e **pede** o da plataforma quando quiser a confirmação que vale em todo lugar |
| D-13 | Quem administra o canal da organização confirma o próprio número pelo link dela | Aceito: o efeito fica dentro da organização (`phone_tenant_vouch`) |
| D-9 | Equipe que também é cliente | Owner, admins e membros **podem ser clientes da própria organização**: dois cadastros separados (`user` e `customer`) que compartilham telefone e e-mail; o cliente aparece marcado com o papel da pessoa na equipe |

## Onde entra

- [x] Pública com SSR: página `/verificar-telefone` e textos de `/legal/*`
- [x] API Hono: `/api/phone-verification/*`, `/api/customers/import`, `/api/inbox/*`, `/api/admin/retention/*`, proxy de login
- [x] Áreas client-only: `/app/clientes`, `/app/atendimento`, `/app/assinatura`, `/portal/conta`, `/admin`

---

## Bloco T: telefone verificado e único (P1 a P3, P13 a P18)

O WhatsApp é a base do produto: o telefone identifica a pessoa, então ele é único no seu
grupo e só vale depois de confirmado.

### Estado atual

- `customer`, `user` e `portal_user` têm `phone`, `phone_normalized` e `phone_key`
  (`src/lib/phone/columns.ts:25-37`).
- Único por organização **só em `customer`**: `customer_tenant_phone_key_idx`
  (`src/db/schema/customer.ts:68-70`). Em `user` e `portal_user` o índice não é único
  (`src/db/schema/auth.ts:59-60`, `portal-auth.ts:47`).
- O vínculo `chat_contact.customer_id` nasce do telefone, sem verificação
  (`autoLinkContact`, `src/lib/inbox/contacts.ts:173-186`), e não registra origem.
- Trocar o telefone grava na hora: equipe em `PATCH /api/customers/:id`
  (`src/lib/tenant/customers.ts:234-324`), cliente em `PATCH /api/portal/me`
  (`src/lib/portal/profile.ts:38-78`), admin em `src/lib/admin/people.ts:185,378`. Não há tela
  para o membro trocar o próprio telefone.
- Risco aberto (`tech/30:495-504` e `:579`): a pessoa do portal troca o telefone para o de um
  terceiro; a primeira mensagem dele vira contato vinculado ao cadastro do atacante, que a
  recebe na exportação e a apaga na exclusão da conta.
- Não existe envio transacional por WhatsApp. `sendChannelText` e `sendChannelTemplate` só
  servem o atendimento humano.

### Regras de unicidade

| Quem | Onde o telefone não se repete | Garantia |
|---|---|---|
| Owner | No SaaS inteiro, entre owners (P13) | `assertOwnerPhoneFree`, em `src/lib/phone/uniqueness.ts`, sob `pg_advisory_xact_lock(hash(phoneKey))`. `user` é global e o papel fica em `member`, então não cabe índice |
| Membros e admins, com o owner | Na organização (P14) | `assertPhoneFreeInTenant(tx, tenantId, group, phoneKey, except)`, com `group` `team` ou `customer`, sob trava por `(tenantId, group, phoneKey)` |
| Clientes | Na organização (P15) | Índice único que já existe, como rede de segurança, e a mesma função |
| Cliente × equipe | **Pode repetir** (D-9) | Cada grupo é conferido sozinho; ver "Equipe que também é cliente" |
| Equipe da plataforma | Entre si | A mesma função, com escopo de plataforma |

Pontos em que a regra do owner é conferida: cadastro sem convite, criação de outra
organização, transferência de posse e troca de telefone. O comentário de `auth.ts:59` ("dois
membros podem dividir o número da empresa") deixa de valer.

**Conta (`user` e `portal_user`): a unicidade vale entre telefones confirmados.** Um número só
declarado não reserva nada, e ninguém bloqueia o número de outra pessoa cadastrando-se com
ele. Na confirmação por link, quem provou a posse fica com o número; se outra conta do mesmo
grupo o tinha confirmado, ela volta a "telefone pendente" e é avisada por e-mail (número de
celular troca de dono). Na liberação manual não há prova de posse: havendo outro detentor
confirmado, a liberação é recusada com 409 `PHONE_IN_USE`. A conta nunca é apagada por isso;
só a ficha de **cliente** que perde o número é apagada (D-1, em "Telefone que já existe").

**Só WhatsApp para owner e equipe (P18).** `userPhoneSchema` aceita apenas número que recebe
WhatsApp (`canWhatsApp`: celular do Brasil ou internacional válido); fixo e celular antigo de 8
dígitos são recusados em `user`. Em `customer` a regra de hoje continua (fixo aceito com aviso).

### Equipe que também é cliente (D-9)

O owner, um admin ou um membro pode ser cliente da própria organização. São **dois cadastros
separados**, `user` (a conta da equipe) e `customer` (a ficha de cliente), que compartilham
telefone e e-mail. Nenhum deles substitui o outro.

- **Ligação por id:** coluna nova `customer.user_id` (FK para `user`, `set null`), com índice
  único parcial em `(tenant_id, user_id)`: uma ficha de cliente por pessoa da equipe, por
  organização. Só é aceita se a pessoa tem `member` ativo naquela organização.
- **Como nasce:** ao criar ou importar um cliente cujo telefone (`phone_key`) é o telefone
  **confirmado** de um membro da organização, a ficha é criada e ligada a ele, e a tela avisa
  ("este número é de Fulano, admin; a ficha ficará marcada"). Na direção inversa, quando alguém
  entra na equipe (aceite de convite) e já existe um cliente com o mesmo telefone, confirmado dos
  dois lados, a ficha é ligada. **O e-mail nunca liga sozinho** (ajuste da revisão de segurança
  da T1): o e-mail da ficha é texto de quem cadastra, e um colaborador salvaria o contato de um
  cliente com o próprio e-mail para virar "dono" da ficha dele. Ligar por e-mail, ou em qualquer
  outro caso, é ação explícita da equipe com `customer:update`, que também desfaz a ligação
  (T4). Toda ligação é auditada (`customer.team_linked`).
- **O "status" é derivado, não gravado:** a ficha mostra o selo com o papel atual da pessoa
  (`Owner`, `Admin`, `Membro` ou o papel personalizado), lido de `member` no momento da
  consulta. Aparece na lista e no detalhe de `/app/clientes` e no painel do contato no
  atendimento; `GET /api/customers` ganha o filtro `team=true`.
- **Os cadastros seguem independentes:** trocar o telefone ou o e-mail de um não altera o
  outro; cada um passa pela sua verificação. A ligação é por id e sobrevive à troca.
- **Pessoa da equipe apagada (D-11):** a ficha de cliente **ligada a ela** e o conteúdo da
  ficha (contatos, conversas, mensagens, arquivos) são apagados junto, por `deleteCustomer`.
  Vale para o owner e para qualquer membro, em dois caminhos: `removeMember` apaga a ficha
  ligada **naquela organização**; a exclusão da conta (`anonymizeUser`) apaga as fichas
  ligadas em **todas** as organizações. É a única situação em que apagar alguém da equipe apaga
  cliente: fichas de outros clientes nunca são tocadas (P7). Quem quer manter a ficha desfaz a
  ligação antes. Trocar o papel da pessoa não apaga nada.
  **Restrições para implementar a D-11** (revisão de segurança da T1): (a) a rota de desfazer a
  ligação entra antes; (b) quem tem `customer:update` consegue vincular à mão o contato de
  outra pessoa à própria ficha (`linkContact`), então a exclusão por D-11 só apaga os contatos
  cuja `phone_key` é a do telefone confirmado da pessoa, e os demais apenas perdem o vínculo;
  (c) até lá, a T1 só desfaz a ligação quando a conta é excluída.
- **Atendimento:** `chat_contact` continua com um vínculo só (`chat_contact_single_link`). No
  escopo da organização, o vínculo automático passa a tentar **o cliente primeiro** e o membro
  depois (hoje é o contrário, `contacts.ts:176-181`): a conversa de quem é os dois fica na
  ficha de cliente, e o painel mostra o selo da equipe. No escopo da plataforma nada muda.
- **LGPD:** exportação e exclusão seguem `chat_contact.customer_id`, nunca o vínculo com
  `user` (regra de `.claude/rules/inbox.md`, mantida). A exclusão por D-11 também respeita a
  regra: o que decide é a ligação `customer.user_id`, criada pela equipe ou por telefone
  confirmado, e o que se apaga é o que está ligado à **ficha**, nunca o `chat_contact.user_id`.
- **Portal:** a ficha com e-mail pode ter conta no portal, como qualquer cliente. É outra
  instância de autenticação (`portalAuth`), com senha e sessão próprias.

### Estado de verificação

Duas colunas em `customer`, `user` e `portal_user`:

| Coluna | Tipo | Significado |
|---|---|---|
| `phone_verified_at` | `timestamptz` nulo | Quando o número atual foi confirmado. Nulo = pendente |
| `phone_verified_via` | `text` nulo, `CHECK` | `whatsapp`: clique no link. `manual`: liberado pelo responsável. `team`: telefone de cliente digitado ou importado pela equipe. `inbound`: cadastro salvo a partir de um contato que escreveu |

- **O vínculo automático só usa telefone confirmado.** `linkCandidates` passa a exigir
  `phone_verified_at IS NOT NULL` do `customer` ou do `user`. É o que fecha o risco aberto.
  Exportação e exclusão continuam por `chat_contact.customer_id` (P1).
- **Nas contas (`user` e `portal_user`) só valem `whatsapp` e `manual`** (`CHECK`
  `user_phone_via_global` e `portal_user_phone_via_global`, T2a): a conta é global, e a coluna
  só guarda o que vale no sistema inteiro. `team` e `inbound` são formas da ficha de cliente.
- Na ficha de cliente, `manual` (liberada pelo owner, número declarado pelo cliente) não atrai
  conversa nem é ligada à pessoa da equipe com o número; `team`, `whatsapp` e `inbound`, sim. Por
  isso a migration da T2a converte em `team` as fichas que a da T1 marcou `manual`.
- Migration: os cadastros que já existem (só de desenvolvimento) nascem `manual`, e o seed
  marca os seus usuários como `manual`. Sem isso, ligar a exigência trancaria todo mundo,
  inclusive o primeiro proprietário da plataforma.

### Quem verifica, por onde e quem libera (P16, P17)

| Cadastro | Canal que envia o link | Sem canal ou sem entrega: quem libera |
|---|---|---|
| Owner (cadastro sem convite) e equipe da plataforma | Canais da **plataforma** | Proprietário da plataforma, em `/admin/usuarios` |
| Membro e admin (aceite de convite) | Canais da **organização** que convidou | Owner, em `/app/equipe` |
| Cliente com conta no portal (autocadastro ou convite) | Canais da **organização** | Owner, em `/app/clientes` |
| Troca de telefone de qualquer um deles | O mesmo canal da linha correspondente | O mesmo responsável |
| Cliente cadastrado ou importado pela equipe | **Não envia link** | Nasce `team` |

- A liberação manual usa a permissão nova `phone:confirm`, que nasce só no papel owner; o
  proprietário da plataforma usa `requirePlatform`. Toda confirmação é auditada
  (`phone.verified`, com a forma e quem liberou; `phone.unverified` quando ela cai).
- **A tabela acima diz quem responde, não até onde a resposta vale.** O alcance está na seção
  seguinte, e muda a leitura das linhas de membro, admin e cliente: o que uma organização
  confirma, pelo link ou à mão, vale só dentro dela.
- O responsável é avisado por e-mail quando um cadastro cai em liberação manual, e a tela dele
  mostra a fila de pendentes.
- Cliente criado pela equipe não recebe link: uma importação de 10.000 linhas viraria 10.000
  mensagens a quem nunca escreveu, e o número seria bloqueado pelo WhatsApp. O telefone que a
  equipe informa é aceito como `team`. A **troca** do telefone de um cliente, por ele ou pela
  equipe, sempre passa pelo link (P1).

### Alcance da confirmação (T2a, revisões de segurança)

**A confirmação vale até onde vale o responsável do pedido, nunca mais.** Qualquer pessoa cria
uma organização. Se o que o owner atesta valesse fora dela, uma organização de fachada
"confirmaria" o número de uma vítima numa conta do atacante, e essa conta passaria a atrair as
conversas e a ficha da vítima em outras organizações. O mesmo vale para o **link**: ele sai pelo
canal do responsável, e o canal por QR Code de uma organização é o WhatsApp do próprio owner,
que lê o que enviou e portanto conhece o link de qualquer número que mandar verificar.

| Pedido de | Fechado por | Efeito | Onde vale |
|---|---|---|---|
| Plataforma (`tenant_id` nulo) | Link, na sessão da própria conta | `user.phone_verified_via = whatsapp`. Quem provou fica com o número: a outra conta do grupo volta a pendente, com pedido novo e auditoria | Sistema inteiro |
| Plataforma | Proprietário da plataforma, à mão | `user.phone_verified_via = manual`. Recusada (409 `PHONE_IN_USE`) se outra conta do grupo já tem o número | Sistema inteiro |
| Organização, conta de membro | Link (sessão da conta) ou owner, à mão | Linha em `phone_tenant_vouch` (conta, organização). A conta **não muda**. Recusada se um colega já tem o número (não tira o número de ninguém) | Só naquela organização |
| Organização, ficha de cliente | Link, na sessão do portal | `customer.phone_verified_via = whatsapp`; liga o contato que já escreveu e a pessoa da equipe com o mesmo número | A ficha, que já é da organização |
| Organização, ficha de cliente | Owner, à mão | `customer.phone_verified_via = manual`. Não liga contato nem pessoa da equipe, e **não atrai** as próximas conversas do número | Idem |

- **Um pedido por (cadastro, responsável).** A conta tem sempre o pedido da plataforma, que é o
  caminho dela para a confirmação que vale em todo lugar, e mais um por organização em que é
  membro comum. Confirmada para o sistema inteiro, os demais pedidos são encerrados.
- **Owner e equipe da plataforma só respondem à plataforma** (P16): não entram na fila de
  organização nenhuma. Quem vira owner sai das filas em que estava; a tentativa de liberá-lo
  por uma organização responde 409 `PLATFORM_ONLY` e encaminha o pedido.
- **A fila do proprietário da plataforma** mostra owners, a equipe da plataforma e quem não é
  de organização nenhuma. O membro comum tem o pedido da plataforma aberto, mas quem o libera à
  mão é a organização.
- **O link só confirma na sessão do próprio cadastro.** Não há rota pública de confirmação: o
  token vai no corpo de um `POST` autenticado, e o cadastro vem da sessão. Sem isso, bastava se
  cadastrar com o número da vítima e esperar ela clicar. Token inválido, usado, vencido, de
  outro cadastro ou de um número que o cadastro já trocou respondem o mesmo 400.
- **A conta do portal (`portal_user`) nunca é confirmada por um pedido de organização**, nem
  nasce confirmada a partir de uma ficha: é global e é outra identidade. Enquanto não existir
  pedido da plataforma para ela, o portal avalia a **ficha** (T3).
- **A ligação da ficha de cliente com a pessoa da equipe (D-9) exige confirmação que vale no
  sistema inteiro** (`userPhoneConfirmedGlobally`); a liberação de organização não a cria.
- **A liberação de organização cai** quando a pessoa sai da equipe, a organização é excluída, a
  conta troca de número ou outra conta prova a posse do número. A manutenção apaga as que
  sobrarem sem membro ou com número antigo.
- **Para o vínculo automático da conversa**, o membro vale se a conta está confirmada no sistema
  ou liberada **naquela** organização; a ficha vale com `team`, `whatsapp` ou `inbound`.

### Bloqueio de acesso enquanto pendente (D-2)

```bash
PHONE_VERIFICATION_REQUIRED=true   # false: entra sem confirmar; o vínculo automático espera
```

- Com `true`, a conta com telefone pendente **não usa o sistema**: `requireAuth` e
  `requirePortalAuth` respondem 403 `PHONE_UNVERIFIED` a tudo, menos ler o próprio estado,
  reenviar o link, corrigir o número, confirmar e sair. A tela mostra só "Confirme seu
  WhatsApp", com o estado (link enviado, ou aguardando liberação de quem é o responsável).
- A sessão é criada porque reenviar e corrigir o número exigem saber quem é a pessoa; o
  bloqueio é do servidor, não da tela.
- O link sai sempre, também com `false`. Nesse modo a pessoa entra, vê um aviso, e o vínculo
  automático com a conversa espera a confirmação.
- Vale junto com `EMAIL_VERIFICATION_REQUIRED`, sem substituí-la.
- **Predicado do portão (decorre da T2a):** a equipe de uma organização passa com a conta
  confirmada no sistema **ou** liberada naquela organização; owner e equipe da plataforma, só
  com a confirmação do sistema; o portal avalia a ficha de cliente da organização em uso.

### Envio do link: Cloud, QR Code ou manual (D-3)

```bash
PHONE_VERIFICATION_CHANNELS=whatsapp_cloud,whatsapp_qr   # ordem de tentativa; vazio = sempre manual
PHONE_VERIFICATION_TTL_MINUTES=30
```

Job `phone.verify`, para o escopo responsável da tabela acima:

1. Lista os canais `connected` do escopo, na ordem de `PHONE_VERIFICATION_CHANNELS`.
2. **Cloud:** exige o modelo de verificação escolhido no canal. Sem modelo, pula. Com modelo,
   envia. Erro na chamada, ou status `failed` que chega depois pelo webhook (sem crédito,
   erro `131042`; modelo pausado ou recusado), passa ao próximo canal.
3. **QR Code:** texto livre com o link. Erro passa ao próximo.
4. Sem canal apto, ou todos falharam: o pedido vira `awaiting_manual`, o responsável é avisado
   e a pessoa vê "aguardando liberação".

- **Modelo de verificação da Cloud:** colunas `verification_template_name` e
  `verification_template_language` em `channel_whatsapp_cloud`, escolhidas entre os modelos
  aprovados já sincronizados, na tela do canal. O modelo precisa de um botão de URL dinâmica
  cujo sufixo é o token (`/verificar-telefone?token={{1}}`). Conferir no smoke com conta real
  da Meta antes de fechar a T2.
- **Cada tentativa gera um token novo** e substitui o hash: o token nunca fica no payload do
  job nem no banco.
- "Reenviar", pedido pela pessoa, tenta o próximo canal da ordem (e volta ao primeiro no fim).
- O envio de verificação **não entra na caixa de entrada**: não cria `chat_contact`,
  `conversation` nem `message`. O id da mensagem no provedor fica no pedido, e
  `applyChannelEvent` consulta o pedido quando chega um status de mensagem que não é da caixa.
- **Restrições que a T2a deixou para a T2b:** (a) a conta com pedidos em vários responsáveis
  não recebe um link por pedido no mesmo número: o da plataforma sai primeiro, e o da
  organização só se a plataforma não tem canal; (b) a URL do botão do modelo Cloud é conferida
  contra `APP_URL` antes de aceitar o modelo; (c) a página `/verificar-telefone` exige a sessão
  do cadastro e leva ao login quando não há; (d) o lead do portal sem ficha não passa por
  `requirePortalTenant` e precisa de um caminho próprio para confirmar;
  (e) **o job escolhe o canal estritamente pelo `tenant_id` do pedido**: pedido da plataforma
  enviado pelo canal de uma organização reabriria a falha que o alcance por responsável fechou
  (`issueVerificationToken` não confere escopo, quem chama confere); (f) quem controla o canal
  da organização (`channel:manage`, não só o owner) lê o link que ela envia, então consegue
  liberar o próprio número **naquela organização** pelo link, e `SELF_CONFIRMATION` não cobre
  esse caminho: **aceito pelo proprietário (D-13)**, porque o efeito fica dentro dela e o owner já
  confia o canal a essa pessoa; (g) `GET /api/me/phone-verification` precisa dizer a
  situação por responsável (hoje devolve "pendente" enquanto houver qualquer pedido aberto), para
  a tela e para o portão da T3.
- **Para quem a plataforma envia o link (D-12, decidido em 2026-11-13):** só a quem responde a
  ela, isto é, owners, a equipe da plataforma e quem não é de organização nenhuma. Todo membro
  comum tem o pedido da plataforma aberto, mas ele **não dispara envio sozinho**: o membro recebe
  o link da organização em que entrou e **pede** o da plataforma quando quiser a confirmação que
  vale em todo lugar ("Reenviar" escolhendo a plataforma). Enviar a todos seria o número da
  plataforma escrevendo a toda a equipe de toda organização (custo de modelo na Cloud, risco de
  bloqueio no QR Code).

### T2b: o que foi feito (2026-11-13)

Implementado como descrito acima, com o detalhe em `docs/context/tech/28-crm-cadastro.md`
("Envio do link e página de confirmação"). Onde o código ficou diferente do texto desta SPEC, vale
o código, e o motivo está aqui:

- **Sem o estado `pending`.** A T2a não o criou: o pedido nasce `awaiting_manual` e vira `sent`
  quando um canal aceita o link. Entre a abertura e o job, o pedido aparece na fila de liberação
  (como já aparecia na T2a).
- **O reenvio tem corpo opcional:** `{ responsible?: "platform" | <tenantId> }` na equipe (o
  membro comum escolhe a plataforma, D-12) e `{ tenantId? }` no portal (padrão: a organização
  ativa). Sem corpo continua valendo.
- **`GET …/phone-verification` cresceu sem quebrar:** mantém `pending` e acrescenta a situação por
  responsável (`responsibles`, `confirmedGlobally`, `answersTo`), restrição (g).
- **Token com prefixo** `u.` (conta) ou `c.` (ficha): diz à página qual sessão pedir. O portal tem a
  própria página, `/portal/verificar-telefone`, porque a sessão do `portalAuth` só existe sob
  `/portal/**`; o link que sai é sempre `/verificar-telefone`, que encaminha.
- **Limite também no job:** além de 3 reenvios por hora por cadastro na rota, o job não manda mais
  de 3 links por hora ao mesmo cadastro, venha o pedido de onde vier (contenção do envio frio,
  inclusive da troca de telefone repetida no portal).
- **Restrição (a), na prática:** o pedido de organização espera enquanto outro pedido da mesma
  conta tem link válido a caminho do mesmo número; se o da plataforma cai na liberação à mão, o da
  organização é disparado. Reenvio pedido pela pessoa não espera (ela escolheu).
- **Restrição (e) em quatro lugares:** lista de candidatos, a função que envia
  (`sendVerificationMessage`), o envio do canal pelo escopo, e um gatilho no banco
  (`phone_verification_channel_same_scope`).
- **A conta que perde a confirmação (`demote`) não recebe link:** o número agora é de outra
  pessoa; ela recebe o e-mail `phone-number-claimed` e o pedido da plataforma fica na fila.
- **E-mail ao responsável uma vez por pedido** (`manual_notified_at`), e só se o pedido é da fila
  dele (o pedido da plataforma de um membro comum não avisa o proprietário).

**Ficou de fora da T2b (pendente):** a troca de telefone com o cadastro mantendo o número antigo
até a confirmação (`POST …/phone-change` e `DELETE`, os três contratos acima; hoje o portal grava
o número novo como pendente e o link vai para ele) e o `claim` do portal com exclusão da ficha
antiga (D-1). Seguem também a T3 (bloqueio) e a T4 (telas, inclusive a do modelo de verificação e a
do reenvio). O formato do modelo na Meta (botão de URL dinâmica e `index`) só foi testado com
provedor falso: conferir no smoke com conta real antes de fechar a T2.

### T3: o que foi feito (2026-11-13)

Implementado como em "Bloqueio de acesso enquanto pendente (D-2)", com o detalhe em
`docs/context/tech/28-crm-cadastro.md` ("Bloqueio de acesso com telefone pendente").

- **`PHONE_VERIFICATION_REQUIRED`**, padrão `true` (o da SPEC), em `src/lib/env.ts`, `.env.example`,
  `docker/.env.prod.example` e `docker/compose.prod.yml`. Lida a cada requisição.
- **Portão no servidor:** `requireAuth` e `requirePortalAuth` respondem 403
  `{ error, code: "PHONE_UNVERIFIED" }` depois da sessão e do e-mail. **Ordem das recusas:** 401 sem
  cookie, 503 com o Auth fora, 401 sessão inválida, 403 `EMAIL_NOT_VERIFIED`, 403 `PHONE_UNVERIFIED`.
  O e-mail vem antes também nas rotas que confirmam o telefone. Falha do banco ao conferir: 503.
- **O que passa (lista fechada, `src/api/phone-gate.ts`, casada pelo método e pelo caminho da
  requisição):** na equipe, `GET /api/me/phone-verification`, `POST …/resend`, `POST …/confirm`,
  `POST /api/tenant/active`, `POST /api/invitations/:id/accept` e `POST /api/admin/stop-impersonating`;
  no portal, `GET /api/portal/me/phone-verification`, `POST …/resend`, `POST …/confirm`,
  `PATCH /api/portal/me` e `POST /api/portal/active-tenant`. Sair é `POST /api/auth/sign-out` e
  `/api/portal/auth/sign-out`, do Better Auth, que não passa pelos middlewares.
- **Exclusão da própria conta (LGPD, T3-7, decidido em 2026-11-13):** também passa. Na equipe,
  `DELETE /api/me`, `GET /api/me/deletion` e `POST /api/me/deletion/cancel`; no portal,
  `DELETE /api/portal/me`, `POST /api/portal/me/deletion/confirm`, `GET /api/portal/me/deletion` e
  `POST /api/portal/me/deletion/cancel`. As rotas seguem pedindo a senha (e o código do 2FA) ou o
  link por e-mail, e o suporte, na sessão personificada, continua sem poder pedir. A tela "Confirme
  seu WhatsApp" traz "Excluir minha conta"; `GET /api/portal/me/deletion` passou a devolver
  `needsPassword`, porque a tela não lê `/api/portal/me`. A exportação e a exclusão da organização
  continuam bloqueadas.
- **Fora dos dois middlewares:** as leituras do plugin admin do Better Auth (`/api/auth/admin/*`,
  dados de outras pessoas) ganharam o mesmo portão; o resto de `/api/auth/*` (sessão, senha, e-mail,
  2FA, sair) é da própria conta e fica aberto. SSE, arquivos, mídia e `/api/admin/*` já passam por
  `requireAuth`. Rotas públicas (webhooks assinados, `media-out` por token, login e cadastro) não têm
  sessão.
- **Predicado** (`src/lib/phone/gate.ts`, sobre `confirmed.ts`): equipe passa com
  `userPhoneConfirmedGlobally`, ou com `userPhoneConfirmedIn(organização ativa)` se é membro dela e
  não é owner de organização nenhuma nem da equipe da plataforma. Portal: a ficha da organização em
  uso (`customerPhoneConfirmed`, predicado novo em `confirmed.ts`), entre as fichas `lead` ou
  `active` de organização ativa.
- **Com `false`:** `/api/me` e `/api/portal/me` devolvem `phonePending` (o mesmo predicado), e as três
  áreas mostram um aviso que abre o painel de confirmação. O vínculo automático continua exigindo o
  telefone confirmado no escopo (já era assim; agora com teste). O link sai nos dois modos.
- **Tela "Confirme seu WhatsApp"** (`src/components/phone/phone-verification-panel.tsx`): quando
  `/api/me` (ou `/api/portal/me`) responde `PHONE_UNVERIFIED`, `ProtectedRoute` (`/app`, `/admin` e
  o onboarding) e `PortalLayout` mostram só ela, com a situação por responsável de
  `GET …/phone-verification`, "Reenviar o link" por responsável, "Usar esta organização" onde o número
  já vale, a correção do número (portal), "Já confirmei" e "Sair". Qualquer chamada recusada com
  `PHONE_UNVERIFIED` no meio da sessão faz os providers relerem a conta (`apiFetch` emite o evento).
  Sem `loader`.
- **Primeiro proprietário:** o seed já cria todos confirmados (`manual`); o comando de promoção pelo
  banco (`tech/08-auth.md`, README, `tech/14-deploy.md`) passa a confirmar o telefone junto com o papel,
  e o `maintenance.prune` encerra pedido aberto de conta já confirmada no sistema. Contas anteriores ao
  bloco T foram marcadas `manual` pela `0035`.
- **Testes:** `tests/db/phone-gate.test.ts` percorre `api.routes` (rota nova entra na conferência
  sozinha; rota pública precisa ser classificada no teste) com uma conta da equipe e uma do portal
  pendentes, confere que cada entrada da lista existe, o predicado, a personificação, o modo `false`
  com o vínculo, a combinação com `EMAIL_VERIFICATION_REQUIRED` e o primeiro proprietário; o seed, em
  `tests/db/billing.test.ts`. O resto do `test:db` roda com `PHONE_VERIFICATION_REQUIRED=false`
  (`vitest.db.config.ts`): os outros arquivos criam contas pendentes para conferir outras regras.

**Decisões da T3 a confirmar pelo proprietário** (escolhidas para não trancar ninguém sem saída e não
abrir dado):

| # | Ponto que a SPEC não fechava | Escolha | Alternativa |
|---|---|---|---|
| T3-1 | Aceitar convite com telefone pendente | **Passa:** é o aceite que torna a organização responsável pelo telefone (pedido dela, link pelos canais dela, liberação pelo owner). A resposta não traz dado da organização | Bloquear: o convidado só teria a fila da plataforma, que pela D-12 não libera membro comum |
| T3-2 | Rota sem organização ativa (onboarding, criar organização) | Só vale a confirmação do sistema. Criar organização fica bloqueado: quem cria vira owner, e owner só passa com a confirmação do sistema (P16) | Deixar criar e trancar logo depois |
| T3-3 | Membro de várias organizações, liberado em uma e pendente em outra | O portão é pela **organização ativa**; trocar de organização passa, e a tela oferece "Usar esta organização" onde o número já vale | Exigir todas, ou passar com qualquer uma |
| T3-4 | Sessão personificada sobre conta pendente | O portão avalia a **conta personificada**: o suporte vê a mesma tela, não confirma nem reenvia (`blockWhileImpersonating`) e sai por `stop-impersonating`, que passa | Isentar a personificação (abriria dados da organização sob uma conta que ela ainda não liberou) |
| T3-5 | Lead do portal sem ficha ativa | Sem organização em uso (ou sem ficha nela): passa se **alguma** ficha `lead`/`active` da pessoa está confirmada; sem ficha que possa confirmar, passa (nada a confirmar; `requirePortalTenant` segura os dados) | Trancar: o lead que já confirmou continuaria preso até virar cliente ativo |
| T3-6 | Corrigir o número | Portal: `PATCH /api/portal/me`, a rota que já existe (exige ficha ativa: o lead não corrige sozinho). **Equipe: não há rota para a própria conta**; a tela manda falar com a plataforma, e o proprietário corrige em `/admin/usuarios/:id`. A troca pela própria pessoa é a de `…/phone-change` (fase própria) | Criar agora uma rota de troca da conta (é o contrato `phone-change`, fora do escopo) |
| T3-7 | O que fica bloqueado com telefone pendente | Além dos dados: `GET /api/me`, sessões (`/api/me/sessions`), consentimento, **exportação** dos dados da conta, `GET /api/me/invitations` e o `set-password` do portal. Fica aberto o Better Auth da própria conta (senha, 2FA, e-mail, sessão, sair). **Confirmada em parte pelo proprietário em 2026-11-13: o pedido de exclusão da própria conta passa** (pedir, ver e desistir), porque o direito de apagar os dados não depende de confirmar o WhatsApp | Abrir também a exportação da conta sem o telefone |
| T3-8 | Leituras do plugin admin do Better Auth | Ganham o portão (servem dados de outras pessoas e não passam por `requireAuth`) | Deixar como estão |
| T3-9 | Contas sem telefone (anteriores ao A1, só em desenvolvimento) | Ficam na tela de confirmação até o proprietário cadastrar o número em `/admin` | Isentar quem não tem número |

**Limites conhecidos da T3:** o fluxo SSE já aberto não é derrubado quando a confirmação cai no meio
da sessão (o número muda de dono): segue até a vida máxima de 15 min, como na troca de papel; a
reconexão passa pelo portão. O login do portal com o telefone pendente não escolhe a organização do
`?org=` (o mapeamento slug → organização vem de `/api/portal/me`, bloqueado): a tela de confirmação
troca de organização. A sessão que ficou numa organização de que a pessoa saiu não é levada à
preferida (quem faz isso é `/api/me`, que está atrás do portão): a tela oferece "Usar esta
organização". O owner com telefone pendente que é o único proprietário de uma organização não
consegue excluir a conta (409 `LAST_OWNER`, a regra de sempre), e excluir ou transferir a
organização está atrás do portão: ele precisa confirmar o número ou falar com a plataforma. A tela
não foi conferida num navegador nesta fase.

### T4: o que foi feito (2026-11-13)

**Parcial.** Entraram as três filas de liberação, o modelo de verificação na tela do canal Cloud e os acertos
de texto da tela da T3. Ficaram de fora as telas de troca de telefone, o `claim` e a ligação da ficha à equipe,
por falta de rota no servidor (lista abaixo). Detalhe em `docs/context/tech/28-crm-cadastro.md` ("Telas da liberação à
mão").

- **Fila da plataforma:** aba "Telefones" em `/admin/usuarios?scope=telefones`, **só para o
  proprietário** (`GET /api/admin/phone-verifications` é `ownerOnly`: o suporte recebe 403, então a aba nem
  existe para ele). O número de pendentes aparece na aba. `useAdminQuery` e `useAdminMutation`.
- **Fila da organização:** um cartão em `/app/equipe` (pedidos de pessoas da equipe) e outro em
  `/app/clientes` (pedidos de fichas de cliente), sobre `GET /api/phone-verifications`, dentro de
  `<Can resource="phone" action="confirm">` (a rota que lista também exige a permissão, então sem ela nada
  é pedido). A rota devolve equipe e clientes juntos, sem filtro por tipo: cada tela filtra a página no
  cliente, e a paginação vale para a fila toda (a tela avisa quando há mais de uma página).
- **Em todas:** confirmação antes de liberar, com "a liberação à mão não prova que o número é da pessoa" e o
  alcance conforme o responsável (plataforma: sistema inteiro; equipe: só a organização; ficha: só a
  organização, sem atrair conversas nem ligar à equipe); mensagem própria para `SELF_CONFIRMATION`,
  `PHONE_IN_USE`, `PLATFORM_ONLY`, `VERIFICATION_STALE` e 404; estado vazio; a lista relê depois de cada
  tentativa, com sucesso ou erro. O número aparece como a rota o devolve (`phone`, o número normalizado, sem
  máscara), junto de "Link enviado" ou "Aguardando liberação" e da data do pedido.
- **Modelo de verificação na tela do canal Cloud** (autorizado pelo proprietário em 2026-11-13: expor o modelo
  escolhido na leitura do canal): `verificationTemplate: { name, language } | null` passou a sair em
  `GET /api/channels` e `GET /api/admin/channels` (`src/lib/channels/service.ts`, ao lado dos outros campos da
  Cloud; só leitura, sem coluna `_enc`, rota, permissão ou migration; teste em
  `whatsapp_cloud/verification.db.test.ts`). A tela é `VerificationTemplateCard`, dentro de "Gerenciar" do número
  Cloud, um componente para `/app` e `/admin` (`basePath` por props): mostra o modelo em uso, lista os modelos
  **aprovados** já sincronizados (`GET …/templates?status=APPROVED`), aplica (`PUT …/verification-template`),
  tira, sincroniza (`POST …/templates/sync`) e mostra o motivo do 422 como a API o devolve. Conferida no
  navegador (desktop e DOM em celular) em `/app/configuracoes/canais` com um número Cloud de teste local: 422 de
  URL fora do endereço, aplicar, "Em uso" e tirar; **a variante de `/admin` não foi aberta** (mesmo componente).
- **Tela da T3, só texto:** "aguardando a liberação de o proprietário" virou "do proprietário da
  plataforma"; "abra o link que enviamos" só aparece quando algum link saiu (sem envio, "Falta confirmar o
  WhatsApp terminado em …").
- **Conferido num navegador** (Postgres local, servidor de desenvolvimento, contas do seed, sem canal
  conectado e com `PHONE_VERIFICATION_CHANNELS` vazio, nenhuma mensagem enviada): as três filas em desktop,
  a liberação com sucesso na equipe, 404 e `VERIFICATION_STALE` na fila de clientes, e a tela "Confirme seu
  WhatsApp" da equipe (conta pendente da plataforma) e do portal (cliente com duas fichas pendentes) em
  desktop. Em largura de celular os screenshots do painel saem fatiados; a conferência foi pelo DOM
  (nenhum elemento fora de 375 px, sem rolagem horizontal) na aba do admin e nas duas telas da T3.
  **Não exercitados na tela:** `SELF_CONFIRMATION`, `PHONE_IN_USE` e `PLATFORM_ONLY` (têm teste de servidor
  na T2a), a fila da organização em largura de celular (é o mesmo componente da do admin) e a paginação
  com mais de 50 pedidos.

**Pendentes, com o que falta para destravar**

| Pendente | Por que ficou | O que destrava |
|---|---|---|
| Troca de telefone pelo pedido em `/app/clientes` e `/portal/conta` (e o perfil da equipe, F2) | As rotas passaram a existir em 2026-11-13 ("Troca de telefone pelo pedido") | Só a tela |
| `claim` do portal (D-1) | Idem | O `purpose = claim` e a exclusão da ficha antiga |
| Ligar e desligar a ficha de cliente à pessoa da equipe (D-9) | Não há rota (`customer.user_id` só é gravado pelo telefone confirmado e na exclusão) | Rota com `customer:update`, auditoria `customer.team_linked` e a restrição (a) da D-11 |
| Filtro por tipo na fila da organização | A rota lista equipe e clientes juntos | `?subject=user\|customer` em `GET /api/phone-verifications` |
| Fila lida pelo suporte da plataforma | A rota é só do proprietário | Trocar `ownerOnly` por `requirePlatform` na leitura (decisão de regra) |

**Roteiro manual com número real** (a verificação da T4; quem executa é o proprietário). Pré-requisitos:
servidor com `APP_URL` público em `https`, `JOBS_MODE=inline` (ou o worker rodando),
`PHONE_VERIFICATION_CHANNELS=whatsapp_cloud,whatsapp_qr`, SMTP ou Mailpit para os e-mails, um número real
que receba WhatsApp e **não** seja o do canal que envia, e uma organização com um owner.
O modelo se escolhe em `/app/configuracoes/canais` → "Gerenciar" no número Cloud → "Modelo de verificação de
telefone" (ou na tela equivalente de `/admin`, para os números da plataforma). Em cada cenário, confira a auditoria (`phone.verified`, com a forma e quem liberou) e que o número não aparece em log, job nem
auditoria.

1. **Cloud com modelo.**
   1. Em `/app/configuracoes/canais`, conecte o número oficial e confira o diagnóstico verde.
   2. Na Meta, crie um modelo de utilidade sem variável no corpo, com **um botão de URL dinâmica** apontando
      para `https://<APP_URL>/verificar-telefone?token={{1}}`; espere a aprovação e sincronize os modelos
      ("Sincronizar modelos", na mesma seção).
   3. Escolha o modelo na tela e clique "Usar este modelo". Um modelo com a URL errada deve mostrar o motivo do
      422 (`INVALID_VERIFICATION_TEMPLATE`); "Em uso" mostra o modelo gravado, e "Tirar o modelo" o desfaz.
   4. Convide, por e-mail, uma pessoa com o número real e aceite o convite. **Esperado:** o modelo chega no
      WhatsApp; o botão abre `/verificar-telefone`; sem sessão vai ao login e volta; o clique em "Confirmar"
      libera. `/app/equipe` não mostra pedido, e o pedido está `confirmed` no banco.
   5. Abra o mesmo link com outra conta logada: **esperado** 400 "Link inválido ou expirado".
   6. Confira que o formato do botão (`sub_type: url`, `index`) foi aceito pela Meta: a SPEC só testou isso com
      provedor falso, e este é o ponto que o roteiro precisa fechar antes de dar a T2 por encerrada.
2. **Cloud sem crédito caindo no QR Code.**
   1. Conecte também um número por QR Code (`whatsapp_qr`) na mesma organização, conectado.
   2. Deixe a Cloud sem crédito de conversa (ou com o modelo pausado), de modo que a Meta devolva o status
      `failed` (erro `131042`).
   3. Repita o convite com um número real. **Esperado:** a Cloud aceita o envio, o status `failed` chega pelo
      webhook, o job passa ao QR Code e o link chega como texto livre. Em `phone_verification.attempts` há uma
      entrada para a Cloud (com o erro) e outra para o QR Code; o token não aparece ali.
   4. Peça "Reenviar o link" na tela de confirmação: a ordem recomeça e o limite é de 3 links por hora por
      cadastro (a 4ª tentativa responde o aviso de limite).
3. **Sem canal caindo na liberação.**
   1. Desconecte ou remova os canais da organização (ou deixe `PHONE_VERIFICATION_CHANNELS` vazio).
   2. Convide e aceite com um número real. **Esperado:** a pessoa vê "Confirme seu WhatsApp" com "Sem envio
      automático agora: aguardando a liberação de quem administra <organização>"; o owner recebe o e-mail
      "phone-verification-manual" uma vez; o pedido aparece em `/app/equipe` como "Aguardando liberação".
   3. Como owner (outra pessoa, não a que espera), abra "Liberar": o diálogo mostra o aviso de que a liberação
      não prova a posse e o alcance só na organização. Confirme. **Esperado:** "Telefone liberado", o pedido
      sai da fila, a pessoa clica "Já confirmei" e entra; a auditoria registra `phone.verified` com `manual`.
   4. Tente liberar o próprio número (precisa de um pedido do liberador na fila de uma organização, por
      exemplo um colega com `phone:confirm`): **esperado** a mensagem de `SELF_CONFIRMATION`.
   5. Repita com um cliente do portal (autocadastro): o pedido aparece em `/app/clientes`; a liberação à mão não
      liga a ficha à equipe nem atrai conversas futuras do número.
   6. Plataforma: cadastre um owner sem convite, sem canal da plataforma. **Esperado:** o pedido aparece na aba
      "Telefones" de `/admin/usuarios` do proprietário; liberar vale no sistema inteiro; o suporte da
      plataforma não vê a aba.

**Decisões da T4 a confirmar pelo proprietário**

| # | Ponto | Escolha | Alternativa |
|---|---|---|---|
| T4-1 | Onde fica a fila da plataforma | Aba "Telefones" em `/admin/usuarios`, com contagem, só para o proprietário | Cartão fixo no topo da lista, ou página própria |
| T4-2 | Fila da organização sem filtro por tipo na rota | Duas telas filtram a página no cliente; o aviso diz que a paginação é da fila toda | Pedir `?subject=` ao servidor (pendente acima) |
| T4-3 | Modelo de verificação na tela do canal | Tela dentro de "Gerenciar" do número Cloud; a leitura do canal passou a trazer `verificationTemplate` (autorizado em 2026-11-13) | Seção própria fora do diálogo, ou rota dedicada de leitura |
| T4-4 | Suporte da plataforma | Não vê a fila (a rota é do proprietário) | Liberar a leitura ao suporte |

### Troca de telefone pelo pedido: o que foi feito (2026-11-13)

Implementada no servidor, sem tela nova (a tela da troca fica para a próxima fase de telas). Detalhe em
`docs/context/tech/28-crm-cadastro.md` ("Troca de telefone pelo pedido").

- **Migration `0038_troca_telefone`:** `phone_verification` ganhou `purpose` (`signup` ou `change`; `claim` não
  existe ainda), `phone` (o número digitado, para gravar no cadastro), `requested_by_type` (`user` ou
  `portal_user`) e `requested_by_id`, com `CHECK`s (a troca sempre leva número e quem pediu). Os índices de
  pedido aberto passaram a incluir `purpose` (a troca convive com o pedido do número atual), e um índice novo
  garante **uma troca aberta por cadastro**, qualquer que seja o responsável.
- **O cadastro mantém o número antigo, e a confirmação dele, até a troca se confirmar.** O número novo vive só
  no pedido. Confirmada (pelo link do número novo, na sessão do próprio cadastro, ou pelo responsável à mão), a
  troca grava o número com o estado do responsável, fecha os pedidos que sobravam (eram do número antigo) e
  apaga as liberações de organização (eram do número antigo). Cancelada (`DELETE`), nada a desfazer.
- **Rotas (as de "Contratos"):** `POST`/`DELETE /api/me/phone-change` (`userPhoneChangeSchema`, só WhatsApp,
  bloqueadas em personificação), `POST`/`DELETE /api/portal/me/phone-change` (`requirePortalAuth` +
  `requirePortalTenant`, ficha da organização ativa) e `POST`/`DELETE /api/customers/:id/phone-change`
  (`customer:update`). `POST` responde 202 `{ ok: true }`, `DELETE` 204 (também sem troca aberta). Pedir de novo o
  mesmo número reenvia o link; outro número substitui a troca. Limite de 5 pedidos por hora por cadastro, além
  dos 3 links por hora do job. O mesmo número que o cadastro já tem é 400 `PHONE_UNCHANGED`.
- **`PATCH /api/customers/:id` e `PATCH /api/portal/me`** deixaram de gravar outro número: abrem a troca (o
  `PATCH` do portal devolve `phoneChangePending`). O mesmo número escrito de outro jeito (mesma `phone_key`,
  com ou sem o 9º dígito) continua gravado direto. **A edição de conta em `/admin/usuarios/:id`** abre a troca
  e o proprietário a libera à mão na mesma transação (`manual`). Criar cliente pela equipe segue `team`.
- **Leitura do estado sem quebrar a T3 e a T4:** `GET /api/me/phone-verification` ganhou `change`
  (`{ status, phoneHint, responsible, tenantId, tenantName, requestedAt } | null`; `phoneHint` é o final do
  número **novo**); `pending` e `responsibles` seguem sendo do número atual. No portal, cada item de
  `responsibles` ganhou `change`. `GET /api/customers/:id` (e a resposta do `PATCH`) ganhou `phoneChange`. As
  filas (`GET /api/phone-verifications` e a do admin) ganharam `purpose`. Reenviar o link da troca:
  `POST …/phone-verification/resend` com `{ purpose: "change" }` (na equipe e no portal).
- **Envio:** o link vai sempre ao número **novo**, pelo canal do responsável da troca. A troca não espera a
  D-12 (foi pedida). A troca da ficha sem conta no portal não manda link (ninguém o confirmaria): vai direto à
  liberação do owner, que é avisado por e-mail.
- **Bloqueio (T3):** `POST` e `DELETE /api/me/phone-change` entraram na lista do que passa com o telefone
  pendente (é o "corrigir o número" da equipe, que não existia; a decisão T3-6 deixa de valer na parte da
  equipe). No portal, `POST` e `DELETE /api/portal/me/phone-change` entraram e **`PATCH /api/portal/me` saiu**:
  com o telefone pendente, o portal só corrige o número, não edita o perfil. A tela da T3 do portal passou a
  usar a rota da troca.
- **Testes:** `tests/db/phone-change.test.ts` (15 casos: conta, membro comum, cancelamento, uma troca por
  cadastro, número em uso, personificação, bloqueio ligado, portal, equipe, `/admin`) e três casos em
  `tests/db/phone-delivery.test.ts` (link ao número novo; ficha sem portal sem link; troca da conta sem
  esperar a D-12). Os testes que trocavam o número no portal para criar uma ficha pendente passaram a usar
  `makeCustomerPhonePending` (`tests/db/phone-helpers.ts`).

**Decisões da troca a confirmar pelo proprietário**

| # | Ponto que a SPEC não fechava | Escolha | Alternativa |
|---|---|---|---|
| TC-1 | Cadastro cujo número atual nunca foi confirmado "corrige" o número | **O mesmo fluxo:** abre a troca; o número antigo (pendente) fica no cadastro até a confirmação, e o pedido dele segue aberto. Uniforme, sem gravar número sem prova e sem oráculo; a fila mostra os dois pedidos, marcados por `purpose` | Gravar o número novo direto, como pendente (não há confirmação a preservar), fechando o pedido do antigo |
| TC-2 | Conferência de unicidade no pedido e na confirmação | **No pedido, só onde quem pede pode saber:** a equipe recebe 409 `PHONE_IN_USE` ao pedir a troca da ficha (como no cadastro). A própria conta e a pessoa do portal recebem sempre 202. **Na confirmação, sempre**, sob a trava do número (conta, `lockPhoneKey`) ou da ficha (com o índice único como rede): conta pelo link da plataforma fica com o número (quem provou fica com ele, como no cadastro); pelo link da organização ou à mão, 409; ficha, 409 (D-1, o `claim`, ainda não existe) | Recusar já no pedido (oráculo de quem tem conta ou é cliente) |
| TC-3 | Quem responde pela troca da conta | **A plataforma** para quem responde a ela e para quem já tem o número confirmado no sistema inteiro (a troca não rebaixa a conta); **a organização em uso** (ou a primeira em que entrou) para o membro comum sem essa confirmação. Confirmada pela organização, a conta fica com o número novo pendente no sistema e liberada só nela; ganha os pedidos da plataforma (sem envio, D-12) e das outras organizações | Sempre a plataforma (contraria a D-12), ou sempre a organização (rebaixa quem tinha a confirmação do sistema) |
| TC-4 | O que acontece na confirmação com o resto | Pedidos abertos do número antigo: fechados. Liberações de organização: apagadas (eram do número antigo). Ligação da ficha à pessoa da equipe (`customer.user_id`): fica (é por id, D-9); a ficha que troca pelo link liga a pessoa da equipe do número novo se não tinha ligação. Contato e conversas do número antigo: continuam na ficha (P1) | Desfazer a ligação da ficha na troca da conta |
| TC-5 | Troca pedida pela equipe para um cliente | **Pelo link**, como diz a SPEC: o link vai ao número novo e só confirma na sessão do portal da ficha. Ficha sem conta no portal: sem link, direto à liberação do owner, que vale `manual` (não atrai conversas nem liga à equipe). Assim um colaborador não passa a ficha de um cliente para um número dele | A equipe atestar (`team`), como no cadastro |
| TC-6 | Edição em `/admin` | Conta: troca aberta e liberada à mão pelo proprietário na mesma transação (`manual`, 409 se outra conta do grupo tem o número; editar a própria conta já era recusado). **Pessoa do portal: continua gravando direto como `manual`** (a conta do portal não tem pedido, e nada da ficha muda) | Criar pedido para `portal_user` |
| TC-7 | `PATCH` que traz telefone | Continuam aceitando `phone`: outro número abre a troca, o mesmo é gravado. `PATCH /api/portal/me` saiu da lista do bloqueio | Recusar `phone` no `PATCH` e exigir a rota da troca |
| TC-8 | Troca e responsáveis que mudam | A troca não espera a D-12. Membro que sai da organização responsável perde a troca (cancelada, como os pedidos dela); quem vira owner tem a troca movida para a plataforma, na fila, sem link até pedir o reenvio. A troca da plataforma aparece na fila do proprietário também para o membro comum | Manter a troca na organização até expirar |
| TC-9 | Conta do portal na troca da ficha | Só a troca pedida pela própria pessoa leva o número à conta (`portal_user`), só declarado, como o `PATCH` fazia | Nunca mexer na conta |
| TC-10 | Repetição | O mesmo número do cadastro: 400 `PHONE_UNCHANGED` (é dado do próprio cadastro). Pedir de novo o número da troca aberta é reenviar | Tratar como nova troca |

### Pedido de verificação: `phone_verification`

`scopedPolicy()`, com `tenant_id` nulo para os pedidos do escopo da plataforma. **A T2a criou**
`id`, `tenant_id`, `subject_type` (`user` ou `customer`), `subject_id` (sem FK: quem apaga o
cadastro apaga os pedidos, e a manutenção tira os órfãos), `phone_normalized`, `phone_key`,
`status` (`sent`, `awaiting_manual`, `confirmed`, `canceled`), `token_hash`, `expires_at`,
`confirmed_at`, `confirmed_by` e as datas. As demais colunas da tabela abaixo entram na T2b,
com o envio. A T2a criou também `phone_tenant_vouch` (`user_id`, `tenant_id`, `phone_key`,
`vouched_by`; chave `(user_id, tenant_id)`; `tenantPolicy()`), a liberação de organização.

| Coluna | Observação |
|---|---|
| `id`, `tenant_id` | Escopo responsável pelo envio |
| `subject_type`, `subject_id` | `customer` ou `user` |
| `purpose` | `signup` (número do cadastro), `change` (troca) ou `claim` (número que já existe, P3). **Implementados `signup` e `change`** (migration `0038`) |
| `payload` | `jsonb` nulo: dados validados da ficha que nasce na confirmação (`claim`) |
| `phone`, `phone_normalized`, `phone_key` | O número a confirmar, de `phoneValues`. Na troca, o cadastro mantém o antigo até a confirmação |
| `token_hash` | SHA-256, único. O token (`randomBytes(32)`) só existe no link |
| `status` | `pending`, `sent`, `awaiting_manual`, `confirmed`, `canceled` |
| `channel_id`, `provider_message_id`, `attempts` | Canal e mensagem da tentativa atual; histórico em `jsonb` (canal, hora, erro) |
| `requested_by_type`, `requested_by_id` | Quem pediu (`user` ou `portal_user`); preenchidos na troca (`0038`) |
| `expires_at`, `created_at`, `confirmed_at`, `confirmed_by` | Validade por `PHONE_VERIFICATION_TTL_MINUTES`; `confirmed_by` só na liberação manual |

Dois índices únicos parciais para pedidos abertos: `(subject_type, subject_id, tenant_id)` nos
de organização e `(subject_type, subject_id)` nos da plataforma. É um pedido por (cadastro,
responsável); o do número novo substitui o do antigo. Encerrados há mais de 30 dias e órfãos
saem no `maintenance.prune`, que também devolve a `awaiting_manual` o pedido de link vencido.

### Confirmação

```
1. Pessoa abre /verificar-telefone?token=… → sem sessão, vai ao login e volta; com sessão, a
   página renderiza e mostra um botão (T2b)
2. POST /api/me/phone-verification/confirm (equipe) ou /api/portal/me/phone-verification/confirm
   (portal), com { token } no corpo. O cadastro vem da sessão. Na mesma transação:
   - trava o cadastro e o pedido, e confere que o token ainda é o do pedido (uso único);
   - aplica o efeito conforme o responsável do pedido ("Alcance da confirmação");
   - audita `phone.verified` (ids e enums; o número nunca vai para a auditoria).
```

Na troca, o `chat_contact` do número antigo **continua ligado ao cliente**: o histórico é do
cadastro, não do número (P1).

### Telefone que já existe (P3, D-1, `purpose = claim`)

**Quem verifica fica com o número.** O link prova a posse; confirmado, o cadastro novo recebe
o número, e o cadastro de **cliente** que o tinha, agora sem telefone, é **apagado**.

| Quem cadastra | O número já é de | Resultado |
|---|---|---|
| Pessoa no autocadastro do portal | `customer` da organização, com ou sem conta | Resposta neutra ("enviamos um link para confirmar seu WhatsApp"). Confirmado: a ficha nova nasce com o número e a antiga é apagada |
| Equipe em `/app/clientes` | `customer` da organização | 409 `PHONE_IN_USE` com o id do cadastro existente e a ação "Enviar link de verificação". Confirmado pelo dono do número: a ficha nova nasce e a antiga é apagada |
| Importação | `customer` da organização | Linha `duplicate`, sem link (importação não dispara mensagens) |
| Owner ou membro no cadastro | Outra conta do mesmo grupo | Cadastro aceito como pendente; confirmado, fica com o número e a conta anterior volta a "telefone pendente" (conta não é apagada) |

- **A ficha nova só nasce na confirmação.** `customer` exige telefone (`CHECK`), então os dados
  validados do cadastro ficam em `phone_verification.payload` (`jsonb`) até o clique; vencido o
  pedido, somem com ele.
- **Apagar a ficha antiga é `deleteCustomer`:** saem os contatos vinculados, as conversas, as
  mensagens e os arquivos, como em qualquer exclusão de cliente (P7). É a opção segura quando o
  número mudou de dono: o novo detentor não herda a conversa de outra pessoa. O custo é o caso
  em que é a mesma pessoa: o histórico da ficha antiga se perde.
- A troca e a exclusão ocorrem na mesma transação, sob a trava de unicidade. Audita
  `customer.deleted_by_phone_claim` (ficha antiga, ficha nova, 4 últimos dígitos) e avisa o
  owner por e-mail.
- A ficha antiga ligada a um membro da equipe (D-9) segue a mesma regra.
| Equipe em `/app/clientes` ou na importação | Membro da organização | **Permitido** (D-9): a ficha de cliente é criada e ligada ao membro |

### Contratos

| Método e rota | Entrada (Zod) | Saída | Autorização |
|---|---|---|---|
| `GET /api/me/phone-verification` e `GET /api/portal/me/phone-verification` (**T2a**) | sem corpo | `{ pending: { status, phoneHint } \| null }` | sessão; liberada mesmo com telefone pendente |
| `POST /api/me/phone-verification/confirm` e a do portal (**T2a**) | `{ token }` | 200, 400 `INVALID_OR_EXPIRED`, 409 `PHONE_IN_USE` ou `PLATFORM_ONLY` | sessão do próprio cadastro; bloqueada em personificação; rate limit |
| `POST /api/me/phone-verification/resend` (e a do portal) (**T2b**) | opcional: `{ responsible?: "platform" \| <tenantId> }` (portal: `{ tenantId? }`) | 202 | idem; rate limit por cadastro (3 por hora) |
| `POST /api/me/phone-change` | `userPhoneChangeSchema { phone }` | 202 | `requireAuth`; bloqueada em personificação; liberada com telefone pendente (corrigir o número) |
| `POST /api/portal/me/phone-change` | `phoneChangeSchema` | 202 | `requirePortalAuth` + `requirePortalTenant` |
| `POST /api/customers/:id/phone-change` | `phoneChangeSchema` | 202 | `requireAuth` + `requireTenant` + `customer:update` |
| `DELETE …/phone-change` (as três) | sem corpo | 204 | a mesma de quem pediu |
| `GET /api/phone-verifications` (**T2a**) | `?page=` | fila da organização, mais antigos primeiro, paginada | `requireTenant` + `phone:confirm` |
| `POST /api/phone-verifications/:id/confirm` (**T2a**) | sem corpo | 200; 403 `SELF_CONFIRMATION`; 404; 409 `PHONE_IN_USE`, `PLATFORM_ONLY` ou `VERIFICATION_STALE` | `requireTenant` + `phone:confirm` |
| `GET` e `POST /api/admin/phone-verifications…` (**T2a**) | as mesmas | as mesmas, escopo da plataforma | `requirePlatform`, só o proprietário |

Não existe rota pública de confirmação nem `GET` com o token no caminho (o token iria para o
log de acesso): a revisão de segurança da T2a trocou as duas rotas públicas previstas pelas
rotas autenticadas acima.
| `PUT /api/channels/:id/verification-template` (e a de `/api/admin/channels`) (**T2b**) | `{ template: { name, language } \| null }` | 200; 404; 422 `INVALID_VERIFICATION_TEMPLATE` | `channel:manage` |

`PATCH /api/customers/:id`, `PATCH /api/portal/me` e a edição de pessoa em `/admin` deixam de
gravar `phone` direto: passam pelo pedido. Criar cliente pela equipe grava com `team`.

### Segurança

- Token só em hash, validade curta, uso único, consumido só por POST autenticado, com o token
  no corpo e o cadastro tirado da sessão.
- O link de uma organização não é prova fora dela ("Alcance da confirmação").
- Ninguém libera o próprio telefone (403 `SELF_CONFIRMATION`).
- As respostas de cadastro seguem neutras: não dizem se um número já tem conta.
- Rate limit: 3 envios por hora por cadastro, além do limite por IP.
- O link vai a um número que pode nunca ter escrito ao remetente: em canal QR é envio frio. O
  limite por cadastro é a contenção; não existe teto de envio frio neste projeto.
- A liberação manual é o ponto fraco do desenho (não prova posse): por isso é restrita ao
  owner e ao proprietário da plataforma, auditada e recusada quando o número já está
  confirmado em outra conta do grupo.

### Fases

| Fase | Entrega | Verificação | LLM |
|---|---|---|---|
| T1 (**implementada**; a tabela de pedidos e o modelo de verificação do canal Cloud passaram para a T2, que é quem os usa) | Migration (colunas), `customer.user_id`, funções de unicidade, `userPhoneSchema`, vínculo automático só com telefone confirmado e com o cliente antes do membro, permissão `phone:confirm` | `tests/db`: owners com o mesmo número são recusados; membros da mesma organização também; cliente com o telefone de um membro é **aceito** e ligado; uma ficha por pessoa da equipe; contato de quem é os dois liga ao cliente; contato novo não liga a telefone pendente; `rbac.test.ts` com a permissão nova | Opus 5.5 |
| T2a (**implementada**) | Pedido (`phone_verification`), liberação de organização (`phone_tenant_vouch`), confirmação pelo link na sessão do cadastro, liberação manual nas duas filas, alcance pelo responsável, ganchos (cadastro, convite, virar owner, sair da equipe, exclusões) e limpeza | `tests/db/phone-requests.test.ts`: token de uso único, vencido, de outra conta; "quem provou fica com o número"; liberação manual recusada com número em uso; fachada (à mão e pelo link) não confirma fora dela; fila paginada; `CHECK` das contas | Fable 5.2 + três passadas de revisão de segurança |
| T2b (**implementada**, sem a troca pelo pedido e sem o `claim`, que ficaram pendentes; ver "T2b: o que foi feito") | Job `phone.verify` com a cascata, status de falha pelo webhook, página `/verificar-telefone`, reenvio, e-mail ao responsável e à conta que perdeu a confirmação, e as restrições (a) a (g) de "Envio do link". **Pendentes, para fase própria:** troca de telefone pelo pedido (`…/phone-change`) e `claim` do portal (D-1) | `tests/db/phone-delivery.test.ts`: Cloud sem modelo cai no QR; `failed` assíncrono cai no próximo; sem canal vira `awaiting_manual`; o canal é sempre do responsável; um link só por número; D-12; reenvio com limite; token fora de job, log e auditoria; eco fora da caixa; lead do portal confirma. No módulo Cloud: modelo com URL fora de `APP_URL` é recusado | Opus 5.5 + `/code-review` e `/security-review` |
| T3 (**implementada**, com as decisões T3-1 a T3-9 a confirmar; ver "T3: o que foi feito") | Bloqueio por `PHONE_VERIFICATION_REQUIRED` em `requireAuth` e `requirePortalAuth`, tela "Confirme seu WhatsApp" | `tests/db`: com `true`, toda rota privada responde 403 e as liberadas passam; com `false`, entra e o vínculo espera; seed e proprietário da plataforma não ficam trancados | Opus 5.5 + `/security-review` |
| T4 (**parcial**: filas, modelo de verificação na tela do canal e acertos de texto da T3 implementados; telas de troca de telefone, `claim` e ligação à equipe pendentes; ver "T4: o que foi feito") | Telas: fila de liberação em `/admin/usuarios`, `/app/equipe` e `/app/clientes`; troca em `/app/clientes` e `/portal/conta`; modelo de verificação na tela do canal | Roteiro manual com número real: Cloud com modelo, Cloud sem crédito caindo no QR, sem canal caindo na liberação | Sonnet 5.5 |

---

## Bloco R: retenção e limpeza de mensagens (P4)

### Estado atual

Não há prazo para `message` nem `conversation` (`tech/30:505-508`). Só `channel_event` tem
retenção (`CHANNEL_EVENT_RETENTION_DAYS`, `src/jobs/maintenance.ts:72-83`). Não existe favorito
em mensagem. `message.reply_to_message_id` e `message.file_id` já são `set null`
(`src/db/schema/inbox.ts:209-216`).

### Desenho (SPEC 060 da origem, na stack daqui)

Mantido da origem, sem alteração de regra: desligado quando a variável está ausente (o
exemplo de produção já vem ligado, D-7); piso de idade; prévia sem apagar;
três fases na ordem **idade, contagem, favoritas acima do teto** (a favorita rebaixada só é
apagada no ciclo seguinte); `0` é "sem limite" e `NULL` herda; a conversa esvaziada permanece.

| Origem (060) | Aqui | Motivo |
|---|---|---|
| Função SQL `purge_channel_messages` chamada por RPC | Serviço `src/lib/inbox/retention.ts` com as mesmas três sentenças em Drizzle (`sql`), dentro de `withScope` | Drizzle é a única camada de dados; sem `SECURITY DEFINER` nem `REVOKE` para manter |
| Disparo por rota de cron | Job pg-boss `inbox.retention` em `src/jobs/queues.ts`, cron diário, com `singletonKey` | O projeto já tem agendador; a tabela de claim `message_retention_state` vira só `last_run_at` e `last_result` |
| Política do dono da conta, depois movida ao proprietário da plataforma | **Proprietário da plataforma**, em `/admin` | É o estado final decidido na origem (cabeçalho da 060) |
| Escopo conta × tipo de canal | Tenant × tipo de canal; o escopo da plataforma usa só os padrões do `.env` | `Scope` já separa os dois |
| Arquivo no bucket fica órfão | **Apaga `file` e o objeto**, como `purgeContacts` faz | Aqui a mídia conta em `storage_mb` do plano; órfão cobraria do tenant o que ele não vê |
| Estrela por `UPDATE` direto do cliente | `PUT /api/inbox/messages/:id/favorite`, com `inbox:reply` e `visibility.ts` | Autorização no servidor |

**Dados.**

- `message.is_favorite` (`boolean`, padrão `false`), `favorited_at`, `favorited_by` (`set null`);
  índice parcial `(conversation_id, created_at) WHERE is_favorite`.
- `retention_policy`: `tenant_id`, `channel_type`, `max_messages`, `retention_days`,
  `max_favorites` (inteiros nulos, `>= 0`), `updated_by`, único em `(tenant_id, channel_type)`.
  Política `platformOnlyPolicy()`: o tenant não lê.
- Índice `message (conversation_id, created_at)` se ainda não existir.

**Precedência** (módulo puro `src/lib/inbox/retention-policy.ts`, com teste da matriz inteira):
linha da política, depois padrão do `.env`, depois sem limite. Toda ausência resulta em não
apagar.

**Piso.** Protege a idempotência da reentrega (a ingestão procura a mensagem para não duplicar)
e a citação de mensagem recente. Prevalece sobre qualquer política.

**Variáveis** (em `src/lib/env.ts` e `.env.example`):

```bash
MESSAGE_RETENTION_ENABLED=false                      # .env.example (dev); true em docker/.env.prod.example
MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES=5000
MESSAGE_RETENTION_WHATSAPP_QR_DAYS=90
MESSAGE_RETENTION_WHATSAPP_QR_MAX_FAVORITES=200
MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES=5000
MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS=90
MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_FAVORITES=200
MESSAGE_RETENTION_MIN_AGE_HOURS=72
MESSAGE_RETENTION_BATCH_LIMIT=5000
```

**Interface.** Estrela na mensagem e selo na bolha; aviso neutro na conversa esvaziada
("Mensagens antigas removidas pela política de retenção", sem números); em `/admin`, tela de
retenção por organização com prévia e última execução. O texto de privacidade (bloco L) cita
a retenção.

**Observação.** A 060 poda por idade e contagem de mensagens, não por conversa encerrada. Uma
conversa encerrada antiga perde as mensagens e permanece na lista.

### Fases

| Fase | Entrega | Verificação | LLM |
|---|---|---|---|
| R1 | Migration, módulo de precedência e testes | `npm test`: `0` nunca apaga; ausência nunca apaga | Sonnet 5.5 |
| R2 | Serviço de limpeza, prévia, job; exclusão do arquivo | `tests/db`: desligado não apaga; piso; favorita sobrevive; rebaixada só some no ciclo seguinte; prévia bate com a execução; isolamento entre tenants | Opus 5.5 |
| R3 | Estrela, aviso da conversa vazia, tela do `/admin` | Roteiro manual com o interruptor ligado em banco de teste | Sonnet 5.5 |

---

## Bloco L: texto legal (P5)

`src/lib/legal/privacidade.md` e `termos.md` não citam WhatsApp, e o item "Conta" não cita o
telefone, hoje obrigatório.

- **`privacidade.md`:** telefone na conta e no cadastro; conversas, mensagens e mídia do
  atendimento por WhatsApp; dados do contato que escreve sem ser cliente (número e nome do
  WhatsApp); operadores (Meta, na Cloud API, e o servidor Evolution da plataforma, no canal por
  QR Code; armazenamento de arquivos); linhas novas na tabela de retenção (mensagens conforme a
  política do bloco R, avisos de canal por `CHANNEL_EVENT_RETENTION_DAYS`); a verificação de
  telefone por link; o que a exclusão de cliente e de conta apaga.
- **`termos.md`:** o atendimento por WhatsApp no serviço; responsabilidade do owner pelo uso
  dos números e pelas políticas da Meta; o canal por QR Code é conexão não oficial, com risco de
  bloqueio do número pelo WhatsApp; o owner remove os números antes de excluir a organização.
- **Versão:** `LEGAL_VERSIONS` sobe `terms` e `privacy` juntas (o aceite grava uma versão só
  para as duas, `consent-dialog.tsx:39`). Formato `AAAA-MM`: usar o mês do deploy. Não há
  aceite real a preservar.
- **Verificação:** `src/lib/legal/legal.test.ts`; teste novo exige que os dois textos contenham
  "WhatsApp". **LLM:** Sonnet 5.5 no texto; revisão jurídica é humana.

---

## Bloco E: exclusões (P6, P7)

| Item | Estado atual | Mudança |
|---|---|---|
| Excluir cliente | Apaga contatos vinculados, conversas, mensagens e arquivos (`deleteCustomer`, `customers.ts:331-372`). O diálogo só fala do portal (`customer-detail-page.tsx:243-249`) | O diálogo passa a dizer que as conversas e os arquivos do atendimento são apagados sem volta, com a contagem de conversas. `GET /api/customers/:id` devolve `conversationCount` |
| Remover membro | `removeMember` apaga `member` e devolve as conversas à fila; `customer` não tem `created_by` e toda FK para `user` é `set null` | `removeMember` e `anonymizeUser` passam a apagar **só a ficha de cliente ligada à própria pessoa** (`customer.user_id`), com as conversas dela (D-11). O diálogo de remoção e o de exclusão de conta avisam quando a ficha existe, com a contagem de conversas. Teste em `tests/db`: remover o membro e anonimizar o `user` apagam a ficha ligada e o conteúdo dela, e mantêm todos os outros clientes, contatos, conversas e mensagens, com os campos de autoria nulos |
| Excluir organização | Não toca em `channel`; credenciais cifradas e a instância no provedor continuam; o cartão não cita números (`organization-deletion-card.tsx:92-103`) | Comportamento mantido (P6). O cartão lista os números ainda ativos e pede a remoção antes; o pedido não é bloqueado |

**LLM:** Sonnet 5.5.

---

## Bloco S: senha forte (P8)

### Estado atual

Só tamanho: 10 a 128 (`src/lib/schemas/auth.ts:4-20`; `minPasswordLength: 10` em
`src/lib/auth/server.ts:90` e `portal.ts:89`). Sem medidor. `POST /api/auth/reset-password` e
`/change-password` só passam pelo Better Auth, sem Zod; o `set-password` do portal só passa
pelo Zod (`src/lib/portal/profile.ts:91-142`).

### Desenho (SPEC 054 da origem)

- `src/lib/auth/password-policy.ts` (puro, com teste): `evaluatePassword`, `isPasswordValid`,
  `normalizePassword` (`trim` + NFC) e as constantes.
- Regras: maiúscula, minúscula, número, um especial de `!@#$%^&*()_+-=[]{}:;,.?/~`, sem
  caractere de controle, espaço permitido no meio.
- **Mínimo fica em 10** (a origem usa 8; não se reduz o que já é mais forte).
- **Máximo fica em 128 caracteres.** O limite de 72 bytes da origem é do bcrypt; aqui o Better
  Auth usa o hasher padrão (scrypt). A T-S1 confirma o hasher antes de fixar.
- `newPassword` de `src/lib/schemas/auth.ts` passa a refinar com `isPasswordValid`: cobre
  cadastro, convite, redefinição, autocadastro do portal e `set-password` do portal.
- Servidor: hook `before` nas duas instâncias do Better Auth em `/sign-up/email`,
  `/reset-password` e `/change-password` aplica a mesma regra e a normalização. O login
  normaliza do mesmo jeito (senão a senha com espaço no fim deixa de entrar).
- `src/components/auth/password-strength-meter.tsx`: checklist ao vivo e barra; usado nas cinco
  telas. O botão de enviar fica desabilitado até a senha valer.
- O login não valida complexidade (senhas antigas seguem entrando; só existem as de dev).
- `SEED_PASSWORD` passa a exigir a mesma regra; atualizar `.env.example`.

**Fases:** S1 módulo, schema e hooks (`npm test`, `tests/db/auth.test.ts` e
`portal-auth.test.ts`: senha fraca recusada nas cinco entradas, inclusive por chamada direta à
rota); S2 medidor nas telas. **LLM:** Opus 5.5 na S1 (toca auth) com `/security-review`;
Sonnet 5.5 na S2.

---

## Bloco F: perfil do owner e da equipe (D-8)

### Estado atual

Não existe tela de perfil. `/app/settings` só tem `ChangeEmailCard`
(`src/routes/app.settings.tsx:24`) e a de segurança só tem 2FA
(`app.settings.security.tsx`, `admin/security.tsx:28`). Nome e telefone só mudam pelo
`/admin`. `POST /api/auth/change-password` está aberta, sem tela.

### Desenho

Página "Perfil" em `/app` e em `/admin` (o mesmo componente), para owner, admins, membros e
equipe da plataforma. Toda escrita é bloqueada em personificação.

| Campo | Como muda | Regra |
|---|---|---|
| Foto | `POST /api/me/avatar` (multipart) e `DELETE /api/me/avatar` | PNG, JPEG ou WebP conferidos pela assinatura do arquivo (não pela extensão); sem SVG; teto `AVATAR_MAX_KB` (padrão 1024); recorte quadrado de 256 px feito no navegador antes do envio |
| Nome | `PATCH /api/me` `{ name }` | 2 a 120 caracteres; audita `user.profile_updated` |
| E-mail | `ChangeEmailCard`, que já existe | Segue com verificação por link no e-mail novo |
| Telefone | `POST /api/me/phone-change` (bloco T) | Só número com WhatsApp; vale depois do link ou da liberação do responsável; a tela mostra "troca pendente", reenviar e cancelar |
| Senha | Cartão novo sobre `POST /api/auth/change-password` | Pede a senha atual; usa o medidor do bloco S; derruba as outras sessões |

**Foto.**

- Guardada pelo `StorageProvider` como `file` com `owner_type = 'user_avatar'` e `tenant_id`
  nulo: a pessoa é global e a foto não conta em `storage_mb` de nenhuma organização.
  `user.image` guarda o id do arquivo; trocar apaga o anterior.
- Servida por `GET /api/avatars/:userId`, só para sessão da equipe que divide organização com
  a pessoa ou para a equipe da plataforma; `Content-Type` do registro, `nosniff` e cache
  privado. Nunca por URL pública do armazenamento.
- Aparece no cabeçalho, na lista de membros e no atendimento (quem atende), pelo
  `ui/avatar.tsx` que já existe, com as iniciais como reserva.
- LGPD: `anonymizeUser` apaga a foto; a exportação da pessoa a inclui.

**Fases e LLM:** F1 API (nome, foto, rota de leitura, LGPD), com `tests/db` cobrindo tipo
falso, tamanho, autorização da leitura e personificação: Opus 5.5 na leitura e no upload,
com `/security-review`; F2 tela: Sonnet 5.5. Depende de S1 (medidor) e de T2 (troca de
telefone).

---

## Bloco B: bloqueio de login por tentativas (P9)

### Estado atual

Só rate limit por IP e caminho, com valores fixos (3 a cada 10 s; `server.ts:204-215`,
`portal.ts:174-182`). Não há contagem por conta. O único bloqueio é o do 2FA.

### Desenho

```bash
LOGIN_LOCKOUT_SCOPE=email       # email | email_ip | off
LOGIN_MAX_ATTEMPTS=5            # falhas seguidas até bloquear
LOGIN_ATTEMPT_WINDOW_MINUTES=15 # janela em que as falhas se somam
LOGIN_LOCKOUT_MINUTES=15        # duração do bloqueio
```

| `LOGIN_LOCKOUT_SCOPE` | O que é bloqueado | Efeito |
|---|---|---|
| `email` (padrão) | O e-mail, venha de onde vier | Segura ataque distribuído; um terceiro consegue bloquear a conta errando a senha |
| `email_ip` | O par e-mail e IP | **O e-mail nunca fica bloqueado para o dono** (D-4): só o IP que errou espera. Não segura ataque vindo de muitos IPs |
| `off` | Nada | Só o limite por IP de hoje |

A chave do contador muda com o escopo: `HMAC(e-mail)` ou `HMAC(e-mail + IP)`, com o IP de
`clientKey`.

- Tabela `login_throttle`: `realm` (`team`, `portal`), `key_hash` (HMAC do e-mail normalizado
  com `AUDIT_SALT`), `failures`, `window_started_at`, `locked_until`; PK `(realm, key_hash)`.
  Sem `tenant_id`: escrita pelo `bizu_app` fora de escopo de tenant, como `rate_limit_bucket`.
- `src/lib/auth/login-throttle.ts`: decisão pura (`evaluate(state, now, config)`) e a casca de
  banco com `INSERT … ON CONFLICT DO UPDATE` atômico.
- Aplicado no proxy Hono antes do Better Auth, em `POST /api/auth/sign-in/email`
  (`src/api/auth-ext.ts`) e no login do portal (`src/api/portal.ts`): bloqueado responde 429
  com `Retry-After`; resposta 401 soma falha; 200 zera.
- **Não revela se o e-mail existe:** e-mail inexistente soma e bloqueia igual; a mensagem é a
  mesma de hoje ("Muitas tentativas. Tente mais tarde.").
- Redefinir a senha zera o contador daquele e-mail.
- Audita `auth.login_locked`, sem o e-mail e sem o hash dele (a auditoria dura muito mais
  que o contador; ajuste da revisão de segurança). Linhas vencidas saem no
  `maintenance.prune`.
- O limite por IP continua como está.

**Limite conhecido.** Com `email`, quem sabe o e-mail de alguém consegue mantê-lo bloqueado
errando a senha de propósito; a saída da vítima é redefinir a senha, ou a operação troca o
escopo para `email_ip`.

**Verificação:** teste unitário da decisão; `tests/db`: N falhas bloqueiam, sucesso zera, o
bloqueio expira, e-mail inexistente se comporta igual, portal e equipe não compartilham
contador; com `email_ip`, outro IP entra com a senha certa durante o bloqueio; com `off`,
nada bloqueia. **LLM:** Opus 5.5 + `/security-review`.

---

## Bloco I: importação de clientes (P10)

### Estado atual

Não existe importador nem dependência de planilha. O cadastro valida com `customerSchema`
(`src/lib/schemas/customer.ts:31-42`) e aplica `assertWithinLimit(tenantId, "customers")`.

### Desenho (SPEC 052 da origem)

- **Leitura no navegador:** `src/lib/spreadsheet/` (puro, com teste): `parse-csv.ts` com
  delimitador detectado no cabeçalho (`,`, `;`, tab), aspas envolventes e `""` conforme RFC
  4180, apóstrofo preservado; `parse-xlsx.ts` com `read-excel-file` (import dinâmico) e
  escolha da aba que tem coluna de telefone; `template-file.ts` gera o modelo.
- **Colunas:** `phone` (obrigatória; `telefone`, `celular`, `whatsapp`, `numero`), `name`
  (`nome`), `email` (`e-mail`), `document` (`documento`, `cpf`, `cnpj`), `tags` (`etiquetas`;
  separador `;`), `notes` (`observacoes`). Colunas desconhecidas são ignoradas. Sem `name`, usa
  o telefone formatado. Campos adicionais ficam fora (como na origem).
- **Escrita no servidor** (a origem inseria pelo navegador; aqui não):
  `POST /api/customers/import`, lotes de até 500 linhas, `customer:create`. Cada linha passa
  por `customerSchema`, `normalizePhone` e `assertPhoneFreeInTenant`; duplicada (no arquivo ou
  na base) é ignorada, nunca atualiza. Resposta por linha:
  `created | duplicate | invalid(reason) | limit`.
- **Limite do plano:** `GET /api/customers/import/quota` devolve as vagas; a tela avisa antes
  ("cabem N de M") e o servidor para no limite com `limit`, sem transformar em "ignorada".
- **Etiquetas:** as existentes são ligadas; as novas só são criadas com a permissão de gerir
  etiquetas, respeitando o teto de 100; sem permissão, são ignoradas com aviso.
- Telefone importado nasce com `phone_verified_via = team` (bloco T). A unicidade é conferida
  só entre clientes: linha com o telefone ou o e-mail de um membro da equipe é criada e ligada
  a ele (D-9), e o resultado da linha informa a ligação.
- **Tetos:** 10 MB e 10.000 linhas. Rate limit `customer-import`. Auditoria
  `customer.imported` com as contagens.
- **Tela:** diálogo em `/app/clientes`: soltar arquivo, modelo para baixar, referência de
  colunas, prévia das 5 primeiras, contadores `lidas · válidas · duplicadas · inválidas`,
  progresso e a lista de rejeitadas (linha e motivo) **visível depois do resultado**.
- **Google Planilhas por link:** fase separada (I3): rota de servidor que baixa o CSV público,
  com guarda de SSRF (só `docs.google.com`, sem redirecionamento para outro host) e rate limit.

**Fases:** I1 `src/lib/spreadsheet/` com os casos A a K da origem como teste; I2 rota e tela;
I3 Google Planilhas. **LLM:** Sonnet 5.5; Opus 5.5 na guarda de SSRF da I3.

---

## Bloco X: atendimento (P11)

Comparação com as SPECs 049, 056 e 066 da origem.

| Recurso da origem | Aqui | Ação |
|---|---|---|
| Conversa única por contato e canal, canal imutável (049) | Existe (`inbox.ts:150-157`, gatilho em `0033`) | Nenhuma |
| Selo do canal na lista e na conversa (049 §4.2) | Existe (`channel-badge.tsx`) | Nenhuma |
| Escolher o número ao iniciar conversa (049 §4.6) | Existe (`new-conversation-dialog.tsx`) | Nenhuma |
| Composer conforme a capacidade do canal (049 §4.3) | Existe para modelo; não há interativo nem gravação de áudio a esconder | Nenhuma |
| Filtro de canal na URL (049 §4.1) | Filtro existe, em estado local (`conversation-list.tsx:85`) | **X1:** `?canal=<id>`; id inválido cai em "todos" |
| "Também neste contato" (049 §4.4) | Não existe | **X1:** seção no `contact-panel.tsx` com as outras conversas do contato, respeitando `visibility.ts` |
| Filtro de clientes por canal (049 §4.5) | Não existe | **X4**, opcional: parâmetro `channelId` em `GET /api/customers` com `EXISTS` |
| Continuar por outro canal (056) | Servidor pronto: `startConversation` é o find-or-create por contato e canal (`contact-actions.ts:358-432`); falta a ação | **X2** |
| Seletor de emoji (066) | Não existe; `Textarea` controlado sem ref de cursor (`composer.tsx:394-411`) | **X3** |
| Motores cientes de canal, teto de envio frio, enquete, API v1, webhooks de saída, IA (049 F6) | Não existem neste projeto (`plano.md`, "O que não é portado") | Fora |
| Opt-out do contato e aviso de número não oficial (056) | Não existe o campo | Fora (D-5) |

**X2: continuar por outro canal.**

- `eligibleTransferChannels` em `src/lib/inbox/transfer.ts` (puro): canal do mesmo escopo,
  diferente do atual, `connected`; com `sessionWindow24h`, só com a janela aberta **naquela**
  conversa de destino; devolve o motivo da recusa.
- `POST /api/inbox/conversations/:id/transfer` `{ channelId, text }`: valida a elegibilidade no
  servidor, chama `startConversation` com o `contactId` da conversa (o schema passa a aceitar
  contato existente), envia o texto pela conversa de destino e devolve o id dela. Conversa de
  destino atribuída a outra pessoa responde 409 `ALREADY_ASSIGNED`, como hoje.
- Nada muda no envio: a mensagem sai pelo canal da conversa de destino.
- Entradas: botão "Continuar por outro número" na faixa "Janela de 24 horas encerrada", ao lado
  de "Enviar modelo", e na seção "Também neste contato". Só aparecem com canal elegível.
- O diálogo mostra o **nome do número** de saída e a frase "O contato vai receber de outro
  número, e a conversa continua por lá". Sem aviso de "número não oficial" (D-5): é só mais
  um número da organização. Só texto; depois o composer completo está na conversa de destino.
- Sentido QR para oficial com a janela fechada: ação desabilitada com o motivo, apontando o
  modelo.

**X3: seletor de emoji.**

- `frimousse` (dependência) e `emojibase-data` (dev). Dados em `public/emojibase/pt/`, copiados
  por `scripts/sync-emojibase.mjs`: a CSP segue com `connect-src 'self'`
  (`src/api/security.ts:19-31`).
- `src/lib/emoji/` puro, com teste: `insert-at-cursor.ts`, `recents.ts` (16 mais recentes, por
  usuário, em `localStorage` com chave `bizu:emoji:*`), `preferences.ts` (tom de pele).
- `src/components/ui/popover.tsx` **não existe**: criar no padrão dos outros componentes base.
- Painel carregado com `React.lazy` na primeira abertura; o popover fica aberto para várias
  inserções e o foco volta ao campo ao fechar.
- `composer.tsx` ganha ref no `Textarea`; o botão segue a mesma regra de bloqueio do campo.
- Conferir o cabeçalho de cache de `/emojibase/*` no servidor de arquivos estáticos.

**Fases e LLM:** X1 e X3 com Sonnet 5.5; X2 com Opus 5.5 (cria conversa e envia por outro
número) e `/security-review`.

---

## Bloco Q: planos e quotas (P12)

Comparação com a SPEC 059 da origem.

| Recurso da origem | Aqui | Ação |
|---|---|---|
| Catálogo com limites em JSON, chave ausente = ilimitado | Existe (`plan.limits`, `src/db/schema/billing.ts:59-86`) | Nenhuma |
| Limites de contatos, membros e canais por tipo | Existem: `members`, `customers`, `channels_whatsapp_*`, mais `storage_mb`, `custom_roles`, `organizations` | Nenhuma |
| Convite pendente ocupa vaga | Existe (`limits.ts:66-89`) | Nenhuma |
| Contato que chega por mensagem não é bloqueado | Existe: `chat_contact` não conta (T4 do plano) | Nenhuma |
| Suspensão e somente leitura | Existe (`access_mode`, `billingState`) | Nenhuma |
| Troca de plano pelo owner e pelo admin | Existe (`/api/billing/change-plan`, `/api/admin/tenants/:id/plan`) | Nenhuma |
| Enforcement no banco por trigger | Só na aplicação | **Não portar.** Na origem o navegador grava direto no banco; aqui toda escrita passa pela API |
| Interruptor global de quotas | Não existe | **Não portar.** O plano gratuito com limites nulos cumpre o papel |
| Contador de uso | `count(*)` na hora | **Não portar** agora; reavaliar se a contagem de `customers` pesar |
| Garantia contra corrida | Só em canais e organizações | **Q1:** `pg_advisory_xact_lock` por tenant e métrica em `assertWithinLimit` para `customers` e `members` (a importação torna a corrida real) |
| Tela "Plano e uso" com barras | Não existe; `/api/me` devolve limites sem uso | **Q2:** `GET /api/billing/usage` e barras em `/app/assinatura` (aviso a partir de 80%) |
| Exceção de limite por conta (`limit_overrides`) | Não existe | **Q3:** `subscription.limit_overrides` (jsonb), aplicado em `checkLimit`, editado em `/admin` com motivo e auditoria |
| Recurso por plano (`plan_feature`) | `plan.features` existe, sem `hasFeature` | **Q4**, opcional: `hasFeature` no servidor e na tela; primeiro uso natural é a importação |
| Histórico de mudança de plano | Só no `audit_log` | Nenhuma |
| Limite por papel (admin × agente) | Não existe | Fora |

**LLM:** Sonnet 5.5 em Q1, Q2 e Q4; Opus 5.5 em Q3 (toca cobrança) com `/security-review`.

---

## Ordem e portão de produção

| Ordem | Blocos | Segura o deploy? | Por quê |
|---|---|---|---|
| 1 | S, B | Sim | Segurança de conta; pequenos e isolados |
| 2 | T, F | Sim | Fecha o achado aberto da revisão de segurança da caixa de entrada; sem o perfil (F), owner e equipe não têm onde trocar o telefone |
| 3 | E, L | Sim | Avisos de exclusão e texto legal precisam valer no primeiro aceite real |
| 4 | R | Sim | Protege o servidor (D-7): produção sobe com a retenção ligada e os padrões baixos; em desenvolvimento fica desligada |
| 5 | Q1 antes de I; depois I, X, Q2 a Q4 | Não | Recursos novos, sem risco para o que já existe |

Cada fase termina com `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db`,
`npm run build` e `/code-review`; `/security-review` onde a tabela de fases indica.

## Decisões

Todas as decisões de produto (P1 a P18 e D-1 a D-13) estão na tabela "Decisões do
proprietário". Em aberto, para o proprietário confirmar: as decisões T3-1 a T3-9 da T3 (em "T3: o
que foi feito"), T4-1 a T4-4 (em "T4: o que foi feito") e TC-1 a TC-10 da troca de telefone (em "Troca
de telefone pelo pedido: o que foi feito").

**Leituras que esta SPEC fez das últimas respostas, confirmadas na aprovação (2026-11-11):**

| # | Leitura confirmada | Alternativa descartada |
|---|---|---|
| C-1 | D-11 vale nos dois caminhos: **remover a pessoa da equipe** apaga a ficha ligada naquela organização, e **excluir a conta** apaga as fichas ligadas em todas | Valer só na exclusão da conta; remover da equipe apenas desfaz a ligação |
| C-2 | D-1: apagar a ficha antiga apaga também as conversas dela (é `deleteCustomer`) | Passar o contato e as conversas do número para a ficha nova |
| C-3 | D-7: 5.000 mensagens, 90 dias e 200 favoritas por organização e tipo de canal; o exemplo de produção vem com a retenção **ligada** | Outros números, ou produção desligada até decisão de operação |

**Decisões técnicas desta SPEC:**

| Decisão | Motivo | Alternativa descartada |
|---|---|---|
| Unicidade de owner e equipe por função com trava, sem índice | `user` é global e o papel fica em `member` | Índice único em `user.phone_key` (impediria a mesma pessoa em duas organizações com contas distintas) |
| Unicidade de conta só entre telefones confirmados | Número declarado não pode reservar o telefone de outra pessoa nem revelar que ele tem conta | 409 no cadastro |
| Cliente criado ou importado pela equipe não recebe link | Importação viraria envio em massa a quem nunca escreveu | Link para todo telefone novo |
| Sessão criada com telefone pendente, bloqueio no servidor | Reenviar e corrigir o número exigem identidade | Recusar o login, como no e-mail não verificado |
| Token novo a cada tentativa de envio | O token nunca fica no payload do job | Guardar o token cifrado no pedido |
| Retenção em serviço Drizzle e job pg-boss | Drizzle é a única camada de dados; o projeto já tem agendador | Função SQL e rota de cron, como na origem |
| Sem trigger de quota, contador de uso e interruptor global | Toda escrita passa pela API | Portar o motor da SPEC 059 inteiro |
| Dados de emoji no próprio servidor | `connect-src` segue `self` | CDN |

## Atualização de contexto

Na entrega de cada bloco:

- [ ] `tech/28-crm-cadastro.md`: verificação e unicidade do telefone (T), importação (I)
- [ ] `tech/30-caixa-de-entrada.md`: fechar os limites de vínculo e de retenção (T, R), avisos de exclusão (E), transferência, emoji e filtro na URL (X)
- [ ] `tech/08-auth.md` e `tech/26-seguranca.md`: política de senha, bloqueio de login, bloqueio por telefone pendente e perfil (S, B, T, F)
- [ ] `tech/21-tenant-rbac.md`: permissão `phone:confirm`; `tech/29-canais-whatsapp.md`: modelo de verificação e envio fora da caixa de entrada (T)
- [ ] `tech/27-lgpd-arquivos.md` e `lgpd.md`: retenção de mensagens e texto legal (R, L)
- [ ] `tech/23-billing-planos.md`: uso, exceção por tenant e trava de corrida (Q)
- [ ] `tech/20-jobs.md`: jobs `phone.verify` e `inbox.retention`
- [ ] `INDEX.md`, `status.md`, `.env.example`, `docker/.env.prod.example` e as rules em par (`.claude/rules/` e `.cursor/rules/`) de `auth` e `inbox`
- [ ] `docs/specs/whatsapp-crm/plano.md`: tirar de "O que não é portado" a retenção automática de mensagens
