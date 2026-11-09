import { Badge } from "@/components/ui/badge";
import type { ChannelStatus as Status } from "@/lib/channels/types";
import { cn } from "@/lib/utils";

const STATUS: Record<Status, { label: string; dot: string }> = {
  connected: { label: "Conectado", dot: "bg-emerald-500" },
  connecting: { label: "Conectando", dot: "bg-amber-500" },
  disconnected: { label: "Desconectado", dot: "bg-muted-foreground" },
  error: { label: "Com erro", dot: "bg-destructive" },
  disabled: { label: "Desativado", dot: "bg-muted-foreground/50" },
};

type ChannelStatusProps = {
  status: Status;
  /** Motivo do erro ou da queda, quando o provedor informa. */
  detail?: string | null;
  className?: string;
};

/** Estado do número. A cor nunca vem sozinha: o texto diz o estado. */
export function ChannelStatus({ status, detail, className }: ChannelStatusProps) {
  const { label, dot } = STATUS[status];

  return (
    <Badge variant="outline" className={cn("gap-1.5", className)} title={detail ?? undefined}>
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      {label}
    </Badge>
  );
}
