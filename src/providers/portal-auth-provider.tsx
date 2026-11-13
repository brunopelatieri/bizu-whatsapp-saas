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
import { toAuthActionError } from "@/lib/auth/client";
import { portalClient } from "@/lib/auth/portal-client";
import { rememberPortalOrg } from "@/lib/portal/last-org";
import type { LoginInput } from "@/lib/schemas/auth";
import type { CustomerStatus } from "@/lib/tenant/customer-constants";

export type PortalUser = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  /** Dígitos com DDI: o formulário monta o valor do `PhoneField` a partir dele. */
  phoneNormalized: string | null;
  hasPassword: boolean;
};

export type PortalTenantSummary = {
  id: string;
  slug: string;
  name: string;
  status: CustomerStatus;
  /** Pode entrar agora: cliente ativo em tenant aberto. */
  available: boolean;
};

export type PortalMe = {
  user: PortalUser;
  tenants: PortalTenantSummary[];
  active: { id: string; slug: string; name: string } | null;
  consentRequired: Array<"terms" | "privacy">;
  /** A ficha da organização em uso não está confirmada (só com `PHONE_VERIFICATION_REQUIRED=false`). */
  phonePending: boolean;
};

/** O servidor recusou a sessão pelo telefone (403 `PHONE_UNVERIFIED`, T3). */
export const isPhoneBlocked = (error: unknown) =>
  error instanceof ApiError && error.code === "PHONE_UNVERIFIED";

const NO_TENANTS: PortalTenantSummary[] = [];
const NO_CONSENT: PortalMe["consentRequired"] = [];

type PortalAuthContextValue = {
  user: PortalUser | null;
  tenants: PortalTenantSummary[];
  active: PortalMe["active"];
  consentRequired: PortalMe["consentRequired"];
  /**
   * Há sessão, mas a API recusa tudo até a ficha da organização em uso ter o WhatsApp confirmado
   * (`PHONE_VERIFICATION_REQUIRED=true`): a área mostra só "Confirme seu WhatsApp".
   */
  phoneBlocked: boolean;
  /** Telefone pendente com a exigência desligada: a área mostra um aviso. */
  phonePending: boolean;
  /** Nome da sessão: o que a tela de confirmação tem quando `/api/portal/me` é recusado. */
  sessionName: string | null;
  loading: boolean;
  accountError: Error | null;
  /** Lança `AuthActionError`. `org` só escolhe entre os tenants da pessoa. */
  signIn: (values: LoginInput, org?: string | null) => Promise<void>;
  signOut: () => Promise<void>;
  /** Relê a sessão depois de uma mudança feita fora do `portalClient`. */
  refresh: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
};

const PortalAuthContext = createContext<PortalAuthContextValue | undefined>(
  undefined,
);

/**
 * Sessão do cliente, separada da `AuthProvider`: em `/portal/**` as duas convivem, cada uma
 * com o seu cookie. Serve à interface. Quem protege os dados é `requirePortalAuth`.
 */
export function PortalAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isPending, refetch } = portalClient.useSession();
  const userId = data?.user.id;

  const account = useQuery({
    queryKey: ["portal-me", userId],
    queryFn: () => apiFetch<PortalMe>("/api/portal/me"),
    enabled: Boolean(userId),
    retry: false,
  });
  const me = account.data;
  const phoneBlocked = Boolean(data) && isPhoneBlocked(account.error);

  // Uma chamada qualquer recusada pelo telefone (o número mudou de dono no meio da sessão) relê
  // `/api/portal/me`, e a área passa a mostrar a tela de confirmação.
  useEffect(() => {
    const reload = (event: Event) => {
      if ((event as CustomEvent<{ area?: string }>).detail?.area !== "portal") return;
      void queryClient.invalidateQueries({ queryKey: ["portal-me"] }, { cancelRefetch: false });
    };
    window.addEventListener(PHONE_UNVERIFIED_EVENT, reload);
    return () => window.removeEventListener(PHONE_UNVERIFIED_EVENT, reload);
  }, [queryClient]);

  const switchTenant = useCallback(
    async (tenantId: string) => {
      await apiFetch("/api/portal/active-tenant", {
        method: "POST",
        body: JSON.stringify({ tenantId }),
      });
      // Limpa em vez de invalidar: a tela em andamento não guarda dados do tenant anterior.
      await queryClient.resetQueries();
    },
    [queryClient],
  );

  const signIn = useCallback(
    async ({ email, password }: LoginInput, org?: string | null) => {
      // Sem `portalClient`: com `callbackURL`, o cliente do Better Auth troca de página
      // na hora, antes de o tenant pedido ser ativado. A URL só serve ao link de
      // verificação, reenviado a quem ainda não confirmou o e-mail.
      await apiFetch("/api/portal/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          callbackURL: org ? `/portal?org=${encodeURIComponent(org)}` : "/portal",
        }),
      }).catch((error: unknown) => {
        if (error instanceof ApiError) {
          throw toAuthActionError({ status: error.status, code: error.code });
        }
        throw error;
      });

      await refetch();

      let next: PortalMe;
      try {
        next = await apiFetch<PortalMe>("/api/portal/me");
      } catch (error) {
        // Entrou, mas com o WhatsApp pendente: a área mostra a tela de confirmação, que também
        // troca a organização em uso.
        if (isPhoneBlocked(error)) {
          await queryClient.invalidateQueries({ queryKey: ["portal-me"] });
          return;
        }
        throw error;
      }
      const chosen = next.tenants.find(
        (tenant) => tenant.available && tenant.slug === org,
      );
      if (chosen && chosen.id !== next.active?.id) await switchTenant(chosen.id);
    },
    [refetch, switchTenant, queryClient],
  );

  const signOut = useCallback(async () => {
    if (me?.active) rememberPortalOrg(me.active.slug);
    await portalClient.signOut();
    queryClient.clear();
  }, [me, queryClient]);

  const refresh = useCallback(async () => {
    await refetch();
    await queryClient.invalidateQueries({ queryKey: ["portal-me"] });
  }, [refetch, queryClient]);

  const value = useMemo<PortalAuthContextValue>(
    () => ({
      user: me?.user ?? null,
      tenants: me?.tenants ?? NO_TENANTS,
      active: me?.active ?? null,
      consentRequired: me?.consentRequired ?? NO_CONSENT,
      phoneBlocked,
      phonePending: me?.phonePending ?? false,
      sessionName: data?.user.name ?? null,
      loading: isPending || (Boolean(data) && account.isPending),
      accountError: me ? null : account.error,
      signIn,
      signOut,
      refresh,
      switchTenant,
    }),
    [
      me,
      data,
      isPending,
      phoneBlocked,
      account.isPending,
      account.error,
      signIn,
      signOut,
      refresh,
      switchTenant,
    ],
  );

  return (
    <PortalAuthContext.Provider value={value}>
      {children}
    </PortalAuthContext.Provider>
  );
}

export function usePortalAuth() {
  const context = useContext(PortalAuthContext);

  if (!context) {
    throw new Error("usePortalAuth must be used within PortalAuthProvider");
  }

  return context;
}
