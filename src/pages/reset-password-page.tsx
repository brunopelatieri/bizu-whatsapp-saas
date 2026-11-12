import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  AuthShell,
  authInputClassName,
  authLabelClassName,
  authLinkClassName,
  authSubmitClassName,
} from "@/components/auth/auth-shell";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";
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
import { authClient, toAuthActionError } from "@/lib/auth/client";
import { passwordChecklist } from "@/lib/auth/password-checklist";
import { type ResetPasswordInput, resetPasswordSchema } from "@/lib/schemas/auth";

/** Só renderiza no GET: o token é consumido pelo envio do formulário. */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
    mode: "onChange",
  });

  async function onSubmit({ password }: ResetPasswordInput) {
    if (!token) return;

    const { error } = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    if (error) {
      toast.error(toAuthActionError(error).message);
      return;
    }

    toast.success("Senha alterada. Entre com a nova senha.");
    navigate("/login", { replace: true });
  }

  if (!token) {
    return (
      <AuthShell title="Redefinir senha" subtitle="Link inválido ou expirado">
        <p className="text-center text-sm">
          <Link to="/esqueci-senha" className={authLinkClassName}>
            Pedir um novo link
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Redefinir senha" subtitle="Escolha uma nova senha">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="grid w-full grid-cols-1 gap-4"
        >
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem className="w-full">
                <FormLabel className={authLabelClassName}>Nova senha</FormLabel>
                <FormControl className="w-full">
                  <Input
                    {...field}
                    type="password"
                    autoComplete="new-password"
                    placeholder="Crie uma senha forte"
                    className={authInputClassName}
                  />
                </FormControl>
                <PasswordStrengthMeter password={field.value} />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="confirmPassword"
            render={({ field }) => (
              <FormItem className="w-full">
                <FormLabel className={authLabelClassName}>
                  Repita a senha
                </FormLabel>
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
          <Button
            type="submit"
            size="lg"
            className={authSubmitClassName}
            disabled={
              form.formState.isSubmitting ||
              !form.formState.isValid ||
              !passwordChecklist(form.watch("password")).valid ||
              form.watch("password") !== form.watch("confirmPassword")
            }
          >
            {form.formState.isSubmitting ? (
              <Loader2 className="animate-spin" />
            ) : null}
            Salvar nova senha
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
