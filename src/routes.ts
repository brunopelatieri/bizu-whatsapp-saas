import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  // ---------------------------------------------------------------------------
  // Site público (com header/footer) — SSR habilitado para SEO/Open Graph
  // ---------------------------------------------------------------------------
  layout("components/layout/root-layout.tsx", [
    index("routes/home.tsx"),
    route("sobre", "routes/about.tsx"),
    route("projetos", "routes/projects.tsx"),
    route("contato", "routes/contact.tsx"),
    route("blog", "routes/blog.tsx"),
    route("blog/:slug", "routes/blog-post.tsx"),
    route("precos", "routes/pricing.tsx"),
    route("legal/:slug", "routes/legal.tsx"),
  ]),

  // ---------------------------------------------------------------------------
  // Páginas de autenticação (standalone, sem header/footer)
  // ---------------------------------------------------------------------------
  // Quem recebe token na URL só renderiza no GET; o botão faz a chamada.
  route("login", "routes/auth/login.tsx"),
  route("cadastro", "routes/auth/signup.tsx"),
  route("verificar-email", "routes/auth/verify-email.tsx"),
  route("esqueci-senha", "routes/auth/forgot-password.tsx"),
  route("redefinir-senha", "routes/auth/reset-password.tsx"),
  route("convite/:id", "routes/auth/invite.tsx"),
  route("2fa", "routes/auth/two-factor.tsx"),

  // ---------------------------------------------------------------------------
  // Área do tenant (owner e equipe) — client-only (SEM loader de servidor).
  // O ProtectedRoute faz o gate no cliente; nenhum dado sensível é
  // renderizado no HTML inicial. /admin segue o mesmo modelo.
  // ---------------------------------------------------------------------------
  layout("components/auth/protected-route.tsx", [
    route("app/onboarding", "routes/app.onboarding.tsx"),
    route("app", "components/app/app-layout.tsx", [
      index("routes/app.tsx"),
      route("clientes", "routes/app.customers.tsx"),
      route("clientes/:id", "routes/app.customers.$id.tsx"),
      route("equipe", "routes/app.team.tsx"),
      route("assinatura", "routes/app.subscription.tsx"),
      route("assinatura/faturas", "routes/app.subscription.invoices.tsx"),
      route("assinatura/retorno", "routes/app.subscription.return.tsx"),
      route("auditoria", "routes/app.audit.tsx"),
      route("configuracoes", "routes/app.settings.tsx"),
      route("configuracoes/seguranca", "routes/app.settings.security.tsx"),
      route("configuracoes/sessoes", "routes/app.settings.sessions.tsx"),
      route("configuracoes/etiquetas", "routes/app.settings.tags.tsx"),
      route("configuracoes/privacidade", "routes/app.settings.privacy.tsx"),
      route("configuracoes/suporte", "routes/app.settings.support.tsx"),
    ]),

    // Plataforma (proprietário e suporte). O gate de papel é do `AdminLayout` e da
    // API (`requirePlatform`), nunca só do cliente.
    route("admin", "components/admin/admin-layout.tsx", [
      index("routes/admin/index.tsx"),
      route("tenants", "routes/admin/tenants.tsx"),
      route("tenants/:id", "routes/admin/tenant.tsx"),
      route("usuarios", "routes/admin/users.tsx"),
      // admin-crud C: detalhe de usuário de equipe e de pessoa do portal.
      route("usuarios/portal/:id", "routes/admin/portal-user.tsx"),
      route("usuarios/:id", "routes/admin/user.tsx"),
      route("planos", "routes/admin/plans.tsx"),
      route("planos/:id", "routes/admin/plan.tsx"),
      route("assinaturas", "routes/admin/subscriptions.tsx"),
      route("webhooks", "routes/admin/webhooks.tsx"),
      route("auditoria", "routes/admin/audit.tsx"),
      route("configuracoes", "routes/admin/settings.tsx"),
      route("configuracoes/seguranca", "routes/admin/security.tsx"),
    ]),
  ]),

  // ---------------------------------------------------------------------------
  // Portal do cliente — client-only, com sessão própria (`bizu_portal`). Nada na URL
  // identifica o tenant além do `org` do login: o ativo fica na sessão do portal.
  // ---------------------------------------------------------------------------
  layout("components/portal/portal-root.tsx", [
    route("portal/login", "routes/portal/login.tsx"),
    route("portal/entrar", "routes/portal/enter.tsx"),
    route("portal/confirmar", "routes/portal/confirm.tsx"),
    route("portal/cadastro", "routes/portal/signup.tsx"),
    route("portal/escolher", "routes/portal/choose.tsx"),
    route("portal", "components/portal/portal-layout.tsx", [
      index("routes/portal/home.tsx"),
      route("conta", "routes/portal/account.tsx"),
      route("faturas", "routes/portal/invoices.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
