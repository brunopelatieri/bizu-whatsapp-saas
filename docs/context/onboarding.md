# Onboarding local

- **Escopo:** Primeira execução: instalação, env, Postgres e Mailpit locais, migrations Drizzle e dev server.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-testes-operacao.md`
- **Paths do código:** `docker-compose.yml`, `docker/postgres/init.sql`, `.env.example`, `src/lib/env.ts`

## Primeira execução

```bash
nvm use                           # lê .nvmrc (Node 24); sem nvm, confira node -v >= 24.19
npm install
cp .env.example .env.local        # gere BETTER_AUTH_SECRET, CREDENTIALS_ENCRYPTION_KEY e AUDIT_SALT
docker compose up -d              # Postgres em localhost:15437 e Mailpit em localhost:8025
npm run db:migrate
npm run dev
```

- `npm install` falha com `EBADENGINE` / "Unsupported engine" em Node abaixo de 24.19: o
  `.npmrc` tem `engine-strict=true` e `package.json` declara `engines.node`. Troque a versão
  (`nvm use`) em vez de remover a trava.
- `drizzle-kit` está em **devDependencies**; os scripts `db:*` usam o binário local.
- `drizzle.config.ts` carrega `.env.local` e usa `DIRECT_URL` (fallback `DATABASE_URL`).
- Postgres local na porta **15437** do host (5432 costuma estar reservada no Windows).
  Banco `bizu`; `docker/postgres/init.sql` cria `bizu_owner` (migrations) e `bizu_app`
  (runtime, sem `BYPASSRLS`) no primeiro start do volume.
- Volume antigo (banco `portal`, de antes do Bizu SaaS): `docker compose down -v` e suba de novo.
- Porta `15437` ocupada por outro projeto: crie `docker-compose.override.yml` (ignorado
  pelo git) com `services.postgres.ports: !override ["15438:5432"]` e troque a porta em
  `.env.local`.
- Mailpit captura todo e-mail enviado por SMTP em `localhost:1025`; a interface fica em
  `http://localhost:8025`. Nada sai para a internet com `EMAIL_PROVIDER=smtp` apontando
  para ele.
- `src/lib/env.ts` valida as variáveis na inicialização. Falta de variável obrigatória
  derruba o processo com a lista do que falta, sem imprimir valores. Em produção,
  segredos com o valor de exemplo (`change-me...`) são recusados.
- Para usar outro Postgres, rode o SQL de `docker/postgres/init.sql` como superusuário e
  troque `DATABASE_URL` e `DIRECT_URL`.
- Testes: `npm test` roda sem banco; `npm run test:db` exige o Postgres do Docker com as
  migrations aplicadas.
- Dados de exemplo: defina `SEED_PASSWORD` em `.env.local` (10+ caracteres, com maiúscula, minúscula, número e especial) e rode
  `npm run db:seed`. Entre com `owner@bizu.local` (vai a `/admin`) ou `acme.owner@bizu.local`
  (vai a `/app`). Pode rodar de novo sem duplicar nada.
- Para testar login: cadastre-se em `/cadastro`, abra o Mailpit em `http://localhost:8025` e
  confirme pelo link. Sem o seed, o primeiro proprietário é promovido por SQL (`tech/08-auth.md`).

## `.env.local` criado antes da fase 9

`CREDENTIALS_ENCRYPTION_KEY: use 32 bytes em base64` na subida significa que o arquivo traz o exemplo
antigo. Gere uma chave com `openssl rand -base64 32` ou copie a do `.env.example`.
