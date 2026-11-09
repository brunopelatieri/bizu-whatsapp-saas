# Qualidade e validação

- **Escopo:** Verificações realizadas e comandos antes de cada entrega.
- **Specs relacionadas:** nenhuma citada
- **Paths do código:** não declarado


## 15. Qualidade e Validacao

Autenticacao: `npm test` cobre `requireAuth`, `requirePlatform`, `verificationGuard`,
schemas e templates sem banco; `npm run test:db` cobre os fluxos em `tests/db/auth.test.ts`
e, sobre o servidor Node, em `tests/db/auth-http.test.ts`.

Verificacoes recentes realizadas:

- `npm run typecheck` passou.
- Smoke test de producao passou anteriormente:
  - `/api/health`
  - `/`
  - `/blog`
  - `/blog/reduzir-mensagens-de-status`
  - `/login`
  - `/app` sem auth, confirmando shell sem dados sensiveis.

Comandos recomendados antes de cada entrega:

```bash
npm run lint
npm run typecheck
npm test
npm run test:db   # exige o Postgres do Docker com migrations aplicadas
npm run build
```

O CI em `.github/workflows/ci.yml` roda os mesmos comandos em push para `main` e em
pull requests, no Node declarado em `.nvmrc` (`setup-node` com `node-version-file`), com um servico `postgres:16` onde `docker/postgres/init.sql` e aplicado
via `psql` antes de `db:migrate` e `test:db`, e fecha com
`npm audit --omit=dev --audit-level=high`.

Um segundo job, `module-removal`, roda `npm run check:module-removal -- <id>` em matriz (`stripe`,
`sentry`, `s3`, `whatsapp_cloud`, `whatsapp_qr`), sem banco: se algo fora da pasta do módulo passar a depender dele, o CI falha.

Testes unitarios e de API ficam ao lado do codigo (`src/**/*.test.ts`): autenticacao,
protecoes da API, `env.ts` e e-mail com provedor `memory`. Testes com banco real
ficam em `tests/db/` (`vitest.db.config.ts`, sem paralelismo entre arquivos).

Para smoke test local de producao, com segredos gerados no `.env.local` (as senhas de desenvolvimento
do banco valem aqui porque o host e `localhost`):

```bash
npm run build && npm run start
```

O script define `NODE_ENV=production` (sem isso o servidor encerra sem escutar) e
carrega o `.env.local`. Confira `/api/health`, `/api/ready` (`{ db, jobs, schema }`), `/api/me`
(401) e um cadastro em `/cadastro` com o e-mail chegando no Mailpit.

---

### Fase 10 (LGPD, arquivos, observabilidade)

- Unitários (`npm test`): chaves e provedor `local` do `StorageProvider` (confinamento, `..` recusado), assinatura do link de download (válida, expirada, de outro pedido, de outro segredo), zip, redação do logger e do `logError`, `request_id`, markdown dos textos legais, versões.
- `npm run test:db`: `tests/db/lgpd.test.ts` (consentimento e re-aceite), `lgpd-export.test.ts` (zip, e-mail, download com sessão e assinatura), `lgpd-deletion.test.ts` (último owner, senha e 2FA, carência, cancelamento, anonimização idempotente, portal, organização), `files.test.ts`, `maintenance.test.ts` (retenção por tabela, com datas controladas), `rls-lgpd.test.ts`, mais as linhas novas de `rbac.test.ts` e `tenant-http.test.ts`.
- `npm run check:module-removal -- stripe|sentry|s3|whatsapp_cloud|whatsapp_qr` prova que cada módulo opcional sai sem quebrar typecheck nem testes.
- Teste de banco que lê `deletion_request` ou `data_export` com `bizu_owner` precisa do bypass (RLS forçado).
- Teste de banco que enfileira (`/api/me/export`) chama `registerQueues(await getBoss())` antes, porque quem cria as filas é o worker. Servidor de smoke com `JOBS_MODE=inline` aberto contra o mesmo banco rouba esses jobs: encerre-o.
