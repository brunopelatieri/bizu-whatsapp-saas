# PRD: Cadastro CRM (etiquetas, campos adicionais e telefone)

- **Status:** aprovado
- **Data:** 2026-11-09
- **Responsável:** Bruno Pelatieri
- **Programa:** `docs/specs/whatsapp-crm/plano.md`

> O PRD responde **o quê** e **por quê**. Tabelas, endpoints e componentes ficam na SPEC.

## Problema

O cadastro de cliente do owner tem campos fixos e etiquetas de texto livre, digitadas em cada
cliente. Ninguém consegue padronizar as etiquetas, dar cor, renomear uma em todos os clientes ou
filtrar por elas com confiança. Quem precisa guardar um dado próprio do negócio (plano
contratado, data de renovação, origem) usa o campo de observações.

O cadastro também exige e-mail, e o telefone é texto livre e opcional, sem máscara nem
validação. Com o WhatsApp como canal da base, o telefone é o dado principal: o cliente chega só
com o número, e o mesmo número escrito de formas diferentes não é reconhecido. O mesmo vale
para as pessoas do sistema (owner, equipe, administradores da plataforma): sem telefone válido
não há como falar com elas.

O proprietário da plataforma tem o mesmo problema com as organizações: não há como marcar
"em implantação", "inadimplente recorrente" ou guardar um dado comercial de cada conta.

## Objetivo e métrica de sucesso

- **Objetivo:** o owner configura uma vez as etiquetas e os campos do seu negócio, e toda a
  equipe usa esse mesmo catálogo no cadastro e no atendimento. O proprietário da plataforma faz
  o mesmo para as organizações.
- **Métrica:** em um tenant de teste, criar 5 etiquetas e 3 campos, aplicá-los a 20 clientes e
  filtrar por etiqueta em menos de 10 minutos, sem tocar em observações. Zero etiqueta duplicada
  por diferença de maiúscula.

## Usuários

| Perfil | Precisa conseguir |
|---|---|
| Owner e admin do tenant | Criar, renomear, recolorir e excluir etiquetas; criar, ordenar, arquivar e excluir campos adicionais |
| Membro do tenant | Aplicar e remover etiquetas; preencher os campos; filtrar clientes por etiqueta. Não mexe no catálogo |
| Proprietário da plataforma | O mesmo catálogo, separado, para as organizações |
| Suporte da plataforma | Ver etiquetas e campos das organizações |
| Cliente (portal) | Nada muda: não vê etiquetas, campos nem observações |

## Escopo

**Dentro:**

- Catálogo central de etiquetas com nome e cor, por tenant, gerido nas configurações.
- Etiquetas aplicadas ao cliente pelo formulário, pelo detalhe e por um seletor rápido.
- Filtro de clientes por uma ou mais etiquetas.
- Campos adicionais definidos nas configurações e anexados ao cadastro do cliente, com tipo,
  ordem e obrigatoriedade.
- Telefone **obrigatório** em todo cadastro de pessoa, com máscara e validação (DDD e celular),
  normalizado em um formato único: conta de owner, membro, admin e suporte (cadastro, perfil e
  `/admin`), conta do portal e cliente.
- Cliente sem e-mail (com telefone), sem conta acessível; e-mail obrigatório para quem tem
  conta.
- O mesmo par, etiquetas e campos, para as organizações em `/admin`.

**Fora:**

- Etiquetas em conversas, em membros da equipe ou em usuários.
- Campos adicionais visíveis ou editáveis pelo cliente no portal.
- Filtro e ordenação da lista por campo adicional (fica para depois; a SPEC deixa o caminho).
- Importação e exportação de clientes em planilha.
- Fórmulas, campos calculados, anexos e campos condicionais.
- Mesclar clientes duplicados pelo telefone (o telefone é único por tenant desde o primeiro
  cadastro, então não há duplicado a fundir).
- Migrar dados anteriores (etiquetas de texto, telefones, contas sem telefone): o projeto é
  novo e só terá cadastros depois desta implementação.

## Requisitos funcionais

| ID | Requisito | Prioridade |
|---|---|---|
| RF-01 | Quem tem permissão cria etiqueta com nome (até 40 caracteres) e cor, escolhida entre presets, uma grade ampliada ou um código hexadecimal | Must |
| RF-02 | O nome da etiqueta é único no tenant, sem diferenciar maiúsculas; tentar repetir mostra o erro no campo | Must |
| RF-03 | Renomear ou recolorir uma etiqueta muda todos os clientes que a têm | Must |
| RF-04 | Excluir uma etiqueta pede confirmação, informa quantos clientes a usam e a remove de todos | Must |
| RF-05 | A etiqueta aparece como um chip colorido, legível nos temas claro e escuro; cor de baixo contraste gera aviso, sem bloquear | Should |
| RF-06 | No cliente, a equipe aplica e remove etiquetas do catálogo, sem digitar texto livre; um seletor com busca permite marcar várias | Must |
| RF-07 | Quem pode gerir o catálogo cria uma etiqueta nova de dentro do seletor | Should |
| RF-08 | A lista de clientes filtra por uma ou mais etiquetas (qualquer uma delas) junto com busca e situação | Must |
| RF-09 | (Removido: não há etiquetas de texto a migrar; o projeto é novo) | – |
| RF-10 | Quem tem permissão cria um campo adicional com rótulo, tipo (texto, número, data, sim/não, lista de opções, múltipla escolha), opções, obrigatoriedade e ordem | Must |
| RF-11 | Os campos aparecem no formulário e no detalhe do cliente, na ordem definida, com o controle certo para cada tipo | Must |
| RF-12 | O valor é validado conforme o tipo; campo obrigatório vazio impede salvar pelo formulário | Must |
| RF-13 | Arquivar um campo o esconde sem apagar valores; excluir apaga os valores de todos os clientes, depois de confirmação | Must |
| RF-14 | Mudar o rótulo de um campo não perde valores | Must |
| RF-15 | O cliente pode ser salvo sem e-mail, mas **nunca sem telefone**. Sem e-mail ele não tem conta acessível: "Enviar acesso", convite e magic link ficam indisponíveis, com a explicação "cadastre um e-mail para liberar o acesso". Ao cadastrar o e-mail depois, o acesso pode ser enviado | Must |
| RF-16 | O telefone é validado e guardado em formato único; o mesmo número escrito de formas diferentes é reconhecido como o mesmo | Must |
| RF-22 | O telefone é **obrigatório** no cadastro de conta (`/cadastro`), no autocadastro do portal, no perfil, na edição de usuário em `/admin` e no cadastro de cliente. Sem telefone válido o formulário não envia e a API recusa (400) | Must |
| RF-23 | Todo campo de telefone tem **máscara** enquanto se digita (`(19) 99924-9658` no Brasil) e seletor de país, com o Brasil como padrão; o erro aparece no campo, em português, dizendo o que corrigir | Must |
| RF-24 | **Brasil:** o número precisa ter DDD entre os 67 em uso e ser **celular** (9 dígitos, o primeiro é `9`) ou **fixo** (8 dígitos, o primeiro de 2 a 8). Fixo e celular antigo de 8 dígitos mostram o aviso "este número pode não receber WhatsApp", sem bloquear. O **celular antigo** é aceito se for informado assim, **mas validado**: DDD entre os 67, exatamente 8 dígitos e o primeiro `9`; o sistema nunca acrescenta o 9 sozinho. DDD inexistente, celular sem o `9`, número incompleto e serviço especial (`0800`) são recusados. Aceita digitação com `+55`, `55`, `0` de tronco, parênteses, espaços e hífen; número sem DDI é tratado como do Brasil. **Outros países (DDI diferente de 55):** a regra do Brasil não se aplica; vale só número internacional válido (8 a 15 dígitos com DDI, informado pelo seletor de país ou com `+`), inclusive os de 11 dígitos, como os dos EUA | Must |
| RF-25 | E-mail é obrigatório para toda conta (owner, membro, admin, suporte e conta do portal) | Must |
| RF-26 | Nenhuma conta nem cliente existe sem telefone: além da validação da tela e da API, o banco recusa o registro sem telefone (só a linha anonimizada pela LGPD fica sem ele). Não há cadastro anterior a esta regra | Must |
| RF-17 | O proprietário da plataforma tem catálogo próprio de etiquetas e campos, aplicados às organizações em `/admin`, com filtro por etiqueta | Must |
| RF-18 | O owner e a equipe nunca veem as etiquetas e os campos que a plataforma aplicou à organização deles | Must |
| RF-19 | Criar, alterar e excluir etiqueta ou campo fica registrado na auditoria | Should |
| RF-20 | Dois clientes do mesmo tenant não têm o mesmo telefone: salvar um número já usado é recusado com erro no campo, que indica o cliente que o tem (o nome só aparece a quem pode ver clientes). Vale para o mesmo número escrito de formas diferentes e com ou sem o 9º dígito | Must |
| RF-21 | Cada tenant tem até 100 etiquetas e 12 campos adicionais ativos por entidade; passar do teto é recusado com mensagem. A plataforma tem os mesmos tetos no seu catálogo | Must |

## Requisitos não funcionais

- **Privacidade:** valores de campos adicionais e etiquetas são dado pessoal do cliente: entram
  na exportação LGPD do owner e saem na anonimização.
- **Isolamento:** catálogo e valores de um tenant nunca aparecem em outro; os da plataforma
  nunca aparecem em tenant nenhum.
- **Desempenho:** a lista de clientes com etiquetas responde em uma consulta por página, sem
  uma consulta por cliente.
- **Acessibilidade:** a cor nunca é o único sinal: o chip sempre traz o nome.

## Critérios de aceite

- [ ] Dado um admin, quando cria a etiqueta "VIP" e depois tenta criar "vip", então a segunda é recusada com erro no campo.
- [ ] Dado um membro sem permissão de catálogo, quando abre as configurações, então vê as etiquetas e os campos sem botões de edição, e a API recusa a escrita.
- [ ] Dado um cliente com a etiqueta "VIP", quando o admin a renomeia para "Premium" e muda a cor, então a lista e o detalhe mostram "Premium" na cor nova.
- [ ] Dada uma etiqueta usada por 12 clientes, quando o admin a exclui, então o diálogo mostra 12 e, depois de confirmar, nenhum cliente a tem.
- [ ] Dado um campo obrigatório "Segmento" do tipo lista, quando o membro salva um cliente sem escolher, então o formulário recusa.
- [ ] Dado um campo de data, quando a API recebe um texto que não é data, então responde 400.
- [ ] Dado um campo com valores, quando o admin o arquiva e depois reativa, então os valores voltam.
- [ ] Dado um cliente sem e-mail e com telefone, quando o membro salva, então o cadastro é aceito e "Enviar acesso" fica indisponível com a explicação; dado o mesmo cliente, quando ele tenta entrar no portal por magic link com qualquer e-mail, então não encontra conta e a resposta é a genérica de sempre.
- [ ] Dado um cliente com e-mail, quando o membro tenta salvá-lo sem telefone, então o formulário recusa e a API responde 400 `PHONE_REQUIRED`.
- [ ] Dado um cliente sem e-mail e sem telefone, quando o membro tenta salvar, então a API responde 400 pedindo o telefone.
- [ ] Dado o cadastro em `/cadastro`, quando a pessoa envia sem telefone, ou com `(10) 98765-4321` (DDD inexistente), `(11) 88765-4321` (celular sem o 9) ou `(11) 98765-43` (incompleto), então o cadastro é recusado com a mensagem do motivo e nenhuma conta é criada.
- [ ] Dado um cliente, quando o membro informa `(11) 3456-7890` (fixo), então o cadastro é aceito com o aviso de que o número pode não receber WhatsApp, e "Conversar" no atendimento fica indisponível para ele.
- [ ] Dado o cadastro em `/cadastro`, quando a pessoa envia `+55 (11) 98765-4321`, `5511987654321` ou `011 98765-4321`, então todos são aceitos e gravados como `5511987654321`.
- [ ] Dado um número de fora do Brasil, quando o país escolhido não é o Brasil (DDI diferente de 55) e o número tem tamanho válido, então é aceito sem a regra de DDD nem de 9º dígito; `+1 415 555 2671` é aceito.
- [ ] Dado um cliente, quando o membro informa `(11) 9876-5432` (celular antigo), então o cadastro é aceito com o aviso para conferir o 9 e gravado sem o 9 acrescentado; com `(10) 9876-5432` (DDD inexistente) ou `(11) 9876-543` (incompleto), é recusado.
- [ ] Dado o autocadastro do portal, o perfil e a edição de usuário em `/admin`, quando o telefone falta ou é inválido, então são recusados do mesmo jeito.
- [ ] Dado um campo de telefone, quando a pessoa digita `11987654321`, então a máscara mostra `(11) 98765-4321` enquanto digita.
- [ ] Dado qualquer caminho de criação de conta ou cliente (cadastro, convite do portal, seed), quando o telefone falta, então o registro não é criado.
- [ ] Dado um cliente com telefone `(19) 99924-9658`, quando se busca `5519999249658`, então ele é encontrado.
- [ ] Dado um cliente com telefone `(19) 99924-9658`, quando o membro tenta salvar outro cliente com `+55 19 99924-9658` (ou sem o 9º dígito), então a API responde 409 `PHONE_IN_USE` e o formulário mostra o erro no campo com o cliente que já tem o número; salvar o próprio cliente sem mudar o telefone continua funcionando.
- [ ] Dado um tenant com 100 etiquetas, quando o admin cria a 101ª, então recebe `TAG_LIMIT`; dado um com 12 campos ativos, quando cria o 13º, então recebe `FIELD_LIMIT` (arquivar um campo libera vaga).
- [ ] Dado o proprietário da plataforma, quando etiqueta a organização `acme`, então o owner do `acme` não vê nada disso em nenhuma tela nem resposta da API.
- [ ] Dado o tenant A, quando chama a API com o id de uma etiqueta do tenant B, então recebe 404.

## Riscos e dependências

- **Mudança de contrato:** `tags` deixa de ser lista de textos na API de clientes. Toda tela
  que lê ou grava cliente muda junto.
- **E-mail opcional** toca o portal, a exportação e a exclusão LGPD e o `/admin`, que hoje
  contam com o e-mail preenchido.
- **Sem dados anteriores:** o projeto é novo e só terá cadastros depois desta implementação
  (decisão do proprietário). Não há telefone, etiqueta nem conta a migrar; um banco de
  desenvolvimento com dados de teste antigos precisa ser recriado com o seed.
- **Fixo aceito** (decisão do proprietário, como na origem `zap-crm-br-client`): o cliente que
  só tem telefone fixo pode ser cadastrado, mas não recebe WhatsApp; o aviso aparece no
  formulário e o atendimento não inicia conversa com ele.
- **Telefone único** impede dois cadastros com o mesmo número (família, empresa). É decisão do
  proprietário: como o telefone também é obrigatório, a segunda pessoa só é cadastrada como
  cliente com outro número.
- Depende da fase F0 do plano (escopo de plataforma) para a parte de `/admin`.

## Decisões do proprietário (2026-11-09)

- **Tetos:** 100 etiquetas e 12 campos adicionais ativos por escopo (RF-21).
- **Telefone repetido:** não permitir; o telefone é único por tenant (RF-20).
- **Telefone e e-mail:** telefone obrigatório em todos os cadastros, com máscara e validação de
  DDD (RF-22 a RF-24); e-mail obrigatório para ter conta acessível, e o cliente sem e-mail não
  tem acesso (RF-15, RF-25).
- **Campos adicionais como colunas na lista de clientes:** não nesta entrega (proposta do PRD,
  Could).
- **Celular antigo de 8 dígitos:** aceito se for informado, mas validado (DDD, 8 dígitos,
  começa com 9), com aviso; nunca completado com o 9 (RF-24).
- **Telefone de outro país:** a regra do Brasil só vale para DDI 55; os demais só precisam ser
  um número internacional válido (RF-24).
- **Cadastros anteriores:** não existem; o projeto é novo. Sem migração de dados nem aviso de
  telefone pendente, e o banco exige o telefone (RF-26).
