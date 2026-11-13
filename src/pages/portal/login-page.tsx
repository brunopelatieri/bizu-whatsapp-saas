import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MailCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AuthShell,
  AuthSpinner,
  authInputClassName,
  authLabelClassName,
  authLinkClassName,
  authSubmitClassName,
} from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import { safeNextPath } from "@/lib/auth/next-path";
import { lastPortalOrg, rememberPortalOrg } from "@/lib/portal/last-org";
import {
  emailOnlySchema,
  type LoginInput,
  loginSchema,
} from "@/lib/schemas/auth";
import { usePortalAuth } from "@/providers/portal-auth-provider";

type PublicTenant = { tenant: { name: string; selfSignup: boolean } };
type EmailOnly = { email: string };

function MagicLinkForm({ org }: { org: string }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useForm<EmailOnly>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
    mode: "onChange",
  });

  async function onSubmit({ email }: EmailOnly) {
    try {
      await apiFetch("/api/portal/auth-ext/magic-link", {
        method: "POST",
        body: JSON.stringify({ email, org }),
      });
      setSentTo(email);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Não foi possível enviar.",
      );
    }
  }

  if (sentTo) {
    return (
      <div className="flex items-start gap-3 text-sm">
        <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="font-medium text-white">Confira seu e-mail</p>
          <p className="mt-1 text-muted-foreground">
            Se <span className="break-all">{sentTo}</span> tiver acesso, enviamos um
            link. Ele vale por 10 minutos e só pode ser usado uma vez.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid w-full grid-cols-1 gap-4"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="w-full">
              <FormLabel className={authLabelClassName}>E-mail</FormLabel>
              <FormControl className="w-full">
                <Input
                  {...field}
                  type="email"
                  autoComplete="email"
                  placeholder="voce@email.com"
                  className={authInputClassName}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          size="lg"
          className={authSubmitClassName}
          disabled={form.formState.isSubmitting || !form.formState.isValid}
        >
          {form.formState.isSubmitting ? (
            <Loader2 className="animate-spin" />
          ) : null}
          Receber link de acesso
        </Button>
      </form>
    </Form>
  );
}

/**
 * Destino depois do login do portal: só caminho interno do próprio portal (o link de verificação
 * de telefone volta por aqui). Qualquer outra coisa vai para `/portal`.
 */
export function portalNextPath(next: string | null) {
  const path = safeNextPath(next);
  return path.startsWith("/portal/") ? path : "/portal";
}

function PasswordForm({ org, next }: { org: string | null; next: string }) {
  const navigate = useNavigate();
  const { signIn } = usePortalAuth();
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
    mode: "onChange",
  });

  async function onSubmit(values: LoginInput) {
    try {
      await signIn(values, org);
      navigate(next, { replace: true });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao entrar. Tente novamente.",
      );
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid w-full grid-cols-1 gap-4"
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="w-full">
              <FormLabel className={authLabelClassName}>E-mail</FormLabel>
              <FormControl className="w-full">
                <Input
                  {...field}
                  type="email"
                  autoComplete="email"
                  placeholder="voce@email.com"
                  className={authInputClassName}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem className="w-full">
              <FormLabel className={authLabelClassName}>Senha</FormLabel>
              <FormControl className="w-full">
                <Input
                  {...field}
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  className={authInputClassName}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          size="lg"
          className={authSubmitClassName}
          disabled={form.formState.isSubmitting || !form.formState.isValid}
        >
          {form.formState.isSubmitting ? (
            <Loader2 className="animate-spin" />
          ) : null}
          Entrar
        </Button>
      </form>
    </Form>
  );
}

export function PortalLoginPage() {
  const { user, loading } = usePortalAuth();
  const [searchParams] = useSearchParams();
  const [usePassword, setUsePassword] = useState(false);
  // Só depois de montar: no servidor não há `localStorage`.
  const [storedOrg, setStoredOrg] = useState<string | null>(null);
  const requestedOrg = searchParams.get("org");
  const next = portalNextPath(searchParams.get("next"));
  const org = requestedOrg ?? storedOrg;

  useEffect(() => {
    if (requestedOrg) rememberPortalOrg(requestedOrg);
    else setStoredOrg(lastPortalOrg());
  }, [requestedOrg]);

  const tenant = useQuery({
    queryKey: ["portal-tenant", org],
    queryFn: () =>
      apiFetch<PublicTenant>(
        `/api/portal/auth-ext/org/${encodeURIComponent(org ?? "")}`,
      ),
    enabled: Boolean(org),
    retry: false,
  });

  if (loading) return <AuthSpinner />;
  if (user) return <Navigate to={next} replace />;

  const known = tenant.data?.tenant;
  const showPassword = usePassword || !org;

  return (
    <AuthShell
      title={known ? known.name : "Portal do cliente"}
      subtitle="Entre para acessar seus dados"
    >
      <div className="grid gap-4">
        {showPassword ? (
          <PasswordForm org={org} next={next} />
        ) : (
          <MagicLinkForm org={org ?? ""} />
        )}

        {!org ? (
          <p className="text-center text-sm text-muted-foreground">
            Sem senha? Use o link enviado pela empresa.
          </p>
        ) : (
          <button
            type="button"
            className={`text-center text-sm ${authLinkClassName}`}
            onClick={() => setUsePassword((value) => !value)}
          >
            {usePassword ? "Entrar com link por e-mail" : "Entrar com senha"}
          </button>
        )}

        {known?.selfSignup && org ? (
          <p className="text-center text-sm text-muted-foreground">
            Primeiro acesso?{" "}
            <Link
              to={`/portal/cadastro?org=${encodeURIComponent(org)}`}
              className={authLinkClassName}
            >
              Criar cadastro
            </Link>
          </p>
        ) : null}
      </div>
    </AuthShell>
  );
}
