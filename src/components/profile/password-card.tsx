import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password-policy";
import { signupSchema } from "@/lib/schemas/auth";
import { useAuth } from "@/providers/auth-provider";

/**
 * Troca de senha da própria conta (`POST /api/auth/change-password`, do Better Auth): pede a
 * senha atual, segue a política do bloco S (o medidor só orienta; o servidor repete a regra) e
 * encerra as outras sessões (`revokeOtherSessions`). A sessão personificada não troca senha.
 */
const passwordFormSchema = z.object({
  currentPassword: z.string().min(1, "Informe a senha atual.").max(PASSWORD_MAX_LENGTH),
  newPassword: signupSchema.shape.password,
});
type PasswordFormInput = z.input<typeof passwordFormSchema>;
type PasswordFormOutput = z.output<typeof passwordFormSchema>;

export function PasswordCard() {
  const { user } = useAuth();
  const readOnly = Boolean(user?.impersonatedBy);
  const form = useForm<PasswordFormInput, unknown, PasswordFormOutput>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { currentPassword: "", newPassword: "" },
    mode: "onChange",
  });

  async function onSubmit({ currentPassword, newPassword }: PasswordFormOutput) {
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });

    if (error) {
      const known = toAuthActionError(error);
      // Aqui a senha errada é a atual: o texto do login ("e-mail ou senha") não serve.
      toast.error(known.code === "INVALID_PASSWORD" ? "A senha atual está incorreta." : known.message);
      return;
    }

    form.reset({ currentPassword: "", newPassword: "" });
    toast.success("Senha trocada. As outras sessões foram encerradas.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Senha</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Ao trocar a senha, as outras sessões abertas desta conta são encerradas; esta continua.
        </p>
        {readOnly ? (
          <p className="text-sm text-muted-foreground">
            Durante o acesso de suporte a senha não pode ser trocada.
          </p>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="grid max-w-sm gap-4">
              <FormField
                control={form.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Senha atual</FormLabel>
                    <FormControl>
                      <Input {...field} type="password" autoComplete="current-password" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nova senha</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="password"
                        autoComplete="new-password"
                        placeholder="Crie uma senha forte"
                      />
                    </FormControl>
                    <PasswordStrengthMeter password={field.value} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-fit"
                disabled={
                  form.formState.isSubmitting ||
                  !form.formState.isValid ||
                  !passwordChecklist(form.watch("newPassword")).valid
                }
              >
                Trocar a senha
              </Button>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
