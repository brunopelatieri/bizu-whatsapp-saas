# Áreas autenticadas (/app, /admin e /portal)

- **Escopo:** Layout, rotas e estado atual da área autenticada do owner e da equipe (`/app`). A área da plataforma (`/admin`) está em `tech/22-admin.md`, e o portal (`/portal`), em `tech/25-portal-clientes.md`.
- **Specs relacionadas:** `docs/specs/saas-foundation/spec-rotas-api.md`, `spec-tenant-rbac.md`
- **Paths do código:** `src/components/app/`, `src/components/admin/`, `src/components/auth/can.tsx`, `src/lib/constants/app-nav.ts`, `src/lib/constants/admin-nav.ts`, `src/lib/constants/permission-labels.ts`, `src/providers/auth-provider.tsx`, `src/pages/dashboard-page.tsx`, `src/pages/onboarding-page.tsx`, `src/pages/team-page.tsx`, `src/routes/app.tsx`, `src/routes/app.onboarding.tsx`, `src/routes/app.team.tsx`, `src/routes/app.settings.tsx`, `src/routes/app.customers.tsx`, `src/routes/app.customers.$id.tsx`, `src/pages/customers-page.tsx`, `src/pages/customer-detail-page.tsx`, `src/components/app/customers/`, `src/pages/profile-page.tsx`, `src/components/profile/`, `src/routes/app.profile.tsx`, `src/routes/admin/profile.tsx`, `src/components/phone/phone-change-section.tsx`, `src/components/inbox/`, `src/pages/inbox-page.tsx`, `src/routes/app.inbox.tsx`

## Rotas

| Rota | Estado |
|---|---|
| `/app` | visão geral com `AccountCard` e cards de clientes, equipe e assinatura |
| `/app/atendimento`, `/app/atendimento/:conversationId` | caixa de entrada: lista (Fila, Minhas, Todas), conversa e painel do contato; tempo real por SSE (`use-inbox-events.ts`, montado no `AppLayout` para o ponto de não lidas do menu andar em toda tela) e, sem ele, polling de 20 s com o aviso "Atualização em tempo real indisponível"; ocupa a altura toda; composer com anexo, citação e modelo (`template-dialog.tsx`); estrela na mensagem (selo na bolha e botão ao lado do "Responder", só com `inbox:reply`) e aviso "Mensagens antigas removidas pela política de retenção" na conversa esvaziada (`tech/30-caixa-de-entrada.md`) |
| `/admin/atendimento`, `/admin/atendimento/:conversationId` | atendimento da plataforma (C6): os mesmos componentes de `src/components/inbox/` em `mode="platform"` (`inbox-scope.tsx`), sem fila nem abas, painel com o usuário e as organizações (etiquetas e campos só leitura); item no `admin-nav.ts` com o ponto de não lidas; ocupa a altura toda; a estrela e o aviso da conversa esvaziada valem também aqui (`tech/30-caixa-de-entrada.md`) |
| `/app/clientes`, `/app/clientes/:id` | lista com busca, filtro e paginação; criar, editar, remover, bloquear, enviar acesso ao portal e último acesso (`tech/25-portal-clientes.md`) |
| `/app/onboarding` | criação do tenant e convites abertos; fora do layout com sidebar |
| `/app/equipe` | membros, convites, reenvio, revogação, troca de papel e remoção |
| `/app/assinatura` | plano e estado, escolha de plano e método por capacidades, perfil de faturamento, cancelar, pausar, portal e faturas recentes |
| `/app/assinatura/faturas` | histórico, com link para a fatura no provedor |
| `/app/assinatura/retorno` | volta do checkout: consulta o estado local, nunca a query string |
| `/app/auditoria` | log do tenant, com `audit:read`, filtros por ação e pessoa e paginação |
| `/app/perfil` | página "Perfil" da própria conta (F2): foto com recorte, nome, e-mail, telefone (troca pelo pedido) e senha; o mesmo componente de `/admin/perfil`; item "Perfil" no menu do usuário |
| `/app/configuracoes` | organização, papéis personalizados (só owner) e um link para o Perfil (o e-mail mudou para lá) |
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
- Telefone pendente (T3): com a API respondendo 403 `PHONE_UNVERIFIED`, `ProtectedRoute` (`/app`, `/admin`, onboarding) mostra só `TeamPhoneGate` e `PortalLayout` só `PortalPhoneGate` (`src/components/phone/phone-verification-panel.tsx`); com `PHONE_VERIFICATION_REQUIRED=false`, `TeamPhonePendingBanner` e `PortalPhonePendingBanner` avisam (`phonePending` de `/api/me` e `/api/portal/me`). O bloqueio é do servidor (`tech/28-crm-cadastro.md`).
- Fila de liberação de telefone (T4): `TenantPhoneReleaseCard` (`src/components/phone/phone-release-card.tsx`) em `/app/equipe` (pessoas) e `/app/clientes` (fichas), dentro de `<Can resource="phone" action="confirm">`; a plataforma tem a aba "Telefones" em `/admin/usuarios` (`tech/22-admin.md`). Detalhe em `tech/28-crm-cadastro.md`.
- Perfil (F2, `src/pages/profile-page.tsx`, `src/components/profile/`): `AvatarCard` (escolher, `AvatarCropDialog`, enviar, remover; regras do recorte em `src/lib/profile/avatar-crop.ts`), `NameCard` (`PATCH /api/me`), `ChangeEmailCard`, telefone (`TeamPhoneChange`) e `PasswordCard` (`authClient.changePassword` com `revokeOtherSessions`). Na personificação (`user.impersonatedBy`) os cartões só mostram. A foto aparece pelo `UserAvatar` (`ui/avatar.tsx` com as iniciais como reserva): menu do usuário (`user.avatarUrl`, que traz `?v=`), lista de membros e quem atende a conversa; para outra pessoa a tela tenta `GET /api/avatars/:userId` e o 404 cai nas iniciais (nenhuma rota devolve o endereço dos outros).
- Troca de telefone (`PhoneChangeSection`, `src/components/phone/phone-change-section.tsx`): um componente para a equipe (`/api/me/phone-change`), o portal (`/api/portal/me/phone-change`) e a ficha do cliente (`CustomerPhoneChangeCard`, `/api/customers/:id/phone-change`). Mostra o número atual, a troca pendente (final do número novo, link enviado ou aguardando liberação e de quem), reenvia, cancela e substitui, sempre dizendo que o número atual vale até o novo ser confirmado. As filas de liberação marcam `purpose = change`.
- Retenção de mensagens (bloco R, R3b): `TenantRetentionCard` na página da organização (`/admin/tenants/:id`) e `PlatformRetentionCard` (só leitura) em `/admin/configuracoes`, em `src/components/admin/retention-card.tsx` (busca e grava) e `retention-scope.tsx` (apresentação); os textos e a decisão de cada limite (herdar, sem limite, definir) ficam em `src/lib/inbox/retention-format.ts`. Só consome `/api/admin/retention/*`; detalhe em `tech/22-admin.md`.
- Nada disso tem loader no servidor.
