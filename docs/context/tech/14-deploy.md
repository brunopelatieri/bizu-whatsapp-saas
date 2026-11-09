# Deploy em VPS

- **Escopo:** Modelo de deploy, container, stack de produção, variáveis de ambiente, backup e restauração.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-testes-operacao.md` (seção "Deploy e operação")
- **Paths do código:** `Dockerfile`, `.dockerignore`, `docker/compose.prod.yml`, `docker/.env.prod.example`, `docker/caddy/`, `docker/postgres/`, `docker/backup/`, `src/db/schema-status.ts`


## 14. Deploy em VPS Ubuntu + Docker + Caddy (ou Portainer)

### Demo

Não há demo pública deste repositório. O README diz "em breve"; quando existir, aponte-a lá.

### Modelo de deploy

- VPS própria com Ubuntu e Docker Engine (Compose v2.20+); Portainer é opcional e usa o mesmo arquivo.
- Um único arquivo de stack: `docker/compose.prod.yml`. Nome de projeto próprio (`bizu-saas-prod`): não
  divide containers nem volumes com o `docker-compose.yml` de desenvolvimento.
- Reverse proxy: **Caddy** (TLS automático por Let's Encrypt, HSTS, `reverse_proxy app:3000`), com o
  `docker/caddy/Caddyfile`. Traefik ou Nginx também servem, desde que `TRUSTED_PROXY_HOPS` bata.
- Processo Node único (assets, `/api/*` e SSR); a fila roda dentro dele (`JOBS_MODE=inline`) ou num
  `worker`.

### Container da aplicação

`Dockerfile` multi-stage:

1. Estágio `build`: Node 24 Alpine, `npm ci`, `npm run build`. Tem devDeps (`drizzle-kit`, `tsx`),
   `drizzle/` e as fontes. É o alvo (`target: build`) do serviço `migrate`.
2. Estágio `runtime`: Node 24 Alpine, `npm ci --omit=dev`, só `build/`. Expõe `3000`, healthcheck em
   `/api/health`, `CMD ["node", "build/server/index.js"]`. Sem `drizzle-kit` nem `drizzle/`.

A versão do Node acompanha o `engines` do `package.json` (24.19+, piso do `react-router-hono-server` 4).

O `.dockerignore` **não** exclui `drizzle/` (o estágio `build` precisa dele); exclui `docs`, `.env*` e
`node_modules`.

### Stack de produção (`docker/compose.prod.yml`)

| Serviço | Perfil | O que faz |
|---|---|---|
| `postgres` | sempre | `postgres:16-alpine`, volume `postgres_data`, sem porta publicada. No primeiro start do volume, `docker/postgres/init-prod.sh` roda `docker/postgres/init.sql` com as senhas do ambiente (papéis `bizu_owner`, `bizu_app` e, com `BIZU_BACKUP_PASSWORD`, `bizu_backup`) |
| `app` | sempre | imagem `runtime`, `JOBS_MODE=${APP_JOBS_MODE:-inline}`, volume `storage` em `/data/storage`, healthcheck do Dockerfile |
| `caddy` | sempre | portas `HTTP_PORT`/`HTTPS_PORT` (80/443), TLS para `SITE_ADDRESS`, volumes `caddy_data` e `caddy_config` |
| `worker` | `worker` | mesma imagem, `--worker`, sem porta e sem healthcheck; use com `APP_JOBS_MODE=off` (esquecer gera `warn` no log e alerta em `/admin`, `tech/20-jobs.md`) |
| `migrate` | `tools` | estágio `build`; `npm run db:migrate && npm run jobs:install` com `DIRECT_URL` |
| `backup` | `backup` | `docker/backup/`; `pg_dump` cifrado com `age` e `/data/storage`, como `bizu_backup` |

Variáveis: `docker/.env.prod.example` (copie para `docker/.env.prod`, não versionado). O compose
interpola tudo com `${VAR}`: obrigatórias com `:?` (falha dizendo qual falta), opcionais com `:-`
(vazio vira ausente em `src/lib/env.ts`). Como o Compose interpola até serviços de perfis inativos, as
do `backup` usam `:-`; o `backup.sh` recusa subir sem elas. Senhas de Postgres só com letras e
números (entram em URLs) e pelo menos 16 caracteres: `init-prod.sh` e `src/lib/env.ts` recusam menos.

Rotina:

```bash
alias bizu='docker compose --env-file docker/.env.prod -f docker/compose.prod.yml'
bizu config > /dev/null && bizu build
bizu up -d postgres
bizu --profile tools run --rm migrate      # migrations e fila, sempre fora do app
bizu up -d app caddy
```

Atualizar: `git pull`, `bizu build`, `bizu --profile tools run --rm migrate`, `bizu up -d app caddy`.
Migrations nunca rodam no start do app.

**Esqueceu o `migrate`:** em produção, `app` e `worker` recusam subir (exit 1) quando o banco não tem as
migrations do build, tanto no banco vazio quanto numa atualização, e o log traz o comando a rodar.
Rode-o e suba de novo com `bizu up -d app caddy`: o `app` se recupera sozinho nos próximos restarts, mas o
`caddy` espera o `app` saudável e só sobe com esse `up`. Enquanto o `migrate` roda, o `app` pode
reiniciar mais de uma vez: com `inline`, ele também encerra até a fila estar instalada. Sem essa recusa, o erro passava despercebido:
`/api/health` não toca no banco, então o container ficava `healthy`, o Caddy subia e o site ia ao ar com
login e cadastro quebrados. Banco à frente do build é normal (as migrations vêm antes da imagem) e banco
fora do ar ou sem permissão não encerra nada: o erro vai para o log e `/api/ready` responde 503 com
`schema: false`.

Um primeiro proprietário nasce por cadastro e
`update "user" set role = 'platform_owner'` (o seed é recusado em produção); o 2FA dele é obrigatório,
senão `/admin` responde 403.

**Portainer:** Stacks > Add stack > **Repository** (o build precisa do repositório; o Web editor não
serve), "Compose path" `docker/compose.prod.yml`, variáveis em "Environment variables" (perfis por
`COMPOSE_PROFILES`). O `migrate` roda no terminal do host, **antes** do primeiro deploy e de cada
atualização; sem ele, o `up` da stack falha com o `app` em restart e a causa está nos logs do `app`
(validado com `docker compose`, não no Portainer).

**Postgres gerenciado:** apague o serviço `postgres`, rode `docker/postgres/init.sql` com o `psql` como
superusuário (`-v bizu_owner_password=... -v bizu_app_password=...`) e ajuste `DATABASE_URL` e
`DIRECT_URL` no compose. Sem as variáveis `-v`, o `init.sql` cria os papéis com as senhas de
desenvolvimento e o app recusa subir: corrija com `ALTER ROLE ... PASSWORD`. `bizu_backup` precisa de
`BYPASSRLS` e `pg_read_all_data` (abaixo).

**Teste local sem TLS:** `SITE_ADDRESS=http://localhost`, `APP_URL=http://localhost:4181`,
`HTTP_PORT=4181`, `HTTPS_PORT=4443`.

**Revalidação da stack (fase 11, depois do code-review):** com `-p` próprio e `.env` de segredos gerados,
`build` (app e `migrate`), `up postgres`, `--profile tools run --rm migrate`, `up app caddy`, `/api/health`
(`{"ok":true}`) e `/api/ready` (`{"db":true,"jobs":true}`) atrás do Caddy passaram. Com `APP_JOBS_MODE=off`
e `--profile worker`, o worker subiu só com a `DIRECT_URL` do `bizu_app` (app e worker não recebem a do
`bizu_owner`) e enviou o e-mail de confirmação de um cadastro novo (o app não tinha a fila ligada).

**Sessão sobre HTTP:** cadastro, e-mail de confirmação (Mailpit via `SMTP_HOST=host.docker.internal`),
confirmação no navegador e login funcionam em `http://localhost:4181`. Em produção o Better Auth
emite `__Secure-bizu.session_token` e `__Secure-bizu.session_data` com `HttpOnly; Secure; SameSite=Lax`
mesmo com `APP_URL` em HTTP; `localhost` é contexto seguro e o navegador os aceita (curl também). Não
testado, por inferência do comportamento dos navegadores: em IP ou domínio sem HTTPS o cookie `Secure` é
descartado e a sessão nunca se forma. Fora de `localhost`, só HTTPS.

### Compose de desenvolvimento

`docker-compose.yml` é só de desenvolvimento:

- `postgres:16-alpine`, porta local `15437`, superusuário `postgres`, volume `postgres_data`.
  `docker/postgres/init.sql` roda no primeiro start do volume (senhas de desenvolvimento por
  padrão) e cria o banco `bizu` e os papéis `bizu_owner` (migrations) e `bizu_app` (runtime, sem
  `BYPASSRLS`).
- `axllent/mailpit`: SMTP `1025`, interface `8025`; captura todo e-mail de dev.
- Perfil `backup` e MinIO comentado, opcionais.
- Porta ocupada por outro projeto: crie `docker-compose.override.yml` (ignorado pelo git)
  com `ports: !override` e ajuste `.env.local`.

### Variáveis de ambiente

Runtime (a lista completa está em `.env.example`; a validação, em `src/lib/env.ts`):

- `NODE_ENV=production`, `PORT=3000`
- `APP_URL` com `https://`, `TRUSTED_PROXY_HOPS=1` (um por reverse proxy)
- `DATABASE_URL` (`bizu_app`), `DIRECT_URL` (`bizu_owner`; exigida em todo processo, mas só migrations e `jobs:install` a usam: no compose, `app` e `worker` recebem a do `bizu_app` e só o `migrate` leva a do dono). Em produção, as duas URLs são recusadas com senha vazia, igual ao usuário, com menos de 16 caracteres ou começada por `change-me`; em loopback (`localhost`, smoke de `npm run start`) só o `change-me` é recusado
- `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` (32 bytes em base64), `AUDIT_SALT`: valores
  gerados; os de exemplo derrubam o processo em produção
- `RATE_LIMIT_STORE=postgres`: `memory` derruba o processo em produção
- `EMAIL_PROVIDER` (`memory` é recusado em produção), `EMAIL_FROM`, `SMTP_*` ou `RESEND_*`
- `CSP_REPORT_ONLY`: `true` relata em `/api/csp-report`; `false` bloqueia
- `EMAIL_VERIFICATION_REQUIRED`: `false` (padrão) o cadastro entra direto; `true` exige o link
- `LOG_LEVEL` (`info`), `SENTRY_DSN` (opcional), `STORAGE_PROVIDER` (`local` ou `s3`),
  `STORAGE_LOCAL_DIR`, `S3_*`, `MAX_UPLOAD_MB`, `PAYMENT_PROVIDERS` (vazio = sem cobrança)
- Canais de mensagem: `CHANNEL_PROVIDERS` (vazio = sem WhatsApp) e, com `whatsapp_qr`, `EVOLUTION_API_URL` e `EVOLUTION_GLOBAL_API_KEY` (obrigatórias; a chave de exemplo `change-me*` é recusada em produção), mais `EVOLUTION_WEBHOOK_PUBLIC_URL`, `EVOLUTION_INSTANCE_PREFIX`, `EVOLUTION_MAX_INSTANCES_TOTAL`, `EVOLUTION_MEDIA_ORIGINS` e os dois timeouts. A Cloud API não tem variável (credenciais por canal)
- Pagamentos: só `STRIPE_*` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`), obrigatórias com `stripe` em `PAYMENT_PROVIDERS`. Variáveis de outros provedores entram junto com o módulo em `src/lib/payments/providers/<id>/`

Em Postgres próprio, as migrations rodam em etapa separada (`npm run db:migrate` com `DIRECT_URL`),
antes de subir a nova imagem, depois do `init.sql` com o `psql`.

---

### Logs, Sentry e prontidao (fase 10)

- Os logs saem em JSON no stdout (pino): uma linha por requisicao (`request`, com `req.path`,
  `status`, `duration_ms`) e uma por erro, todas com `request_id`. O `x-request-id` que o proxy
  mandar (8 a 64 caracteres seguros) e mantido e devolvido; sem ele, o app gera. Cookie, e-mail,
  documento, senha e token nunca aparecem (`redact`). Rotacione pelo driver do Docker
  (`max-size`/`max-file`) ou por um coletor; o prazo de retencao dos logs e de quem opera.
- `LOG_LEVEL=debug` inclui `/api/health`, `/api/ready` e `/assets/*`.
- `SENTRY_DSN` liga o envio de erros (`src/lib/monitoring/sentry/`); sem ele, nada e carregado.
  Define a variavel tambem no `worker`.
- `GET /api/health` (liveness) e `GET /api/ready` (banco, fila e migrations, 2 s); `/admin` mostra webhooks
  com falha e jobs mortos.

### Arquivos

- `STORAGE_PROVIDER=local` grava em `STORAGE_LOCAL_DIR` (`.data/storage`): em container, monte um
  volume ali, senao os arquivos somem a cada deploy. `s3` usa bucket privado (MinIO com
  `S3_ENDPOINT`); o app baixa os arquivos por conta propria, sem URL publica.
- O mesmo diretorio recebe as exportacoes LGPD (`exports/`), apagadas apos 7 dias.

### Backup e restauracao

Servico opcional, perfil `backup`, no `docker/compose.prod.yml` (e no `docker-compose.yml` de dev); o
codigo esta em `docker/backup/`:

1. `age-keygen -o chave.txt` **fora do servidor**; guarde a chave privada (gerenciador de senhas ou
   cofre). So a linha `public key` vai para o servidor.
2. Defina `BACKUP_AGE_RECIPIENT=age1...`. O usuario do dump precisa atravessar o RLS (`BYPASSRLS` e
   `pg_read_all_data`); sem isso o `pg_dump` falha, em vez de gerar um backup vazio. No compose de
   producao esse usuario e o `bizu_backup`, criado pelo `init.sql` **no primeiro start do volume**, se
   `BIZU_BACKUP_PASSWORD` existir. Volume ja criado: `CREATE ROLE bizu_backup LOGIN PASSWORD '...'
   CREATEDB BYPASSRLS;` e `GRANT pg_read_all_data TO bizu_backup;` como superusuario. No compose de dev,
   `BACKUP_PGUSER`/`BACKUP_PGPASSWORD` (padrao `postgres`).
3. Producao: `COMPOSE_PROFILES=backup` (ou `bizu --profile backup up -d backup`); dev:
   `docker compose --profile backup up -d backup`. Faz um dump por `BACKUP_INTERVAL_HOURS` (24),
   `bizu-AAAAMMDD-HHMMSS.dump.age` (`pg_dump -Fc`) e `.storage.tar.age` (do volume `storage` ou de
   `STORAGE_LOCAL_DIR`) no volume `backups`, e apaga o que passar de `BACKUP_KEEP_DAYS` (14). Um backup
   agora: `bizu --profile backup run --rm backup once`.
4. Copie o volume para fora da VPS (rsync, rclone, S3); backup so no mesmo disco nao e backup.

Validado em Docker com o compose de producao: backup `once` como `bizu_backup`, dump cifrado e
`restore-test.sh` (37 tabelas, 19 migrations). A restauracao sobre o banco de producao (abaixo) nao foi
ensaiada ponta a ponta no servidor: faca-o numa copia antes de precisar. O mesmo procedimento foi
ensaiado num Postgres 16 local (dump, restore como `bizu_owner`, `bizu_app` com acesso).

**Restaurar (banco).** O dump leva os GRANTs (`pg_dump --no-owner`, sem `--no-privileges`) e o dono
sai de quem restaura, entao restaure **como `bizu_owner`**, o papel de `DIRECT_URL`, sem
`--no-privileges`. Assim as tabelas voltam com dono `bizu_owner` e com o acesso do `bizu_app` em
`public`, `drizzle` (a tabela de migrations que o app le na subida) e `pgboss`. Restaurar como
`postgres` com `--no-owner --no-privileges` deixa tudo sem acesso para o runtime e o app nao sobe.
Em producao, rode o `createdb` e o `pg_restore` com `bizu exec -T postgres ...` e o dump no stdin:

```bash
age --decrypt --identity chave.txt --output bizu.dump bizu-AAAAMMDD-HHMMSS.dump.age
createdb -h HOST -U postgres --owner bizu_owner bizu_novo
pg_restore -h HOST -U bizu_owner --no-owner --dbname bizu_novo bizu.dump
```

- Servidor novo (sem os papeis): rode antes `docker/postgres/init.sql`, que cria os papeis e o banco
  `bizu` vazio, e restaure nesse banco. O `init.sql` so mexe no banco `bizu`.
- Um nome diferente de `bizu` (como `bizu_novo`) exige apontar `DATABASE_URL` e `DIRECT_URL` para ele.
- Dump de uma versao anterior ao schema atual: `npm run db:migrate` depois do restore.
- Confira: `select count(*) from pg_tables where schemaname = 'public' and not has_table_privilege('bizu_app', format('%I.%I', schemaname, tablename), 'SELECT')` e
  `select has_table_privilege('bizu_app', 'drizzle.__drizzle_migrations', 'SELECT')` (0 e `t`).

**Dump antigo** (feito com `--no-privileges`, versoes anteriores do `backup.sh`): nao traz os GRANTs.
Restaure como acima e rode, como `bizu_owner` no banco restaurado:

```sql
GRANT USAGE ON SCHEMA public, drizzle, pgboss TO bizu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, pgboss TO bizu_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, pgboss TO bizu_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO bizu_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO bizu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bizu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bizu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bizu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO bizu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO bizu_app;
```

Restaurar arquivos: `age --decrypt --identity chave.txt ...storage.tar.age | tar -x -C /destino`.

**Teste de restauracao mensal:** `restore-test.sh` decifra o backup, restaura num banco
descartavel (`bizu_restore_test`) e confere tabelas, usuarios, migrations e o acesso do `bizu_app`
(`has_table_privilege` em `public` e em `drizzle.__drizzle_migrations`). Um dump sem GRANTs reprova o
teste. Ele restaura como o usuario do backup (nao e `bizu_owner`), entao pula as entradas `DEFAULT ACL`
do dump, que so um membro de `bizu_owner` pode recriar:

```bash
docker compose --profile backup run --rm -v /caminho/da/chave:/key:ro --entrypoint restore-test.sh   backup /backups/bizu-AAAAMMDD-HHMMSS.dump.age /key/chave.txt
```

**Depois de restaurar, reaplique as exclusoes**: quem foi anonimizado depois do backup volta com os
dados. Rode o job `lgpd.delete` com `deletion_request` executadas desde a data do backup em
`pending` de novo, ou anonimize as contas a mao (`docs/context/lgpd.md`).
