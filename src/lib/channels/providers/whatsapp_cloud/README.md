# Módulo `whatsapp_cloud` (WhatsApp Cloud API da Meta)

Número oficial, com as credenciais do aplicativo da Meta **do dono do número**. Não há variável
de ambiente: token, segredo do aplicativo e token de verificação são de cada canal e ficam
cifrados (`src/lib/channels/credentials.ts`). Liga-se com `whatsapp_cloud` em
`CHANNEL_PROVIDERS`.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `graph.ts` | Cliente da Graph API (`GRAPH_VERSION` em um lugar só), `fetch` injetável, `MetaApiError` |
| `webhook.ts` | Assinatura `X-Hub-Signature-256` sobre o corpo cru, desafio do `GET`, `dedupe_key` |
| `normalize.ts` | Aviso da Meta → eventos comuns (função pura) |
| `index.ts` | Monta o `ChannelProvider` (envio, mídia, `probe`) e exporta o módulo |

## Como obter as credenciais (o que o dono do número faz)

1. Criar um aplicativo do tipo **Empresa** em developers.facebook.com.
2. Adicionar o produto **WhatsApp** e ligar uma conta WhatsApp Business (WABA).
3. Copiar: identificador do número, identificador da conta (WABA), **token de acesso
   permanente** (usuário do sistema) e o **segredo do aplicativo** (Configurações → Básico).
4. Em WhatsApp → Configuração, colar o **endereço de webhook** e o **token de verificação** que
   o bizu mostra para aquele número e assinar `messages` (e, se quiser, os campos
   `message_template_status_update`, `message_template_quality_update` e
   `message_template_components_update`).

Cada número tem o **próprio endereço**, com uma chave aleatória no caminho
(`/api/webhooks/whatsapp/cloud/<webhookKey>`). A chave define de quem é o aviso antes de ler o
corpo. O segredo do aplicativo **é obrigatório por canal**: sem ele não há canal (falha fechada).

## Decisões e o que foi conferido

- **Versão da Graph API: `v26.0`**, conferida em 2026-11-09 (lançada em 2026-07-29). A origem
  usava `v21.0`, que já foi desativada. Trocar a versão é um PR com a sincronização de modelos
  revalidada contra uma conta de teste.
- Erro da Meta vira `(#código) título: mensagem` (`formatMetaError`), o mesmo formato do aviso
  assíncrono de status `failed`. O texto pode citar dado do cliente: sobe só para a tela do dono
  do canal (`META_REJECTED`), nunca para log nem Sentry sem `sanitizeError`.
- 4xx (menos 429) é recusa de credencial e marca o canal `error`; 5xx, 429 e timeout **não**
  mudam o estado (`ProviderError.isRejection`).
- Id de recurso é validado como numérico antes de entrar no caminho da URL (`assertGraphId`).
- O download de mídia leva o token: só vai a hosts da Meta (`fbsbx.com`, `fbcdn.net`,
  `facebook.com`, `whatsapp.net`, `whatsapp.com`), por HTTPS, sem seguir redirecionamento e com
  teto de tamanho.
- Modelos: o cursor `after` é usado para paginar; a URL `paging.next` da resposta nunca é seguida.
- Reação, apagar e tipos novos de mensagem não viram evento (fora do escopo da entrega).

## Não verificado contra a Meta real

Todas as fixtures (`tests/fixtures/channels/cloud/`) são **simuladas** a partir do formato
documentado e do medido na origem; o B0 com conta de teste da Meta ainda não foi feito. Falta
confirmar: forma exata dos avisos de modelo na `v26.0`, a lista de hosts de mídia, o campo
`user_id` (BSUID) nos `contacts` e o comportamento de `register` com e sem PIN.

## Como remover

Apague esta pasta e tire `whatsapp_cloud` de `CHANNEL_PROVIDERS`. Depois:

```bash
npm run check:module-removal -- whatsapp_cloud
```
