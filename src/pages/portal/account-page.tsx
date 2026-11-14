import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { PortalPhoneChange } from "@/components/portal/portal-phone-change";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";
import { AccountDeletionCard } from "@/components/privacy/account-deletion-card";
import { ConfirmDeletionCard } from "@/components/privacy/confirm-deletion-card";
import { ExportCard } from "@/components/privacy/export-card";
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
import { displayPhone } from "@/lib/phone/br";
import { PhoneField, toPhoneFieldValue } from "@/components/ui/phone-field";
import { ApiError, apiFetch } from "@/lib/api/client";
import { passwordChecklist } from "@/lib/auth/password-checklist";
import { portalClient } from "@/lib/auth/portal-client";
import {
  type PortalProfileInput,
  type PortalProfileValues,
  portalProfileSchema,
  type SetPasswordInput,
  setPasswordSchema,
} from "@/lib/schemas/portal";
import { usePortalAuth } from "@/providers/portal-auth-provider";

/**
 * O número da ficha da organização ativa (`GET /api/portal/customer`). É com ele que o servidor
 * compara o `phone` do `PATCH /api/portal/me`: a conta global tem um número só, e as fichas podem
 * ter outros (várias organizações, ou uma troca confirmada pela equipe). Mandar o da conta abriria
 * uma troca que ninguém pediu.
 */
function useFichaPhone() {
  const { active } = usePortalAuth();
  const query = useQuery({
    queryKey: ["portal-customer", active?.id],
    queryFn: () =>
      apiFetch<{ customer: { phone: string | null } }>("/api/portal/customer"),
    retry: false,
  });

  return { pending: query.isPending, phone: query.data?.customer.phone ?? null };
}

function ProfileCard() {
  const ficha = useFichaPhone();

  // O formulário só nasce com o número da ficha em mãos (os valores iniciais não se refazem).
  if (ficha.pending) return null;

  return <ProfileForm fichaPhone={ficha.phone} />;
}

function ProfileForm({ fichaPhone }: { fichaPhone: string | null }) {
  const { user, refresh } = usePortalAuth();
  const form = useForm<PortalProfileValues, unknown, PortalProfileInput>({
    resolver: zodResolver(portalProfileSchema),
    defaultValues: {
      name: user?.name ?? "",
      phone: fichaPhone ?? toPhoneFieldValue(user?.phoneNormalized),
    },
    mode: "onChange",
  });

  async function onSubmit(values: PortalProfileInput) {
    try {
      await apiFetch("/api/portal/me", { method: "PATCH", body: JSON.stringify(values) });
      await refresh();
      toast.success("Dados atualizados.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Não foi possível salvar.",
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Perfil</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid max-w-md gap-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nome</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* O número tem cartão próprio (a troca pelo pedido). Sem número gravado (conta antiga),
                o campo continua aqui, porque o `PATCH` o exige. */}
            {fichaPhone || user?.phoneNormalized ? null : (
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Telefone / WhatsApp *</FormLabel>
                    <FormControl>
                      <PhoneField
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <p className="text-sm text-muted-foreground">
              E-mail: <span className="break-all">{user?.email}</span>
            </p>
            <Button
              type="submit"
              className="w-fit"
              disabled={form.formState.isSubmitting || !form.formState.isValid}
            >
              Salvar
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function PhoneCard() {
  const { user, active, refresh } = usePortalAuth();
  const ficha = useFichaPhone();
  // O número que vale é o da ficha desta organização (a troca age sobre ela).
  const current = displayPhone(ficha.phone) ?? displayPhone(user?.phoneNormalized ? `+${user.phoneNormalized}` : null);

  // Sem número gravado, o campo do perfil acima cadastra o primeiro.
  if (ficha.pending || !current) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Telefone (WhatsApp)</CardTitle>
      </CardHeader>
      <CardContent>
        <PortalPhoneChange
          current={current}
          activeTenantId={active?.id}
          onChanged={refresh}
        />
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const { user, refresh } = usePortalAuth();
  const [needsCurrent, setNeedsCurrent] = useState(false);
  const form = useForm<SetPasswordInput>({
    resolver: zodResolver(setPasswordSchema),
    defaultValues: { newPassword: "" },
    mode: "onChange",
  });

  async function onSubmit({ newPassword, currentPassword }: SetPasswordInput) {
    try {
      await apiFetch("/api/portal/auth-ext/set-password", {
        method: "POST",
        body: JSON.stringify({
          newPassword,
          currentPassword: currentPassword || undefined,
        }),
      });
      form.reset({ newPassword: "" });
      setNeedsCurrent(false);
      await refresh();
      toast.success("Senha salva. Outras sessões foram encerradas.");
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "CURRENT_PASSWORD_REQUIRED"
      ) {
        setNeedsCurrent(true);
      }

      toast.error(
        error instanceof Error ? error.message : "Não foi possível salvar.",
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {user?.hasPassword ? "Trocar senha" : "Definir senha"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {user?.hasPassword
            ? "Esqueceu a senha? Entre por um link no e-mail e troque aqui, sem informar a atual."
            : "Opcional: com uma senha, você entra sem depender do link no e-mail."}
        </p>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid max-w-md gap-4"
          >
            {needsCurrent ? (
              <FormField
                control={form.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Senha atual</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ""}
                        type="password"
                        autoComplete="current-password"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
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
              Salvar senha
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["portal-sessions"],
    queryFn: async () => {
      const { data, error } = await portalClient.listSessions();
      if (error) throw new Error("Não foi possível carregar as sessões.");
      return data;
    },
    retry: false,
  });
  const revokeOthers = useMutation({
    mutationFn: async () => {
      const { error } = await portalClient.revokeOtherSessions();
      if (error) throw new Error("Não foi possível encerrar as sessões.");
    },
    onSuccess: async () => {
      toast.success("Outras sessões encerradas.");
      await queryClient.invalidateQueries({ queryKey: ["portal-sessions"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sessões</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <QueryState {...query}>
          <ul className="space-y-2 text-sm">
            {query.data?.map((session) => (
              <li key={session.id} className="flex justify-between gap-3">
                <span className="truncate text-muted-foreground">
                  {session.userAgent ?? "Navegador desconhecido"}
                </span>
                <span className="shrink-0 text-foreground">
                  {new Date(session.createdAt).toLocaleDateString("pt-BR")}
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
        <Button
          variant="outline"
          size="sm"
          disabled={revokeOthers.isPending}
          onClick={() => revokeOthers.mutate()}
        >
          Encerrar outras sessões
        </Button>
      </CardContent>
    </Card>
  );
}

export function PortalAccountPage() {
  const { user } = usePortalAuth();
  const [params, setParams] = useSearchParams();
  const token = params.get("confirmar-exclusao");

  return (
    <div className="space-y-6">
      <PageTitle
        title="Minha conta"
        description="Perfil, senha, sessões e privacidade."
      />
      {token ? (
        <ConfirmDeletionCard
          token={token}
          onDone={() => {
            params.delete("confirmar-exclusao");
            setParams(params, { replace: true });
          }}
        />
      ) : null}
      <ProfileCard />
      <PhoneCard />
      <PasswordCard />
      <SessionsCard />
      <ExportCard endpoint="/api/portal/me/export" />
      <AccountDeletionCard
        statusUrl="/api/portal/me/deletion"
        deleteUrl="/api/portal/me"
        cancelUrl="/api/portal/me/deletion/cancel"
        needsPassword={user?.hasPassword ?? false}
      />
    </div>
  );
}
