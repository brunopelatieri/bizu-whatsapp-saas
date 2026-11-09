# Áreas autenticadas (/app, /admin e /portal)

- **Escopo:** Layout, rotas e estado atual da área autenticada do owner e da equipe (`/app`). A área da plataforma (`/admin`) está em `tech/22-admin.md`, e o portal (`/portal`), em `tech/25-portal-clientes.md`.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-rotas-api.md`, `spec-tenant-rbac.md`
- **Paths do código:** `src/components/app/`, `src/components/admin/`, `src/components/auth/can.tsx`, `src/lib/constants/app-nav.ts`, `src/lib/constants/admin-nav.ts`, `src/lib/constants/permission-labels.ts`, `src/providers/auth-provider.tsx`, `src/pages/dashboard-page.tsx`, `src/pages/onboarding-page.tsx`, `src/pages/team-page.tsx`, `src/routes/app.tsx`, `src/routes/app.onboarding.tsx`, `src/routes/app.team.tsx`, `src/routes/app.settings.tsx`, `src/routes/app.customers.tsx`, `src/routes/app.customers.$id.tsx`, `src/pages/customers-page.tsx`, `src/pages/customer-detail-page.tsx`, `src/components/app/customers/`

## Rotas

| Rota | Estado |
|---|---|
| `/app` | visão geral com `AccountCard` e cards de clientes, equipe e assinatura |
| `/app/clientes`, `/app/clientes/:id` | lista com busca, filtro e paginação; criar, editar, remover, bloquear, enviar acesso ao portal e último acesso (`tech/25-portal-clientes.md`) |
| `/app/onboarding` | criação do tenant e convites abertos; fora do layout com sidebar |
| `/app/equipe` | membros, convites, reenvio, revogação, troca de papel e remoção |
| `/app/assinatura` | plano e estado, escolha de plano e método por capacidades, perfil de faturamento, cancelar, pausar, portal e faturas recentes |
| `/app/assinatura/faturas` | histórico, com link para a fatura no provedor |
| `/app/assinatura/retorno` | volta do checkout: consulta o estado local, nunca a query string |
| `/app/auditoria` | log do tenant, com `audit:read`, filtros por ação e pessoa e paginação |
| `/app/configuracoes` | organização, papéis personalizados (só owner) e troca de e-mail |
| `/app/configuracoes/seguranca` | 2FA (QR, confirmar, códigos de backup, desativar); owner exige 2FA da equipe |
| `/app/configuracoes/sessoes` | lista e encerra sessões |
| `/app/configuracoes/canais` | números de WhatsApp (`channel:read`): estado, tipo, padrão; conectar, gerenciar e remover com `channel:manage` (`tech/29-canais-whatsapp.md`) |
| `/app/configuracoes/suporte` | só owner: libera o suporte por 24 h, lista e revoga |

`/admin/**` (proprietário e suporte da plataforma, `tech/22-admin.md`) reaproveita o mesmo
shell com outro menu; `/portal/**` é client-only como elas, com layout e sessão próprios: `PortalLayout` e
`PortalAuthProvider`, sem nada de `/app`. `apiFetch` trata o 401 de cada área com o login dela.

## Estado atual

- Layout responsivo inspirado no `shadcn-admin`: sidebar fixa e colapsável no desktop;
  topbar com hambúrguer e `Sheet` no mobile.
- Shell e telas em `src/components/app/`. O seletor de tenant (`TenantSwitcher`) fica na
  sidebar e no menu mobile.
- `AppLayout` espera `/api/me`: sem tenant, manda a `/app/onboarding`; com
  `security.tenantRequires2fa`, manda a `/app/configuracoes/seguranca`. É só o caminho da
  interface; quem barra os dados é `requireTenant`. O `AdminLayout` faz o mesmo com
  `platformRequires2fa`.
- `ImpersonationBanner` fica no topo de `/app` enquanto `user.impersonatedBy` existir, e
  `signOut()` encerra só a personificação. Ao personificar ou sair, a página recarrega: nenhum
  estado do cliente passa de uma sessão à outra.
- `SettingsNav` são as abas de `/app/configuracoes`; `TwoFactorCard` serve `/app` e `/admin`.
- `useAuth()` expõe `tenant`, `tenants`, `permissions`, `billing`, `features`, `limits`,
  `security`, `reloadAccount` e `switchTenant`. `signIn` devolve `{ twoFactor }`: com `true`, a
  tela de login segue para `/2fa`.
- `BillingBanner` (topo de `/app`) avisa do fim do trial, do pagamento pendente e do modo somente
  leitura, com link para `/app/assinatura`; só informa, a API é quem bloqueia. O cartão "Assinatura" da visão geral mostra o plano e os dias restantes.
- `AppSidebar`, `AppNav` e `AppTopbar` recebem o menu por props (`nav`, `header`, `subtitle`); o
  `AdminLayout` passa o de `admin-nav.ts`.
- `<Can resource action>` e `useCan()` escondem ações; item de menu usa `permission` em
  `app-nav.ts`. A regra vale na API.
- Sem `loader` de servidor; dados buscados no cliente via TanStack Query. Cobrança em
  `src/components/app/billing/`, com `useBillingMutation`, que também relê `/api/me`.
- `AccountCard` (`src/components/app/account-card.tsx`) é o exemplo de dados
  privados: `useQuery` + `apiFetch` -> `GET /api/me` -> `requireAuth` -> Drizzle.
- Navegação em `src/lib/constants/app-nav.ts`; tela nova entra lá e em
  `src/routes.ts`.

## Privacidade e re-aceite (fase 10)

- `/app/configuracoes/privacidade` (`src/routes/app.settings.privacy.tsx`, aba "Privacidade" em `SettingsNav`): marketing, exportação, excluir a conta (senha e, com 2FA, o código) e a organização (`<Can resource="organization" action="delete">`; o botão de desistir fica fora do `Can`, porque a organização em exclusão não tem permissões). Componentes em `src/components/privacy/`.
- `/portal/conta`: exportação e exclusão; `?confirmar-exclusao=<token>` só mostra o botão (o clique faz o POST).
- `ConsentGate` (`AppLayout` e `AdminLayout`) e `ConsentDialog` (`PortalLayout`): modal sem fechar enquanto `consentRequired` não esvazia.
- Nada disso tem loader no servidor.
