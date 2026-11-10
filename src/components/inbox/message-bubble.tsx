import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  FileText,
  Loader2,
  MapPin,
  Download,
  RotateCcw,
  User,
} from "lucide-react";
import type { ReactNode } from "react";
import { type MessageView, errorText, useInboxMutation } from "@/components/inbox/inbox-api";
import { formatFileSize, formatTime, splitLinks } from "@/components/inbox/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Uma mensagem. Texto é sempre texto (React escapa); só `http(s)` vira link, com
 * `rel="noopener noreferrer"`. Cada tipo tem o próprio renderizador; tipo sem suporte mostra o
 * aviso, nunca o conteúdo cru.
 */

function TextBody({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words">
      {splitLinks(text).map((part, index) =>
        part.kind === "link" ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: partes de um texto fixo, sem reordenar
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:opacity-80"
          >
            {part.value}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: idem
          <span key={index}>{part.value}</span>
        ),
      )}
    </p>
  );
}

/** Estado do envio: relógio, ✓, ✓✓, ✓✓ lida. Só nas mensagens enviadas. */
export function DeliveryStatus({ message }: { message: MessageView }) {
  if (message.direction !== "out" || !message.status) return null;

  switch (message.status) {
    case "queued":
      return <Clock className="size-3" aria-label="Enviando" />;
    case "sent":
      return <Check className="size-3.5" aria-label="Enviada" />;
    case "delivered":
      return <CheckCheck className="size-3.5" aria-label="Entregue" />;
    case "read":
      return <CheckCheck className="size-3.5 text-sky-500" aria-label="Lida" />;
    case "failed":
      return <AlertCircle className="size-3.5 text-destructive" aria-label="Falhou" />;
  }
}

function MediaFrame({ message, children }: { message: MessageView; children: ReactNode }) {
  const media = message.media;
  const { mutate, isPending } = useInboxMutation({
    success: "Baixando de novo.",
    conversationId: message.conversationId,
  });

  if (!media) return null;

  if (media.status === "pending") {
    return (
      <p className="flex items-center gap-2 text-xs opacity-80">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Baixando mídia…
      </p>
    );
  }

  if (media.status === "failed") {
    return (
      <div className="flex flex-col items-start gap-1.5 text-xs">
        <p className="flex items-center gap-1.5">
          <AlertCircle className="size-3.5 text-destructive" aria-hidden />
          Não foi possível baixar a mídia.
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={isPending}
          onClick={() => mutate({ path: `/api/inbox/messages/${message.id}/media/retry`, method: "POST" })}
        >
          <RotateCcw />
          Tentar de novo
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}

function MediaBody({ message }: { message: MessageView }) {
  const media = message.media;

  return (
    <MediaFrame message={message}>
      {media && message.type === "image" ? (
        <a href={media.url} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={media.url}
            alt={media.name ?? "Imagem recebida"}
            loading="lazy"
            className="max-h-72 max-w-full rounded-lg object-contain"
          />
        </a>
      ) : null}
      {media && message.type === "sticker" ? (
        <img src={media.url} alt="Figurinha" loading="lazy" className="size-32 object-contain" />
      ) : null}
      {media && message.type === "video" ? (
        // biome-ignore lint/a11y/useMediaCaption: mídia do contato, sem legenda disponível
        <video src={media.url} controls preload="metadata" className="max-h-72 max-w-full rounded-lg" />
      ) : null}
      {media && message.type === "audio" ? (
        // biome-ignore lint/a11y/useMediaCaption: áudio do contato, sem legenda disponível
        <audio src={media.url} controls preload="none" className="w-64 max-w-full" />
      ) : null}
      {media && message.type === "document" ? (
        <a
          href={media.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-background/60 p-2 text-foreground hover:bg-background"
        >
          <FileText className="size-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{media.name ?? "Documento"}</span>
            <span className="block text-xs text-muted-foreground">{formatFileSize(media.size)}</span>
          </span>
          <Download className="size-4 shrink-0" aria-hidden />
        </a>
      ) : null}
    </MediaFrame>
  );
}

function Body({ message }: { message: MessageView }) {
  const caption = message.text ? <TextBody text={message.text} /> : null;

  switch (message.type) {
    case "text":
    case "template":
    case "interactive":
      return caption ?? <p className="italic opacity-70">Mensagem sem texto.</p>;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return (
        <div className="space-y-1.5">
          <MediaBody message={message} />
          {caption}
        </div>
      );
    case "location":
      return (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5">
            <MapPin className="size-4" aria-hidden />
            Localização
          </p>
          {caption}
        </div>
      );
    case "contacts":
      return (
        <div className="space-y-1">
          <p className="flex items-center gap-1.5">
            <User className="size-4" aria-hidden />
            Contato compartilhado
          </p>
          {caption}
        </div>
      );
    case "unsupported":
      return (
        <p className="italic opacity-70">
          Mensagem não suportada. Abra no WhatsApp do celular para ver.
        </p>
      );
  }
}

type MessageBubbleProps = {
  message: MessageView;
  /** `false` esconde "Reenviar" (sem `inbox:reply`). */
  canReply: boolean;
};

export function MessageBubble({ message, canReply }: MessageBubbleProps) {
  const outgoing = message.direction === "out";
  const retry = useInboxMutation<{ message: MessageView }>({
    silent: true,
    conversationId: message.conversationId,
  });
  const failed = message.status === "failed";
  const label = message.sender?.name ?? (message.senderType === "device" ? "Celular" : null);

  return (
    <div className={cn("flex", outgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] space-y-1 rounded-2xl px-3 py-2 text-sm shadow-xs sm:max-w-[70%]",
          outgoing
            ? "rounded-br-md bg-primary/15 text-foreground dark:bg-primary/25"
            : "rounded-bl-md bg-muted text-foreground",
          failed && "ring-1 ring-destructive/50",
        )}
      >
        {outgoing && label ? (
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
        ) : null}
        {message.replyTo ? (
          <p className="truncate rounded-md border-l-2 border-primary/60 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
            {message.replyTo.preview}
          </p>
        ) : null}
        <Body message={message} />
        <div className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          <DeliveryStatus message={message} />
        </div>
        {failed ? (
          <div className="space-y-1.5 border-t border-destructive/20 pt-1.5 text-xs">
            <p className="text-destructive">
              Falhou
              {message.error?.message ? `: ${message.error.message}` : ""}
              {message.error?.code === "UNKNOWN_RESULT"
                ? ". Confira no celular antes de reenviar: a mensagem pode ter saído."
                : ""}
            </p>
            {retry.isError ? (
              <p className="text-destructive">{errorText(retry.error)}</p>
            ) : null}
            {canReply && message.type === "text" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={retry.isPending}
                onClick={() =>
                  retry.mutate({ path: `/api/inbox/messages/${message.id}/retry`, method: "POST" })
                }
              >
                <RotateCcw />
                Reenviar
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Mensagem que ainda não voltou do servidor: texto e relógio, sem ação. */
export function SendingBubble({ text, createdAt }: { text: string; createdAt: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] space-y-1 rounded-2xl rounded-br-md bg-primary/15 px-3 py-2 text-sm opacity-80 shadow-xs sm:max-w-[70%] dark:bg-primary/25">
        <TextBody text={text} />
        <div className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          <time dateTime={createdAt}>{formatTime(createdAt)}</time>
          <Clock className="size-3" aria-label="Enviando" />
        </div>
      </div>
    </div>
  );
}
