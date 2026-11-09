import { useState } from "react";
import { Tags } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import {
  type AdminPlan,
  type AdminTenant,
  type Page,
  useAdminQuery,
} from "@/components/admin/admin-api";
import {
  BILLING_STATE_LABELS,
  BillingStateBadge,
} from "@/components/admin/billing-state-badge";
import { Pager } from "@/components/admin/pager";
import { PageTitle, QueryState } from "@/components/admin/query-state";
import { TagChip } from "@/components/crm/tag-chip";
import { platformTagsApi, useTags } from "@/components/crm/tags-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { billingStates } from "@/lib/billing/state";
import { z } from "zod";

const ALL = "all";
const stateItems = [
  { value: ALL, label: "Todos os estados" },
  ...billingStates.map((state) => ({
    value: state,
    label: BILLING_STATE_LABELS[state],
  })),
];

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR");

export function AdminTenantsPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const status = params.get("status") ?? ALL;
  const page = Number(params.get("page") ?? "1") || 1;
  const q = params.get("q") ?? "";
  // admin-crud A: filtro por plano, vindo do "+N" de /admin/planos.
  const planParam = params.get("plan") ?? "";
  const planId = z.uuid().safeParse(planParam).success ? planParam : undefined;
  const plans = useAdminQuery<{ plans: AdminPlan[] }>(
    "/api/admin/plans",
    undefined,
    planId !== undefined,
  );
  const planName = plans.data?.plans.find(({ id }) => id === planId)?.name;
  // crm-cadastro A4: filtro por etiqueta da plataforma (`?tags=<id>,<id>`, qualquer uma).
  const platformTags = useTags(true, platformTagsApi);
  const tagFilter = (params.get("tags") ?? "")
    .split(",")
    .filter((id) => z.uuid().safeParse(id).success);

  const query = useAdminQuery<Page<AdminTenant>>("/api/admin/tenants", {
    q,
    status: status === ALL ? undefined : status,
    plan: planId,
    tags: tagFilter.length > 0 ? tagFilter.join(",") : undefined,
    page,
  });

  function update(next: Record<string, string | null>) {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setParams(merged, { replace: true });
  }

  return (
    <div className="max-w-5xl space-y-6">
      <PageTitle
        title="Organizações"
        description="Todos os tenants da plataforma."
      />

      {planId ? (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary">Plano: {planName ?? "…"}</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => update({ plan: null, page: null })}
          >
            Limpar filtro
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        <form
          className="flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: search.trim() || null, page: null });
          }}
        >
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome ou identificador"
            aria-label="Buscar organização"
            maxLength={100}
          />
        </form>
        <Select
          items={stateItems}
          value={status}
          onValueChange={(next) =>
            update({ status: next && next !== ALL ? next : null, page: null })
          }
        >
          <SelectTrigger aria-label="Estado" className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stateItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {platformTags.data && platformTags.data.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Tags className="size-3.5" />
              Etiquetas{tagFilter.length > 0 ? ` (${tagFilter.length})` : ""}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 min-w-52 overflow-y-auto">
              {platformTags.data.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag.id}
                  checked={tagFilter.includes(tag.id)}
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    update({
                      tags:
                        (checked
                          ? [...tagFilter, tag.id]
                          : tagFilter.filter((id) => id !== tag.id)
                        ).join(",") || null,
                      page: null,
                    })
                  }
                >
                  <TagChip name={tag.name} color={tag.color} />
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {platformTags.data
            .filter(({ id }) => tagFilter.includes(id))
            .map((tag) => (
              <button
                key={tag.id}
                type="button"
                aria-label={`Tirar o filtro ${tag.name}`}
                onClick={() =>
                  update({
                    tags: tagFilter.filter((id) => id !== tag.id).join(",") || null,
                    page: null,
                  })
                }
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
                  Nenhuma organização encontrada.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Organização</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Plano</TableHead>
                      <TableHead className="text-right">Membros</TableHead>
                      <TableHead>Criada em</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.data.items.map((tenant) => (
                      <TableRow key={tenant.id}>
                        <TableCell>
                          <Link
                            to={`/admin/tenants/${tenant.id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {tenant.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {tenant.slug}
                          </p>
                          {tenant.tags.length > 0 ? (
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {tenant.tags.slice(0, 3).map((tag) => (
                                <TagChip key={tag.id} name={tag.name} color={tag.color} />
                              ))}
                              {tenant.tags.length > 3 ? (
                                <span className="text-xs text-muted-foreground">
                                  +{tenant.tags.length - 3}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <BillingStateBadge state={tenant.state} />
                        </TableCell>
                        <TableCell>{tenant.planName ?? "–"}</TableCell>
                        <TableCell className="text-right">
                          {tenant.members}
                        </TableCell>
                        <TableCell>{formatDate(tenant.createdAt)}</TableCell>
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
