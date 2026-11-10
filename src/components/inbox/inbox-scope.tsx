import { createContext, useCallback, useContext, useMemo } from "react";
import { useCan } from "@/components/auth/can";
import { PLATFORM_CHANNELS_PATH, TENANT_CHANNELS_PATH } from "@/components/channels/channels-api";
import { platformReplyRoles } from "@/lib/inbox/constants";
import { useAuth } from "@/providers/auth-provider";

/**
 * De quem é a caixa que a tela mostra: a do tenant (`/app/atendimento`, `/api/inbox`) ou a da
 * plataforma (`/admin/atendimento`, `/api/admin/inbox`). Os mesmos componentes servem aos dois; a
 * rota monta o `InboxModeProvider` e tudo abaixo lê daqui a raiz da API, a rota das telas, a chave das
 * queries e as permissões. A tela só esconde botões: quem decide é o servidor.
 */

export type InboxMode = "tenant" | "platform";

const ModeContext = createContext<InboxMode>("tenant");
export const InboxModeProvider = ModeContext.Provider;

/** Segundo elemento das chaves do TanStack no escopo da plataforma. */
export const PLATFORM_KEY = "platform";

export type InboxScope = {
  mode: InboxMode;
  /** Raiz da API do atendimento. */
  api: string;
  /** Raiz das telas do atendimento. */
  route: string;
  /** Raiz da API de números (canais) do escopo. */
  channelsPath: string;
  /** Tela de configuração dos números do escopo. */
  channelsRoute: string;
  /** Chave das queries: o tenant ativo ou `"platform"`. `undefined` = ainda sem tenant. */
  key: string | undefined;
  /** Pode consultar: no tenant, só com organização ativa. */
  ready: boolean;
};

export function scopeOf(mode: InboxMode, tenantId: string | undefined): InboxScope {
  return mode === "platform"
    ? {
        mode,
        api: "/api/admin/inbox",
        route: "/admin/atendimento",
        channelsPath: PLATFORM_CHANNELS_PATH,
        channelsRoute: "/admin/configuracoes/canais",
        key: PLATFORM_KEY,
        ready: true,
      }
    : {
        mode,
        api: "/api/inbox",
        route: "/app/atendimento",
        channelsPath: TENANT_CHANNELS_PATH,
        channelsRoute: "/app/configuracoes/canais",
        key: tenantId,
        ready: Boolean(tenantId),
      };
}

export const useInboxMode = () => useContext(ModeContext);

/** O escopo da tela. `override` serve ao menu (fora da rota do atendimento). */
export function useInboxScope(override?: InboxMode): InboxScope {
  const contextMode = useContext(ModeContext);
  const mode = override ?? contextMode;
  const { tenant } = useAuth();

  return useMemo(() => scopeOf(mode, tenant?.id), [mode, tenant?.id]);
}

type Can = ReturnType<typeof useCan>;

/**
 * `can(recurso, ação)` do escopo. No tenant, as permissões do papel; na plataforma, só o atendimento:
 * ler (qualquer papel de plataforma) e responder (proprietário e suporte). Não há atribuir, supervisionar,
 * cliente nem canal ali, e a sessão personificada nem chega à tela.
 */
export function useInboxCan(): Can {
  const mode = useContext(ModeContext);
  const tenantCan = useCan();
  const { user } = useAuth();
  const role = user?.platformRole;

  return useCallback(
    ((resource: string, action: string) => {
      if (mode === "tenant") return (tenantCan as (r: string, a: string) => boolean)(resource, action);
      const staff = role === "platform_owner" || role === "platform_support";
      // Qualquer papel de plataforma vê os números (editar é só do proprietário, na tela de canais).
      if (resource === "channel" && action === "read") return staff;
      if (resource !== "inbox") return false;
      if (action === "read") return staff;
      if (action === "reply") return (platformReplyRoles as readonly string[]).includes(role ?? "");
      return false;
    }) as Can,
    [mode, tenantCan, role],
  );
}
