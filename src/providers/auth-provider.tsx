import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { ApiError, apiFetch, PHONE_UNVERIFIED_EVENT } from "@/lib/api/client";
import { authClient, toAuthActionError } from "@/lib/auth/client";
import type { BillingSummary } from "@/lib/billing/summary";
import {
  type AuthUser,
  type MeResponse,
  type TenantSummary,
  toAuthUser,
} from "@/lib/auth/types";
import type { LoginInput, SignupInput } from "@/lib/schemas/auth";

const NO_TENANTS: TenantSummary[] = [];
const NO_PERMISSIONS: string[] = [];
const NO_FEATURES: string[] = [];
const NO_LIMITS: Record<string, number> = {};
const NO_CONSENT: MeResponse["consentRequired"] = [];
const NO_REQUIREMENTS = { tenantRequires2fa: false, platformRequires2fa: false };

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  /** Tenant ativo da sessão; `null` antes do onboarding. */
  tenant: TenantSummary | null;
  tenants: TenantSummary[];
  /** Lista `recurso:ação`. Esconde botões; quem decide é o servidor. */
  permissions: string[];
  /** Cobrança do tenant ativo: estado, plano e fim do trial. */
  billing: BillingSummary | null;
  /** Features do plano do tenant ativo. */
  features: string[];
  /** Limites do plano; chave ausente = ilimitado. */
  limits: Record<string, number>;
  /** `GET /api/me` ainda não respondeu. */
  accountLoading: boolean;
  accountError: Error | null;
  /** Falta 2FA para seguir: a API responde 403 até a pessoa configurar. */
  security: MeResponse["security"];
  /** Documentos legais com versão nova a aceitar (`ConsentGate`). */
  consentRequired: MeResponse["consentRequired"];
  /**
   * Há sessão, mas a API recusa tudo até o WhatsApp valer na organização ativa
   * (`PHONE_VERIFICATION_REQUIRED=true`, 403 `PHONE_UNVERIFIED`): `ProtectedRoute` mostra só
   * "Confirme seu WhatsApp".
   */
  phoneBlocked: boolean;
  /** Telefone pendente com a exigência desligada: as áreas mostram um aviso. */
  phonePending: boolean;
  /**
   * Lança `AuthActionError`, com o `code` do Better Auth. Devolve
   * `twoFactor: true` quando a senha passou, mas a sessão ainda depende do desafio em `/2fa`.
   */
  signIn: (values: LoginInput) => Promise<{ twoFactor: boolean }>;
  /**
   * Não abre sessão. `verifyEmail`: a plataforma exige o link antes do primeiro login; sem
   * ele, quem chama entra com a mesma senha.
   */
  signUp: (values: SignupInput) => Promise<{ verifyEmail: boolean }>;
  /** Na personificação, encerra só ela e devolve o suporte à própria sessão. */
  signOut: () => Promise<void>;
  /** Relê a sessão depois de uma mudança feita fora do `authClient`. */
  refresh: () => Promise<void>;
  /** Relê tenants e permissões. */
  reloadAccount: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Ponto único da autenticação no cliente. A sessão vem de `authClient`; tenants e
 * permissões, de `GET /api/me`. A interface só conhece `AuthUser`. Serve para esconder
 * botões, não para proteger dados: quem protege é a API.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const { data, isPending, refetch } = session;
  const userId = data?.user.id;

  const account = useQuery({
    queryKey: ["me", userId],
    queryFn: () => apiFetch<MeResponse>("/api/me"),
    enabled: Boolean(userId),
    retry: false,
  });
  const me = account.data;
  // Vale também com dados antigos em mãos: o número pode ter mudado de dono no meio da sessão.
  const phoneBlocked =
    Boolean(userId) &&
    account.error instanceof ApiError &&
    account.error.code === "PHONE_UNVERIFIED";

  // Uma chamada qualquer recusada pelo telefone relê `/api/me`, e a área troca de tela.
  useEffect(() => {
    const reload = (event: Event) => {
      if ((event as CustomEvent<{ area?: string }>).detail?.area !== "team") return;
      // Sem cancelar a busca em andamento: várias recusas seguidas não a refazem a cada uma.
      void queryClient.invalidateQueries({ queryKey: ["me"] }, { cancelRefetch: false });
    };
    window.addEventListener(PHONE_UNVERIFIED_EVENT, reload);
    return () => window.removeEventListener(PHONE_UNVERIFIED_EVENT, reload);
  }, [queryClient]);

  const signIn = useCallback(async ({ email, password }: LoginInput) => {
    const { data, error } = await authClient.signIn.email({ email, password });
    if (error) throw toAuthActionError(error);

    return {
      twoFactor: Boolean(
        (data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect,
      ),
    };
  }, []);

  const signUp = useCallback(async (values: SignupInput) => {
    const { data, error } = await authClient.$fetch<{ verifyEmail?: boolean }>(
      "/sign-up/email",
      { method: "POST", body: values },
    );
    if (error) throw toAuthActionError(error);

    // Sem o campo (servidor antigo), o fluxo seguro: pedir a confirmação.
    return { verifyEmail: data?.verifyEmail !== false };
  }, []);

  const impersonating = Boolean(data?.session.impersonatedBy);

  const signOut = useCallback(async () => {
    if (impersonating) {
      await apiFetch("/api/admin/stop-impersonating", {
        method: "POST",
        body: "{}",
      });
      // Recarrega para nenhum estado do cliente personificado sobrar na sessão do suporte.
      window.location.assign("/admin");
      return;
    }

    await authClient.signOut();
    queryClient.clear();
  }, [impersonating, queryClient]);

  const reloadAccount = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["me"] });
  }, [queryClient]);

  const refresh = useCallback(async () => {
    await refetch();
    await reloadAccount();
  }, [refetch, reloadAccount]);

  const switchTenant = useCallback(
    async (tenantId: string) => {
      await apiFetch("/api/tenant/active", {
        method: "POST",
        body: JSON.stringify({ tenantId }),
      });
      // Limpa em vez de invalidar: refeita agora, a busca da tela ainda usaria a chave do
      // tenant anterior e guardaria nela os dados do novo.
      await queryClient.resetQueries();
    },
    [queryClient],
  );

  const value = useMemo<AuthContextValue>(() => {
    const activeId = me?.user.activeTenant?.id;

    return {
      user: data ? (me?.user ?? toAuthUser(data)) : null,
      loading: isPending,
      tenant: me?.tenants.find(({ id }) => id === activeId) ?? null,
      tenants: me?.tenants ?? NO_TENANTS,
      permissions: me?.permissions ?? NO_PERMISSIONS,
      billing: me?.billing ?? null,
      features: me?.features ?? NO_FEATURES,
      limits: me?.limits ?? NO_LIMITS,
      security: me?.security ?? NO_REQUIREMENTS,
      consentRequired: me?.consentRequired ?? NO_CONSENT,
      phoneBlocked,
      phonePending: me?.phonePending ?? false,
      accountLoading: Boolean(data) && account.isPending,
      // Com dados em mãos, uma releitura que falha não derruba a tela.
      accountError: me ? null : account.error,
      signIn,
      signUp,
      signOut,
      refresh,
      reloadAccount,
      switchTenant,
    };
  }, [
    data,
    me,
    isPending,
    phoneBlocked,
    account.isPending,
    account.error,
    signIn,
    signUp,
    signOut,
    refresh,
    reloadAccount,
    switchTenant,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }

  return context;
}
