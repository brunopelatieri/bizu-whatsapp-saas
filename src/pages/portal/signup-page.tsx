import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, MailCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AuthShell,
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
import { PhoneField } from "@/components/ui/phone-field";
import { apiFetch } from "@/lib/api/client";
import { TERMS_VERSION } from "@/lib/legal/versions";
import { type PortalSignupInput, portalSignupSchema } from "@/lib/schemas/portal";

/**
 * Autocadastro. A resposta é a mesma com tenant fechado, e-mail já usado ou cadastro novo:
 * a tela de sucesso não confirma nada.
 */
export function PortalSignupPage() {
  const [searchParams] = useSearchParams();
  const org = searchParams.get("org") ?? "";
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useForm<PortalSignupInput>({
    resolver: zodResolver(portalSignupSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      password: "",
      termsVersion: TERMS_VERSION,
      marketing: false,
      org,
    },
    mode: "onChange",
  });

  async function onSubmit(values: PortalSignupInput) {
    try {
      await apiFetch("/api/portal/auth-ext/sign-up", {
        method: "POST",
        body: JSON.stringify(values),
      });
      setSentTo(values.email);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Não foi possível cadastrar.",
      );
    }
  }

  const login = `/portal/login?org=${encodeURIComponent(org)}`;

  if (sentTo) {
    return (
      <AuthShell title="Portal do cliente" subtitle="Confirme seu e-mail">
        <div className="grid gap-4 text-sm">
          <div className="flex items-start gap-3">
            <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" />
            <p className="text-muted-foreground">
              Se o cadastro estiver aberto, enviamos um link para{" "}
              <span className="break-all">{sentTo}</span>. Ele vale por 1 hora. Sem
              confirmar, o login responde como senha incorreta.
            </p>
          </div>
          <Link to={login} className={authLinkClassName}>
            Já confirmei, entrar
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Portal do cliente" subtitle="Crie seu cadastro">
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
                <Loader2 className="animate-spin" />
              ) : null}
              Criar cadastro
            </Button>
          </form>
        </Form>
        <p className="text-center text-sm text-muted-foreground">
          <Link to={login} className={authLinkClassName}>
            Já tenho acesso
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
