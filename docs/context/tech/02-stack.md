# Stack principal

- **Escopo:** Ferramentas e versões por camada: runtime, frontend, UI, dados, backend e serviços.
- **Specs relacionadas:** nenhuma citada
- **Paths do código:** `src/api/`, `src/api/app.ts`, `src/components/ui/`, `src/root.tsx`


## 2. Stack Principal

### Runtime e Linguagem

| Camada | Ferramenta | Uso |
|--------|------------|-----|
| Runtime | Node.js 24 | Versao em `.nvmrc` (lida pelo CI), `engines` + `engine-strict` no npm, `node:24-alpine` no Docker |
| Linguagem | TypeScript 7 | Tipagem estrita em front, server e configs |
| Package manager | npm | Instalacao e scripts |
| Modulos | ESM (`type: module`) | Padrao moderno exigido pela integracao RR/Hono |

### Frontend / Framework

| Ferramenta | Versao atual | Uso |
|------------|--------------|-----|
| React | 19.3 | UI |
| React DOM | 19.3 | Render/hidratacao |
| React Router | 8.5 | Framework Mode, SSR, loaders, meta functions e rotas |
| `@react-router/dev` | 8.5 | CLI `react-router dev/build/typegen` |
| `@react-router/node` | 8.5 | Utilitarios server-side do RR |
| Vite | 8.3 | Build tool por baixo do Framework Mode (Rolldown) |
| `react-router-hono-server` | 4.1 | Servidor Hono integrado ao build/SSR do RR; exige Node 24.19+ |

### UI / Design System

| Ferramenta | Uso |
|------------|-----|
| Tailwind CSS v4 | Styling utilitario |
| `@tailwindcss/vite` | Plugin Tailwind para Vite |
| shadcn/ui | Componentes copiados para `src/components/ui/` |
| Base UI | Dependencia base de alguns componentes |
| `class-variance-authority` | Variants de componentes |
| `clsx` | Composicao condicional de classes |
| `tailwind-merge` | Merge seguro de classes Tailwind |
| `tw-animate-css` | Animacoes para componentes Radix/shadcn |
| Lucide React | Icones |
| Sonner | Toast notifications |

### Estado, Forms e Dados no Cliente

| Ferramenta | Uso previsto |
|------------|--------------|
| Zustand | Estado global leve; atualmente usado no tema |
| TanStack Query | Server state, cache, loading/error states — `QueryProvider` em `src/root.tsx` |
| React Hook Form | Formularios performaticos |
| Zod | Validacao compartilhavel front/back |
| `@hookform/resolvers` | Integracao React Hook Form + Zod |
| `read-excel-file` (`9.3.14`, versao fixada) | Leitura de `.xlsx` na importacao de clientes (bloco I), so no navegador e em import dinamico (`read-excel-file/browser`); descompacta e le o XML num Web Worker. Unica biblioteca de planilha do projeto |

### Backend / API / Banco

| Ferramenta | Uso |
|------------|-----|
| Hono | API HTTP em `src/api/app.ts` |
| `@hono/node-server` 2 | `getConnInfo` e os testes HTTP o importam direto; `overrides` no `package.json` usa a mesma versao no `react-router-hono-server` |
| Better Auth | Autenticação, com `@better-auth/drizzle-adapter` (`src/lib/auth/server.ts`) |
| `@hono/zod-validator` | Validacao Zod nas rotas Hono |
| Drizzle ORM | ORM tipado para Postgres |
| Drizzle Kit | Migrations, generate, studio |
| postgres.js 4 | Driver Postgres |
| Postgres 16 | Banco proprio da aplicacao |
| dotenv | Carregamento de `.env.local` em desenvolvimento |

Tabelas, graficos, datas e e-mail sao opcionais: veja `docs/context/receitas.md`.

### Operação e LGPD

| Ferramenta | Uso |
|------------|-----|
| pino (`pino-pretty` em dev) | Logs JSON com `request_id` e `redact` |
| `@sentry/node` | Erros em produção, módulo opcional (`SENTRY_DSN`) |
| `@aws-sdk/client-s3` | Provedor `s3` do módulo de arquivos (MinIO, R2...) |
| `age` | Cifra do backup (serviço `backup` do compose) |

### Qualidade

| Ferramenta | Uso |
|------------|-----|
| Biome | Lint de `src/` (`npm run lint`), sem formatacao |
| Vitest | Testes da API (`npm test`), configurados em `vitest.config.ts` |
| GitHub Actions | CI em `.github/workflows/ci.yml`: lint, tipos, testes e build |

---

