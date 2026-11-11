# Bizu SaaS

**Bizu SaaS** é o ponto de partida open source para quem vai lançar um SaaS: multi-tenant,
quatro níveis de login com verificação de e-mail opcional, trial configurável e cobrança manual
ou em módulos de pagamento.
Tudo sobre Drizzle em qualquer Postgres, com documentação viva e fluxo pensado para
**AI Software Engineering**.

[![CI](https://github.com/brunopelatieri/bizu-saas/actions/workflows/ci.yml/badge.svg)](https://github.com/brunopelatieri/bizu-saas/actions/workflows/ci.yml)
[Licença MIT](LICENSE) · [Changelog](CHANGELOG.md) · [Contribuir](CONTRIBUTING.md) · [Segurança](SECURITY.md)

---

## Índice

1. [O que é o Bizu SaaS](#1-o-que-é-o-bizu-saas)
2. [Pré-requisitos](#2-pré-requisitos)
3. [Clonar e instalar](#3-clonar-e-instalar)
4. [Subir os serviços e rodar](#4-subir-os-serviços-e-rodar)
5. [Primeiro acesso](#5-primeiro-acesso)
6. [Testar o cadastro e a verificação de e-mail](#6-testar-o-cadastro-e-a-verificação-de-e-mail)
7. [Pagamentos](#7-pagamentos)
8. [E-mail real](#8-e-mail-real)
9. [Personalizar e remover módulos](#9-personalizar-e-remover-módulos)
10. [Deploy em VPS](#10-deploy-em-vps)
11. [Receber atualizações do template](#11-receber-atualizações-do-template)
12. [Scripts, documentação, contribuição, segurança e licença](#12-scripts-documentação-contribuição-segurança-e-licença)

---

## 1. O que é o Bizu SaaS

Um **template**, não um produto: cada decisão serve de ponto de partida para projetos
derivados, simples de entender, de trocar e de remover. Os módulos opcionais (provedor de
pagamento, e-mail, arquivos, Sentry) ficam em pasta própria e somem ao apagar a pasta e uma
linha de registro.

**Para quem:** quem vai abrir um SaaS (sozinho ou com um agente de IA) e não quer refazer
autenticação, tenants, planos, e-mail, LGPD e deploy toda vez.

**Quatro níveis de acesso:**

| Nível | Área | Quem é |
|---|---|---|
| Proprietário da plataforma | `/admin` | Quem opera o SaaS: organizações, planos, trial, assinaturas, suporte |
| Owner da conta | `/app` | Cliente do SaaS, dono de um tenant |
| Colaborador | `/app` | Equipe do owner, com papel `admin`, `member` ou personalizado |
| Cliente/lead | `/portal` | Cliente do owner, com login próprio dentro do tenant |

**O que vem pronto:**

- Landing, página de preços e blog com SSR e SEO.
- Autenticação (Better Auth + Drizzle) com verificação de e-mail de uso único (opcional), recuperação de
  senha, 2FA, sessões em banco, e uma segunda instância só para clientes do portal.
- Multi-tenant com `tenant_id` e Row Level Security no Postgres, provado por testes. Papéis
  `owner`, `admin`, `member` e personalizados.
- Planos, trial configurável (inclusive gratuito), limites por plano (inclusive quantas organizações
  o dono pode ter), vencimento e inadimplência com cobrança manual no `/admin` como padrão, e
  webhooks verificados com o módulo Stripe pronto (veja [Pagamentos](#7-pagamentos)).
- E-mail transacional com provedor substituível e fila de jobs no próprio Postgres (pg-boss).
- WhatsApp (módulos `whatsapp_cloud` e `whatsapp_qr`) com **caixa de entrada**: `/app/atendimento` com fila, assumir,
  transferir, janela de 24 h, anexos, modelos e tempo real por SSE, e `/admin/atendimento` para a plataforma falar com
  owners e equipes; as conversas entram na exportação e na exclusão LGPD
  ([`tech/30-caixa-de-entrada.md`](docs/context/tech/30-caixa-de-entrada.md)).
- Auditoria, personificação com consentimento, LGPD (consentimento, exportação, exclusão com
  carência, retenção), módulo de arquivos, logs JSON e Sentry opcional.
- Docker de desenvolvimento, **stack de produção com Caddy e TLS**, backup cifrado, CI e este tutorial.

**Demo:** em breve. Enquanto isso, o seed deste tutorial entrega um ambiente completo em minutos.

**Stack:** React 19, TypeScript, React Router v8 (SSR), Vite, Tailwind v4, shadcn/ui, Hono,
Drizzle, Postgres, Zod, TanStack Query, React Hook Form, Better Auth, pg-boss, Nodemailer,
Biome, Vitest e Docker.

```text
React Router v8 Framework Mode + SSR
  |-- /api/*              Hono API -> Drizzle -> Postgres (RLS por tenant)
  |-- /, /sobre, /blog    rotas públicas com SSR e SEO
  |-- /login, /cadastro   autenticação com verificação de e-mail
  |-- /app/**             owner e equipe (client-side, sem loader sensível)
  |-- /admin/**           proprietário da plataforma
  `-- /portal/**          clientes e leads, com login próprio
```

O estado de cada fase da spec está em [`docs/context/status.md`](docs/context/status.md); a spec
completa, em [`docs/specs/saas-foundation/`](docs/specs/saas-foundation/spec.md).

---

## 2. Pré-requisitos

- **Node.js 24.19 ou superior** (`node -v`). A versão fica em `.nvmrc`: com nvm, rode
  `nvm use` na pasta do projeto. O `.npmrc` tem `engine-strict`, então o `npm install`
  recusa Node mais antigo com uma mensagem clara.
- **Docker** com Compose v2 (`docker compose version`): sobe o Postgres e o Mailpit.
- **Git**.
- Opcional: `openssl` para gerar segredos (o Node serve, veja abaixo).

---

## 3. Clonar e instalar

```bash
git clone https://github.com/brunopelatieri/bizu-saas.git
cd bizu-saas
npm install
cp .env.example .env.local
```

O `.env.local` é ignorado pelo git. Gere os **três segredos** e cole cada um em `.env.local`
(os valores de exemplo funcionam em desenvolvimento, mas são **recusados em produção**; gere
agora para pegar o hábito). Com `openssl`:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
```

```bash
openssl rand -base64 32   # CREDENTIALS_ENCRYPTION_KEY (precisa ter 32 bytes em base64)
```

```bash
openssl rand -hex 16      # AUDIT_SALT
```

Sem `openssl` (Windows, por exemplo), o mesmo com o Node:

```bash
node -e "const c=require('crypto');console.log('BETTER_AUTH_SECRET='+c.randomBytes(32).toString('base64'));console.log('CREDENTIALS_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'));console.log('AUDIT_SALT='+c.randomBytes(16).toString('hex'))"
```

Defina também `SEED_PASSWORD` em `.env.local` (10+ caracteres, com maiúscula, minúscula, número e especial): é a senha de todas as
contas de exemplo e só vale para desenvolvimento.

---

## 4. Subir os serviços e rodar

```bash
docker compose up -d
```

Sobe o Postgres 16 (porta `15437` do host; no Windows a `5432` costuma estar reservada) e o
**Mailpit**. No primeiro start, `docker/postgres/init.sql` cria o banco `bizu` e dois papéis:

| Papel | Usado por | Permissão |
|---|---|---|
| `bizu_owner` | `DIRECT_URL`: migrations e instalação da fila | Dono das tabelas |
| `bizu_app` | `DATABASE_URL`: aplicação em runtime e seed | Sem `BYPASSRLS`: o Row Level Security vale para ele |

Depois, três comandos, nesta ordem:

```bash
npm run db:migrate
```

```bash
npm run jobs:install
```

`jobs:install` cria as tabelas e filas do pg-boss (schema `pgboss`); roda com `DIRECT_URL` e é
idempotente. Em seguida, os dados de exemplo (idempotente; recusa produção sem
`SEED_ALLOW_PRODUCTION=1`):

```bash
npm run db:seed
```

```bash
npm run dev
```

| Serviço | Endereço |
|---|---|
| App em desenvolvimento | `http://localhost:5173` |
| Postgres | `localhost:15437`, banco `bizu` |
| Mailpit (e-mails capturados) | `http://localhost:8025` |

**Se algo falhar:**

| Problema | Solução |
|---|---|
| `drizzle-kit` não encontrado | Rode `npm install` antes do migrate |
| Erro de conexão | Confira `docker compose ps` e se `.env.local` aponta para `localhost:15437` |
| Porta `15437` ocupada | Crie `docker-compose.override.yml` (ignorado pelo git) com `services.postgres.ports: !override ["15438:5432"]` e troque a porta em `DATABASE_URL` e `DIRECT_URL` |
| `role "bizu_owner" does not exist` | O volume é antigo: `docker compose down -v` e suba de novo |
| O app não sobe e lista variáveis | `src/lib/env.ts` valida tudo na inicialização, sem imprimir valores; compare com `.env.example` |
| `CREDENTIALS_ENCRYPTION_KEY` inválida | Precisa ser base64 de exatamente 32 bytes (use um dos comandos acima) |

Mais casos em [`docs/context/onboarding.md`](docs/context/onboarding.md).

---

## 5. Primeiro acesso

Entre em `http://localhost:5173/login` com as contas do seed. A senha é a de `SEED_PASSWORD`:

| Conta | Entra em | Papel |
|---|---|---|
| `owner@bizu.local` | `/admin` | proprietário da plataforma |
| `suporte@bizu.local` | `/admin` | suporte (só leitura) |
| `acme.owner@bizu.local` | `/app` | owner do tenant `acme`, em teste no plano Pro |
| `acme.admin@bizu.local`, `acme.membro@bizu.local` | `/app` | admin e membro do `acme` |
| `julia@cliente.local` | `/portal/login?org=acme` | cliente ativa nos tenants `acme` e `beta` |
| `lead@cliente.local` | não entra | lead do `acme`, sem senha, à espera do envio de acesso |
| `em-dia.owner@bizu.local` | `/app` | owner do `cliente-em-dia`: cobrança manual paga |
| `atrasado.owner@bizu.local` | `/app` | owner do `cliente-atrasado`: venceu, na carência |
| `vencido.owner@bizu.local` | `/app` | owner do `cliente-vencido`: carência acabou, somente leitura |

O seed também cria os planos `free` (1 organização), `basic` (2) e `pro` (5), com preços manuais e
do Stripe (sem `provider_price_ref`: ficam vazios até você ligar o provedor), e o tenant `beta`, em
trial. Em `/admin/tenants`, abra um dos tenants `cliente-*` para registrar um pagamento ou marcar
a falta dele.

- **`/admin`:** organizações, usuários, planos, assinaturas, webhooks e as configurações do
  período de teste (dias, plano padrão, carência) e do encarregado de dados.
- **`/app`:** visão geral, clientes, equipe, assinatura e configurações, com o aviso de trial no
  topo. Convide a equipe em `/app/equipe`: o convite cai no Mailpit, vale 48 horas e a página
  que ele abre não o consome; um botão aceita.
- **`/portal`:** em `/app/clientes`, cadastre alguém e clique em "Enviar acesso ao portal". O convite
  cai no Mailpit e abre `/portal/entrar`. Depois, a pessoa pede um link de 10 minutos em
  `/portal/login?org=<slug>` ou define uma senha em `/portal/conta`. Quem é cliente de mais de um
  tenant escolhe em `/portal/escolher`.
- **Mailpit:** todo e-mail do app aparece em `http://localhost:8025`. Para revisar os templates sem
  enviar nada: `npm run email:preview` (grava `.tmp/emails/index.html`).

Detalhes em [`docs/context/tech/08-auth.md`](docs/context/tech/08-auth.md),
[`21-tenant-rbac.md`](docs/context/tech/21-tenant-rbac.md) e
[`25-portal-clientes.md`](docs/context/tech/25-portal-clientes.md).

---

## 6. Testar o cadastro e a verificação de e-mail

**Por padrão a verificação fica desligada** (`EMAIL_VERIFICATION_REQUIRED=false`): cadastre-se em
`http://localhost:5173/cadastro` (e aceite os termos) e você já entra, direto em `/app/onboarding`.
Crie sua organização (nome e identificador): você vira owner e entra em `/app`, em teste no plano
padrão.

Para exigir a confirmação, ponha `EMAIL_VERIFICATION_REQUIRED=true` no `.env.local` e reinicie:

1. Cadastre-se em `/cadastro`.
2. Abra o Mailpit em `http://localhost:8025` e clique no link recebido.
3. Na página aberta, clique em **Confirmar meu e-mail**. O link vale 1 hora e só pode ser usado
   uma vez; abrir a página não o consome.

Com ela ligada, o login sem confirmar responde como senha incorreta e a tela oferece o reenvio.
Desligada, o login logo após o cadastro revela se o e-mail já tinha conta: é o custo de entrar
direto (detalhes em [`08-auth.md`](docs/context/tech/08-auth.md)). Para testar a recuperação de
senha, use `/esqueci-senha`; a troca de e-mail fica em `/app/configuracoes`. As respostas de
cadastro, reenvio e reset nunca revelam se um e-mail existe.

Sem o seed, promova sua conta a proprietário da plataforma:

```sql
update "user" set role = 'platform_owner' where email = 'voce@empresa.com';
```

---

## 7. Pagamentos

**Ficam desligados por padrão.** Com `PAYMENT_PROVIDERS` vazio, a cobrança é **manual**: cadastre um
preço `Manual` em `/admin/planos/:id` e, em `/admin/tenants/:id`, registre o pagamento ou marque a
falta dele. Vencimento, carência, somente leitura e troca de plano funcionam sem provedor, e tudo
entra na auditoria (`docs/context/tech/24-billing-cobranca.md`). Nada pede chave de provedor agora.
Cada provedor é um módulo em `src/lib/payments/providers/<id>/` e entra pela variável; com ele
ligado, as assinaturas pagas por ele seguem o fluxo do provedor.

Quando for ligar o **Stripe** em modo de teste:

1. Pegue a chave `sk_test_...` no painel e rode a [Stripe CLI](https://docs.stripe.com/stripe-cli):

   ```bash
   stripe listen --forward-to localhost:5173/api/webhooks/payments/stripe
   ```

2. No `.env.local`: `PAYMENT_PROVIDERS=stripe`, `STRIPE_SECRET_KEY` e o `whsec_...` impresso pelo
   comando em `STRIPE_WEBHOOK_SECRET`.
3. Crie os preços recorrentes no Stripe e cole cada `price_...` em `/admin/planos`.
4. Em `/app/assinatura`, preencha os dados de faturamento e assine com o cartão
   `4242 4242 4242 4242`.

O passo a passo, o endpoint de produção e o checklist antes de um release estão no
[README do módulo](src/lib/payments/providers/stripe/README.md). **Asaas** (Pix e boleto) e os demais
provedores estão em breve; para escrever o seu, siga o
[checklist de módulos](src/lib/payments/providers/README.md). Assinaturas e webhooks recebidos
aparecem em `/admin/assinaturas` e `/admin/webhooks`.

---

## 8. E-mail real

Em desenvolvimento, `EMAIL_PROVIDER=smtp` aponta para o Mailpit. Em produção, escolha:

- **`smtp`:** qualquer servidor (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_SECURE`: `true` na porta 465, `false` na 587).
- **`resend`:** `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` e `RESEND_WEBHOOK_SECRET`; cadastre
  `https://seu-dominio/api/webhooks/email/resend` no painel para receber bounces e reclamações,
  que alimentam a lista de supressão.
- **`memory`** só serve para testes e é recusado em produção.

Em qualquer um, defina `EMAIL_FROM` com um endereço do **seu domínio** e configure no DNS:
**SPF**, **DKIM** (o provedor fornece o registro) e **DMARC** (comece com `p=none` e endureça
depois de ver os relatórios). Sem isso, os e-mails de verificação caem em spam. Teste o envio
real cadastrando uma conta e abrindo o link. Detalhes e templates em
[`docs/context/tech/19-email.md`](docs/context/tech/19-email.md).

---

## 9. Personalizar e remover módulos

- **Marca e textos:** `src/lib/constants/` (nome, links e navegação do site), `src/components/landing/`,
  `src/pages/`, blog em `src/lib/content/posts.ts`, `public/` (ícone, `sitemap.xml` e `robots.txt`), e-mails em `src/lib/email/`.
- **Domínio do site:** `siteConfig.url` (`src/lib/constants/navigation.ts`), `public/sitemap.xml` e
  `public/robots.txt` trazem o placeholder `https://example.com`. Troque os três pelo seu domínio antes
  de publicar (`grep -rn example.com public src/lib/constants`). São arquivos estáticos: não leem `APP_URL`.
- **Textos legais:** `src/lib/legal/termos.md` e `privacidade.md` são modelos. Preencha o controlador
  e revise com um advogado (`docs/context/lgpd.md`).
- **Planos:** edite em `/admin/planos`; para mudar os do seed, `src/db/seed.ts`.
- **Contexto e agentes:** adapte o [`CLAUDE.md`](CLAUDE.md), `docs/context/` e as rules em
  `.claude/rules/` e `.cursor/rules/` (sempre em par) ao seu produto. Método e receitas:
  [`docs/context/ai-engineering.md`](docs/context/ai-engineering.md) e
  [`docs/context/receitas.md`](docs/context/receitas.md).
- **Repositório derivado:** troque o canal de [`SECURITY.md`](SECURITY.md), o
  [`CODEOWNERS`](.github/CODEOWNERS), `name`, `repository` e `author` do `package.json`.

**Remover um módulo:** apague a pasta, a linha de registro e a variável. O script prova que o resto
continua compilando e passando nos testes sem ele:

```bash
npm run check:module-removal -- stripe   # pagamento: src/lib/payments/providers/stripe/
npm run check:module-removal -- sentry   # monitoramento: src/lib/monitoring/sentry/
npm run check:module-removal -- s3       # arquivos: src/lib/storage/providers/s3/
```

---

## 10. Deploy em VPS

A stack de produção é o [`docker/compose.prod.yml`](docker/compose.prod.yml): `app` (porta 3000,
atrás do Caddy), `worker` (opcional), `migrate` (só sob demanda), `postgres` (com volume e os papéis
criados a partir das suas senhas), `caddy` (TLS automático e HSTS) e `backup` (opcional). Funciona
com `docker compose` ou como stack do Portainer (modo **Repository**; o build precisa do repositório).

> ### Antes de ir ao ar
>
> - [ ] **Controlador nos textos legais:** preencha os colchetes de `src/lib/legal/termos.md` e
>       `src/lib/legal/privacidade.md` e peça revisão jurídica.
> - [ ] **Encarregado (DPO):** informe o e-mail em `/admin/configuracoes`.
> - [ ] **2FA do proprietário:** ative na conta de plataforma (a tela de segurança pede no primeiro
>       acesso). **Sem ele, `/admin` responde 403 em produção.**
> - [ ] **`CSP_REPORT_ONLY=false`:** comece em `true`, navegue pelas telas reais olhando
>       `/api/csp-report` e logs, e só então mude para `false` (o navegador passa a bloquear).
> - [ ] **Segredos gerados:** `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` e `AUDIT_SALT`
>       com os valores do exemplo derrubam a subida. Guarde uma cópia da `CREDENTIALS_ENCRYPTION_KEY`
>       fora do servidor.
> - [ ] **E-mail real** com SPF, DKIM e DMARC (`EMAIL_PROVIDER=memory` é recusado).
> - [ ] **Backup** com cópia fora da VPS e teste de restauração (abaixo).

**Passo a passo** (Ubuntu com Docker Engine e Compose v2.20+; DNS do domínio apontando para a VPS e
portas 80 e 443 livres):

1. Clone o repositório na VPS e crie o `.env` de produção, que o git ignora:

   ```bash
   git clone https://github.com/brunopelatieri/bizu-saas.git && cd bizu-saas
   cp docker/.env.prod.example docker/.env.prod
   ```

2. Edite `docker/.env.prod`: `SITE_ADDRESS` (domínio), `APP_URL` (`https://...`), e-mail e os
   segredos. Gere os valores (senhas de Postgres só com letras e números, pois entram em URLs):

   ```bash
   openssl rand -hex 24      # POSTGRES_SUPERUSER_PASSWORD, BIZU_OWNER_PASSWORD, BIZU_APP_PASSWORD
   openssl rand -base64 32   # BETTER_AUTH_SECRET e CREDENTIALS_ENCRYPTION_KEY
   openssl rand -hex 16      # AUDIT_SALT
   ```

   `TRUSTED_PROXY_HOPS=1` (o Caddy) e `RATE_LIMIT_STORE=postgres` já vêm no exemplo.

3. Confira o arquivo, construa a imagem e suba o banco. A partir daqui, use este atalho:

   ```bash
   alias bizu='docker compose --env-file docker/.env.prod -f docker/compose.prod.yml'
   bizu config > /dev/null && bizu build && bizu up -d postgres
   ```

4. Rode as migrations e a instalação da fila, **fora** do container do app:

   ```bash
   bizu --profile tools run --rm migrate
   ```

5. Suba o app e o proxy, e confira:

   ```bash
   bizu up -d app caddy
   curl -s https://seu-dominio/api/health && curl -s https://seu-dominio/api/ready
   ```

6. Crie o proprietário da plataforma. O seed é recusado em produção; cadastre-se em `/cadastro`,
   confirme o e-mail e promova a conta:

   ```bash
   bizu exec postgres psql -U postgres -d bizu -c "update \"user\" set role = 'platform_owner' where email = 'voce@empresa.com';"
   ```

   Entre, ative o 2FA e abra `/admin`.

**Operação:**

- **Atualizar** (nova versão): `git pull`, `bizu build`, `bizu --profile tools run --rm migrate`,
  `bizu up -d app caddy`. Migrations nunca rodam no start do app: se faltar alguma, `app` e `worker` recusam
  subir e o log diz o que rodar.
- **Worker separado:** `COMPOSE_PROFILES=worker` e `APP_JOBS_MODE=off`; permite várias réplicas de `app`
  sem Redis (o rate limit já está no Postgres).
- **Postgres gerenciado:** apague o serviço `postgres`, rode `docker/postgres/init.sql` com o `psql`
  como superusuário (as senhas entram por `-v`, veja o cabeçalho do arquivo) e ajuste as URLs.
- **Teste local sem TLS:** `SITE_ADDRESS=http://localhost`, `APP_URL=http://localhost:4181`,
  `HTTP_PORT=4181` e `HTTPS_PORT=4443`. Validado de ponta a ponta (build, `migrate`, `app` + `caddy`,
  `/api/health`, `/api/ready`, perfil `worker`, cadastro, e-mail de confirmação e login). A sessão **funciona
  em `http://localhost`**: os cookies saem `__Secure-…; Secure` mesmo com `APP_URL` em HTTP, e Chrome e Firefox
  os aceitam em `localhost`. Em qualquer outro host sem HTTPS (IP ou domínio) o navegador descarta o cookie
  `Secure`: o login "dá certo" e não há sessão. Fora de `localhost`, use HTTPS.
- **Portainer:** Stacks > Add stack > Repository, "Compose path" `docker/compose.prod.yml`, e as variáveis de
  `docker/.env.prod.example` em "Environment variables". O `migrate` roda pelo terminal do host (passo 4), com
  as mesmas variáveis, antes do primeiro deploy e de cada atualização; sem ele, o deploy falha com o `app` em
  restart, e a causa está nos logs do `app`.
- **Backup:** defina `BIZU_BACKUP_PASSWORD` **antes** do primeiro start do Postgres, gere a chave
  com `age-keygen` (a privada fica fora do servidor), defina `BACKUP_AGE_RECIPIENT=age1...` e suba com
  `COMPOSE_PROFILES=backup`. Um backup agora: `bizu --profile backup run --rm backup once`. Copie o volume
  `backups` para fora da VPS e rode o teste mensal de restauração. Passo a passo, restauração e a
  reaplicação das exclusões LGPD: [`docs/context/tech/14-deploy.md`](docs/context/tech/14-deploy.md).

Variáveis, topologia e riscos: [`docs/context/infra-deploy.md`](docs/context/infra-deploy.md).

### Variáveis principais

| Variável | Descrição |
|---|---|
| `APP_URL` | URL pública do app; base dos links de e-mail e dos cookies |
| `DATABASE_URL` / `DIRECT_URL` | Runtime (`bizu_app`) / migrations e fila (`bizu_owner`) |
| `REALTIME_DATABASE_URL` | Opcional: conexão `LISTEN` do tempo real do atendimento (padrão `DATABASE_URL`); direta ou pooler em modo sessão |
| `CHANNEL_EVENT_RETENTION_DAYS` | Opcional: dias que o aviso de canal de WhatsApp já tratado fica guardado (padrão 30) |
| `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `AUDIT_SALT` | Segredos obrigatórios; os de exemplo são recusados em produção |
| `EMAIL_PROVIDER`, `EMAIL_FROM`, `SMTP_*`, `RESEND_*` | Envio de e-mail |
| `JOBS_MODE` | `inline` (fila no servidor), `worker` (`node build/server/index.js --worker`) ou `off` |
| `TRUSTED_PROXY_HOPS` | Proxies na frente do app; `1` atrás do Caddy |
| `RATE_LIMIT_STORE` | `memory` em dev; `postgres` é obrigatório em produção |
| `CSP_REPORT_ONLY` | `true` só relata violações; `false` bloqueia |
| `EMAIL_VERIFICATION_REQUIRED` | `false` (padrão): o cadastro entra direto; `true`: exige o link de confirmação |
| `PAYMENT_PROVIDERS` | Módulos de pagamento ativos; vazio = cobrança manual pelo `/admin` |
| `STORAGE_PROVIDER`, `STORAGE_LOCAL_DIR`, `S3_*`, `MAX_UPLOAD_MB` | Módulo de arquivos |
| `LOG_LEVEL`, `SENTRY_DSN` | Logs JSON com `request_id`; Sentry opcional |

A lista completa está em [`.env.example`](.env.example) (desenvolvimento) e em
[`docker/.env.prod.example`](docker/.env.prod.example) (produção).

---

## 11. Receber atualizações do template

Seu projeto nasceu deste repositório e vai divergir. Para trazer correções e novidades:

```bash
git remote add template https://github.com/brunopelatieri/bizu-saas.git
git fetch template
git merge template/main --allow-unrelated-histories   # só na primeira vez
```

Resolva os conflitos (esperados em `README.md`, `CLAUDE.md`, `docs/context/` e `package.json`), leia a
seção **Migração** do [CHANGELOG](CHANGELOG.md) de cada versão entre a sua e a nova, rode
`npm run db:generate` se mexeu no schema e a verificação completa. O passo a passo, com os
conflitos que costumam aparecer, está em
[`docs/context/atualizar-template.md`](docs/context/atualizar-template.md).

---

## 12. Scripts, documentação, contribuição, segurança e licença

```bash
npm run dev          # dev server: React Router + Hono (porta 5173)
npm run build        # build de produção
npm run start        # roda build/server/index.js (NODE_ENV=production, lê .env.local)
npm run lint         # Biome
npm run typecheck    # typegen + TypeScript
npm test             # testes unitários e de API (sem banco)
npm run test:db      # testes contra o Postgres do Docker (funciona em banco novo, sem seed)
npm run db:generate  # gera migrations Drizzle
npm run db:migrate   # aplica migrations
npm run db:studio    # Drizzle Studio
npm run jobs:install # tabelas e filas do pg-boss (rode após db:migrate)
npm run db:seed      # dados de exemplo (SEED_PASSWORD); idempotente
npm run email:preview # renderiza os e-mails em .tmp/emails/
npm run check:module-removal -- <módulo>   # prova que o módulo sai sem quebrar
```

**Metodologia:** PRD e SPEC antes do código, contexto enxuto carregado sob demanda e mudanças
pequenas e documentadas, para humanos e agentes de IA trabalharem com o mesmo mapa técnico.

```text
PRD -> SPEC -> implementação -> lint + tipos + testes + build -> /code-review -> atualizar contexto
```

No Claude Code: `/prd <feature>`, `/spec <feature>`, `/ctx-banco-drizzle`, `/ctx-auth`, `/ctx-api-hono`,
`/ctx-dashboard`, `/ctx-infra-deploy`, `/ctx-canais`, `/ctx-inbox`, `/context-budget`.

| Arquivo | Conteúdo |
|---|---|
| [`docs/context/INDEX.md`](docs/context/INDEX.md) | Mapa de todo o contexto: ponto de partida para pessoas e agentes |
| [`docs/context/core.md`](docs/context/core.md) | Objetivo, arquitetura e regras de decisão |
| [`docs/context/status.md`](docs/context/status.md) | O que está pronto e o que falta, por fase |
| [`docs/specs/saas-foundation/`](docs/specs/saas-foundation/spec.md) | PRD e SPEC da transformação em SaaS |
| [`docs/context/receitas.md`](docs/context/receitas.md) | Passo a passo das tarefas comuns |
| [`docs/context/ai-engineering.md`](docs/context/ai-engineering.md) | Método de trabalho e adaptação do template |
| [`docs/context/tech/`](docs/context/tech/) | Especificação técnica, um arquivo por seção |
| [`docs/context/infra-deploy.md`](docs/context/infra-deploy.md) | Topologia, credenciais e riscos de deploy |
| [`docs/context/lgpd.md`](docs/context/lgpd.md) | Retenção, base legal e encarregado |
| [`docs/context/atualizar-template.md`](docs/context/atualizar-template.md) | Receber atualizações do template |
| `.claude/rules/`, `.cursor/rules/`, `.claude/skills/` | Regras e skills para agentes |

- **Contribuir:** [CONTRIBUTING.md](CONTRIBUTING.md) (fluxo PRD/SPEC, commits, módulos de pagamento e de
  armazenamento).
- **Segurança:** [SECURITY.md](SECURITY.md). Não abra issue pública para vulnerabilidade. Em produção,
  contas de plataforma só usam `/admin` com 2FA.
- **Licença:** [MIT](LICENSE).

**Autor:** Bruno Pelatieri Goulart · Enterprise Automation Architect • AI • DevOps • n8n Specialist
