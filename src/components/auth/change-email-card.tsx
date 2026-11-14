import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
import { type EmailOnlyInput, emailOnlySchema } from "@/lib/schemas/auth";
import { useAuth } from "@/providers/auth-provider";

/**
 * Pede a troca do e-mail. A resposta é sempre sucesso, inclusive para endereço já
 * usado: nada muda até aprovar no e-mail atual e confirmar no novo.
 */
export function ChangeEmailCard() {
  const { user } = useAuth();
  const [requested, setRequested] = useState(false);
  const form = useForm<EmailOnlyInput>({
    resolver: zodResolver(emailOnlySchema),
    defaultValues: { email: "" },
    mode: "onChange",
  });

  async function onSubmit({ email }: EmailOnlyInput) {
    const { error } = await authClient.changeEmail({ newEmail: email });

    if (error) {
      toast.error(toAuthActionError(error).message);
      return;
    }

    setRequested(true);
    form.reset();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">E-mail da conta</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          E-mail atual: <span className="break-all text-foreground">{user?.email}</span>
        </p>

        {user?.impersonatedBy ? (
          <p className="text-muted-foreground">
            Durante o acesso de suporte o e-mail não pode ser trocado.
          </p>
        ) : requested ? (
          <p className="text-muted-foreground">
            Enviamos um link ao seu e-mail atual. Aprove a troca por lá; depois,
            confirme no novo endereço.
          </p>
        ) : (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="grid max-w-sm gap-3"
            >
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Novo e-mail</FormLabel>
                    <FormControl>
                      <Input {...field} type="email" autoComplete="email" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="justify-self-start"
                disabled={form.formState.isSubmitting || !form.formState.isValid}
              >
                Trocar e-mail
              </Button>
            </form>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}
