# Infra e deploy

- **Escopo:** Topologia, endpoints, credenciais, convenções e riscos do deploy.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-testes-operacao.md`
- **Paths do código:** `src/server.ts`, `src/lib/env.ts`, `docker-compose.yml`, `docker/compose.prod.yml`, `docker/.env.prod.example`, `docker/caddy/`, `docker/postgres/`, `docker/backup/`, `src/lib/logger.ts`, `src/lib/observability.ts`
- **Detalhe completo:** `docs/context/tech/14-deploy.md`

## Topologia

Stack versionada em `docker/compose.prod.yml` (nome de projeto `bizu-saas-prod`):

- VPS própria com Ubuntu e Docker Engine (Compose v2.20+); Portainer opcional, em modo Repository.
- **Caddy** na frente, com TLS automático e HSTS, único serviço com portas publicadas (80/443).
- Processo Node único (`app`): serve assets, `/api/*` e SSR; `worker` opcional (perfil `worker`).
- **Postgres 16** em container, sem porta publicada, com os papéis criados do ambiente no primeiro start,
  ou gerenciado (rode `docker/postgres/init.sql` com o `psql`).
- `migrate` (perfil `tools`) e `backup` (perfil `backup`) rodam sob demanda.

Não há demo pública deste repositório; o README diz "em breve".

## Endpoints

| Ambiente | Aplicação | Banco |
|---|---|---|
| Dev | `http://localhost:5173` | `localhost:15437` (Mailpit em `localhost:8025`) |
| Container | Porta `3000` (`PORT`), atrás do Caddy em 80/443 | `DATABASE_URL` |

- Healthcheck: `GET /api/health`, usado pelo `HEALTHCHECK` do `Dockerfile`.
- Sem CORS: API e frontend compartilham origem.

## Credenciais

- Em produção, as variáveis vêm de `docker/.env.prod` (não versionado, modelo em `docker/.env.prod.example`) ou do Portainer, e o compose as injeta com `${VAR}`.
- Variável `VITE_*` é fixada no build e vai para o navegador; nunca a use em segredos.
- Só há variáveis de pagamento para módulos que existem em `src/lib/payments/providers/` (hoje, `STRIPE_*`). Ao criar um módulo, declare as variáveis dele em `env.ts`, `.env.example`, `docker/compose.prod.yml` e `docker/.env.prod.example`; ao removê-lo, tire-as.
- Em dev, ficam em `.env.local` (ignorado pelo git).
- Só `.env.example` é versionado, sempre com valores de exemplo.
- `src/lib/env.ts` valida tudo na inicialização e, em produção, recusa os segredos de
  exemplo (`change-me...`), senha de banco fraca (vazia, igual ao usuário ou com menos de 16
  caracteres, exceto em host loopback, para o smoke de `npm run start`) e `EMAIL_PROVIDER=memory`.
- `NODE_ENV=production` faz o servidor ignorar `.env.local`.
- NUNCA escreva chaves, senhas ou URLs reais de banco em arquivos versionados.

## Convenções

- Imagem multi-stage em Node 24 Alpine; o runtime leva só deps de produção e `build/`.
- Comando do container: `node build/server/index.js`.
- `DATABASE_URL` é usada em runtime (`bizu_app`, sem `BYPASSRLS`); `DIRECT_URL`, pelo
  Drizzle Kit e seed (`bizu_owner`). Os papéis vêm de `docker/postgres/init.sql`.
- `docker-compose.yml` sobe Postgres e Mailpit de desenvolvimento; o perfil `backup` (`docker/backup/`)
  e o MinIO comentado são opcionais. Produção é só `docker/compose.prod.yml`.
- `docker/postgres/init.sql` aceita as senhas por variáveis do `psql` (`bizu_owner_password`, `bizu_app_password`, `bizu_backup_password`); sem elas, usa as de desenvolvimento, que o app recusa em produção.
- Só o `migrate` leva a `DIRECT_URL` do `bizu_owner`; `app` e `worker` recebem a do `bizu_app`. Senha de banco fraca ou começada por `change-me` é recusada em produção.
- O estágio `build` do `Dockerfile` é o alvo do `migrate` (tem `drizzle-kit`, `tsx` e `drizzle/`).
- Migrations rodam fora do container da aplicação, como etapa separada. Em produção, `app` e `worker` recusam subir quando faltam migrations do build (`src/db/schema-status.ts`).
- Atrás de reverse proxy, defina `TRUSTED_PROXY_HOPS=1` (um valor por proxy na frente).
- O SSE do atendimento (`/api/inbox/events`) não pode passar por buffer nem compressão no proxy (o
  `Caddyfile` o tira do `encode`), e a conexão `LISTEN` (`REALTIME_DATABASE_URL`, padrão `DATABASE_URL`)
  precisa ser direta ou de pooler em modo sessão (`tech/14-deploy.md`).
- HSTS é configurado no reverse proxy, não no app. Só inclua subdomínios se todos usarem HTTPS.

## Riscos e pendências

Somente listados; nenhum foi resolvido aqui.

- **Rate limit:** produção exige `RATE_LIMIT_STORE=postgres`; memória é recusada na subida
  (`tech/26-seguranca.md`).
- **CSP:** `CSP_REPORT_ONLY=true` só relata. Valide nas telas reais e mude para `false`.
- **Verificação de e-mail:** `EMAIL_VERIFICATION_REQUIRED=false` (padrão) deixa o cadastro entrar
  direto; ligue com `true` se o produto precisar provar a posse do e-mail (`tech/08-auth.md`).
- **Dependências:** alertas moderados restantes; veja RISK-004 no mesmo arquivo.
- **Autenticação:** Better Auth com sessão em cookie. Em produção, `APP_URL` com HTTPS, `BETTER_AUTH_SECRET` gerado e `TRUSTED_PROXY_HOPS=1`; sem isso, os limites por IP contam o proxy.
- **Migrations:** o runtime não inclui `drizzle-kit` nem `drizzle/`; o serviço `migrate` do compose usa o
  estágio `build`. Rode-o antes de cada versão nova; o app nunca migra sozinho.
- **TLS real e Portainer:** o compose foi validado com Caddy em HTTP local (`/api/health`, `/api/ready`),
  worker, backup e restore-test; emissão de certificado em domínio real e a stack no Portainer ficam para
  o primeiro deploy de quem opera.
- **Backup:** o perfil `backup` do compose cifra o dump e os arquivos com `age`, mas copiar o volume
  para fora da VPS e testar a restauração todo mês é de quem opera (`tech/14-deploy.md`). Backup
  antigo traz de volta quem foi excluído depois: reaplicar as exclusões ao restaurar.
- **Observabilidade:** logs JSON com `request_id` (pino) e Sentry opcional por `SENTRY_DSN`; sem
  coletor nem métricas (tracing fica para depois).
- **Arquivos:** em container, `STORAGE_LOCAL_DIR` precisa de volume; ou `STORAGE_PROVIDER=s3`.
