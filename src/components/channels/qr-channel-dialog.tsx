import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneField } from "@/components/ui/phone-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, apiFetch } from "@/lib/api/client";
import {
  CHANNEL_NAME_MAX,
  type ChannelStatusResponse,
  createQrChannelSchema,
  pairChannelSchema,
  type QrResponse,
} from "@/lib/schemas/channels";

/**
 * Conectar um número por QR Code (Evolution Go). Autocontido: cria o canal, mostra o QR ou o
 * código de pareamento, consulta o estado a cada 4 s e fecha sozinho quando o número conecta.
 *
 * Uso na página da lista (`/app/configuracoes/canais`):
 *
 * ```tsx
 * <QrChannelDialog trigger={<Button>Conectar por QR Code</Button>} onChanged={refetch} />
 * // Parear de novo um número que caiu:
 * <QrChannelDialog channel={{ id, name }} open={open} onOpenChange={setOpen} onChanged={refetch} />
 * ```
 *
 * `basePath` troca para `/api/admin/channels` nos números da plataforma (B4).
 */

export type QrChannelDialogProps = {
  /** Canal já criado que vai parear de novo. Sem ele, o diálogo pede o nome e cria. */
  channel?: { id: string; name: string } | null;
  /** Elemento que abre o diálogo (modo não controlado). */
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A lista mudou (canal criado, conectado ou readotado): a página recarrega. */
  onChanged?: () => void;
  basePath?: string;
};

type CreatedChannel = { channel: { id: string; name: string } };

const POLL_MS = 4000;

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "Não foi possível concluir. Tente de novo.";

/** Aviso permanente (RF-08): fica visível em todas as etapas, não some depois de lido. */
function RiskNotice() {
  return (
    <div
      role="note"
      className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-foreground"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
      <p>
        <strong>Conexão não oficial.</strong> O WhatsApp pode restringir ou bloquear números
        conectados por QR Code, sem aviso. Para uso comercial contínuo, prefira a API oficial
        (WhatsApp Cloud).
      </p>
    </div>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;

  return (
    <p role="alert" className="text-xs text-destructive">
      {errorText(error)}
    </p>
  );
}

/** Segundos que faltam para o QR vencer; 0 quando venceu ou ainda não há QR. */
function useCountdown(expiresAt: number | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
}

function QrTab({
  basePath,
  channelId,
  onAlreadyConnected,
}: {
  basePath: string;
  channelId: string;
  onAlreadyConnected: () => void;
}) {
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const remaining = useCountdown(expiresAt);
  const requested = useRef<string | null>(null);

  const qr = useMutation({
    mutationFn: () => apiFetch<QrResponse>(`${basePath}/${channelId}/qr`, { method: "POST" }),
    onSuccess: (data) => {
      if (data.alreadyConnected) {
        onAlreadyConnected();
        return;
      }
      setExpiresAt(Date.now() + data.expiresInSeconds * 1000);
    },
  });
  const { mutate } = qr;

  // Um QR por abertura: gerar custa cerca de 3 s no servidor e reconecta a instância, então
  // nada de laço. Depois disso, só pelo botão "Gerar outro".
  useEffect(() => {
    if (requested.current === channelId) return;

    requested.current = channelId;
    mutate();
  }, [channelId, mutate]);

  const data = qr.data && !qr.data.alreadyConnected ? qr.data : null;
  const expired = Boolean(data) && remaining === 0;

  return (
    <div className="grid justify-items-center gap-3">
      <div className="relative grid size-56 place-items-center rounded-lg border border-border bg-white p-3">
        {qr.isPending ? (
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Gerando QR Code" />
        ) : data?.code ? (
          // O texto do código desenhado aqui: nenhuma imagem externa entra na página.
          <QRCodeSVG value={data.code} size={200} className={expired ? "opacity-20" : undefined} />
        ) : data?.qrcode?.startsWith("data:image/") ? (
          <img
            src={data.qrcode}
            alt="QR Code para conectar o WhatsApp"
            className={expired ? "size-[200px] opacity-20" : "size-[200px]"}
          />
        ) : (
          <p className="px-4 text-center text-xs text-muted-foreground">
            Não foi possível gerar o QR Code.
          </p>
        )}
        {expired ? (
          <p className="absolute inset-0 grid place-items-center text-sm font-medium text-neutral-900">
            QR Code expirado
          </p>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {data && !expired
          ? `Expira em ${remaining} s. No celular: WhatsApp > Aparelhos conectados > Conectar um aparelho.`
          : expired
            ? "Gere outro QR Code para continuar."
            : "Aguarde, o QR Code leva alguns segundos."}
      </p>
      <ErrorLine error={qr.error} />

      <Button variant="outline" size="sm" disabled={qr.isPending} onClick={() => mutate()}>
        <RefreshCw className="size-4" aria-hidden />
        Gerar outro
      </Button>
    </div>
  );
}

function CodeTab({ basePath, channelId }: { basePath: string; channelId: string }) {
  const [phone, setPhone] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);

  const pair = useMutation({
    mutationFn: (digits: string) =>
      apiFetch<{ pairingCode: string }>(`${basePath}/${channelId}/pair`, {
        method: "POST",
        body: JSON.stringify({ phone: digits }),
      }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();

    // O campo entrega E.164 (`+5511...`); a API quer só os dígitos, com o código do país.
    const parsed = pairChannelSchema.safeParse({ phone: phone.replace(/\D/g, "") });
    if (!parsed.success) {
      setInvalid("Informe o número do WhatsApp com DDD.");
      return;
    }

    setInvalid(null);
    pair.mutate(parsed.data.phone);
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="qr-pair-phone">Número do WhatsApp que será conectado</Label>
        <PhoneField
          id="qr-pair-phone"
          value={phone}
          onChange={setPhone}
          invalid={Boolean(invalid)}
          disabled={pair.isPending}
        />
        {invalid ? (
          <p role="alert" className="text-xs text-destructive">
            {invalid}
          </p>
        ) : null}
      </div>

      <Button type="submit" size="sm" disabled={pair.isPending}>
        {pair.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pair.data ? "Gerar outro código" : "Gerar código"}
      </Button>
      <ErrorLine error={pair.error} />

      {pair.data ? (
        <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3 text-center">
          <p className="font-mono text-2xl tracking-[0.3em]">
            <span className="sr-only">Código de pareamento: </span>
            {pair.data.pairingCode}
          </p>
          <p className="text-xs text-muted-foreground">
            No celular: WhatsApp &gt; Aparelhos conectados &gt; Conectar um aparelho &gt; Conectar
            com número de telefone, e digite este código.
          </p>
        </div>
      ) : null}
    </form>
  );
}

function PairStep({
  basePath,
  channelId,
  onConnected,
}: {
  basePath: string;
  channelId: string;
  onConnected: () => void;
}) {
  const done = useRef(false);
  const finish = useCallback(() => {
    if (done.current) return;

    done.current = true;
    onConnected();
  }, [onConnected]);

  const status = useQuery({
    queryKey: ["channel-status", basePath, channelId],
    queryFn: () => apiFetch<ChannelStatusResponse>(`${basePath}/${channelId}/status`),
    refetchInterval: (query) => (query.state.error ? false : POLL_MS),
    refetchIntervalInBackground: false,
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    // 404: o mesmo número voltou para um canal antigo e este deixou de existir (readoção).
    const readopted = status.error instanceof ApiError && status.error.status === 404;

    if (status.data?.status === "connected" || status.data?.readoptedInto || readopted) finish();
  }, [status.data, status.error, finish]);

  return (
    <div className="grid gap-3">
      <Tabs defaultValue="qr">
        <TabsList className="w-full">
          <TabsTrigger value="qr" className="flex-1">
            QR Code
          </TabsTrigger>
          <TabsTrigger value="code" className="flex-1">
            Código
          </TabsTrigger>
        </TabsList>
        <TabsContent value="qr" className="pt-2">
          <QrTab basePath={basePath} channelId={channelId} onAlreadyConnected={finish} />
        </TabsContent>
        <TabsContent value="code" className="pt-2">
          <CodeTab basePath={basePath} channelId={channelId} />
        </TabsContent>
      </Tabs>

      <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {status.data?.status === "error"
          ? (status.data.statusDetail ?? "O servidor recusou a conexão.")
          : "Aguardando a conexão do celular. Esta janela fecha sozinha."}
      </p>
    </div>
  );
}

function NameStep({
  basePath,
  onCreated,
}: {
  basePath: string;
  onCreated: (channel: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (value: string) =>
      apiFetch<CreatedChannel>(`${basePath}/whatsapp-qr`, {
        method: "POST",
        body: JSON.stringify({ name: value }),
      }),
    onSuccess: (data) => onCreated(data.channel),
  });

  function submit(event: FormEvent) {
    event.preventDefault();

    const parsed = createQrChannelSchema.safeParse({ name });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Informe o nome.");
      return;
    }

    setInvalid(null);
    create.mutate(parsed.data.name);
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="qr-channel-name">Nome do número</Label>
        <Input
          id="qr-channel-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={CHANNEL_NAME_MAX}
          placeholder="Ex.: Atendimento"
          autoComplete="off"
          aria-invalid={Boolean(invalid) || undefined}
          disabled={create.isPending}
        />
        {invalid ? (
          <p role="alert" className="text-xs text-destructive">
            {invalid}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">Só para identificar o número na sua lista.</p>
        )}
      </div>

      <ErrorLine error={create.error} />
      <Button type="submit" disabled={create.isPending}>
        {create.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Continuar
      </Button>
    </form>
  );
}

export function QrChannelDialog({
  channel,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onChanged,
  basePath = "/api/channels",
}: QrChannelDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const open = controlledOpen ?? internalOpen;
  const target = channel ?? created;

  const setOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
      // Fechou: a próxima abertura começa do zero. O canal criado e não pareado fica na lista
      // como "conectando", e dali pode ser pareado de novo ou removido.
      if (!next) setCreated(null);
    },
    [onOpenChange],
  );

  const handleConnected = useCallback(() => {
    toast.success("Número conectado.");
    onChanged?.();
    setOpen(false);
  }, [onChanged, setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger render={trigger} /> : null}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target ? `Conectar "${target.name}"` : "Conectar número por QR Code"}
          </DialogTitle>
          <DialogDescription>
            {target
              ? "Leia o QR Code com o celular ou use o código de pareamento."
              : "Dê um nome ao número e, em seguida, leia o QR Code com o celular."}
          </DialogDescription>
        </DialogHeader>

        <RiskNotice />

        {/* Só monta com o diálogo aberto: fechado, nada consulta o estado nem gera QR. */}
        {open && target ? (
          <PairStep
            key={target.id}
            basePath={basePath}
            channelId={target.id}
            onConnected={handleConnected}
          />
        ) : null}
        {open && !target ? (
          <NameStep
            basePath={basePath}
            onCreated={(next) => {
              setCreated(next);
              onChanged?.();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
