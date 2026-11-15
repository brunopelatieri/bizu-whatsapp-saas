import { Link } from "react-router";
import { ChannelBadge } from "@/components/channels/channel-badge";
import { TagChip } from "@/components/crm/tag-chip";
import { contactLabel, formatListTime, initialsOf } from "@/components/inbox/format";
import type { ConversationItem as Item } from "@/components/inbox/inbox-api";
import { CONVERSATION_STATUS_LABELS } from "@/components/inbox/labels";
import { useInboxPath } from "@/components/inbox/use-inbox-path";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ConversationItemProps = {
  item: Item;
  selected: boolean;
  /** Mostra o canal só quando há mais de um número. */
  showChannel: boolean;
  /** Na aba "Todas" o dono importa. */
  showOwner: boolean;
};

const MAX_TAGS = 2;

/** Uma linha da lista: quem é, última mensagem, hora, não lidas, número, etiquetas. */
export function ConversationItem({ item, selected, showChannel, showOwner }: ConversationItemProps) {
  const pathOf = useInboxPath();
  const label = contactLabel(item.contact);
  const preview = item.lastMessagePreview
    ? `${item.lastMessageDirection === "out" ? "Você: " : ""}${item.lastMessagePreview}`
    : "Sem mensagens";
  const extraTags = item.tags.length - MAX_TAGS;

  return (
    <Link
      to={pathOf(item.id)}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex gap-3 border-b border-border px-3 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
        selected && "bg-primary/5",
      )}
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
        aria-hidden
      >
        {initialsOf(label)}
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm text-foreground",
              item.unreadCount > 0 ? "font-semibold" : "font-medium",
            )}
          >
            {label}
          </span>
          <time
            dateTime={item.lastMessageAt ?? undefined}
            className="shrink-0 text-xs text-muted-foreground"
          >
            {formatListTime(item.lastMessageAt)}
          </time>
        </div>

        <div className="flex items-center justify-between gap-2">
          <p
            className={cn(
              "truncate text-xs",
              item.unreadCount > 0 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {preview}
          </p>
          {item.unreadCount > 0 ? (
            <span
              className="flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground"
              role="status"
              aria-label={`${item.unreadCount} não lidas`}
            >
              {item.unreadCount > 99 ? "99+" : item.unreadCount}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {!item.contact.identified ? <Badge variant="outline">Não identificado</Badge> : null}
          {item.status !== "open" ? (
            <Badge variant="secondary">{CONVERSATION_STATUS_LABELS[item.status]}</Badge>
          ) : null}
          {showOwner ? <span>{item.assignedTo ? item.assignedTo.name : "Na fila"}</span> : null}
          {showChannel ? (
            <ChannelBadge type={item.channel.type} name={item.channel.name} className="max-w-32 text-xs" />
          ) : null}
          {item.tags.slice(0, MAX_TAGS).map((tag) => (
            <TagChip key={tag.id} name={tag.name} color={tag.color} className="max-w-24" />
          ))}
          {extraTags > 0 ? <span>+{extraTags}</span> : null}
        </div>
      </div>
    </Link>
  );
}
