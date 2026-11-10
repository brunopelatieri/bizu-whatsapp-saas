import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCustomers } from "@/components/app/customers/customers-api";
import { useCan } from "@/components/auth/can";
import { CustomFieldInput } from "@/components/crm/custom-field-input";
import { useCustomFields } from "@/components/crm/custom-fields-api";
import { TagPicker } from "@/components/crm/tag-picker";
import { type ContactView, errorText, invalidateInbox } from "@/components/inbox/inbox-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PhoneField } from "@/components/ui/phone-field";
import { Label } from "@/components/ui/label";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { CustomFieldValues } from "@/lib/crm/values";
import { displayPhone, formatPhoneForDisplay } from "@/lib/phone/br";
import { saveContactAsCustomerSchema } from "@/lib/schemas/inbox";
import { useAuth } from "@/providers/auth-provider";
import { Link } from "react-router";

/** Vincular o contato a um cliente (ou membro) ou desfazer; relê a caixa e os clientes no fim. */
export function useLinkContact(contactId: string) {
  const queryClient = useQueryClient();
  const { tenant } = useAuth();

  return useMutation({
    mutationFn: (body: { customerId: string | null; userId: string | null } | { userId: string }) =>
      apiFetch(`/api/inbox/contacts/${contactId}/link`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onError: (error) => toast.error(errorText(error)),
    onSettled: () =>
      Promise.all([
        invalidateInbox(queryClient, tenant?.id),
        queryClient.invalidateQueries({ queryKey: ["customers"] }),
      ]),
  });
}

// ---------------------------------------------------------------------------
// Salvar como cliente
// ---------------------------------------------------------------------------

type SaveDialogProps = {
  open: boolean;
  contact: ContactView;
  onClose: () => void;
};

export function SaveAsCustomerDialog({ open, contact, onClose }: SaveDialogProps) {
  const queryClient = useQueryClient();
  const { tenant } = useAuth();
  const can = useCan();
  const fields = useCustomFields("false", open);
  const defs = fields.data ?? [];
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // O número do WhatsApp, com `+`; o atendente o corrige se o cadastro o recusar (`INVALID_PHONE`).
  const providerNumber = `+${contact.phone}`;
  const [phoneValue, setPhoneValue] = useState(providerNumber);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [planLimit, setPlanLimit] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [inUse, setInUse] = useState<{ customerId: string; name?: string } | null>(null);
  const link = useLinkContact(contact.id);

  // Cada abertura começa do nome que já se conhece do contato.
  // Só na abertura: o polling atualiza `waName` a cada mensagem e não pode apagar o que se digita.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` é o único gatilho
  useEffect(() => {
    if (!open) return;
    setName(contact.name ?? contact.waName ?? "");
    setEmail("");
    setPhoneValue(providerNumber);
    setPhoneError(null);
    setTagIds([]);
    setValues({});
    setFormError(null);
    setPlanLimit(false);
    setEmailError(null);
    setInUse(null);
  }, [open]);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch(`/api/inbox/contacts/${contact.id}/customer`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async () => {
      toast.success("Cliente salvo e vinculado.");
      await Promise.all([
        invalidateInbox(queryClient, tenant?.id),
        queryClient.invalidateQueries({ queryKey: ["customers"] }),
      ]);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        if (error.code === "PHONE_IN_USE") {
          const customerId = error.details.customerId;
          setInUse({
            customerId: typeof customerId === "string" ? customerId : "",
            name: typeof error.details.name === "string" ? error.details.name : undefined,
          });
          return;
        }
        if (error.code === "CUSTOMER_EMAIL_TAKEN") {
          setEmailError(error.message);
          return;
        }
        if (error.code === "INVALID_PHONE") {
          setPhoneError(error.message);
          return;
        }
      }
      setPlanLimit(error instanceof ApiError && error.code === "PLAN_LIMIT_REACHED");
      setFormError(errorText(error));
    },
  });

  function submit() {
    setFormError(null);
    setPlanLimit(false);
    setEmailError(null);
    setPhoneError(null);
    setInUse(null);

    const patch: CustomFieldValues = {};
    for (const [id, value] of Object.entries(values)) {
      if (value !== null && value !== undefined && value !== "") {
        patch[id] = value as CustomFieldValues[string];
      }
    }

    const parsed = saveContactAsCustomerSchema.safeParse({
      name,
      // Só quando o atendente mexeu: sem correção, o servidor grava o número como o WhatsApp entregou.
      ...(phoneValue && phoneValue !== providerNumber ? { phone: phoneValue } : {}),
      email: email || null,
      tagIds,
      customFields: patch,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue?.path[0] === "email") setEmailError(issue.message);
      else if (issue?.path[0] === "phone") setPhoneError(issue.message);
      else setFormError(issue?.message ?? "Confira os dados.");
      return;
    }

    save.mutate(parsed.data);
  }

  const phone = displayPhone(`+${contact.phone}`) ?? contact.phone;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Salvar como cliente</DialogTitle>
          <DialogDescription>
            O número {phone} é gravado como o WhatsApp entregou, e a conversa passa a mostrar o
            cadastro. Se o cadastro recusar o número, corrija-o abaixo: o contato continua com o número
            do WhatsApp.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="save-customer-name">Nome</Label>
            <Input
              id="save-customer-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              autoComplete="off"
              required
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="save-customer-phone">Telefone</Label>
            <PhoneField
              id="save-customer-phone"
              value={phoneValue}
              onChange={(next) => {
                setPhoneValue(next);
                setPhoneError(null);
              }}
              disabled={save.isPending}
              invalid={Boolean(phoneError)}
            />
            {phoneError ? <p className="text-xs text-destructive">{phoneError}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="save-customer-email">E-mail (opcional)</Label>
            <Input
              id="save-customer-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              autoComplete="off"
              aria-invalid={Boolean(emailError)}
            />
            {emailError ? <p className="text-xs text-destructive">{emailError}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label>Etiquetas</Label>
            <TagPicker value={tagIds} onChange={setTagIds} disabled={save.isPending} />
          </div>
          {defs.map((def) => (
            <div key={def.id} className="grid gap-1.5">
              <Label htmlFor={`save-customer-field-${def.id}`}>{def.label}</Label>
              <CustomFieldInput
                id={`save-customer-field-${def.id}`}
                field={def}
                value={values[def.id] ?? null}
                onChange={(value) => setValues((current) => ({ ...current, [def.id]: value }))}
              />
            </div>
          ))}

          {inUse ? (
            <div role="alert" className="space-y-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <p>
                Este número já pertence a {inUse.name ? <strong>{inUse.name}</strong> : "outro cliente"}.
              </p>
              {inUse.customerId && can("customer", "update") ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={link.isPending}
                  onClick={() =>
                    link.mutate(
                      { customerId: inUse.customerId, userId: null },
                      {
                        onSuccess: () => {
                          toast.success("Contato vinculado.");
                          onClose();
                        },
                      },
                    )
                  }
                >
                  Vincular a {inUse.name ?? "ele"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}{" "}
              {planLimit ? (
                <Link to="/app/assinatura" className="font-medium underline">
                  Ver assinatura
                </Link>
              ) : null}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={save.isPending || name.trim().length < 2}>
              Salvar cliente
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Vincular a cliente
// ---------------------------------------------------------------------------

type LinkDialogProps = {
  open: boolean;
  contactId: string;
  /** Clientes com o mesmo telefone (`link.candidates`), mostrados primeiro. */
  candidates: { id: string; name: string; phone: string | null }[];
  onClose: () => void;
};

export function LinkCustomerDialog({ open, contactId, candidates, onClose }: LinkDialogProps) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const link = useLinkContact(contactId);
  const results = useCustomers({ q, page: 1 }, open && q.length >= 2);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (open) setSearch("");
  }, [open]);

  const found = useMemo(
    () =>
      (results.data?.items ?? [])
        .filter((customer) => !candidates.some(({ id }) => id === customer.id))
        .map(({ id, name, phoneNormalized }) => ({ id, name, phone: phoneNormalized })),
    [results.data, candidates],
  );

  function choose(customerId: string) {
    link.mutate(
      { customerId, userId: null },
      {
        onSuccess: () => {
          toast.success("Contato vinculado ao cliente.");
          onClose();
        },
      },
    );
  }

  const row = (customer: { id: string; name: string; phone: string | null }) => (
    <li key={customer.id} className="flex items-center justify-between gap-2 py-2">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{customer.name}</span>
        {customer.phone ? (
          <span className="block text-xs text-muted-foreground">
            {formatPhoneForDisplay(customer.phone)}
          </span>
        ) : null}
      </span>
      <Button size="sm" variant="outline" disabled={link.isPending} onClick={() => choose(customer.id)}>
        Vincular
      </Button>
    </li>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Vincular a cliente</DialogTitle>
          <DialogDescription>
            O contato passa a mostrar o cadastro do cliente, com etiquetas e campos.
          </DialogDescription>
        </DialogHeader>

        {candidates.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground">Com o mesmo telefone</p>
            <ul className="divide-y divide-border">{candidates.map(row)}</ul>
          </div>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor="link-customer-search">Buscar cliente</Label>
          <Input
            id="link-customer-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nome, e-mail ou documento"
            maxLength={100}
            autoComplete="off"
          />
        </div>

        {q.length >= 2 ? (
          results.isPending ? (
            <p className="text-sm text-muted-foreground">Buscando…</p>
          ) : results.isError ? (
            <p className="text-sm text-destructive">{results.error.message}</p>
          ) : found.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum cliente encontrado.</p>
          ) : (
            <ul className="max-h-60 divide-y divide-border overflow-y-auto">{found.map(row)}</ul>
          )
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
