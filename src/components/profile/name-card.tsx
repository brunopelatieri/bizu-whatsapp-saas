import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
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
import { ApiError, apiFetch } from "@/lib/api/client";
import { type ProfileNameInput, profileNameSchema } from "@/lib/schemas/profile";
import { useAuth } from "@/providers/auth-provider";

/** Nome da conta (`PATCH /api/me`, 2 a 120 caracteres). */
export function NameCard() {
  const { user, refresh } = useAuth();
  const readOnly = Boolean(user?.impersonatedBy);
  const form = useForm<ProfileNameInput>({
    resolver: zodResolver(profileNameSchema),
    defaultValues: { name: user?.name ?? "" },
    mode: "onChange",
  });
  const { reset } = form;

  // O nome relido (outra aba, depois de salvar) entra no campo sem sobrescrever o que se digita.
  useEffect(() => {
    if (user?.name) reset({ name: user.name }, { keepDirtyValues: true });
  }, [user?.name, reset]);

  async function onSubmit(values: ProfileNameInput) {
    try {
      await apiFetch("/api/me", { method: "PATCH", body: JSON.stringify(values) });
      await refresh();
      reset({ name: values.name.trim() });
      toast.success("Nome atualizado.");
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.code === "IMPERSONATION_BLOCKED"
          ? "Durante o acesso de suporte não é possível trocar o nome."
          : error instanceof Error
            ? error.message
            : "Não foi possível salvar o nome.",
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Nome</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid max-w-sm gap-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Seu nome</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="name" disabled={readOnly} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {readOnly ? (
              <p className="text-sm text-muted-foreground">
                Durante o acesso de suporte o nome não pode ser alterado.
              </p>
            ) : (
              <Button
                type="submit"
                className="w-fit"
                disabled={
                  form.formState.isSubmitting || !form.formState.isValid || !form.formState.isDirty
                }
              >
                Salvar o nome
              </Button>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
