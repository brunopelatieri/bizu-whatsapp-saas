# Política de privacidade

Versão {{VERSION}}. Modelo para ser revisado por um advogado antes de ir ao ar: troque os trechos entre colchetes pelos dados do seu negócio.

## 1. Controlador e encarregado

O controlador dos dados pessoais é **[NOME DO CONTROLADOR, CNPJ E ENDEREÇO]**. O encarregado pelo tratamento de dados (DPO) é contatado em **{{DPO_EMAIL}}**.

Quando uma organização cadastra os próprios clientes no {{APP_NAME}} ou atende pessoas pelo WhatsApp conectado à sua conta, ela é a controladora desses dados e nós somos operadores, tratando-os em nome dela. Nas conversas de WhatsApp entre você e a própria plataforma (por exemplo, o link de confirmação do seu telefone ou o suporte), nós somos os controladores.

## 2. Quais dados tratamos

- **Conta:** nome, e-mail, **telefone** (obrigatório, e só aceito se for um número que receba WhatsApp, no caso da equipe e dos proprietários), senha (guardada somente como hash) e, se você ativar, segredo da verificação em duas etapas. Também guardamos se o telefone foi confirmado, quando e de que forma.
- **Foto de perfil** da equipe, se você enviar uma.
- **Uso:** sessões (IP e navegador), registros de auditoria das ações na organização, aceite dos termos.
- **Clientes e leads da organização:** nome, e-mail (opcional), telefone, documento e anotações que a organização informar, inclusive etiquetas e campos adicionais que ela mesma criar.
- **Atendimento por WhatsApp:** quando uma organização conecta um número de WhatsApp ao {{APP_NAME}}, tratamos o telefone de quem escreve ou recebe mensagens, o nome do perfil dele no WhatsApp, o nome que a equipe der ao contato, as conversas, o texto das mensagens, o nome do modelo de mensagem usado, a situação de entrega e as imagens, áudios, vídeos e documentos enviados e recebidos. Quem escreve ao número da organização **sem ser cliente cadastrado** também vira contato: guardamos só o número, o nome do perfil e a conversa.
- **Avisos recebidos do WhatsApp:** cada mensagem que chega passa antes por um registro técnico do aviso, que contém o telefone, o nome e o texto da mensagem, usado só para processá-la.
- **Cobrança da organização:** razão social, CPF ou CNPJ e faturas. Dados de cartão ficam com o provedor de pagamento, nunca conosco.

## 3. Para que usamos e em qual base legal

| Finalidade | Base legal (LGPD, art. 7º) |
|---|---|
| Criar e manter sua conta, prestar o serviço | Execução de contrato |
| Atendimento por WhatsApp pedido pela organização | Execução de contrato (entre você e a organização, ou entre ela e nós) |
| Confirmar que o telefone é seu, por um link enviado por WhatsApp | Execução de contrato e segurança |
| Segurança, prevenção a fraude e auditoria | Legítimo interesse |
| Cobrança e guarda de faturas | Obrigação legal e execução de contrato |
| E-mails sobre novidades (opcional) | Consentimento, que você pode retirar quando quiser |

## 4. Com quem compartilhamos

Compartilhamos o mínimo necessário com provedores que operam o serviço:

- hospedagem e armazenamento de arquivos (onde ficam as imagens, os áudios e os documentos das conversas e as exportações de dados);
- envio de e-mail e, se você contratar um plano pago, pagamento;
- **Meta (WhatsApp Business Platform, a "Cloud API"):** quando a organização usa o número oficial, as mensagens, o telefone e o nome do perfil passam pela Meta, que trata esses dados conforme os próprios termos e a própria política de privacidade;
- **servidor Evolution operado pela plataforma:** quando a organização conecta o número por **QR Code**, as mensagens passam por esse servidor, que mantém a conexão com o WhatsApp.

Não vendemos dados pessoais.

## 5. Confirmação do telefone

O telefone precisa ser confirmado antes de valer na conta, no cadastro de cliente (quando ele cria conta no portal) e na troca de número. Para isso enviamos **um link por WhatsApp** ao número informado, a partir de um número de WhatsApp conectado pela plataforma ou pela organização a que o cadastro pertence. O link vale uma vez, por pouco tempo, e só confirma o número quando você o abre **já com sessão aberta na sua própria conta**. Guardamos o número a confirmar, o resultado e um histórico das tentativas (canal, hora e se o envio funcionou), e do link só guardamos uma marca irreversível (hash).

Se a organização usa um número conectado por QR Code, esse número é o WhatsApp da própria organização: quem o administra pode ver que a mensagem com o link foi enviada ao seu telefone. Se nenhum número estiver disponível, ou o envio falhar, o responsável (o proprietário da organização ou, para donos de organização e a equipe da plataforma, o proprietário da plataforma) pode liberar o número manualmente.

## 6. Por quanto tempo guardamos

| Dado | Prazo |
|---|---|
| Sessões | até 7 dias após expirar |
| Registros de auditoria | 365 dias (configurável pela plataforma) |
| Registros de e-mail enviado | 180 dias, sem o corpo da mensagem |
| Eventos de pagamento processados | 90 dias |
| Avisos recebidos do WhatsApp, já tratados | 30 dias (configurável pela plataforma, de 1 a 365) |
| Pedidos de confirmação de telefone encerrados | 30 dias |
| Mensagens e arquivos do atendimento por WhatsApp | apagados automaticamente, uma vez por dia, quando passam do prazo ou do limite de quantidade definidos pela plataforma para cada organização e tipo de número (padrão: 90 dias ou as 5.000 mensagens mais recentes); as mensagens marcadas como favoritas ficam fora dessa limpeza até o limite de favoritas (padrão: as 200 mais recentes); mensagens das últimas 72 horas nunca são apagadas por essa regra (o mínimo configurável é 24 horas). Antes disso, saem quando o cliente, a conta ou a organização são excluídos (seção 7) |
| Contatos e conversas do atendimento por WhatsApp | sem prazo automático: ficam enquanto a organização os mantiver (a conversa continua na lista mesmo sem as mensagens antigas), e saem quando o cliente, a conta ou a organização são excluídos (seção 7) |
| Foto de perfil | até você trocá-la ou removê-la, ou até a conta ser excluída |
| Faturas | 5 anos, anonimizadas se a conta for excluída |
| Arquivos de exportação | 7 dias |
| Cópias de segurança | até 14 dias (configurável por quem opera); cifradas |

## 7. Seus direitos e o que a exclusão apaga

Você pode, a qualquer momento: confirmar que tratamos seus dados, acessá-los, corrigi-los, exportá-los, pedir a exclusão e retirar consentimentos. Em **Configurações, Privacidade** (ou **Minha conta**, no portal do cliente) você exporta seus dados e agenda a exclusão, com carência de 30 dias para desistir. Qualquer outro pedido: {{DPO_EMAIL}}.

O que cada exclusão apaga:

- **Excluir um cliente** (pela organização) apaga a ficha, os contatos de WhatsApp ligados a ela, **as conversas, as mensagens e os arquivos** do atendimento, sem volta.
- **Excluir a conta de um cliente do portal** anonimiza os cadastros dela em todas as organizações e apaga os contatos de WhatsApp ligados a eles, com as conversas, as mensagens e os arquivos.
- **Excluir a conta de equipe** anonimiza a conta, remove a foto de perfil e as sessões. As conversas que a pessoa atendia ficam com a organização, sem o nome dela como autora; elas não são apagadas por causa da conta da equipe. **Uma exceção:** se a pessoa também é cliente da organização em que trabalha e a ficha de cliente está ligada à conta dela, essa ficha e as conversas do número dela são apagadas junto com a conta, em todas as organizações; **remover a pessoa da equipe** de uma organização apaga a ficha dela naquela organização, do mesmo jeito. Antes, a organização pode desfazer a ligação para manter a ficha. Fichas de outros clientes nunca são apagadas por isso.
- **Excluir a organização** apaga os membros, as credenciais, os arquivos, todos os contatos, conversas e mensagens do atendimento e os avisos do WhatsApp. Os números de WhatsApp conectados **não são desconectados** por isso: a organização deve removê-los antes de pedir a exclusão, para que as credenciais e a conexão com o provedor também sejam encerradas.
- **Ficam**, sem apontar para ninguém: faturas (pela obrigação fiscal), o registro de aceite dos termos e a auditoria.
- Cópias de segurança já feitas continuam com o que existia no dia, até vencerem o prazo acima; ao restaurar uma, reaplicamos as exclusões feitas depois dela.

Quando você fala com uma organização pelo WhatsApp, quem decide o que fazer com essa conversa é a organização. Para exercer seus direitos sobre ela, fale primeiro com a organização; se preferir, fale com {{DPO_EMAIL}}.

## 8. Segurança

Senhas em hash, cookies protegidos, isolamento entre organizações no banco de dados, auditoria de acessos e backups cifrados. As credenciais dos números de WhatsApp ficam cifradas. Nenhum sistema é infalível: avisaremos você e a ANPD se houver incidente relevante.

## 9. Mudanças

Quando esta política mudar, pediremos um novo aceite no seu próximo acesso.
