import { ArrowRightLeft, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ChannelBadge } from "@/components/channels/channel-badge";
import {
  errorText,
  newClientId,
  useContinueOnChannel,
  useTransferChannels,
} from "@/components/inbox/inbox-api";
import { useInboxCan, useInboxScope } from "@/components/inbox/inbox-scope";
import { TRANSFER_REFUSAL_TEXT, transferEntry } from "@/components/inbox/transfer-entry";
import { useInboxPath } from "@/components/inbox/use-inbox-path";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TransferOption } from "@/lib/inbox/transfer";
import { MESSAGE_TEXT_MAX } from "@/lib/schemas/inbox";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth-provider";

/**
 * "Continuar por outro número" (X2): o botão e o diálogo. A conversa com o mesmo contato segue por outro
 * número do escopo; o diálogo mostra o **nome do número** de saída e pede só o texto (anexo, modelo e
 * citação ficam para o composer da conversa de destino). Quais números servem, e por quê não, vem do
 * servidor (`useTransferChannels`); a tela só mostra e o envio é revalidado lá. Serve aos dois escopos.
 */

type ContinueOnChannelButtonProps = {
  conversationId: string;
  variant?: "default" | "outline";
  className?: string;
};

export function ContinueOnChannelButton({
  conversationId,
  variant = "outline",
  className,
}: ContinueOnChannelButtonProps) {
  const can = useInboxCan();
  const inbox = useInboxScope();
  const { user, billing } = useAuth();
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  // As mesmas travas do composer; o servidor confere todas de novo.
  const allowed =
    can("inbox", "reply") &&
    !user?.impersonatedBy &&
    !(inbox.mode === "tenant" && billing?.state === "read_only");
  const options = useTransferChannels(conversationId, allowed);
  const entry = allowed ? transferEntry(options.data) : ({ kind: "hidden" } as const);

  // O diálogo aberto segue aberto mesmo que uma releitura esvazie a lista (ele mostra o estado).
  if (entry.kind === "hidden" && !open) return null;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={variant}
        className={className}
        disabled={entry.kind !== "enabled"}
        aria-describedby={entry.kind === "disabled" ? reasonId : undefined}
        onClick={() => setOpen(true)}
      >
        <ArrowRightLeft />
        Continuar por outro número
      </Button>
      {entry.kind === "disabled" ? (
        <p id={reasonId} className="w-full text-xs text-muted-foreground">
          {entry.reason}
        </p>
      ) : null}
      <ContinueDialog
        open={open}
        onClose={() => setOpen(false)}
        conversationId={conversationId}
        options={options.data ?? []}
      />
    </>
  );
}

type ContinueDialogProps = {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  options: TransferOption[];
};

function ContinueDialog({ open, onClose, conversationId, options }: ContinueDialogProps) {
  const navigate = useNavigate();
  const pathOf = useInboxPath();
  const send = useContinueOnChannel(conversationId);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Tentar de novo o MESMO envio reaproveita o id (o servidor não manda duas vezes); outro número ou
  // outro texto levam id novo.
  const attempt = useRef<{ key: string; clientId: string } | null>(null);

  const eligible = options.filter((option) => option.eligible);
  // Com um só número que serve, ele já vem escolhido.
  const only = eligible.length === 1 ? eligible[0] : undefined;
  const selected = eligible.find((option) => option.channel.id === (channelId ?? only?.channel.id));
  const value = text.trim();
  const sending = send.isPending;

  // Cada abertura começa do zero.
  useEffect(() => {
    if (!open) return;
    setChannelId(null);
    setText("");
    setError(null);
    attempt.current = null;
  }, [open]);

  async function submit() {
    if (!selected || !value || sending) return;
    const key = `${selected.channel.id}:${value}`;
    const clientId = attempt.current?.key === key ? attempt.current.clientId : newClientId();
    attempt.current = { key, clientId };
    setError(null);

    try {
      const result = await send.mutateAsync({ channelId: selected.channel.id, text: value, clientId });
      if (result.message.status === "failed") {
        toast.error("A mensagem não foi enviada. Veja o motivo na conversa e tente de novo por lá.");
      }
      onClose();
      navigate(pathOf(result.conversationId, selected.channel.id));
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !sending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Continuar por outro número</DialogTitle>
          <DialogDescription>
            O contato vai receber de outro número, e a conversa continua por lá.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">Número de saída</legend>
            {options.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum outro número disponível agora.</p>
            ) : (
              <div className="grid max-h-44 gap-1.5 overflow-y-auto pr-1">
                {options.map((option) => (
                  <label
                    key={option.channel.id}
                    className={cn(
                      "cursor-pointer rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted",
                      "has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      !option.eligible && "cursor-not-allowed opacity-60 hover:bg-transparent",
                    )}
                  >
                    <input
                      type="radio"
                      name="transfer-channel"
                      className="sr-only"
                      checked={option.channel.id === selected?.channel.id}
                      disabled={sending || !option.eligible}
                      onChange={() => {
                        setChannelId(option.channel.id);
                        setError(null);
                      }}
                    />
                    <ChannelBadge type={option.channel.type} name={option.channel.name} />
                    {option.reason ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {TRANSFER_REFUSAL_TEXT[option.reason]}
                      </span>
                    ) : null}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor="transfer-text">Mensagem</Label>
            <Textarea
              id="transfer-text"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
              maxLength={MESSAGE_TEXT_MAX}
              rows={4}
              disabled={sending}
              placeholder="Escreva a primeira mensagem por este número"
              className="max-h-60 resize-none"
            />
            {selected ? (
              <p className="text-xs text-muted-foreground" data-testid="transfer-outgoing">
                Vai sair pelo número <strong className="font-semibold text-foreground">{selected.channel.name}</strong>.
              </p>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!selected || !value || sending}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              Enviar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
