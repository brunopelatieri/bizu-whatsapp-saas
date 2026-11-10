# Módulo `whatsapp_qr` (Evolution Go, QR Code)

Número pessoal ou comercial conectado por QR Code ou código de pareamento a **um servidor
Evolution Go único, da plataforma**. O tenant nunca informa a URL (sem SSRF). Liga-se com
`whatsapp_qr` em `CHANNEL_PROVIDERS` e exige `EVOLUTION_API_URL` e `EVOLUTION_GLOBAL_API_KEY`.

> **Caminho não oficial.** O WhatsApp pode bloquear o número. A tela mostra um aviso
> permanente (RF-08).

## Arquivos

| Arquivo | O que faz |
|---|---|
| `client.ts` | `evolutionRequest` (header `apikey`), `unwrap`, mapa de escopo de chave **por endpoint**, `EvolutionApiError`, `readEvolutionConfig(env)` |
| `instances.ts` | Nome da instância, criar/excluir, conectar (webhook), QR, código, estado, desconectar, logout, reconectar |
| `webhook.ts` | Cadeia de verificação, `dedupe_key`, origem permitida de `mediaUrl` |
| `media.ts` | base64 do aviso → `StorageProvider` (`externalizeEvolutionMedia`); `mediaUrl` de origem listada → download (`resolveEvolutionMedia`) |
| `normalize.ts` | Aviso da Evolution → eventos comuns (função pura) |
| `routes.ts` | Rotas do tipo (`qrRoutes(kit)`: criar, QR, código, estado, ciclo de vida, ajustes), montadas por `buildChannelRoutes` para `/api/channels` e `/api/admin/channels` |
| `index.ts` | Monta o `ChannelProvider` (envio, `probe`, `destroy`, `pairing`, mídia) e exporta o módulo (`routes`, `requiredEnv`) |
| `webhook.db.test.ts`, `routes.db.test.ts`, `admin-routes.db.test.ts`, `db-test-support.ts` | Testes com banco (`npm run test:db`) e o servidor Evolution simulado deles |

## O que fica fora desta pasta

O módulo só fala com o servidor Evolution e lê o formato dele. Banco, limites, estado e auditoria são
do núcleo, que chama o módulo pelo contrato (`ChannelProvider.pairing`, `externalizeInboundMedia`,
`resolveInboundMedia`): `src/lib/channels/pairing.ts` (criar, QR, código, estado, ciclo de vida),
`connection.ts` (estado e readoção), `inbound-pairing.ts` e `src/api/webhooks-channels-evolution.ts`
(webhook) e `media.ts` (armazenamento). As rotas desta pasta só ligam o HTTP a `pairing.ts`. Com o
módulo fora de `CHANNEL_PROVIDERS`, elas respondem 503 `PROVIDER_UNAVAILABLE` e o webhook, 503; sem
a pasta, as rotas deixam de existir (404).

## O que foi medido (na origem) e diverge da documentação

Medido contra um servidor real no `zap-crm-br-client` (SPEC 048); vale como ponto de partida.
**Ainda não foi remedido aqui** (B0 pendente): ver "Não verificado".

- Erro vem como `{"error":"not authorized"}` (texto plano em JSON) ou `text/plain` cru em 404;
  nunca o envelope `{success, error: {code, message}}` da referência.
- Sucesso convive em três formatos (`{data, message}`, objeto cru, array cru): `unwrap`.
- A chave global só vale em `/instance/create`, `/instance/delete` e `/instance/all`; o resto
  usa o token da instância. `evolutionRequest` **recusa** a combinação errada antes de enviar.
- `GET /instance/qr` custa cerca de 3 s e o QR vale 60 s. "session already logged in" (400) não
  é erro. A resposta traz `qrcode` (data URI) e `code` (texto).
- `event` do aviso não é a família assinada: `SEND_MESSAGE` chega como `SendMessage`,
  `READ_RECEIPT` como `Receipt`, `CONNECTION` como `Connected`/`LoggedOut`/`PairSuccess`.
- O **nome** do evento de conexão carrega o estado; o corpo de `Connected` é
  `{status: "open", jid, pushName}`, sem booleano.
- Tipo do recibo (`Delivered`, `Read`, `ReadSelf`) vem em `state`, no envelope.
- `Info.ID` (maiúsculo e aninhado) é o id da mensagem, no aviso e na resposta de `/send/*`.
- `Info.Chat` é o contato nos dois sentidos; no eco, `Sender` é o número do dono.
- JID tem sufixo de dispositivo (`:NN`) nas duas formas (telefone e `@lid`).
- Mídia: `URL` do proto aponta para o CDN do WhatsApp e é **cifrado**. Servem o `base64`
  (irmão do proto dentro de `Message`) ou um `mediaUrl` em claro de S3.
- O token da instância que `/instance/info` devolve **nunca** é repassado.

## Mídia (`mediaUrl` e S3 privado)

A URL vem de um aviso e nunca é confiável. `isAllowedMediaUrl` só aceita a **origem** (esquema +
host + porta, exatos) listada em `EVOLUTION_MEDIA_ORIGINS`; `http:` só se a entrada da lista for
`http:`; sem credencial na URL; o download não segue redirecionamento. Só serve URL
**pré-assinada** de bucket **privado**. Se a Evolution Go só souber gerar URL pública, não se usa
o caminho `mediaUrl`: fica o base64.

## Decisões da B3

- **Conectar fica no QR e no código**, não na criação: `POST /:id/qr` e `/:id/pair` chamam
  `/instance/connect` antes (reexecutável), para o webhook estar registrado.
- **Um QR por abertura da tela.** Gerar reconecta a instância e custa cerca de 3 s; a tela só pede
  outro pelo botão. A contagem de 60 s é `QR_TTL_SECONDS` (`index.ts`).
- **O QR é desenhado a partir de `code`** (`qrcode.react`). Se o servidor mandar só `qrcode` (data
  URI), a tela usa `<img>`; a CSP já tem `img-src data:` (`src/api/security.ts`).
- **`instanceToken` não fica no `channel_event.raw`:** depois de conferido, sai do corpo.
- **Mídia acima de 25 MB ou que não decodifica** é descartada (o campo vira `null`), nunca gravada
  como texto.
- **Readoção** só para canal do **mesmo escopo** que não está conectado. A instância velha de um canal
  caído é apagada no servidor depois do commit (melhor esforço; falha vai ao log).

## Não verificado contra o servidor real

Todas as fixtures (`tests/fixtures/channels/evolution/`) são **simuladas** a partir do que a
origem documenta; o B0 contra um servidor Evolution Go real ainda não foi feito. Falta
confirmar: corpo de `/instance/all`, `/instance/status` (se traz o JID), campo de citação
(`contextInfo.stanzaID`), se a Evolution Go grava no SeaweedFS e se a `mediaUrl` vem
pré-assinada e com que validade, e a compatibilidade com a configuração S3 dela. Da B3, também sem
smoke real: o fluxo completo de QR e de código de pareamento, desconectar pelo celular, o corpo de
`PUT /instance/<id>/advanced-settings`, se `/instance/status` traz o telefone (sem ele, a readoção só
acontece pelo aviso `Connected`) e o limite de corpo do proxy (Caddy) para avisos de 25 MB.

## Como remover

Apague esta pasta e tire `whatsapp_qr` de `CHANNEL_PROVIDERS`. Depois:

```bash
npm run check:module-removal -- whatsapp_qr
```
