# PRD: Cadastro CRM (etiquetas, campos adicionais e telefone)

- **Status:** rascunho
- **Data:** 2026-11-09
- **Responsável:** Bruno Pelatieri
- **Programa:** `docs/specs/whatsapp-crm/plano.md`

> O PRD responde **o quê** e **por quê**. Tabelas, endpoints e componentes ficam na SPEC.

## Problema

O cadastro de cliente do owner tem campos fixos e etiquetas de texto livre, digitadas em cada
cliente. Ninguém consegue padronizar as etiquetas, dar cor, renomear uma em todos os clientes ou
filtrar por elas com confiança. Quem precisa guardar um dado próprio do negócio (plano
contratado, data de renovação, origem) usa o campo de observações.

O cadastro também exige e-mail, e o telefone é texto livre. Com o WhatsApp como canal de
atendimento, o cliente chega só com o número, e o mesmo número escrito de formas diferentes
não é reconhecido.

O proprietário da plataforma tem o mesmo problema com as organizações: não há como marcar
"em implantação", "inadimplente recorrente" ou guardar um dado comercial de cada conta.

## Objetivo e métrica de sucesso

- **Objetivo:** o owner configura uma vez as etiquetas e os campos do seu negócio, e toda a
  equipe usa esse mesmo catálogo no cadastro e no atendimento. O proprietário da plataforma faz
  o mesmo para as organizações.
- **Métrica:** em um tenant de teste, criar 5 etiquetas e 3 campos, aplicá-los a 20 clientes e
  filtrar por etiqueta em menos de 10 minutos, sem tocar em observações. Zero etiqueta duplicada
  por diferença de maiúscula depois da migração.

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
- Migração das etiquetas de texto que já existem para o catálogo.
- Campos adicionais definidos nas configurações e anexados ao cadastro do cliente, com tipo,
  ordem e obrigatoriedade.
- Telefone normalizado e cliente sem e-mail (com telefone).
- O mesmo par, etiquetas e campos, para as organizações em `/admin`.

**Fora:**

- Etiquetas em conversas, em membros da equipe ou em usuários.
- Campos adicionais visíveis ou editáveis pelo cliente no portal.
- Filtro e ordenação da lista por campo adicional (fica para depois; a SPEC deixa o caminho).
- Importação e exportação de clientes em planilha.
- Fórmulas, campos calculados, anexos e campos condicionais.
- Mesclar clientes duplicados pelo telefone.

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
| RF-09 | As etiquetas de texto atuais viram itens do catálogo, sem perder nenhum vínculo | Must |
| RF-10 | Quem tem permissão cria um campo adicional com rótulo, tipo (texto, número, data, sim/não, lista de opções, múltipla escolha), opções, obrigatoriedade e ordem | Must |
| RF-11 | Os campos aparecem no formulário e no detalhe do cliente, na ordem definida, com o controle certo para cada tipo | Must |
| RF-12 | O valor é validado conforme o tipo; campo obrigatório vazio impede salvar pelo formulário | Must |
| RF-13 | Arquivar um campo o esconde sem apagar valores; excluir apaga os valores de todos os clientes, depois de confirmação | Must |
| RF-14 | Mudar o rótulo de um campo não perde valores | Must |
| RF-15 | O cliente pode ser salvo sem e-mail, desde que tenha telefone; "Enviar acesso" ao portal continua exigindo e-mail | Must |
| RF-16 | O telefone é validado e guardado em formato único; o mesmo número escrito de formas diferentes é reconhecido como o mesmo | Must |
| RF-17 | O proprietário da plataforma tem catálogo próprio de etiquetas e campos, aplicados às organizações em `/admin`, com filtro por etiqueta | Must |
| RF-18 | O owner e a equipe nunca veem as etiquetas e os campos que a plataforma aplicou à organização deles | Must |
| RF-19 | Criar, alterar e excluir etiqueta ou campo fica registrado na auditoria | Should |

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
- [ ] Dado um tenant com clientes etiquetados como "vip", "VIP " e "Lead", quando a migração roda, então o catálogo tem "vip" e "Lead", e cada cliente mantém as suas.
- [ ] Dado um campo obrigatório "Segmento" do tipo lista, quando o membro salva um cliente sem escolher, então o formulário recusa.
- [ ] Dado um campo de data, quando a API recebe um texto que não é data, então responde 400.
- [ ] Dado um campo com valores, quando o admin o arquiva e depois reativa, então os valores voltam.
- [ ] Dado um cliente sem e-mail e com telefone, quando o membro salva, então o cadastro é aceito e "Enviar acesso" fica indisponível com a explicação.
- [ ] Dado um cliente com telefone `(19) 99924-9658`, quando se busca `5519999249658`, então ele é encontrado.
- [ ] Dado o proprietário da plataforma, quando etiqueta a organização `acme`, então o owner do `acme` não vê nada disso em nenhuma tela nem resposta da API.
- [ ] Dado o tenant A, quando chama a API com o id de uma etiqueta do tenant B, então recebe 404.

## Riscos e dependências

- **Mudança de contrato:** `tags` deixa de ser lista de textos na API de clientes. Toda tela
  que lê ou grava cliente muda junto.
- **E-mail opcional** toca o portal, a exportação e a exclusão LGPD e o `/admin`, que hoje
  contam com o e-mail preenchido.
- **Telefones já gravados** em formato inválido ficam sem valor normalizado; a SPEC define o
  que fazer com eles.
- Depende da fase F0 do plano (escopo de plataforma) para a parte de `/admin`.

## Perguntas em aberto

- Campos adicionais devem aparecer como colunas na lista de clientes já nesta entrega? Proposta:
  não (Could). Decide: proprietário.
- Teto de 200 etiquetas e 30 campos por cadastro é suficiente? Decide: proprietário.
- Dois clientes com o mesmo telefone continuam permitidos (hoje são). Proposta: sim, com aviso
  ao salvar. Decide: proprietário.
