import { UserRoundSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { type Page, useAdminQuery } from "@/components/admin/admin-api";
import { platformFieldsApi, useCustomFields } from "@/components/crm/custom-fields-api";
import { TagChip } from "@/components/crm/tag-chip";
import { DetailRow } from "@/components/detail-row";
import { useLinkContact } from "@/components/inbox/contact-dialogs";
import type { ContactLink } from "@/components/inbox/inbox-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { roleLabel } from "@/lib/auth/permissions";
import { displayCustomFieldValue } from "@/lib/crm/values";

/**
 * Painel do contato na plataforma (`/admin/atendimento`): o usuário vinculado e as organizações dele,
 * com a anotação da plataforma (etiquetas e campos de `crm-cadastro`) **só para leitura**: a edição
 * continua nas telas de organização. Nada de cliente de owner: o vínculo é só com `user`.
 */

type PlatformLink = Extract<ContactLink, { kind: "user" | "none" }>;

export function PlatformContactSection({
  contactId,
  link,
  canReply,
}: {
  contactId: string;
  link: PlatformLink;
  canReply: boolean;
}) {
  const unlink = useLinkContact(contactId);
  const [linking, setLinking] = useState(false);

  if (link.kind === "none") {
    return (
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Cadastro</h3>
        <p className="text-sm text-muted-foreground">
          Este número ainda não está ligado a um usuário da plataforma.
        </p>
        {canReply ? (
          <Button size="sm" onClick={() => setLinking(true)}>
            <UserRoundSearch />
            Vincular a usuário
          </Button>
        ) : null}
        <LinkUserDialog open={linking} contactId={contactId} onClose={() => setLinking(false)} />
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Usuário</h3>
        <p className="text-sm">
          <Link to={`/admin/usuarios/${link.user.id}`} className="font-medium text-primary hover:underline">
            {link.user.name}
          </Link>
        </p>
      </div>

      <Organizations organizations={link.organizations} />

      {canReply ? (
        <Button
          size="sm"
          variant="outline"
          disabled={unlink.isPending}
          onClick={() => unlink.mutate({ userId: null })}
        >
          Desvincular
        </Button>
      ) : null}
    </section>
  );
}

function Organizations({
  organizations,
}: {
  organizations: Extract<ContactLink, { kind: "user" }>["organizations"];
}) {
  const fields = useCustomFields("false", organizations.length > 0, platformFieldsApi);
  const defs = fields.data ?? [];

  if (organizations.length === 0) {
    return <p className="text-sm text-muted-foreground">Este usuário não está em nenhuma organização.</p>;
  }

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-medium text-muted-foreground">Organizações</h4>
      <ul className="space-y-3">
        {organizations.map((org) => {
          const filled = defs.filter((def) => displayCustomFieldValue(def, org.customFields[def.id]) !== null);

          return (
            <li key={org.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <Link to={`/admin/tenants/${org.id}`} className="text-sm font-medium text-primary hover:underline">
                  {org.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {org.role
                    .split(",")
                    .map((role) => roleLabel(role))
                    .join(", ")}
                </span>
              </div>

              {org.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {org.tags.map((tag) => (
                    <TagChip key={tag.id} name={tag.name} color={tag.color} />
                  ))}
                </div>
              ) : null}

              {filled.length > 0 ? (
                <dl className="space-y-2 text-sm">
                  {filled.map((def) => (
                    <DetailRow
                      key={def.id}
                      label={def.label}
                      value={displayCustomFieldValue(def, org.customFields[def.id])}
                    />
                  ))}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type UserRow = { id: string; name: string; email: string; banned: boolean };

/** Escolhe o usuário da lista de `/api/admin/users` (equipe e plataforma) para ligar ao contato. */
function LinkUserDialog({
  open,
  contactId,
  onClose,
}: {
  open: boolean;
  contactId: string;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const link = useLinkContact(contactId);
  const users = useAdminQuery<Page<UserRow>>("/api/admin/users", { q, page: 1, scope: "team" }, open && q.length >= 2);

  useEffect(() => {
    if (open) {
      setSearch("");
      setQ("");
    }
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const rows = (users.data?.items ?? []).filter((row) => !row.banned);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vincular a usuário</DialogTitle>
          <DialogDescription>Busque pelo nome ou e-mail. O vínculo é só deste contato.</DialogDescription>
        </DialogHeader>

        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Buscar usuário (2 letras ou mais)"
          aria-label="Buscar usuário"
          maxLength={100}
          autoComplete="off"
          autoFocus
        />

        <ul className="max-h-60 divide-y divide-border overflow-y-auto">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{row.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{row.email}</span>
              </span>
              <Button
                size="sm"
                disabled={link.isPending}
                onClick={() => link.mutate({ userId: row.id }, { onSuccess: onClose })}
              >
                Vincular
              </Button>
            </li>
          ))}
        </ul>
        {users.isSuccess && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum usuário encontrado.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
