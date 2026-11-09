import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type Control, type FieldPath, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import type { ChannelDialogProps } from "@/components/channels/channel-dialogs";
import { ChannelStatus } from "@/components/channels/channel-status";
import { type Channel, useChannelMutation } from "@/components/channels/channels-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client";
import type { ChannelStatus as Status } from "@/lib/channels/types";
import { createCloudChannelSchema, updateChannelSchema } from "@/lib/schemas/channels";

/**
 * Número oficial (WhatsApp Cloud API). Conectar segue 4 etapas: criar o aplicativo na Meta,
 * adicionar o produto WhatsApp, colar as credenciais e configurar o webhook com o endereço e o
 * token que o servidor gerou. Gerenciar mostra o mesmo formulário (segredo em branco mantém o
 * gravado), o endereço do webhook e o diagnóstico.
 *
 * Token e segredo só sobem: a API nunca os devolve, e os campos nascem vazios.
 */

type Webhook = { url: string; verifyToken: string };
type Check = { id: string; ok: boolean; detail?: string };
type Diagnosis = { checks: Check[]; status: Status };

const STEPS = ["Aplicativo", "WhatsApp", "Credenciais", "Webhook"] as const;

const editSchema = updateChannelSchema.omit({ advancedSettings: true });
type CreateInput = z.input<typeof createCloudChannelSchema>;
type CreateOutput = z.output<typeof createCloudChannelSchema>;
type EditInput = z.input<typeof editSchema>;
type EditOutput = z.output<typeof editSchema>;

const CHECK_LABELS: Record<string, string> = {
  credentials_readable: "Credenciais guardadas e legíveis",
  token_valid: "Token de acesso aceito pela Meta",
  phone_reachable: "Número encontrado na Meta",
  waba_subscribed: "Conta WhatsApp Business assinada no aplicativo",
  webhook_verified: "Endereço de webhook verificado pela Meta",
  last_event_at: "Já chegou algum aviso da Meta",
};

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="font-medium text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Etapas">
      {STEPS.map((label, index) => (
        <li
          key={label}
          aria-current={index === step ? "step" : undefined}
          className={
            index === step
              ? "font-semibold text-foreground"
              : index < step
                ? "text-foreground"
                : "text-muted-foreground"
          }
        >
          {index + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copiado.`);
    } catch {
      toast.error("Não foi possível copiar. Selecione o texto e copie à mão.");
    }
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1.5 text-xs">
          {value}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          <Copy className="size-3.5" aria-hidden />
          Copiar
        </Button>
      </div>
    </div>
  );
}

/** Endereço e token para colar na Meta (WhatsApp → Configuração → Webhook). */
function WebhookCard({ webhook, children }: { webhook: Webhook; children?: ReactNode }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <CopyField label="URL de retorno (Callback URL)" value={webhook.url} />
      <CopyField label="Token de verificação" value={webhook.verifyToken} />
      <p className="text-xs text-muted-foreground">
        Na Meta, abra WhatsApp → Configuração → Webhook, cole os dois valores, clique em
        “Verificar e salvar” e assine o campo <code>messages</code>. Este endereço é só deste
        número.
      </p>
      {children}
    </div>
  );
}

function Diagnostics({ channelId }: { channelId: string }) {
  const diagnose = useChannelMutation<Diagnosis>();
  const result = diagnose.data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={diagnose.isPending}
          onClick={() => diagnose.mutate({ path: `/api/channels/${channelId}/test`, method: "POST" })}
        >
          {diagnose.isPending ? "Conferindo…" : "Diagnosticar"}
        </Button>
        {result ? <ChannelStatus status={result.status} /> : null}
      </div>
      {result ? (
        <ul className="space-y-1.5 text-sm" aria-live="polite">
          {result.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2">
              {check.ok ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              )}
              <span>
                <span className="sr-only">{check.ok ? "Certo: " : "Pendente: "}</span>
                {CHECK_LABELS[check.id] ?? check.id}
                {check.detail ? (
                  <span className="block text-xs text-muted-foreground">
                    {check.id === "last_event_at"
                      ? new Date(check.detail).toLocaleString("pt-BR")
                      : check.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type TextFieldProps<T extends Record<string, unknown>> = {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: string;
  placeholder?: string;
  secret?: boolean;
  numeric?: boolean;
};

function TextField<T extends Record<string, unknown>>({
  control,
  name,
  label,
  description,
  placeholder,
  secret,
  numeric,
}: TextFieldProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              value={typeof field.value === "string" ? field.value : ""}
              type={secret ? "password" : "text"}
              inputMode={numeric ? "numeric" : undefined}
              autoComplete={secret ? "new-password" : "off"}
              spellCheck={false}
              // O `FormControl` do projeto põe o id no invólucro: o nome acessível vai aqui.
              aria-label={label}
              placeholder={placeholder}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

const PIN_HELP = "Só se o número ainda não foi registrado na Cloud API (PIN de duas etapas, 6 números).";

/** Etapas 1 a 4 de quem conecta um número novo. */
function ConnectFlow({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [created, setCreated] = useState<{ channel: Channel; webhook: Webhook } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const save = useChannelMutation<{ channel: Channel; webhook: Webhook }>(undefined, {
    silent: true,
  });
  const form = useForm<CreateInput, unknown, CreateOutput>({
    resolver: zodResolver(createCloudChannelSchema),
    defaultValues: {
      name: "",
      phoneNumberId: "",
      wabaId: "",
      accessToken: "",
      appSecret: "",
      appId: "",
      pin: "",
    },
  });

  async function onSubmit(values: CreateOutput) {
    setFailure(null);
    try {
      const result = await save.mutateAsync({
        path: "/api/channels/whatsapp-cloud",
        method: "POST",
        body: values,
      });
      setCreated(result);
      setStep(3);
      toast.success("Número conectado. Falta configurar o webhook na Meta.");
    } catch (error) {
      // Recusa da Meta, limite do plano, número em uso: fica junto do formulário.
      setFailure(error instanceof Error ? error.message : "Não foi possível salvar.");
    }
  }

  return (
    <div className="space-y-4">
      <Stepper step={step} />

      {step === 0 ? (
        <div className="space-y-2 text-sm">
          <p>
            Em{" "}
            <ExternalLink href="https://developers.facebook.com/apps">
              developers.facebook.com
            </ExternalLink>
            , crie um aplicativo do tipo <strong>Empresa</strong>, ligado ao portfólio
            empresarial da sua empresa.
          </p>
          <p className="text-muted-foreground">
            Se você já tem um aplicativo com WhatsApp, pode reaproveitá-lo: vários números do
            mesmo aplicativo funcionam aqui.
          </p>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-2 text-sm">
          <p>
            No aplicativo, adicione o produto <strong>WhatsApp</strong> e ligue a sua conta
            WhatsApp Business (WABA) com o número que vai atender.
          </p>
          <p className="text-muted-foreground">
            Gere um <strong>token permanente</strong> de um usuário do sistema, com as permissões{" "}
            <code>whatsapp_business_messaging</code> e <code>whatsapp_business_management</code>.
            O token temporário da tela de testes vence em 24 horas.
          </p>
        </div>
      ) : null}

      {step === 2 ? (
        <Form {...form}>
          <form id="cloud-channel-form" onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            <TextField
              control={form.control}
              name="name"
              label="Nome do número aqui"
              placeholder="Ex.: Atendimento"
            />
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="phoneNumberId"
                label="Identificador do número"
                description="Phone number ID, em WhatsApp → Configuração da API."
                numeric
              />
              <TextField
                control={form.control}
                name="wabaId"
                label="Identificador da conta (WABA)"
                description="WhatsApp Business Account ID."
                numeric
              />
            </div>
            <TextField
              control={form.control}
              name="accessToken"
              label="Token de acesso permanente"
              secret
            />
            <TextField
              control={form.control}
              name="appSecret"
              label="Segredo do aplicativo"
              description="Em Configurações do app → Básico. Confere a assinatura de cada aviso da Meta."
              secret
            />
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="appId"
                label="Identificador do aplicativo (opcional)"
                numeric
              />
              <TextField control={form.control} name="pin" label="PIN (opcional)" description={PIN_HELP} numeric secret />
            </div>
            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
          </form>
        </Form>
      ) : null}

      {step === 3 && created ? (
        <div className="space-y-4">
          <WebhookCard webhook={created.webhook} />
          <Diagnostics channelId={created.channel.id} />
        </div>
      ) : null}

      <DialogFooter>
        {step > 0 && step < 3 ? (
          <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
            Voltar
          </Button>
        ) : null}
        {step < 2 ? (
          <Button type="button" onClick={() => setStep(step + 1)}>
            Continuar
          </Button>
        ) : null}
        {step === 2 ? (
          <Button type="submit" form="cloud-channel-form" disabled={save.isPending}>
            {save.isPending ? "Conferindo na Meta…" : "Salvar e continuar"}
          </Button>
        ) : null}
        {step === 3 ? (
          <Button type="button" onClick={onClose}>
            Concluir
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}

/** Número já conectado: editar, ver o endereço do webhook e diagnosticar. */
function ManageView({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [rotated, setRotated] = useState<Webhook | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const save = useChannelMutation("Número atualizado.", { silent: true });
  const rotate = useChannelMutation<Webhook>("Novo endereço gerado. Atualize o webhook na Meta.");
  const webhook = useQuery({
    queryKey: ["channel-webhook", channel.id],
    queryFn: () => apiFetch<Webhook>(`/api/channels/${channel.id}/webhook`),
    retry: false,
    // Tem o token de verificação: não fica guardado depois de fechar.
    gcTime: 0,
  });
  const form = useForm<EditInput, unknown, EditOutput>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: channel.name,
      wabaId: channel.wabaId ?? "",
      appId: channel.appId ?? "",
      accessToken: "",
      appSecret: "",
      pin: "",
    },
  });

  async function onSubmit(values: EditOutput) {
    setFailure(null);
    try {
      await save.mutateAsync({ path: `/api/channels/${channel.id}`, method: "PATCH", body: values });
      form.reset({ ...form.getValues(), accessToken: "", appSecret: "", pin: "" });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Não foi possível salvar.");
    }
  }

  async function rotateNow() {
    const next = await rotate
      .mutateAsync({ path: `/api/channels/${channel.id}/webhook/rotate`, method: "POST" })
      .catch(() => null);
    setConfirmingRotate(false);
    if (next) setRotated(next);
  }

  const current = rotated ?? webhook.data;

  return (
    <div className="space-y-5">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <TextField control={form.control} name="name" label="Nome do número aqui" />
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <TextField control={form.control} name="wabaId" label="Identificador da conta (WABA)" numeric />
            <TextField
              control={form.control}
              name="appId"
              label="Identificador do aplicativo (opcional)"
              numeric
            />
          </div>
          <TextField
            control={form.control}
            name="accessToken"
            label="Token de acesso"
            description={
              channel.accessTokenHint
                ? `Gravado: termina em ${channel.accessTokenHint}. Deixe em branco para manter.`
                : "Deixe em branco para manter o que está gravado."
            }
            secret
          />
          <TextField
            control={form.control}
            name="appSecret"
            label="Segredo do aplicativo"
            description="Deixe em branco para manter o que está gravado."
            secret
          />
          <TextField control={form.control} name="pin" label="PIN (opcional)" description={PIN_HELP} numeric secret />
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? "Salvando…" : "Salvar alterações"}
            </Button>
          </div>
        </form>
      </Form>

      <section className="space-y-2" aria-labelledby="cloud-webhook-title">
        <h3 id="cloud-webhook-title" className="text-sm font-semibold">
          Webhook
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {channel.webhookVerifiedAt && !rotated ? "verificado pela Meta" : "ainda não verificado"}
          </span>
        </h3>
        {current ? (
          <WebhookCard webhook={current}>
            {confirmingRotate ? (
              <div className="space-y-2 text-xs">
                <p className="text-destructive">
                  O endereço atual para de funcionar na hora. Os avisos só voltam depois de você
                  colar o novo endereço e o novo token na Meta.
                </p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="destructive" disabled={rotate.isPending} onClick={rotateNow}>
                    Gerar novo endereço
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setConfirmingRotate(false)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingRotate(true)}>
                Gerar novo endereço…
              </Button>
            )}
          </WebhookCard>
        ) : webhook.isError ? (
          <p className="text-sm text-destructive">{webhook.error.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Carregando o endereço…</p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="cloud-diagnostics-title">
        <h3 id="cloud-diagnostics-title" className="text-sm font-semibold">
          Diagnóstico
        </h3>
        <Diagnostics channelId={channel.id} />
      </section>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Fechar
        </Button>
      </DialogFooter>
    </div>
  );
}

export function CloudChannelDialog({ open, channel, onClose }: ChannelDialogProps) {
  // Cada abertura começa do zero: nenhum segredo digitado sobra de uma vez para a outra.
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (open) setSession((value) => value + 1);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{channel ? channel.name : "Conectar número oficial"}</DialogTitle>
          <DialogDescription>
            {channel
              ? `WhatsApp oficial${channel.identifier ? ` · ${channel.identifier}` : ""}`
              : "WhatsApp Cloud API, com as credenciais do seu aplicativo da Meta."}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          channel ? (
            <ManageView key={`${channel.id}-${session}`} channel={channel} onClose={onClose} />
          ) : (
            <ConnectFlow key={session} onClose={onClose} />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
