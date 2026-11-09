import { useSearchParams } from "react-router";
import {
  type Page,
  useAdminMutation,
  useAdminQuery,
  useIsPlatformOwner,
} from "@/components/admin/admin-api";
import { Pager } from "@/components/admin/pager";
import { PageTitle, QueryState } from "@/components/admin/query-state";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { paymentEventStatuses, PROVIDER_LABELS } from "@/lib/billing/constants";
import { ChannelEventsTab } from "@/pages/admin/channel-events-tab";

type PaymentEventStatus = (typeof paymentEventStatuses)[number];

type AdminWebhook = {
  id: string;
  provider: keyof typeof PROVIDER_LABELS;
  providerEventId: string;
  eventType: string | null;
  status: PaymentEventStatus;
  verified: boolean;
  attempts: number;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
};

const STATUS_LABELS: Record<PaymentEventStatus, string> = {
  pending: "Na fila",
  processed: "Processado",
  ignored: "Ignorado",
  failed: "Falhou",
  duplicate: "Duplicado",
};

const VARIANTS: Record<
  PaymentEventStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "secondary",
  processed: "default",
  ignored: "outline",
  failed: "destructive",
  duplicate: "outline",
};

const ALL = "all";
const statusItems = [
  { value: ALL, label: "Todos os estados" },
  ...paymentEventStatuses.map((status) => ({
    value: status,
    label: STATUS_LABELS[status],
  })),
];

export function AdminWebhooksPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "canais" ? "canais" : "pagamentos";

  return (
    <div className="max-w-6xl space-y-6">
      <PageTitle
        title="Webhooks"
        description="Eventos recebidos dos provedores de pagamento e dos canais de WhatsApp."
      />

      <Tabs
        value={tab}
        // Estado e página são de cada aba: trocar de aba recomeça os filtros.
        onValueChange={(next) =>
          setParams(next === "canais" ? { tab: "canais" } : {}, { replace: true })
        }
      >
        <TabsList>
          <TabsTrigger value="pagamentos">Pagamentos</TabsTrigger>
          <TabsTrigger value="canais">Canais</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "canais" ? <ChannelEventsTab /> : <PaymentWebhooksTab />}
    </div>
  );
}

function PaymentWebhooksTab() {
  const owner = useIsPlatformOwner();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? ALL;
  const page = Number(params.get("page") ?? "1") || 1;
  const query = useAdminQuery<Page<AdminWebhook>>("/api/admin/webhooks", {
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
          update({ status: next && next !== ALL ? next : null, page: null })
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
                  Nenhum evento encontrado.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Recebido em</TableHead>
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
                          <p className="font-medium text-foreground">
                            {event.eventType ?? "–"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {PROVIDER_LABELS[event.provider]}
                          </p>
                        </TableCell>
                        <TableCell>
                          <Badge variant={VARIANTS[event.status]}>
                            {event.verified
                              ? STATUS_LABELS[event.status]
                              : "Assinatura inválida"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{event.attempts}</TableCell>
                        <TableCell className="max-w-56 truncate text-xs text-muted-foreground">
                          {event.error ?? "–"}
                        </TableCell>
                        <TableCell className="text-right">
                          {owner &&
                          event.verified &&
                          (event.status === "failed" ||
                            event.status === "ignored") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={reprocess.isPending}
                              onClick={() =>
                                reprocess.mutate({
                                  path: `/api/admin/webhooks/${event.id}/reprocess`,
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
