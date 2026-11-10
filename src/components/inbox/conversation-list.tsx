import { Inbox, Loader2, MessageSquarePlus, Search, Tags } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { QueryState } from "@/components/admin/query-state";
import { useCan } from "@/components/auth/can";
import { useChannels } from "@/components/channels/channels-api";
import { TagChip } from "@/components/crm/tag-chip";
import { useTags } from "@/components/crm/tags-api";
import { ConversationItem } from "@/components/inbox/conversation-item";
import {
  type ConversationFilters,
  useAssignees,
  useConversations,
  useInboxUnread,
} from "@/components/inbox/inbox-api";
import { CONVERSATION_STATUS_LABELS } from "@/components/inbox/labels";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { conversationStatuses, type ConversationStatus } from "@/lib/inbox/constants";
import type { ConversationTab } from "@/lib/schemas/inbox";
import { cn } from "@/lib/utils";

const ALL = "all";
const SEARCH_DEBOUNCE_MS = 300;

const TAB_LABELS: Record<ConversationTab, string> = {
  queue: "Fila",
  mine: "Minhas",
  all: "Todas",
};

const STATUS_ITEMS = [
  { value: ALL, label: "Qualquer situação" },
  ...conversationStatuses.map((status) => ({
    value: status,
    label: CONVERSATION_STATUS_LABELS[status],
  })),
];

function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

type ConversationListProps = {
  selectedId: string | undefined;
  onNewConversation: () => void;
  className?: string;
};

/**
 * Lista do atendimento: abas Fila, Minhas e Todas (a última só com `inbox:supervise`), filtros,
 * busca com espera e rolagem infinita por cursor. O servidor decide o que cada aba devolve.
 */
export function ConversationList({ selectedId, onNewConversation, className }: ConversationListProps) {
  const can = useCan();
  const canSupervise = can("inbox", "supervise");
  const canFilterTags = can("customer", "read");
  const [tab, setTab] = useState<ConversationTab>("queue");
  const [status, setStatus] = useState<ConversationStatus | undefined>();
  const [unread, setUnread] = useState(false);
  const [channelId, setChannelId] = useState<string | undefined>();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [assignedTo, setAssignedTo] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  const channels = useChannels();
  const tags = useTags(canFilterTags);
  const assignees = useAssignees(canSupervise && can("inbox", "assign"));
  const unreadCounts = useInboxUnread();

  const filters: ConversationFilters = useMemo(
    () => ({
      tab,
      status,
      unread: unread || undefined,
      channelId,
      tagIds: canFilterTags && tagIds.length > 0 ? tagIds : undefined,
      assignedTo: canSupervise ? assignedTo : undefined,
      q: q || undefined,
    }),
    [tab, status, unread, channelId, tagIds, assignedTo, q, canFilterTags, canSupervise],
  );

  const query = useConversations(filters);
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { root: scroller.current, rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const channelList = channels.data?.channels ?? [];
  const usableChannels = channelList.filter((channel) => channel.status === "connected");
  const filtering = Boolean(status || unread || channelId || tagIds.length > 0 || assignedTo || q);
  const channelItems = [
    { value: ALL, label: "Todos os números" },
    ...channelList.map((channel) => ({ value: channel.id, label: channel.name })),
  ];
  const assigneeItems = [
    { value: ALL, label: "Qualquer atendente" },
    ...(assignees.data ?? []).map((user) => ({ value: user.id, label: user.name })),
  ];

  function clearFilters() {
    setStatus(undefined);
    setUnread(false);
    setChannelId(undefined);
    setTagIds([]);
    setAssignedTo(undefined);
    setSearch("");
  }

  const tabBadge = (value: ConversationTab) => {
    const count = value === "queue" ? unreadCounts.data?.queue : value === "mine" ? unreadCounts.data?.mine : 0;
    return count ? (
      <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
        {count}
      </span>
    ) : null;
  };

  const tabs: ConversationTab[] = canSupervise ? ["queue", "mine", "all"] : ["queue", "mine"];

  return (
    <section className={cn("flex min-h-0 flex-col bg-background", className)} aria-label="Conversas">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-base font-semibold text-foreground">Atendimento</h1>
          {can("inbox", "reply") ? (
            <Button size="sm" variant="outline" onClick={onNewConversation}>
              <MessageSquarePlus />
              Nova
            </Button>
          ) : null}
        </div>

        <Tabs
          value={tab}
          onValueChange={(next) => {
            setTab(next as ConversationTab);
            // O filtro de atendente só existe em "Todas".
            if (next !== "all") setAssignedTo(undefined);
          }}
        >
          <TabsList className="w-full">
            {tabs.map((value) => (
              <TabsTrigger key={value} value={value}>
                {TAB_LABELS[value]}
                {tabBadge(value)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar nome ou telefone"
            aria-label="Buscar conversa"
            maxLength={100}
            className="pl-8"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={STATUS_ITEMS}
            value={status ?? ALL}
            onValueChange={(next) =>
              setStatus(next && next !== ALL ? (next as ConversationStatus) : undefined)
            }
          >
            <SelectTrigger size="sm" aria-label="Filtrar por situação" className="w-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm"
            variant={unread ? "secondary" : "outline"}
            aria-pressed={unread}
            onClick={() => setUnread((current) => !current)}
          >
            Não lidas
          </Button>

          {channelList.length > 1 ? (
            <Select
              items={channelItems}
              value={channelId ?? ALL}
              onValueChange={(next) => setChannelId(next && next !== ALL ? next : undefined)}
            >
              <SelectTrigger size="sm" aria-label="Filtrar por número" className="w-auto max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channelItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {canSupervise && tab === "all" && (assignees.data?.length ?? 0) > 0 ? (
            <Select
              items={assigneeItems}
              value={assignedTo ?? ALL}
              onValueChange={(next) => setAssignedTo(next && next !== ALL ? next : undefined)}
            >
              <SelectTrigger size="sm" aria-label="Filtrar por atendente" className="w-auto max-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assigneeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {canFilterTags && tags.data && tags.data.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                <Tags />
                Etiquetas{tagIds.length > 0 ? ` (${tagIds.length})` : ""}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 min-w-52 overflow-y-auto">
                {tags.data.map((tag) => (
                  <DropdownMenuCheckboxItem
                    key={tag.id}
                    checked={tagIds.includes(tag.id)}
                    closeOnClick={false}
                    onCheckedChange={(checked) =>
                      setTagIds((current) =>
                        checked ? [...current, tag.id] : current.filter((id) => id !== tag.id),
                      )
                    }
                  >
                    <TagChip name={tag.name} color={tag.color} />
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {filtering ? (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              Limpar
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <QueryState {...query}>
          {items.length === 0 ? (
            <EmptyList
              tab={tab}
              filtering={filtering}
              noConnectedChannel={channels.isSuccess && usableChannels.length === 0}
              canSeeChannels={can("channel", "read")}
            />
          ) : (
            <>
              {items.map((item) => (
                <ConversationItem
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  showChannel={channelList.length > 1}
                  showOwner={tab === "all"}
                />
              ))}
              {hasNextPage ? (
                <div ref={sentinel} className="flex justify-center p-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isFetchingNextPage}
                    onClick={() => void fetchNextPage()}
                  >
                    {isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
                    Carregar mais
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </QueryState>
      </div>
    </section>
  );
}

function EmptyList({
  tab,
  filtering,
  noConnectedChannel,
  canSeeChannels,
}: {
  tab: ConversationTab;
  filtering: boolean;
  noConnectedChannel: boolean;
  canSeeChannels: boolean;
}) {
  if (filtering) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">Nenhuma conversa encontrada.</p>
    );
  }

  if (noConnectedChannel) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <Inbox className="size-8" aria-hidden />
        <p>Nenhum número de WhatsApp conectado.</p>
        {canSeeChannels ? (
          <Link to="/app/configuracoes/canais" className="font-medium text-primary hover:underline">
            Conectar um número
          </Link>
        ) : (
          <p>Peça a quem administra para conectar um número.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <Inbox className="size-8" aria-hidden />
      <p>
        {tab === "queue"
          ? "Nenhuma conversa na fila."
          : tab === "mine"
            ? "Você não tem conversas atribuídas."
            : "Nenhuma conversa ainda."}
      </p>
    </div>
  );
}
