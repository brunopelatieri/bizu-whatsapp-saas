import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, MailCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  authInputClassName,
  authLabelClassName,
  authLinkClassName,
  authSubmitClassName,
} from "@/components/auth/auth-shell";
import { ResendVerification } from "@/components/auth/resend-verification";
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
import { PhoneField } from "@/components/ui/phone-field";
import { safeNextPath } from "@/lib/auth/next-path";
import { TERMS_VERSION } from "@/lib/legal/versions";
import {
  type LoginInput,
  loginSchema,
  MIN_PASSWORD_LENGTH,
  type SignupInput,
  signupSchema,
} from "@/lib/schemas/auth";
import { useAuth } from "@/providers/auth-provider";

/** Tela depois do cadastro. A mesma para e-mail novo e existente. */
function CheckEmailNotice({
  email,
  loginPath,
}: {
  email: string;
  loginPath: string;
}) {
  return (
    <div className="grid gap-4 text-sm">
      <div className="flex items-start gap-3">
        <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" />
        <div>
          <p className="font-medium text-white">Confirme seu e-mail</p>
          <p className="mt-1 text-muted-foreground">
            Enviamos um link para <span className="break-all">{email}</span>. Ele
            vale por 1 hora. Sem confirmar, o login responde como senha incorreta.
          </p>
        </div>
      </div>
      <ResendVerification email={email} />
      <p className="text-center text-muted-foreground">
        <Link to={loginPath} className={authLinkClassName}>
          Já confirmei, entrar
        </Link>
      </p>
    </div>
  );
}

/**
 * Sem verificação de e-mail, o cliente entra logo após o cadastro. Se não entrar, o e-mail já
 * tinha conta com outra senha: a mensagem é a mesma de qualquer login recusado.
 */
function SignupLoginFailedNotice({ loginPath }: { loginPath: string }) {
  return (
    <div className="grid gap-4 text-sm">
      <p className="text-muted-foreground">
        Não foi possível entrar com esses dados. Se você já tem conta com este e-mail,
        entre com a sua senha ou redefina-a.
      </p>
      <p className="text-center text-muted-foreground">
        <Link to={loginPath} className={authLinkClassName}>
          Entrar
        </Link>
        {" · "}
        <Link to="/esqueci-senha" className={authLinkClassName}>
          Esqueci a senha
        </Link>
      </p>
    </div>
  );
}

/** Destino depois do cadastro que entra direto: o `?next=` do link de login, se houver. */
function nextFromLoginPath(loginPath: string) {
  const query = loginPath.split("?")[1] ?? "";
  return safeNextPath(new URLSearchParams(query).get("next"));
}

export function LoginForm({ nextPath }: { nextPath: string }) {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [resendOpen, setResendOpen] = useState(false);
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
    mode: "onChange",
  });

  async function onSubmit(values: LoginInput) {
    try {
      const { twoFactor } = await signIn(values);

      navigate(
        twoFactor ? `/2fa?next=${encodeURIComponent(nextPath)}` : nextPath,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao entrar. Tente novamente.",
      );
    }
  }

  return (
    <div className="grid w-full gap-4">
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
                    placeholder="voce@empresa.com"
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
              <>
                <Loader2 className="animate-spin" />
                Entrando...
              </>
            ) : (
              "Entrar"
            )}
          </Button>
        </form>
      </Form>

      <div className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
        <Link to="/esqueci-senha" className={authLinkClassName}>
          Esqueci minha senha
        </Link>
        <Link to="/cadastro" className={authLinkClassName}>
          Criar conta
        </Link>
      </div>

      {/* Fixo: o login responde igual para senha errada e conta não confirmada. */}
      <div className="grid gap-3 text-center text-sm">
        <button
          type="button"
          aria-expanded={resendOpen}
          className={authLinkClassName}
          onClick={() => setResendOpen((open) => !open)}
        >
          Não recebeu o link de confirmação?
        </button>
        {resendOpen ? (
          <ResendVerification initialEmail={form.getValues("email")} />
        ) : null}
      </div>
    </div>
  );
}

type SignupFormProps = {
  /** Cadastro por convite: o e-mail é o do convite. */
  lockedEmail?: string;
  loginPath?: string;
};

export function SignupForm({
  lockedEmail,
  loginPath = "/login",
}: SignupFormProps) {
  const navigate = useNavigate();
  const { signUp, signIn } = useAuth();
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [loginFailed, setLoginFailed] = useState(false);
  const form = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      name: "",
      email: lockedEmail ?? "",
      phone: "",
      password: "",
      termsVersion: TERMS_VERSION,
      marketing: false,
    },
    mode: "onChange",
  });

  async function onSubmit(values: SignupInput) {
    try {
      const { verifyEmail } = await signUp(values);

      if (verifyEmail) {
        setSubmittedEmail(values.email);
        return;
      }

      try {
        await signIn({ email: values.email, password: values.password });
      } catch {
        setLoginFailed(true);
        return;
      }
      navigate(nextFromLoginPath(loginPath));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Falha ao criar conta. Tente novamente.",
      );
    }
  }

  if (submittedEmail) {
    return <CheckEmailNotice email={submittedEmail} loginPath={loginPath} />;
  }
  if (loginFailed) return <SignupLoginFailedNotice loginPath={loginPath} />;

  return (
    <div className="grid w-full gap-4">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="grid w-full grid-cols-1 gap-4"
        >
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem className="w-full">
                <FormLabel className={authLabelClassName}>Nome</FormLabel>
                <FormControl className="w-full">
                  <Input
                    {...field}
                    autoComplete="name"
                    placeholder="Seu nome completo"
                    className={authInputClassName}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

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
                    placeholder="voce@empresa.com"
                    readOnly={Boolean(lockedEmail)}
                    className={authInputClassName}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem className="w-full">
                <FormLabel className={authLabelClassName}>Telefone / WhatsApp *</FormLabel>
                <FormControl className="w-full">
                  <PhoneField
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    name={field.name}
                    inputClassName={authInputClassName}
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
                    autoComplete="new-password"
                    placeholder={`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres`}
                    className={authInputClassName}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="acceptTerms"
            render={({ field }) => (
              <FormItem className="w-full">
                <label className="flex items-start gap-2 text-sm text-muted-foreground">
                  <input
                    ref={field.ref}
                    name={field.name}
                    onBlur={field.onBlur}
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={field.value === true}
                    onChange={(event) => field.onChange(event.target.checked)}
                  />
                  <span>
                    Li e aceito os{" "}
                    <a
                      href="/legal/termos"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline"
                    >
                      termos de uso
                    </a>{" "}
                    e a{" "}
                    <a
                      href="/legal/privacidade"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline"
                    >
                      política de privacidade
                    </a>
                    .
                  </span>
                </label>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="marketing"
            render={({ field }) => (
              <FormItem className="w-full">
                <label className="flex items-start gap-2 text-sm text-muted-foreground">
                  <input
                    ref={field.ref}
                    name={field.name}
                    onBlur={field.onBlur}
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={field.value === true}
                    onChange={(event) => field.onChange(event.target.checked)}
                  />
                  <span>Quero receber novidades por e-mail (opcional).</span>
                </label>
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
              <>
                <Loader2 className="animate-spin" />
                Criando conta...
              </>
            ) : (
              "Criar conta"
            )}
          </Button>
        </form>
      </Form>

      <p className="text-center text-sm text-muted-foreground">
        Já tem conta?{" "}
        <Link to={loginPath} className={authLinkClassName}>
          Entrar
        </Link>
      </p>
    </div>
  );
}
