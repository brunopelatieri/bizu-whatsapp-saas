import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useCan } from "@/components/auth/can";
import { CustomFieldInput } from "@/components/crm/custom-field-input";
import { useCustomFields } from "@/components/crm/custom-fields-api";
import { TagChip } from "@/components/crm/tag-chip";
import { TagPicker } from "@/components/crm/tag-picker";
import { DetailRow } from "@/components/detail-row";
import {
  LinkCustomerDialog,
  SaveAsCustomerDialog,
  useLinkContact,
} from "@/components/inbox/contact-dialogs";
import { contactLabel, initialsOf } from "@/components/inbox/format";
import {
  type ConversationResponse,
  invalidateInbox,
  useInboxMutation,
} from "@/components/inbox/inbox-api";
import { useInboxCan, useInboxScope } from "@/components/inbox/inbox-scope";
import { PlatformContactSection } from "@/components/inbox/platform-contact-section";
import { RelatedConversations } from "@/components/inbox/related-conversations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiFetch } from "@/lib/api/client";
import { displayCustomFieldValue, type CustomFieldDef } from "@/lib/crm/values";
import { displayPhone } from "@/lib/phone/br";
import { useAuth } from "@/providers/auth-provider";

type ContactPanelProps = {
  detail: ConversationResponse;
  /** Abaixo de `xl` o painel é uma tela à parte e tem "voltar". */
  onBack: () => void;
};

/** Painel ao lado do chat: quem é o contato, o cadastro vinculado e o que o atendente pode fazer. */
export function ContactPanel({ detail, onBack }: ContactPanelProps) {
  const { contact, link } = detail;
  const can = useInboxCan();
  const inbox = useInboxScope();
  const { user, billing } = useAuth();
  const readOnly =
    Boolean(user?.impersonatedBy) || (inbox.mode === "tenant" && billing?.state === "read_only");
  const canReply = can("inbox", "reply") && !readOnly;
  const label = contactLabel({ displayName: contact.displayName, phone: contact.phone });
  const phone = displayPhone(`+${contact.phone}`) ?? contact.phone;

  return (
    <aside className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background" aria-label="Dados do contato">
      <div className="flex items-center gap-2 border-b border-border p-3 xl:hidden">
        <Button variant="ghost" size="icon" aria-label="Voltar para a conversa" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <h2 className="text-sm font-semibold">Contato</h2>
      </div>

      <div className="space-y-5 p-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <div
            className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary"
            aria-hidden
          >
            {initialsOf(label)}
          </div>
          <ContactName detail={detail} label={label} canRename={canReply} />
          {!contact.identified ? <Badge variant="outline">Não identificado</Badge> : null}
        </div>

        <dl className="space-y-3 text-sm">
          <DetailRow label="Telefone" value={phone} />
          <DetailRow label="Nome no WhatsApp" value={contact.waName} />
        </dl>

        {link.kind === "user" || (inbox.mode === "platform" && link.kind === "none") ? (
          <PlatformContactSection contactId={contact.id} link={link as Extract<typeof link, { kind: "user" | "none" }>} canReply={canReply} />
        ) : link.kind === "customer" ? (
          <CustomerSection detail={detail} link={link} canReply={canReply} />
        ) : link.kind === "member" ? (
          <MemberSection contactId={contact.id} name={link.user.name} canReply={canReply} />
        ) : (
          <UnlinkedSection detail={detail} link={link} canReply={canReply} />
        )}

        <RelatedConversations conversationId={detail.conversation.id} />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------

function ContactName({
  detail,
  label,
  canRename,
}: {
  detail: ConversationResponse;
  label: string;
  canRename: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const rename = useInboxMutation({ success: "Nome atualizado." });
  const { api } = useInboxScope();
  const { contact } = detail;

  if (!editing) {
    return (
      <div className="flex max-w-full items-center gap-1">
        <h2 className="truncate text-base font-semibold text-foreground">{label}</h2>
        {canRename ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Renomear contato"
            onClick={() => {
              setName(contact.name ?? contact.displayName ?? "");
              setEditing(true);
            }}
          >
            <Pencil />
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="flex w-full gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate(
          { path: `${api}/contacts/${contact.id}`, method: "PATCH", body: { name: name.trim() || null } },
          { onSuccess: () => setEditing(false) },
        );
      }}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Nome do contato"
        maxLength={120}
        autoFocus
      />
      <Button type="submit" size="sm" disabled={rename.isPending}>
        Salvar
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancelar
      </Button>
    </form>
  );
}

function MemberSection({
  contactId,
  name,
  canReply,
}: {
  contactId: string;
  name: string;
  canReply: boolean;
}) {
  const unlink = useLinkContact(contactId);

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Membro da equipe</h3>
      <p className="text-sm">{name}</p>
      {canReply ? <UnlinkButton pending={unlink.isPending} onClick={() => unlink.mutate({ customerId: null, userId: null })} /> : null}
    </section>
  );
}

function UnlinkButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={onClick}>
      Desvincular
    </Button>
  );
}

// ---------------------------------------------------------------------------

type CustomerLink = Extract<ConversationResponse["link"], { kind: "customer" }>;

function CustomerSection({
  detail,
  link,
  canReply,
}: {
  detail: ConversationResponse;
  link: CustomerLink;
  canReply: boolean;
}) {
  const can = useCan();
  const queryClient = useQueryClient();
  const { tenant } = useAuth();
  const unlink = useLinkContact(detail.contact.id);
  const definitions = useCustomFields();
  const defs = definitions.data ?? [];
  const canEdit = can("customer", "update") && canReply && link.customer.name !== null;
  const canOpen = can("customer", "read") && link.customer.name !== null;
  const customerPath = `/api/customers/${link.customer.id}`;

  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const serverFields = link.customFields;
  const serverKey = JSON.stringify(serverFields);
  // biome-ignore lint/correctness/useExhaustiveDependencies: o JSON é a identidade dos valores
  useEffect(() => setDraft({}), [serverKey, link.customer.id]);

  async function patch(body: unknown, success: string) {
    setSaving(true);
    try {
      await apiFetch(customerPath, { method: "PATCH", body: JSON.stringify(body) });
      toast.success(success);
      await Promise.all([
        invalidateInbox(queryClient, tenant?.id),
        queryClient.invalidateQueries({ queryKey: ["customers"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  }

  const currentValue = (def: CustomFieldDef) => (def.id in draft ? draft[def.id] : (serverFields[def.id] ?? null));
  const changed = Object.keys(draft).length > 0;

  if (link.customer.name === null) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Cliente</h3>
        <p className="text-sm text-muted-foreground">
          Este contato está vinculado a um cliente. Você não tem permissão para ver o cadastro.
        </p>
        {canReply ? <UnlinkButton pending={unlink.isPending} onClick={() => unlink.mutate({ customerId: null, userId: null })} /> : null}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Cliente</h3>
        <p className="text-sm">
          {canOpen ? (
            <Link
              to={`/app/clientes/${link.customer.id}`}
              className="font-medium text-primary hover:underline"
            >
              {link.customer.name}
            </Link>
          ) : (
            link.customer.name
          )}
        </p>
      </div>
      <dl className="space-y-3 text-sm">
        <DetailRow label="E-mail" value={link.customer.email ?? null} />
      </dl>

      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">Etiquetas</h4>
        {canEdit ? (
          <TagPicker
            value={link.tags.map(({ id }) => id)}
            disabled={saving}
            onChange={(next) => void patch({ tagIds: next }, "Etiquetas atualizadas.")}
          />
        ) : link.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {link.tags.map((tag) => (
              <TagChip key={tag.id} name={tag.name} color={tag.color} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nenhuma etiqueta</p>
        )}
      </div>

      {defs.length > 0 ? (
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground">Campos adicionais</h4>
          {canEdit ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void patch(
                  {
                    customFields: Object.fromEntries(
                      Object.entries(draft).map(([id, value]) => [
                        id,
                        value === "" || value === undefined ? null : value,
                      ]),
                    ),
                  },
                  "Campos atualizados.",
                );
              }}
            >
              {defs.map((def) => (
                <div key={def.id} className="grid gap-1.5">
                  <Label htmlFor={`panel-field-${def.id}`} className="text-xs">
                    {def.label}
                  </Label>
                  <CustomFieldInput
                    id={`panel-field-${def.id}`}
                    field={def}
                    value={currentValue(def)}
                    onChange={(value) => setDraft((current) => ({ ...current, [def.id]: value }))}
                  />
                </div>
              ))}
              <Button type="submit" size="sm" disabled={!changed || saving}>
                Salvar campos
              </Button>
            </form>
          ) : (
            <dl className="space-y-3 text-sm">
              {defs.map((def) => (
                <DetailRow
                  key={def.id}
                  label={def.label}
                  value={displayCustomFieldValue(def, serverFields[def.id])}
                />
              ))}
            </dl>
          )}
        </div>
      ) : null}

      {canReply ? (
        <UnlinkButton
          pending={unlink.isPending}
          onClick={() => unlink.mutate({ customerId: null, userId: null })}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

type NoneLink = Extract<ConversationResponse["link"], { kind: "none" }>;

function UnlinkedSection({
  detail,
  link,
  canReply,
}: {
  detail: ConversationResponse;
  link: NoneLink;
  canReply: boolean;
}) {
  const can = useCan();
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState(false);
  const linkMember = useLinkContact(detail.contact.id);
  const candidates = link.candidates ?? { customers: [], users: [] };

  const canSave = canReply && can("customer", "create");
  const canLinkCustomer = canReply && can("customer", "update") && can("customer", "read");

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Cadastro</h3>
      <p className="text-sm text-muted-foreground">
        Este número ainda não está ligado a um cliente nem a alguém da equipe.
      </p>

      {canSave || canLinkCustomer ? (
        <div className="flex flex-wrap gap-2">
          {canSave ? (
            <Button size="sm" onClick={() => setSaving(true)}>
              <UserPlus />
              Salvar como cliente
            </Button>
          ) : null}
          {canLinkCustomer ? (
            <Button size="sm" variant="outline" onClick={() => setLinking(true)}>
              Vincular a cliente
            </Button>
          ) : null}
        </div>
      ) : null}

      {candidates.customers.length > 0 || candidates.users.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">Com o mesmo telefone</p>
          <ul className="space-y-2">
            {candidates.customers.map((customer) => (
              <li key={customer.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{customer.name}</span>
                {canLinkCustomer ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={linkMember.isPending}
                    onClick={() =>
                      linkMember.mutate({ customerId: customer.id, userId: null })
                    }
                  >
                    Vincular
                  </Button>
                ) : null}
              </li>
            ))}
            {candidates.users.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {member.name} <span className="text-xs text-muted-foreground">(equipe)</span>
                </span>
                {canReply ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={linkMember.isPending}
                    onClick={() => linkMember.mutate({ userId: member.id })}
                  >
                    Vincular
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <SaveAsCustomerDialog open={saving} contact={detail.contact} onClose={() => setSaving(false)} />
      <LinkCustomerDialog
        open={linking}
        contactId={detail.contact.id}
        candidates={candidates.customers}
        onClose={() => setLinking(false)}
      />
    </section>
  );
}
