# Fixtures de canais (B0)

Avisos e respostas de API usados pelos testes de `src/lib/channels/`.

> **Origem: simuladas, não medidas.** A fase B0 da SPEC pede captura contra um servidor
> Evolution Go real e uma conta de teste da Meta. Nenhum dos dois estava disponível quando
> estas fixtures foram escritas. Elas reproduzem os **formatos medidos na origem**
> (`zap-crm-br-client`, SPEC 048, e as lições registradas no código dela) e a documentação
> da Graph API, com dados inventados. **Falta a revisão humana** que a B0 exige: capturar de
> verdade, anonimizar e comparar com estas (as divergências viram nota no `README.md` do
> módulo e, se preciso, nova fixture).

## Anonimização

- Telefones: `5511999990001` (número do canal) e `5511988880001` (cliente), inventados.
- Ids da Meta: `100000000000001` (WABA), `200000000000001` e `...02` (números), `wamid.*`
  curtos. Tokens e segredos: textos de teste óbvios (`test-instance-token-0001`).
- Nada aqui é credencial. Se uma captura real entrar, troque telefones, nomes, ids, tokens,
  chaves de mídia e URLs assinadas antes de commitar.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `cloud/` | Corpo do `POST` do webhook da Meta: mensagens (um tipo por arquivo), status, modelos, dois números no mesmo WABA |
| `cloud/api/` | Respostas da Graph API (número, envio, erros, assinaturas, mídia, modelos paginados) |
| `evolution/` | Envelope do webhook da Evolution Go (`event`, `instanceId`, `instanceToken`, `state`, `data`) |
| `evolution/api/` | Respostas do servidor (criar, conectar, QR, pareamento, estado, envio, erro) |

`src/lib/channels/test-fixtures.ts` carrega por nome.
