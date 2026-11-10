import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useTeam } from "@/components/app/team/team-api";
import { useCustomers } from "@/components/app/customers/customers-api";
import { type Page, useAdminQuery } from "@/components/admin/admin-api";
import { type Channel, useChannels } from "@/components/channels/channels-api";
import { errorText, invalidateInbox } from "@/components/inbox/inbox-api";
import { useInboxCan, useInboxScope } from "@/components/inbox/inbox-scope";
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
import { Label } from "@/components/ui/label";
import { PhoneField } from "@/components/ui/phone-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api/client";
import { canWhatsApp, formatPhoneForDisplay, normalizePhone, type PhoneKind } from "@/lib/phone/br";
import { useAuth } from "@/providers/auth-provider";

/** Na plataforma não há `customerId`: o cliente é do owner (a API recusa). */
export type StartTarget = { customerId: string } | { userId: string } | { phone: string };

/** O que a lista de usuários de `/api/admin/users` traz para escolher com quem conversar. */
type PlatformUserRow = { id: string; name: string; email: string; banned: boolean; phoneKind: PhoneKind | null };

/** Tipo do telefone guardado (`phone_normalized`, dígitos com DDI); `null` sem telefone. */
export function phoneKindOf(phoneNormalized: string | null | undefined): PhoneKind | null {
  if (!phoneNormalized) return null;
  const parsed = normalizePhone(`+${phoneNormalized}`);
  return parsed.ok ? parsed.kind : null;
}

/** Números que podem enviar: conectados (o servidor ainda confere). */
export function connectedChannels(channels: Channel[] | undefined) {
  return (channels ?? []).filter((channel) => channel.status === "connected");
}

/** Acha ou cria a conversa (não envia nada) e abre a tela dela. */
export function useStartConversation(onDone?: () => void, silent = false) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scope = useInboxScope();

  return useMutation({
    mutationFn: (body: { channelId: string } & StartTarget) =>
      apiFetch<{ conversation: { id: string } }>(`${scope.api}/conversations`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async ({ conversation }) => {
      await invalidateInbox(queryClient, scope.key);
      onDone?.();
      navigate(`${scope.route}/${conversation.id}`);
    },
    onError: (error) => {
      if (!silent) toast.error(errorText(error));
    },
  });
}

type Mode = "customer" | "member" | "phone";

type NewConversationDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Destino já escolhido (botão "Conversar"): o diálogo só pede o número de saída. */
  preset?: { target: StartTarget; name: string };
};

export function NewConversationDialog({ open, onClose, preset }: NewConversationDialogProps) {
  const can = useInboxCan();
  const scope = useInboxScope();
  const platform = scope.mode === "platform";
  const channels = useChannels(scope.channelsPath);
  const usable = useMemo(() => connectedChannels(channels.data?.channels), [channels.data]);
  const [channelId, setChannelId] = useState<string | undefined>();
  const [mode, setMode] = useState<Mode>(can("customer", "read") ? "customer" : "member");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = useStartConversation(onClose, true);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setQ("");
    setPhone("");
    setError(null);
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // O número padrão (ou o primeiro conectado) já vem escolhido.
  const effectiveChannel =
    channelId && usable.some(({ id }) => id === channelId)
      ? channelId
      : (usable.find(({ isDefault }) => isDefault) ?? usable[0])?.id;

  const customers = useCustomers({ q, page: 1 }, open && !preset && mode === "customer" && can("customer", "read"));
  const team = useTeam(open && !preset && mode === "member" && !platform);
  const platformUsers = useAdminQuery<Page<PlatformUserRow>>(
    "/api/admin/users",
    { q, page: 1, scope: "team" },
    open && !preset && mode === "member" && platform,
  );

  const customerRows = (customers.data?.items ?? []).filter(
    (customer) => canWhatsApp(phoneKindOf(customer.phoneNormalized) ?? "landline"),
  );
  const memberRows = platform
    ? (platformUsers.data?.items ?? [])
        .filter((row) => row.phoneKind && canWhatsApp(row.phoneKind) && !row.banned)
        .map((row) => ({ id: row.id, userId: row.id, name: row.name }))
    : (team.data?.members ?? [])
        .filter((member) => member.phoneKind && canWhatsApp(member.phoneKind))
        .filter((member) => !q || member.name.toLowerCase().includes(q.toLowerCase()));
  const membersLoaded = platform ? platformUsers.isSuccess : team.isSuccess;

  function begin(target: StartTarget) {
    if (!effectiveChannel) return;
    setError(null);
    start.mutate(
      { channelId: effectiveChannel, ...target },
      { onError: (err) => setError(errorText(err)) },
    );
  }

  const channelItems = usable.map((channel) => ({ value: channel.id, label: channel.name }));
  const parsedPhone = phone ? normalizePhone(phone) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{preset ? `Conversar com ${preset.name}` : "Nova conversa"}</DialogTitle>
          <DialogDescription>
            Abre a conversa sem enviar nada. Você escreve a primeira mensagem na tela dela.
          </DialogDescription>
        </DialogHeader>

        {channels.isSuccess && usable.length === 0 ? (
          <p role="alert" className="text-sm text-destructive">
            Nenhum número de WhatsApp conectado. Conecte um em Configurações › Canais.
          </p>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="new-conversation-channel">Número de saída</Label>
            <Select
              items={channelItems}
              value={effectiveChannel ?? ""}
              onValueChange={(next) => next && setChannelId(next)}
            >
              <SelectTrigger id="new-conversation-channel" className="w-full">
                <SelectValue placeholder="Escolha o número" />
              </SelectTrigger>
              <SelectContent>
                {channelItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {preset ? (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button disabled={!effectiveChannel || start.isPending} onClick={() => begin(preset.target)}>
              <MessageSquarePlus />
              Abrir conversa
            </Button>
          </DialogFooter>
        ) : (
          <>
            <Tabs value={mode} onValueChange={(next) => setMode(next as Mode)}>
              <TabsList className="w-full">
                {can("customer", "read") ? <TabsTrigger value="customer">Cliente</TabsTrigger> : null}
                <TabsTrigger value="member">{platform ? "Usuário" : "Equipe"}</TabsTrigger>
                <TabsTrigger value="phone">Telefone</TabsTrigger>
              </TabsList>
            </Tabs>

            {mode === "phone" ? (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (parsedPhone?.ok) begin({ phone });
                }}
              >
                <Label htmlFor="new-conversation-phone">Telefone</Label>
                <PhoneField id="new-conversation-phone" value={phone} onChange={setPhone} />
                {parsedPhone && !parsedPhone.ok ? (
                  <p className="text-xs text-muted-foreground">Complete o número com DDD.</p>
                ) : null}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={onClose}>
                    Cancelar
                  </Button>
                  <Button
                    type="submit"
                    disabled={!effectiveChannel || !parsedPhone?.ok || start.isPending}
                  >
                    Abrir conversa
                  </Button>
                </DialogFooter>
              </form>
            ) : (
              <div className="grid gap-2">
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={mode === "customer" ? "Buscar cliente" : platform ? "Buscar usuário" : "Buscar na equipe"}
                  aria-label="Buscar"
                  maxLength={100}
                  autoComplete="off"
                />
                <ul className="max-h-60 divide-y divide-border overflow-y-auto">
                  {mode === "customer"
                    ? customerRows.map((customer) => (
                        <li key={customer.id} className="flex items-center justify-between gap-2 py-2">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{customer.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {customer.phoneNormalized ? formatPhoneForDisplay(customer.phoneNormalized) : ""}
                            </span>
                          </span>
                          <Button
                            size="sm"
                            disabled={!effectiveChannel || start.isPending}
                            onClick={() => begin({ customerId: customer.id })}
                          >
                            Conversar
                          </Button>
                        </li>
                      ))
                    : memberRows.map((member) => (
                        <li key={member.id} className="flex items-center justify-between gap-2 py-2">
                          <span className="min-w-0 truncate text-sm font-medium">{member.name}</span>
                          <Button
                            size="sm"
                            disabled={!effectiveChannel || start.isPending}
                            onClick={() => begin({ userId: member.userId })}
                          >
                            Conversar
                          </Button>
                        </li>
                      ))}
                </ul>
                {mode === "customer" && customers.isSuccess && customerRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nenhum cliente com telefone de WhatsApp{q ? " para esta busca" : ""}.
                  </p>
                ) : null}
                {mode === "member" && membersLoaded && memberRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {platform ? "Nenhum usuário" : "Ninguém da equipe"} com telefone de WhatsApp{q ? " para esta busca" : ""}.
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Conversar" no detalhe do cliente e na lista de equipe: com `inbox:reply` e telefone. Número que
 * não é WhatsApp (fixo ou celular de 8 dígitos) mantém o botão com a explicação: só abre a conversa de quem
 * já escreveu pelo WhatsApp (o servidor decide). Com um único número
 * conectado, abre a conversa direto; com vários, pergunta de qual sair.
 */
export function StartConversationButton({
  target,
  name,
  phoneKind,
  size = "default",
}: {
  target: { customerId: string } | { userId: string };
  name: string;
  phoneKind: PhoneKind | null;
  size?: "default" | "sm";
}) {
  const can = useInboxCan();
  const scope = useInboxScope();
  const { user, billing } = useAuth();
  const channels = useChannels(scope.channelsPath);
  const [choosing, setChoosing] = useState(false);
  const start = useStartConversation();
  const usable = connectedChannels(channels.data?.channels);

  const tenantReadOnly = scope.mode === "tenant" && billing?.state === "read_only";
  if (!can("inbox", "reply") || user?.impersonatedBy || tenantReadOnly) return null;
  if ("customerId" in target && !can("customer", "read")) return null;
  if (!phoneKind) return null;

  // Fixo e celular de 8 dígitos não abrem conversa nova, mas **abrem** a que já existe: cliente salvo a
  // partir de um contato que escreveu pelo WhatsApp (SPEC, "Iniciar conversa"). A tela não sabe se o
  // contato existe; o servidor decide e o erro (`PHONE_NOT_WHATSAPP`) vira aviso.
  const legacy = !canWhatsApp(phoneKind);

  function click() {
    const only = usable.length === 1 ? usable[0] : undefined;
    if (only) start.mutate({ channelId: only.id, ...target });
    else setChoosing(true);
  }

  return (
    <>
      <Button size={size} variant="outline" disabled={start.isPending} onClick={click}>
        <MessageSquarePlus />
        Conversar
      </Button>
      {legacy ? (
        <p className="w-full text-xs text-muted-foreground">
          Fixo ou celular de 8 dígitos: só abre a conversa de quem já escreveu pelo WhatsApp. Para
          começar uma nova, corrija o número.
        </p>
      ) : null}
      <NewConversationDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        preset={{ target, name }}
      />
    </>
  );
}
