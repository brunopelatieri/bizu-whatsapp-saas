---
paths:
  - "Dockerfile"
  - "docker-compose.yml"
  - ".dockerignore"
  - ".env.example"
  - "docker/compose.prod.yml"
  - "docker/.env.prod.example"
  - "docker/caddy/**"
  - "docker/postgres/**"
  - "docker/backup/**"
  - ".gitattributes"
---

# Docker, Portainer, VPS e variáveis de ambiente

- Processo único: `node build/server/index.js`, porta `3000`, healthcheck em `/api/health`.
- `docker-compose.yml` sobe Postgres (porta `15437`, papéis `bizu_owner`/`bizu_app` via `docker/postgres/init.sql`) e Mailpit (`1025`/`8025`) de desenvolvimento.
- Produção é `docker/compose.prod.yml` (app, worker, migrate, postgres, caddy, backup; perfis `worker`, `tools`, `backup`), com variáveis de `docker/.env.prod` (modelo em `docker/.env.prod.example`, que acompanha `.env.example` e `src/lib/env.ts`). Nome de projeto `bizu-saas-prod`, para não dividir volume com o dev.
- `init.sql` recebe as senhas por variáveis do `psql` (`init-prod.sh` as passa); o estágio `build` do `Dockerfile` é o alvo do serviço `migrate`, e o `.dockerignore` não pode excluir `drizzle/`.
- Só o `migrate` recebe a `DIRECT_URL` do `bizu_owner`; `app` e `worker` levam a do `bizu_app`. Senha de banco começada por `change-me` ou com menos de 16 caracteres é recusada em produção (`env.ts` e `init-prod.sh`); `env.ts` recusa também vazia ou igual ao usuário e, em host loopback (smoke de `npm run start`), só o `change-me`.
- Variável nova entra em `src/lib/env.ts` (Zod) e em `.env.example`; o servidor valida tudo na inicialização.
- Segredos nunca são versionados; `.env.example` leva só valores de exemplo.
- Migrations são etapa separada do container da aplicação: `docker compose ... --profile tools run --rm migrate`. Nunca as ligue ao `up` com `depends_on`: em produção, `app` e `worker` recusam subir quando faltam migrations (`src/db/schema-status.ts`).
- Atrás de reverse proxy, defina `TRUSTED_PROXY_HOPS`; sem isso, todos dividem o mesmo rate limit.
- SSE (`/api/inbox/events`): sem buffer nem compressão no proxy (o `Caddyfile` o tira do `encode`); a conexão `LISTEN` (`REALTIME_DATABASE_URL`, padrão `DATABASE_URL`) é direta ou de pooler em modo sessão, nunca transaction.
- HSTS é configurado no reverse proxy, não no app.
- Produção exige `RATE_LIMIT_STORE=postgres` e `CREDENTIALS_ENCRYPTION_KEY` com 32 bytes em base64. `CSP_REPORT_ONLY=true` só relata: valide nas telas reais antes de virar para `false`.
- `VITE_*` vai para o navegador: nunca use esse prefixo em segredos.
- `STORAGE_PROVIDER=local` precisa de volume em `STORAGE_LOCAL_DIR`; `s3` é módulo removível (`npm run check:module-removal -- s3`). `MAX_UPLOAD_MB` limita o upload.
- Backup opcional: perfil `backup` do compose (`docker/backup/`), cifrado com `age`; o usuário do dump atravessa o RLS. Restaurar exige reaplicar as exclusões feitas depois do backup (`docs/context/tech/14-deploy.md`).
- Logs saem em JSON com `request_id`; `SENTRY_DSN` é opcional e removível. Scripts `*.sh` ficam com LF (`.gitattributes`).

Para entender este domínio, leia: docs/context/infra-deploy.md, docs/context/tech/14-deploy.md