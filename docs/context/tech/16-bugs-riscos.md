# Bugs, riscos e ajustes

- **Escopo:** Histórico de bugs corrigidos e riscos abertos.
- **Specs relacionadas:** nenhuma citada
- **Paths do código:** `src/api/app.ts`, `src/lib/content/posts.ts`, `src/lib/schemas/contact.ts`, `src/server.ts`


## 16. Bugs, Riscos e Ajustes Recomendados

### BUG-001 — `.env.example` ainda indicava `PORT=3001` (corrigido)

Estado anterior:

- O projeto migrou para processo unico.
- `Dockerfile` e runtime usam `PORT=3000`.
- `.env.example` ainda documenta `PORT=3001` como "API Hono".

Impacto:

- Confunde novos projetos criados a partir do template.
- Pode fazer o dev subir o app em porta diferente da documentada no Docker.

Status:

- Corrigido para `PORT=3000`.
- Comentario atualizado para "Servidor unico — React Router SSR + Hono API".

### BUG-002 — `README.md` estava desatualizado pos-migracao (corrigido)

Estado anterior:

- README ainda fala em Vite `:5173` + API `:3001`.
- Lista scripts que nao existem mais: `dev:client`, `dev:server`.
- Mostra estrutura antiga com `server/`.

Impacto:

- Onboarding incorreto.
- Template perde confiabilidade para novos projetos.

Status:

- README reescrito para Framework Mode, Hono unificado, metodologia AI Software
  Engineering, scripts atuais e deploy VPS/Docker/Portainer.

### BUG-003 — `.cursor/rules/portal-stack.mdc` estava desatualizada (corrigido)

Estado anterior:

- A rule diz que API Hono fica em `server/` e `/api` passa por proxy Vite.
- A arquitetura atual usa `src/api/app.ts` + `src/server.ts` em processo unico.

Impacto:

- Agentes futuros podem seguir instrucao antiga e recriar arquitetura errada.

Status:

- Rule atualizada para React Router Framework Mode + Hono integrado.
- Marcada como `alwaysApply: true`.

### BUG-004 — `.cursor/rules/portal-scope.mdc` conflitava com o estado atual (corrigido)

Estado atual:

- A rule diz "Nao adicionar auth de usuarios, dashboard ou pagamentos sem spec
  aprovada".
- O projeto ja possui login, dashboard inicial e dependencias de pagamentos.

Impacto:

- Agentes podem bloquear evolucoes legitimas do proprio template.

Status:

- Rule atualizada para o novo objetivo: template multiuso para SaaS, portal,
  site, blog, dashboard e sistemas web.

### BUG-005 — `next-themes` instalado mas nao usado (corrigido)

Estado atual:

- `next-themes` aparece em `package.json`.
- Nao ha imports de `next-themes` no codigo.
- O tema usa provider proprio com Zustand.

Impacto:

- Dependencia orfa.
- Aumenta superficie de manutencao sem beneficio.

Status:

- Dependencia removida com `npm uninstall next-themes`.

### BUG-006 — DELETE respondia 500 no servidor Node (corrigido)

O `bodyLimit` do Hono remonta a `Request` quando não há `Content-Length`, como em todo DELETE
do navegador. O `react-router-hono-server` liga o @hono/node-server com
`overrideGlobalObjects: false`, e o construtor nativo não aceita o objeto dele. Os testes não
viam: `api.request()` entrega um `Request` nativo, e `serve()` usa `true`. Corrigido com
`overrideGlobalObjects: true` em `src/server.ts`. Regressão em `tests/db/tenant-http.test.ts`.

### RISK-001 — `/api/contact` ainda nao usava Zod (corrigido)

Estado atual:

- `@hono/zod-validator` e `zod` estao instalados.
- A rota ainda faz validacao manual simples.

Impacto:

- Menos consistencia entre forms e API.
- Risco de validacoes divergentes no futuro.

Status:

- Criado `src/lib/schemas/contact.ts`.
- Aplicado `zValidator("json", contactMessageSchema)` em `src/api/app.ts`.
- Formulario de contato reutiliza `contactMessageSchema.safeParse`.

### RISK-002 — Migrations nao estao no runtime Docker

Estado atual:

- `.dockerignore` exclui `drizzle/`.
- Runtime Docker usa `npm ci --omit=dev`, portanto nao inclui `drizzle-kit`.

Impacto:

- O container de app nao executa migrations.
- Isso e aceitavel se migrations forem uma etapa separada no deploy.

Acao recomendada:

- Documentar explicitamente no README/Portainer: migrations devem rodar em job
  separado ou pipeline.

### RISK-003 — Blog ainda e estatico

Estado atual:

- Blog SSR funcional, mas dados vivem em `src/lib/content/posts.ts`.

Impacto:

- Bom para template inicial.
- Ainda nao atende CMS/blog dinamico.

Acao recomendada:

- Criar tabela `posts` no Drizzle quando o blog virar feature real.

### RISK-004 — Alertas moderados em dependencias

Estado atual:

- A cadeia do `react-router-hono-server` foi resolvida com React Router 8, `react-router-hono-server` 4
  e `@hono/node-server` 2. `overrides` no `package.json` mantem `@hono/node-server` na versao corrigida
  (o hono-server fixa uma anterior, e o `@hono/vite-dev-server` ainda pede a 1.x) e `minimatch` 11 no
  `@hono/vite-dev-server`. Revise ou remova os dois quando esses pacotes atualizarem.
- `npm audit` aponta 4 alertas moderados, sem altos ou criticos, todos em
  `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild` antigo.

Impacto:

- Nenhum em producao: o alerta e do servidor de desenvolvimento do `esbuild`, que o `drizzle-kit` nao
  sobe. Aparece em `--omit=dev`, e o pacote vai para a imagem, porque e peer opcional do `better-auth`;
  o app nao o executa ali (o servico `migrate` usa o estagio `build`).

Acao recomendada:

- Esperar uma versao do `drizzle-kit` sem `@esbuild-kit`. O `npm audit fix --force` rebaixaria para
  0.18 e quebraria as migrations: nao rode.

### RISK-005 — Rate limit em memoria (corrigido na fase 9)

`RATE_LIMIT_STORE=postgres` guarda os contadores em `rate_limit_bucket`, e producao recusa
`memory` na subida. Sobra o `failureLimit` dos webhooks, em memoria: com N instancias, o teto e N
vezes o limite.

Atras de proxy e sem `TRUSTED_PROXY_HOPS`, todos ainda dividem o limite do IP do proxy: defina a
variavel no deploy.

---

### RISK-011 — Backup antigo restaura quem foi excluído (risco aceito)

A anonimização é um `UPDATE` e a remoção de linhas: um backup anterior ainda guarda a pessoa. O prazo é
curto (`BACKUP_KEEP_DAYS`, 14), o arquivo é cifrado com `age`, e quem restaura precisa reaplicar as exclusões
executadas desde o backup (`tech/14-deploy.md`, `docs/context/lgpd.md`). Não há automação disso.

### RISK-012 — Exclusão de organização depende do provedor responder (risco aceito)

`DELETE /api/tenant` encerra a assinatura no provedor antes de agendar. Se o provedor estiver fora do ar, a
rota responde 502 e nada é agendado (é o desenho: não agendar com cobrança no ar). O proprietário tenta de novo
depois, ou o suporte cancela a assinatura em `/admin/assinaturas`.

### RISK-013 — Restore sem GRANTs deixava o `bizu_app` sem acesso (corrigido)

O `backup.sh` gerava o dump com `--no-privileges` e o procedimento restaurava com `--no-owner
--no-privileges` como `postgres`: tabelas de `public`, `drizzle.__drizzle_migrations` e o schema `pgboss`
voltavam sem GRANT para o `bizu_app` (reproduzido: 37 tabelas sem acesso, dono `postgres`). Agora o dump
leva os GRANTs, a restauração é como `bizu_owner` e o `restore-test.sh` mede o acesso do `bizu_app`.
Risco residual: backups feitos antes da correção não têm os GRANTs; use "Dump antigo" em `tech/14-deploy.md`
(o `restore-test.sh` reprova esse dump de propósito).

### RISK-009 — Código TOTP reutilizável dentro da janela (risco aceito)

O plugin aceita o mesmo código enquanto ele estiver na janela de 30 s (mais uma para trás e uma para
frente) e não guarda o último usado. Quem captura a senha e um código ao vivo consegue entrar nesse
intervalo. O limite de 3 por 10 s e o lockout seguem valendo. Resolver exige controle próprio do
último contador, fora do plugin.

### RISK-010 — Trocar `BETTER_AUTH_SECRET` invalida o 2FA (risco aceito)

Segredo TOTP e códigos de backup são cifrados com ele. Rotacionar exige recriar o 2FA das contas, e o
plugin não oferece rotação. O caminho manual está em `tech/26-seguranca.md`.

---

### RISK-008 — Cadastro + login revelavam se o e-mail existe em `/api/auth` (corrigido)

Achado no security-review da fase 8, no código da fase 2. `/api/auth/sign-up/email` responde
igual para e-mail novo e existente, mas o login conferia a senha antes da verificação: com a senha
usada no cadastro, respondia 403 `EMAIL_NOT_VERIFIED` se a conta era nova e 401 se ela já existia.
Corrigido com `hideUnverified` (`src/api/auth-ext.ts`), o mesmo do portal, que devolve o 401 do
Better Auth byte a byte. A tela de login passou a oferecer o reenvio sempre, sem depender do erro.

### RISK-014 — Autocadastro do portal ainda deixa inferir que o número é de um cliente (risco residual)

Com o `claim` (D-1, `tech/28-crm-cadastro.md`), o autocadastro com o número de uma ficha que já existe aparece no portal
como uma ficha pendente comum, e o link segue o mesmo envio do autocadastro comum (Cloud, depois QR Code). Sobram dois
sinais para quem se cadastra com o número de outra pessoa (cada tentativa custa um e-mail novo confirmado):

- a organização some do painel quando o `claim` vence (`PHONE_VERIFICATION_TTL_MINUTES`), enquanto o lead comum fica;
- quando a ficha que tem o número é protegida (conta no portal, ligada à equipe ou bloqueada), o `claim` nem abre e a
  organização nunca aparece, como antes do `claim`.

Igualar exigiria inventar regra: manter o `claim` (e o `payload`) além do prazo, ou mostrar um pedido que não existe.
Nenhum dos dois foi feito. O sinal "aguardando liberação" em organização só com QR Code deixou de existir em
2026-11-14, quando o `claim` passou a usar o QR Code.

### RISK-015 — Pool de conexões travado por seção que segura uma e pede outra (corrigido, 2026-11-14)

O pool de runtime é um só, de 10 conexões (`src/db/index.ts`), e o Better Auth usa o mesmo. `createOrganizationWithinLimit`
(`src/lib/billing/organizations.ts`, anterior à trava de limites da Q1) abre uma transação de plataforma, toma um lock por pessoa e
chama o `createOrganization` do Better Auth **lá dentro**, que pede uma segunda conexão. Com 10 criações simultâneas, da mesma
pessoa (as outras esperando o lock, cada uma com uma conexão) ou de pessoas diferentes, as 10 conexões ficavam presas em
transações que esperavam o Better Auth, e o Better Auth ficava na fila do pool, que o `postgres.js` não limita no tempo: nada
liberava, e todo o acesso ao banco do processo parava até reiniciar. A trava de `members` da Q1 (`withinLimit` com
`createInvitation` e `acceptInvitation` dentro) tinha o mesmo desenho e foi corrigida junto.

Correção: `nestedSection` (`src/db/nested-section.ts`), um semáforo em memória com teto de `floor(POOL_MAX / 3)` = 3 seções ao
mesmo tempo, com a fila de pedidos **sem** conexão; `withinLimitNested` não abre transação quando a métrica não tem limite.
Cada seção segura 1 conexão e o código de dentro usa até 2, então no pior caso 9 de 10. Testes em `tests/db/pool-saturation.test.ts`
(14 pedidos simultâneos, mais que as conexões). O pool não foi aumentado: o teto é que garante a vivacidade.

Risco que sobra: o teto é por **processo**. Com várias instâncias, cada uma tem o seu pool e o seu teto, então não há travamento
entre elas; o limite de conexões do Postgres é a soma dos pools. Código novo que segure uma conexão e peça outra volta ao problema
se não passar por `nestedSection` (regra em `.claude/rules/api-hono.md`).

### RISK-007 — Pré-sequestro no autocadastro do portal (risco aceito)

É o RISK-006 no portal, só em tenant com `portal_self_signup` ligado. Quem cadastra o e-mail de
outra pessoa define a senha antes de provar a posse; se o dono clicar na confirmação, a senha
continua valendo. A confirmação nunca liga essa identidade a um cliente `active`, e o convite
revoga a senha enquanto a conta não estiver verificada. Sobra o caso em que o dono confirma um
cadastro que não fez e depois recebe acesso.

### RISK-006 — Pré-sequestro de conta dentro de 24 h (risco aceito)

Quem cadastra o e-mail de outra pessoa define a senha antes de provar a posse. Se o dono
clicar no link em até 24 h, a senha do atacante continua valendo na conta verificada. O
prazo de `src/lib/auth/pending-signup.ts` fecha a conta deixada à espera por tempo
indeterminado, mas não essa janela.

Decisão do usuário: manter a confirmação em um clique. Pedir a senha na página de
confirmação fecharia a janela, mas acrescenta atrito ao cadastro de todo mundo, e o ataque
exige alvo específico e o clique da vítima dentro do prazo. Reavalie se o produto derivado
guardar dados sensíveis já no cadastro. O reenvio fixo na tela de login (RISK-008) facilita
esse clique: o servidor não mudou, mas o dono chega ao link com menos esforço.

Falta também um job de limpeza (fase 3): hoje a conta vencida só some no próximo cadastro.
