---
paths:
  - "src/api/auth.ts"
  - "src/api/auth-ext.ts"
  - "src/api/portal.ts"
  - "src/api/portal-auth.ts"
  - "src/lib/portal/**"
  - "src/db/schema/portal-auth.ts"
  - "src/api/verification-guard.ts"
  - "src/lib/auth/**"
  - "src/lib/schemas/auth.ts"
  - "src/lib/email/templates/auth/**"
  - "src/db/schema/auth.ts"
  - "src/providers/auth-provider.tsx"
  - "src/components/auth/**"
  - "src/routes/auth/**"
  - "src/pages/login-page.tsx"
  - "src/pages/two-factor-page.tsx"
  - "src/pages/signup-page.tsx"
  - "src/pages/verify-email-page.tsx"
  - "src/pages/forgot-password-page.tsx"
  - "src/pages/reset-password-page.tsx"
  - "src/lib/legal/**"
  - "src/lib/lgpd/consent.ts"
  - "src/lib/lgpd/identity.ts"
---

# Autenticação com Better Auth, sessão em cookie e falha fechada

- Instância `getAuth()` em `src/lib/auth/server.ts`; rotas em `src/api/auth-ext.ts`.
- Clientes e leads usam `getPortalAuth()` (`src/lib/auth/portal.ts`), com segredo derivado, cookies `bizu_portal` e tabelas `portal_*`: um cookie nunca vale pelo outro. Por HTTP, só o que está em `PORTAL_AUTH_PATHS` (`src/api/portal.ts`); `/api/portal/auth/magic-link/verify` só aceita POST.
- Rota privada usa `requireAuth` (sessão no banco; e-mail verificado só com `EMAIL_VERIFICATION_REQUIRED=true`); de plataforma, também `requirePlatform`.
- Verificação de e-mail é opcional (padrão desligada). O cadastro nunca abre sessão (`autoSignIn: false`); desligada, o cliente entra com a mesma senha. O que depende de provar o e-mail (listar os convites do próprio e-mail) exige `emailVerified` nas duas posições.
- Nenhum token é consumido em GET: a página renderiza e um botão faz a chamada. `/api/auth/verify-email` só aceita POST, atrás do `verificationGuard`.
- Respostas de cadastro, reenvio, reset e troca de e-mail nunca revelam se um e-mail existe: mesmo status, corpo e cabeçalhos. Trabalho que depende da existência roda em `runInBackground`.
- Login de conta não verificada responde o 401 de senha errada, byte a byte (`hideUnverified`, em todo o proxy): a tela não pode depender de `EMAIL_NOT_VERIFIED`.
- `/send-verification-email`, `/request-password-reset`, personificação, rotas de sessão (`/list-sessions`, `/revoke-*`), `/two-factor/send-otp`, `/two-factor/verify-otp` e toda escrita do plugin admin ficam em `disabledPaths`; use `auth.api.*` no servidor, atrás das rotas próprias.
- Personificação passa só por `POST /api/admin/impersonate` e `/stop-impersonating` (`src/api/impersonation.ts`), com consentimento; mutação sensível nova usa `blockWhileImpersonating` e entra no `it.each` de `tests/db/impersonation.test.ts`. Em `/api/auth/*`, a sessão personificada só usa `get-session` e `sign-out`. O prazo dela é `session.impersonation_expires_at`, nunca `expires_at`, que o cliente consegue renovar. Guarda sobre sessão decide por `resolveSession`, não por `getSessionCookie`, que lê cookie repetido de outro jeito.
- Papel de plataforma sem 2FA em produção responde 403 `PLATFORM_2FA_REQUIRED`; `tenant.settings.require_2fa` responde 403 `TENANT_2FA_REQUIRED`. Trocar `BETTER_AUTH_SECRET` invalida os 2FA ativos.
- Não confie em `X-Forwarded-For`: o IP vem de `clientKey` (`TRUSTED_PROXY_HOPS`) e chega ao Better Auth em `x-bizu-client-ip`.
- Rota nova em `/api/auth/*` confere `Origin` e não passa `c.req.raw` a `new Request()`; teste também em `tests/db/auth-http.test.ts`.
- Use `AuthUser` (`src/lib/auth/types.ts`), sem expor tipos do Better Auth na interface.
- Links de e-mail são absolutos, montados com `appLink`, e todo template em `src/lib/email/templates/auth/` exporta `previewInput`.
- Nunca abra o gate para contornar falha: 503, não acesso.
- `/api/auth/organization/*` responde 404: use `auth.api.*` com `organizationId` explícito, atrás das rotas próprias (`tech/21-tenant-rbac.md`).
- Permissões são validadas no servidor; o cliente só esconde botões.
- Sessões e usuários ficam no Postgres, via Drizzle.
- Cadastro grava o aceite em `consent_log` pelo hook de criação do usuário (`withSignupConsent`); versão nova em `src/lib/legal/versions.ts` faz `/api/me` e `/api/portal/me` devolverem `consentRequired`. A sessão de suporte nunca aceita termos.
- Telefone é obrigatório em toda conta: o hook `user.create.before` das duas instâncias grava `phone_normalized` e `phone_key` a partir do contexto do cadastro e recusa sem telefone válido (`tech/28-crm-cadastro.md`).
- Token de confirmação da exclusão do portal é de uso único, só em hash, consumido por POST; nenhum link da LGPD consome token em GET.

Para entender este domínio, leia: docs/context/tech/08-auth.md, docs/context/tech/25-portal-clientes.md e docs/context/tech/26-seguranca.md, docs/context/tech/27-lgpd-arquivos.md