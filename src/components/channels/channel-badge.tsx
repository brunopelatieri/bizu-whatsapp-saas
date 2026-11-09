import { CHANNEL_KINDS } from "@/components/channels/channel-kinds";
import type { ChannelType } from "@/lib/channels/types";
import { cn } from "@/lib/utils";

type ChannelBadgeProps = {
  type: ChannelType;
  name: string;
  className?: string;
};

/** Ícone do tipo + nome do número. Reaproveitado pela lista e pelo atendimento. */
export function ChannelBadge({ type, name, className }: ChannelBadgeProps) {
  const { icon: Icon, label } = CHANNEL_KINDS[type];

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">{label}:</span>
      <span className="truncate font-medium text-foreground">{name}</span>
    </span>
  );
}
