import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import {
  AuthShell,
  AuthSpinner,
  authLinkClassName,
  authSubmitClassName,
} from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "@/lib/api/client";
import { VERIFICATION_TOKEN_PATTERN } from "@/lib/schemas/phone";
import { useAuth } from "@/providers/auth-provider";
import { usePortalAuth } from "@/providers/portal-auth-provider";

/**
 * Página do link de verificação de telefone (SPEC `pre-producao`, T2b). Só renderiza no GET:
 * quem consome o token é o POST do botão, **na sessão do próprio cadastro**. Sem sessão, leva ao
 * login e volta. O prefixo do token diz qual sessão pedir (`u.` equipe, `c.` portal); quem decide
 * se o token vale é o servidor.
 */

const TEAM_PATH = "/verificar-telefone";
const PORTAL_PATH = "/portal/verificar-telefone";

const withToken = (path: string, token: string) => `${path}?token=${encodeURIComponent(token)}`;

function InvalidLink({ home }: { home: string }) {
  return (
    <AuthShell title="Confirmar WhatsApp" subtitle="Link inválido ou expirado">
      <p className="text-center text-sm text-muted-foreground">
        Este link venceu, já foi usado ou não é desta conta. Peça um novo na sua conta.
      </p>
      <p className="mt-4 text-center text-sm">
        <Link to={home} className={authLinkClassName}>
          Ir para a conta
        </Link>
      </p>
    </AuthShell>
  );
}

function ConfirmPhone({
  token,
  endpoint,
  home,
  loginPath,
  signOut,
}: {
  token: string;
  endpoint: string;
  home: string;
  /** Sessão vencida no meio do caminho: o login, com a volta para esta página. */
  loginPath: string;
  /** Sai da sessão antes do login: sem isso, o cache da sessão no cookie mandaria de volta. */
  signOut: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "sending" | "done" | "invalid">("idle");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setState("sending");
    setError(null);

    try {
      await apiFetch(endpoint, { method: "POST", body: JSON.stringify({ token }) });
      setState("done");
    } catch (failure) {
      if (!(failure instanceof ApiError)) throw failure;
      if (failure.status === 401) {
        await signOut().catch(() => undefined);
        navigate(loginPath, { replace: true });
        return;
      }
      if (failure.code === "INVALID_OR_EXPIRED" || failure.status === 400) {
        setState("invalid");
        return;
      }
      setError(failure.message);
      setState("idle");
    }
  }

  if (state === "invalid") return <InvalidLink home={home} />;

  if (state === "done") {
    return (
      <AuthShell title="Confirmar WhatsApp" subtitle="Tudo certo">
        <div className="grid gap-4 text-sm">
          <p className="flex items-start gap-2 text-white">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" />
            Seu número de WhatsApp está confirmado.
          </p>
          <Link to={home} className={authLinkClassName}>
            Ir para a conta
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Confirmar WhatsApp" subtitle="Falta um clique">
      <div className="grid gap-4 text-sm">
        <p className="text-muted-foreground">
          Confirme que este número de WhatsApp é seu. Só vale na conta em que você o cadastrou.
        </p>
        {error ? <p className="text-destructive">{error}</p> : null}
        <Button
          type="button"
          size="lg"
          className={authSubmitClassName}
          disabled={state === "sending"}
          onClick={() => void confirm()}
        >
          {state === "sending" ? <Loader2 className="animate-spin" /> : null}
          Confirmar meu WhatsApp
        </Button>
      </div>
    </AuthShell>
  );
}

/** `/verificar-telefone`: conta da equipe (owner, membros, equipe da plataforma). */
export function VerifyPhonePage() {
  const { user, loading, signOut } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  // Link de ficha de cliente: a sessão é a do portal.
  if (token.startsWith("c.")) return <Navigate to={withToken(PORTAL_PATH, token)} replace />;
  if (!VERIFICATION_TOKEN_PATTERN.test(token)) return <InvalidLink home="/app" />;
  if (loading) return <AuthSpinner />;
  const loginPath = `/login?next=${encodeURIComponent(withToken(TEAM_PATH, token))}`;
  if (!user) return <Navigate to={loginPath} replace />;

  return (
    <ConfirmPhone
      token={token}
      endpoint="/api/me/phone-verification/confirm"
      home="/app"
      loginPath={loginPath}
      signOut={signOut}
    />
  );
}

/** `/portal/verificar-telefone`: a ficha de cliente, na sessão do portal (lead ou cliente). */
export function PortalVerifyPhonePage() {
  const { user, loading, signOut } = usePortalAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  if (!token.startsWith("c.") || !VERIFICATION_TOKEN_PATTERN.test(token)) {
    return <InvalidLink home="/portal" />;
  }
  if (loading) return <AuthSpinner />;
  const loginPath = `/portal/login?next=${encodeURIComponent(withToken(PORTAL_PATH, token))}`;
  if (!user) return <Navigate to={loginPath} replace />;

  return (
    <ConfirmPhone
      token={token}
      endpoint="/api/portal/me/phone-verification/confirm"
      home="/portal"
      loginPath={loginPath}
      signOut={signOut}
    />
  );
}
