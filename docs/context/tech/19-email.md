# E-mail transacional

- **Escopo:** `sendEmail`, fila `email.send`, provedores (`smtp`, `resend`, `memory`), supressão e webhooks de bounce, templates e Mailpit.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-email-jobs.md`, `spec-dados.md` (`email_message`, `email_suppression`)
- **Paths do código:** `src/lib/email/` (`send.ts`, `deliver.ts`, `store.ts`, `address.ts`, `status.ts`, `links.ts`, `types.ts`, `providers/`, `templates/`, `template-catalog.ts`, `preview.ts`), `src/db/schema/email.ts`, `src/api/webhooks-email.ts`, `src/jobs/email.ts`

## Fluxo

```text
sendEmail(message)
  → email_message (queued, só hash do destinatário)
  → pg-boss: fila email.send (singletonKey = email_message.id)
       → worker: deliverEmail → checa email_suppression → provedor.send
       → sent  |  failed/suppressed  |  retry 5x (backoff) → failed + email.send.dead
  → webhook do provedor: delivered | bounced | complained (+ email_suppression)
```

- `sendEmail(message)` devolve `{ id, status, error? }`: `queued` na fila; `sent`/`failed`
  só na entrega direta (provedor `memory`). Quem chama não espera o envio real.
- Passe `tags: { template: "nome" }` para `email_message.template` (auditoria); sem a tag
  vira `custom`.
- `email_message` guarda `to_hash` (sha256 do endereço em minúsculas), template, provedor,
  `provider_message_id`, `status` (`queued` → `sent` → `delivered` | `bounced` |
  `complained`, ou `failed`), `error` (sem endereços) e datas. **Nunca o corpo nem o
  endereço**. O status só avança: evento atrasado não rebaixa (`status.ts`).
- O job `email.send` carrega a mensagem renderizada (o corpo não está no banco de
  domínio). Por isso a fila apaga jobs concluídos em 1 h e a dead letter guarda 7 dias;
  tokens de link são de uso único e curta duração.
- Falha definitiva é visível em `email_message.status = failed` (e no job em
  `pgboss.job` / futuro `/admin/jobs`).

## Provedores

| `EMAIL_PROVIDER` | Arquivo | Uso |
|---|---|---|
| `smtp` | `providers/smtp.ts` | nodemailer; Mailpit em dev; sem webhook (bounce chega na caixa do remetente) |
| `resend` | `providers/resend.ts` | SDK oficial; `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`; bounces e reclamações por webhook |
| `memory` | `providers/memory.ts` | testes; `sent[]`; recusado em produção |

Postmark e SES não estão implementados: crie `providers/postmark.ts` seguindo
`providers/README.md` (contrato, webhook, ids).

### Webhook de bounce (Resend)

`POST /api/webhooks/email/resend` (`src/api/webhooks-email.ts`): confere a assinatura
Svix no corpo bruto (`svix-id`, `svix-timestamp`, `svix-signature`, segredo `whsec_...`),
aplica `delivered`/`bounced`/`complained` por `provider_message_id` e cria
`email_suppression` em **hard bounce** (`bounce.type = Permanent`) ou **reclamação**.
Bounce `Transient` marca `bounced` mas não suprime. Assinatura inválida → 400; provedor
diferente do configurado → 404. No painel do Resend, cadastre o endpoint
`https://SEU_DOMINIO/api/webhooks/email/resend` com os eventos `email.delivered`,
`email.bounced` e `email.complained`.

Endereço suprimido: o job grava `failed`, `error = suppressed`, sem chamar o provedor e
sem retry.

## Testes

- `setEmailProviderForTests(createMemoryProvider())`: `sendEmail` entrega **na hora**,
  em memória, sem banco nem pg-boss; `memory.sent` já tem a mensagem quando a promessa
  resolve. O mesmo vale com `EMAIL_PROVIDER=memory` sem override (CI).
- `setEmailProviderForTests(memory, { store })` com `createMemoryEmailStore()` permite
  semear supressões (`store.suppress(hashEmail(email), "hard_bounce")`) e inspecionar
  `store.messages`.
- `setEmailProviderForTests(memory, { queue: true })` usa o fluxo real (banco + fila):
  só em `tests/db/` (`email-queue.test.ts`).
- Sempre `afterEach(() => setEmailProviderForTests(undefined))`.

## Templates de autenticação (fase 2)

Em `templates/auth/`, enviados por `src/lib/auth/emails.ts` com `sendEmail`:
`verify-email`, `existing-user-signup`, `reset-password`, `password-changed`,
`change-email-confirm` e `change-email-done`. Cada arquivo exporta `<nome>Template` e
`previewInput`. Os envios correm em `runInBackground`: a resposta da API não espera o
provedor, então o tempo não revela se o e-mail existe. Links vêm de `appLink`
(`src/lib/auth/links.ts`).

## Avisos de cobrança

`notifyOwners` (`src/lib/billing/notify.ts`) envia aos proprietários do tenant. Saem depois do commit do
job, com o link para `/app/assinatura`:

| Template | Quando |
|---|---|
| `invoice-created` | fatura nova, uma vez, com valor maior que zero |
| `payment-received` | a fatura passou a `paid` |
| `payment-failed` | falha de cobrança, e T-3, T0 e `unpaid` do `billing.dunning` |
| `subscription-canceled` | o owner agendou (com a data), ou o provedor encerrou sem pedido do owner |

## Convite de equipe

`sendInvitationLink` (`src/lib/auth/emails.ts`) envia `invite-member` com link para
`/convite/:id`, página que só renderiza no GET. Como os de autenticação, corre em
`runInBackground`.

## Como escrever um template

```ts
// src/lib/email/templates/trial-expired.ts
import { assertAbsoluteUrl } from "@/lib/email/templates/format";
import { renderLayout } from "@/lib/email/templates/layout";

export type TrialExpiredInput = { name: string; tenantName: string; url: string };

export const previewInput: TrialExpiredInput = {
  name: "Ana",
  tenantName: "Acme Ltda",
  url: "http://localhost:5173/app/assinatura",
};

export function trialExpiredTemplate(input: TrialExpiredInput) {
  return renderLayout({
    subject: `O período de teste de ${input.tenantName} terminou`,
    heading: `Olá, ${input.name}`,
    paragraphs: ["..."],
    action: { label: "Escolher um plano", url: assertAbsoluteUrl(input.url) },
  });
}
```

- Cada arquivo exporta `<nome>Template(input)` → `{ subject, html, text }` e
  `previewInput` (dados fictícios). `template-catalog.ts` descobre todos (inclusive
  `templates/auth/`); os testes (`templates.test.ts`) e o `npm run email:preview`
  usam esse catálogo. Template novo sem `previewInput` falha nos testes.
- Links absolutos: monte com `appUrl("/caminho")` (`links.ts`, usa `APP_URL`);
  `assertAbsoluteUrl` recusa link relativo.
- Tokens só em páginas que não consomem no GET (`spec-auth.md`).
- O layout escapa tudo que recebe: passe texto puro, não HTML.
- E-mail de tenant usa o nome do tenant no assunto; o `From` continua da plataforma
  e o `Reply-To` (`message.replyTo`) é do owner.

`portal-invite` e `portal-magic-link` saem de `src/lib/auth/portal-emails.ts`, com link para
`/portal/entrar?token=&org=`; o convite vale 48 h, e o login, 10 min.

Templates gerais (fase 3): `invite-member`, `portal-invite`, `portal-magic-link`,
`trial-ending`, `trial-expired`, `invoice-created`, `payment-failed`, `payment-received`,
`subscription-canceled`, `impersonation-requested`, `impersonation-started`,
`data-export-ready`, `deletion-scheduled`, `tenant-suspended`. Os de autenticação
(`verify-email`, `reset-password`…) ficam em `templates/auth/` (fase 2).

## Prévia e Mailpit

- `npm run email:preview` grava `.tmp/emails/*.html` (+ `index.html`) com os dados fictícios.
- `docker compose up -d` sobe o Mailpit: SMTP `localhost:1025`, interface
  `http://localhost:8025`. Com `EMAIL_PROVIDER=smtp` e `SMTP_HOST=localhost`, nada sai
  para a internet. Para ver o fluxo completo: `npm run dev` (JOBS_MODE=inline) ou um
  worker separado, e um `sendEmail` real; o e-mail aparece no Mailpit pela fila.

## Entrega e reputação

SPF, DKIM e DMARC do domínio de envio vêm do provedor (valores reais nas páginas oficiais
do Resend ou do provedor escolhido; não verificados nesta spec). Transacional não precisa
de `List-Unsubscribe`.

## Templates da fase 10

- `data-export-ready` (link assinado de 7 dias) e `deletion-scheduled` (conta, conta do portal ou organização) são enviados por `src/lib/lgpd/export.ts` e `deletion.ts`; `deletion-confirm` (novo) leva o link de confirmação da exclusão do cliente do portal, que só vale com o clique.
- A exclusão apaga `email_message` do e-mail anonimizado (busca por `to_hash`).

## Templates do telefone verificado (pré-produção, T2b)

Enviados por `src/lib/phone/notify.ts`, depois do commit de quem chama. Nenhum leva o número
inteiro, só os 4 últimos dígitos (`tech/28-crm-cadastro.md`).

- `phone-verification-manual`: o link de verificação não saiu (nenhum canal apto, ou todos
  falharam) e o pedido espera a liberação à mão. Vai aos owners da organização (botão para
  `/app/equipe` ou `/app/clientes`) ou aos proprietários da plataforma (`/admin/usuarios`), uma vez
  por pedido (`phone_verification.manual_notified_at`), e só quando o pedido é da fila desse
  responsável. Pede que o número seja conferido por outro meio antes da liberação.
- `phone-number-claimed`: outra conta confirmou pelo link o número que esta conta tinha
  confirmado (celular troca de dono); a conta voltou a pendente.
- `customer-deleted-by-phone-claim` (D-1, `claim`): alguém se autocadastrou no portal com o número de uma ficha e
  confirmou pelo link; a ficha antiga foi apagada com as conversas. Vai aos owners da organização, com os 4 últimos
  dígitos e o link da ficha nova, sem o nome da ficha apagada.

## Templates do `/admin` (admin-crud)

- `deletion-scheduled` ganhou a variante `byPlatform`: quando a administração agenda a
  exclusão, o texto diz isso e o botão leva a `/contato` (só a administração cancela).
- `deletion-executed`: exclusão imediata pelo `/admin` ("Excluir agora"); vai ao titular, ou aos
  owners da organização, com o endereço lido **antes** da anonimização.
- `email-changed`: aviso ao endereço **antigo** quando a administração troca o e-mail de uma
  conta de equipe ou do portal. Mostra o novo mascarado (`maskEmail`, `src/lib/email/address.ts`).
