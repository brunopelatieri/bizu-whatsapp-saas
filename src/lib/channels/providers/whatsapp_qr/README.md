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
| `normalize.ts` | Aviso da Evolution → eventos comuns (função pura) |
| `index.ts` | Monta o `ChannelProvider` (envio, `probe`) e exporta o módulo |

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

## Não verificado contra o servidor real

Todas as fixtures (`tests/fixtures/channels/evolution/`) são **simuladas** a partir do que a
origem documenta; o B0 contra um servidor Evolution Go real ainda não foi feito. Falta
confirmar: corpo de `/instance/all`, `/instance/status` (se traz o JID), campo de citação
(`contextInfo.stanzaID`), se a Evolution Go grava no SeaweedFS e se a `mediaUrl` vem
pré-assinada e com que validade, e a compatibilidade com a configuração S3 dela.

## Como remover

Apague esta pasta e tire `whatsapp_qr` de `CHANNEL_PROVIDERS`. Depois:

```bash
npm run check:module-removal -- whatsapp_qr
```
