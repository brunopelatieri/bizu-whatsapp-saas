import { useSearchParams } from "react-router";
import {
  type Page,
  useAdminMutation,
  useAdminQuery,
  useIsPlatformOwner,
} from "@/components/admin/admin-api";
import { Pager } from "@/components/admin/pager";
import { QueryState } from "@/components/admin/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type ChannelEventKind,
  type ChannelEventStatus,
  channelEventStatuses,
} from "@/lib/channels/types";

/** O que `GET /api/admin/channel-events` devolve: nunca o `raw`. */
type AdminChannelEvent = {
  id: string;
  channelId: string;
  channelName: string;
  tenantId: string | null;
  provider: string;
  kind: ChannelEventKind;
  status: ChannelEventStatus;
  attempts: number;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
};

const STATUS_LABELS: Record<ChannelEventStatus, string> = {
  pending: "Na fila",
  processed: "Processado",
  ignored: "Ignorado",
  failed: "Falhou",
};

const VARIANTS: Record<
  ChannelEventStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "secondary",
  processed: "default",
  ignored: "outline",
  failed: "destructive",
};

const KIND_LABELS: Record<ChannelEventKind, string> = {
  message: "Mensagem",
  status: "Status de entrega",
  connection: "Conexão",
  template: "Modelo",
  other: "Outro",
};

const ALL = "all";
/** A aba abre nos eventos com falha: é o que pede ação. */
const DEFAULT_STATUS: ChannelEventStatus = "failed";

const statusItems = [
  { value: ALL, label: "Todos os estados" },
  ...channelEventStatuses.map((status) => ({
    value: status,
    label: STATUS_LABELS[status],
  })),
];

const isStatus = (value: string | null): value is ChannelEventStatus =>
  channelEventStatuses.includes(value as ChannelEventStatus);

export function ChannelEventsTab() {
  const owner = useIsPlatformOwner();
  const [params, setParams] = useSearchParams();
  const raw = params.get("status");
  const status = raw === ALL ? ALL : isStatus(raw) ? raw : DEFAULT_STATUS;
  const page = Number(params.get("page") ?? "1") || 1;
  const query = useAdminQuery<Page<AdminChannelEvent>>("/api/admin/channel-events", {
    status: status === ALL ? undefined : status,
    page,
  });
  const reprocess = useAdminMutation("Evento devolvido à fila.");

  function update(next: Record<string, string | null>) {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setParams(merged, { replace: true });
  }

  return (
    <div className="space-y-6">
      <Select
        items={statusItems}
        value={status}
        onValueChange={(next) =>
          update({ status: next && next !== DEFAULT_STATUS ? next : null, page: null })
        }
      >
        <SelectTrigger aria-label="Estado" className="w-full sm:w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {statusItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <QueryState {...query}>
        {query.data ? (
          <Card>
            <CardContent className="pt-6">
              {query.data.items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {status === DEFAULT_STATUS
                    ? "Nenhum evento de canal com falha."
                    : "Nenhum evento encontrado."}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Recebido em</TableHead>
                      <TableHead>Canal</TableHead>
                      <TableHead>Evento</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Tentativas</TableHead>
                      <TableHead>Erro</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.items.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell>
                          {new Date(event.receivedAt).toLocaleString("pt-BR")}
                        </TableCell>
                        <TableCell>
                          <p className="font-medium text-foreground">{event.channelName}</p>
                          <p className="text-xs text-muted-foreground">
                            {event.tenantId ? "Organização" : "Plataforma"}
                          </p>
                        </TableCell>
                        <TableCell>
                          <p className="text-foreground">{KIND_LABELS[event.kind]}</p>
                          <p className="text-xs text-muted-foreground">{event.provider}</p>
                        </TableCell>
                        <TableCell>
                          <Badge variant={VARIANTS[event.status]}>
                            {STATUS_LABELS[event.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{event.attempts}</TableCell>
                        <TableCell className="max-w-56 truncate text-xs text-muted-foreground">
                          {event.error ?? "–"}
                        </TableCell>
                        <TableCell className="text-right">
                          {owner &&
                          (event.status === "failed" || event.status === "ignored") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={reprocess.isPending}
                              onClick={() =>
                                reprocess.mutate({
                                  path: `/api/admin/channel-events/${event.id}/reprocess`,
                                  method: "POST",
                                })
                              }
                            >
                              Reprocessar
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <Pager
                page={page}
                total={query.data.total}
                pageSize={query.data.pageSize}
                onPage={(next) => update({ page: next > 1 ? String(next) : null })}
              />
            </CardContent>
          </Card>
        ) : null}
      </QueryState>
    </div>
  );
}
