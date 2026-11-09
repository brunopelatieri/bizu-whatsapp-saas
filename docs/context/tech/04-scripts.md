# Scripts

- **Escopo:** Scripts npm de dev, build, typecheck, testes e banco.
- **Specs relacionadas:** nenhuma citada
- **Paths do código:** `package.json`

| Script | Função |
|--------|--------|
| `npm run dev` | Inicia RR dev server com SSR + Hono + HMR |
| `npm run build` | Gera `build/client` e `build/server` |
| `npm run start` | Roda o build com `NODE_ENV=production` (obrigatório: o `react-router-hono-server` só escuta nesse modo) e `--env-file-if-exists=.env.local`; segredos de exemplo são recusados |
| `npm run typecheck` | Gera os tipos de rota e verifica `tsconfig.app.json` e `tsconfig.node.json` |
| `npm run lint` | Lint com Biome em `src/` e `tests/` (caminhos explícitos: worktrees em `.claude/worktrees/` têm `biome.json` próprio) |
| `npm test` | Testes unitários e de API, sem banco |
| `npm run test:db` | Testes em `tests/db/` contra o Postgres do Docker (`DATABASE_URL` e `DIRECT_URL`) |
| `npm run db:generate` | Gera migrations Drizzle |
| `npm run db:migrate` | Aplica migrations |
| `npm run db:push` | Push direto do schema (só dev) |
| `npm run db:studio` | Abre Drizzle Studio |
| `npm run check:module-removal -- <id>` | Tira a pasta do módulo (`stripe` e demais provedores de pagamento, `sentry`, `s3`, `whatsapp_cloud` ou `whatsapp_qr`), roda typecheck e testes e devolve a pasta |
| `npm run db:seed` | Dados de dev, idempotente: proprietário (`owner@bizu.local`), suporte, planos `free`/`basic`/`pro`, configurações de trial e o tenant `acme`. Exige `SEED_PASSWORD`; recusa produção sem `SEED_ALLOW_PRODUCTION=1` (`tech/23-billing-planos.md`) |
| `npm run jobs:install` | Primeiro `start()` do pg-boss com `DIRECT_URL`: tabelas do schema `pgboss`, filas e crons (depois de `db:migrate`; idempotente) |
| `npm run email:preview` | Renderiza todos os templates de e-mail com dados fictícios em `.tmp/emails/*.html` |
| `node build/server/index.js --worker` | Só os workers de jobs, sem HTTP (`JOBS_MODE=worker`) |

Script previsto nas fases seguintes: `db:reset`.
