import { Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Pager } from "@/components/admin/pager";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { CustomerFormDialog } from "@/components/app/customers/customer-form-dialog";
import { CustomerStatusBadge } from "@/components/app/customers/customer-status-badge";
import {
  formatDateTime,
  useCustomers,
} from "@/components/app/customers/customers-api";
import { Can } from "@/components/auth/can";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatPhoneForDisplay } from "@/lib/phone/br";
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
  CUSTOMER_STATUS_LABELS,
  type CustomerStatus,
  customerStatuses,
} from "@/lib/tenant/customer-constants";
import { Tags } from "lucide-react";
import { TagChip } from "@/components/crm/tag-chip";
import { useTags } from "@/components/crm/tags-api";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ALL = "all";
const STATUS_ITEMS = [
  { value: ALL, label: "Todos" },
  ...customerStatuses.map((status) => ({
    value: status,
    label: CUSTOMER_STATUS_LABELS[status],
  })),
];

export function CustomersPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<CustomerStatus | undefined>();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const tags = useTags();
  const query = useCustomers({ q, status, tags: tagFilter, page });

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle
          title="Clientes"
          description="Clientes e leads desta organização, e quem tem acesso ao portal."
        />
        <Can resource="customer" action="create">
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            Novo cliente
          </Button>
        </Can>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setQ(search.trim());
            setPage(1);
          }}
        >
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome, e-mail ou documento"
            aria-label="Buscar cliente"
            maxLength={100}
          />
        </form>
        <Select
          items={STATUS_ITEMS}
          value={status ?? ALL}
          onValueChange={(next) => {
            setStatus(next && next !== ALL ? (next as CustomerStatus) : undefined);
            setPage(1);
          }}
        >
          <SelectTrigger aria-label="Filtrar por situação" className="w-full">
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
      </div>

      {tags.data && tags.data.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Tags className="size-3.5" />
              Etiquetas{tagFilter.length > 0 ? ` (${tagFilter.length})` : ""}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 min-w-52 overflow-y-auto">
              {tags.data.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag.id}
                  checked={tagFilter.includes(tag.id)}
                  closeOnClick={false}
                  onCheckedChange={(checked) => {
                    setTagFilter((current) =>
                      checked ? [...current, tag.id] : current.filter((id) => id !== tag.id),
                    );
                    setPage(1);
                  }}
                >
                  <TagChip name={tag.name} color={tag.color} />
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {tags.data
            .filter(({ id }) => tagFilter.includes(id))
            .map((tag) => (
              <button
                key={tag.id}
                type="button"
                aria-label={`Tirar o filtro ${tag.name}`}
                onClick={() => {
                  setTagFilter((current) => current.filter((id) => id !== tag.id));
                  setPage(1);
                }}
              >
                <TagChip name={`${tag.name} ×`} color={tag.color} />
              </button>
            ))}
        </div>
      ) : null}

      <QueryState {...query}>
        {query.data ? (
          <Card>
            <CardContent className="pt-6">
              {query.data.items.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Nenhum cliente encontrado.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>E-mail</TableHead>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Etiquetas</TableHead>
                      <TableHead>Situação</TableHead>
                      <TableHead>Último acesso</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.items.map((customer) => (
                      <TableRow key={customer.id}>
                        <TableCell className="font-medium">
                          <Link
                            to={`/app/clientes/${customer.id}`}
                            className="hover:text-primary hover:underline"
                          >
                            {customer.name}
                          </Link>
                        </TableCell>
                        <TableCell className="break-all">
                          {customer.email ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {customer.phoneNormalized ? (
                            formatPhoneForDisplay(customer.phoneNormalized)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {customer.tags.length > 0 ? (
                            <span className="flex flex-wrap gap-1">
                              {customer.tags.slice(0, 3).map((tag) => (
                                <TagChip key={tag.id} name={tag.name} color={tag.color} />
                              ))}
                              {customer.tags.length > 3 ? (
                                <span className="text-xs text-muted-foreground">
                                  +{customer.tags.length - 3}
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <CustomerStatusBadge status={customer.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(customer.lastLoginAt)}
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
                onPage={setPage}
              />
            </CardContent>
          </Card>
        ) : null}
      </QueryState>

      <CustomerFormDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
