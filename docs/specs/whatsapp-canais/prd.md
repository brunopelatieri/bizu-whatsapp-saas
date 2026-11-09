# PRD: Canais WhatsApp (Cloud API e Evolution Go)

- **Status:** rascunho
- **Data:** 2026-11-09
- **Responsável:** Bruno Pelatieri
- **Programa:** `docs/specs/whatsapp-crm/plano.md`

> O PRD responde **o quê** e **por quê**. Tabelas, endpoints e componentes ficam na SPEC.

## Problema

O owner fala com os clientes e com a própria equipe pelo WhatsApp, em celulares pessoais. A
conversa não fica na empresa, ninguém enxerga o que o colega respondeu e não há ligação com o
cadastro de clientes. O proprietário da plataforma está na mesma situação com os owners.

O projeto não tem nenhum canal de mensagem. Sem conectar um número de WhatsApp à conta, não há
como ter caixa de entrada.

## Objetivo e métrica de sucesso

- **Objetivo:** o owner conecta um ou mais números de WhatsApp à sua conta, pelo caminho oficial
  (Cloud API da Meta) ou por QR Code (Evolution Go), e vê na tela se cada número está pronto para
  enviar e receber. O proprietário da plataforma faz o mesmo para os números do SaaS.
- **Métrica:** um owner sem ajuda conecta um número por QR Code em até 3 minutos. Um número
  oficial, com as credenciais em mãos, fica "conectado" e recebe a primeira mensagem de teste em
  até 10 minutos. Nenhuma mensagem recebida é perdida por reinício do servidor.

## Usuários

| Perfil | Precisa conseguir |
|---|---|
| Owner e admin do tenant | Conectar, renomear, diagnosticar, desconectar e remover números; escolher o número padrão |
| Membro do tenant | Ver quais números existem e se estão conectados |
| Proprietário da plataforma | O mesmo, para os números da plataforma; definir quantos números cada plano permite |
| Suporte da plataforma | Ver o estado dos números da plataforma |

## Escopo

**Dentro:**

- Número oficial pela **WhatsApp Cloud API**, com as credenciais do aplicativo da Meta do
  próprio dono do número.
- Número por **QR Code** no servidor Evolution Go da plataforma, com leitura do QR ou código de
  pareamento.
- Vários números por conta, dos dois tipos, dentro do limite do plano.
- Estado de cada número (conectando, conectado, desconectado, erro, desativado) e diagnóstico.
- Recebimento seguro dos avisos dos provedores (mensagens, status de entrega, conexão).
- Lista dos modelos de mensagem aprovados na Meta, para uso na caixa de entrada.
- Tudo isso também em `/admin`, para os números da plataforma.

**Fora:**

- Criar, editar e submeter modelos de mensagem (segue no painel da Meta).
- Cadastro incorporado da Meta (Embedded Signup) e aplicativo único da plataforma para todos os
  tenants.
- Servidor Evolution informado pelo tenant.
- Disparo em massa, automações, checagem de números e captação de contatos da agenda.
- Outros canais (Instagram, e-mail, Telegram).
- Monitor de cobrança e de limite de mensagens da Meta.

## Requisitos funcionais

| ID | Requisito | Prioridade |
|---|---|---|
| RF-01 | Quem tem permissão conecta um número oficial informando identificador do número, conta WhatsApp Business, token de acesso, segredo do aplicativo e, se houver, o PIN de duas etapas | Must |
| RF-02 | Ao salvar, o sistema confere as credenciais na Meta e mostra o número e o nome verificados; credencial inválida não é gravada | Must |
| RF-03 | A tela mostra o endereço de webhook e o token de verificação daquele número, prontos para copiar, com o passo a passo de configuração na Meta | Must |
| RF-04 | Um diagnóstico diz, item a item, se o token vale, se o número responde, se a conta está assinada no aplicativo e se o webhook já foi confirmado | Must |
| RF-05 | Quem tem permissão cria um número por QR Code informando só um nome, e conecta lendo o QR ou digitando um código de pareamento no celular | Must |
| RF-06 | A tela do QR mostra a validade, permite gerar outro e avisa sozinha quando o número conecta | Must |
| RF-07 | Um número por QR Code pode ser desconectado, reconectado, deslogado e excluído; a exclusão pede o nome digitado | Must |
| RF-08 | A tela de QR Code traz um aviso permanente de que esse caminho não é oficial e pode levar ao bloqueio do número | Must |
| RF-09 | Cada número tem nome, telefone exibido, tipo e estado; a lista mostra quando foi a última atividade | Must |
| RF-10 | A conta escolhe um número padrão por tipo; o primeiro número de cada tipo vira padrão sozinho | Should |
| RF-11 | Um mesmo número oficial só pode estar em uma conta; tentar cadastrar em outra é recusado | Must |
| RF-12 | Remover um número sem conversas o apaga; com conversas, ele fica desativado, as credenciais são apagadas e o histórico continua | Must |
| RF-13 | O plano define quantos números oficiais e quantos por QR Code a conta pode ter; ao atingir o limite, o botão de criar explica o motivo | Must |
| RF-14 | Alterar um número oficial sem redigitar o token ou o segredo mantém os valores gravados | Must |
| RF-15 | Nenhuma tela ou resposta mostra token ou segredo depois de gravado, só os 4 últimos caracteres | Must |
| RF-16 | Aviso de provedor com assinatura ou segredo inválido é recusado e não altera nada | Must |
| RF-17 | Aviso repetido pelo provedor não gera mensagem nem status duplicado | Must |
| RF-18 | Aviso recebido é guardado antes de ser respondido ao provedor, e processado mesmo que o servidor reinicie | Must |
| RF-19 | Quando o número por QR Code é desconectado no celular, o estado muda na tela em até 1 minuto | Must |
| RF-20 | A conta sincroniza os modelos de mensagem aprovados de cada número oficial | Must |
| RF-21 | O proprietário da plataforma vê os avisos de provedor com falha e pode reprocessá-los | Should |
| RF-22 | Conectar, alterar, desconectar e remover número fica registrado na auditoria | Must |
| RF-23 | Sem o servidor Evolution configurado, a opção de QR Code não aparece para os tenants, e `/admin` explica o que falta | Must |

## Requisitos não funcionais

- **Segurança:** credenciais cifradas em repouso; webhooks validados antes de qualquer leitura
  do conteúdo; endereço do servidor Evolution só por variável de ambiente.
- **Isolamento:** o aviso de um número nunca é aplicado em outra conta, mesmo que dois números
  usem o mesmo aplicativo da Meta.
- **Disponibilidade:** o recebimento responde ao provedor em menos de 2 segundos; a Evolution
  desiste de reenviar em cerca de 2 minutos e meio.
- **Privacidade:** o conteúdo bruto dos avisos é guardado só pelo tempo necessário para
  reprocessar (30 dias).
- **Removível:** cada motor é um módulo; apagar a pasta e tirar o id da variável o remove.

## Critérios de aceite

- [ ] Dado um admin com credenciais válidas, quando salva um número oficial, então ele aparece "conectado" com o telefone e o nome verificados.
- [ ] Dado um token inválido, quando salva, então recebe a mensagem da Meta e nada é gravado.
- [ ] Dado um número oficial conectado, quando a Meta chama a verificação do webhook com o token certo, então recebe o desafio de volta; com token errado, 403.
- [ ] Dado um aviso da Meta com assinatura adulterada, quando chega, então a resposta é 401 e nada muda.
- [ ] Dado o mesmo aviso entregue duas vezes, quando o segundo chega, então nenhuma mensagem nova nasce.
- [ ] Dado um número já cadastrado no tenant A, quando o tenant B tenta cadastrá-lo, então recebe 409 sem saber de quem é.
- [ ] Dado um admin, quando cria um número por QR Code e lê o código no celular, então a tela passa a "conectado" sem recarregar.
- [ ] Dado um número por QR Code conectado, quando o dono desloga no celular, então a lista mostra "desconectado".
- [ ] Dado um plano com limite de 1 número por QR Code e 1 já criado, quando tenta criar outro, então recebe 403 `PLAN_LIMIT_REACHED`.
- [ ] Dado um número com conversas, quando é removido, então fica "desativado", as credenciais somem do banco e as conversas continuam legíveis.
- [ ] Dado um membro sem permissão, quando chama qualquer escrita de canal, então recebe 403.
- [ ] Dado qualquer usuário, quando lê um canal pela API, então a resposta não contém token nem segredo.
- [ ] Dado um aviso gravado e o servidor reiniciado antes do processamento, quando o servidor volta, então o aviso é processado.
- [ ] Dado `CHANNEL_PROVIDERS` sem `whatsapp_qr` e a pasta do módulo apagada, quando rodam `typecheck` e os testes, então passam.

## Riscos e dependências

- **Bloqueio do número por QR Code:** o caminho não é oficial. O aviso é permanente e a decisão
  é do dono do número.
- **Servidor Evolution fora do ar** derruba todos os números por QR Code de todos os tenants.
- **A documentação do Evolution Go não confere com o servidor real** (medido na origem): os
  contratos precisam ser medidos de novo antes de codificar (fase B0).
- **Versão da Graph API:** a origem usa `v21.0`; a versão vigente precisa ser conferida.
- **Mídia grande em base64** no aviso da Evolution: exige limite de corpo próprio.
- Depende de F0 (escopo de plataforma), do módulo de arquivos e da fila de jobs.
- A caixa de entrada (`docs/specs/caixa-de-entrada/`) é quem transforma os avisos em conversas.

## Perguntas em aberto

- Quantos números por plano? Proposta: `free` 0 oficial e 1 QR; `basic` 1 e 1; `pro` 3 e 3.
  Decide: proprietário.
- Teto global de instâncias no servidor Evolution? Proposta: 20, por variável. Decide: quem
  opera a VPS.
- O servidor Evolution entrega mídia por base64 ou por armazenamento próprio (MinIO)? A SPEC
  aceita os dois. Decide: quem opera a VPS.
