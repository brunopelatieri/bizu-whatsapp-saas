import { ArrowLeft, ChevronDown, Hand, PanelRight, Undo2, UserRoundCog } from "lucide-react";
import { ChannelBadge } from "@/components/channels/channel-badge";
import { contactLabel, initialsOf } from "@/components/inbox/format";
import {
  type ConversationResponse,
  useAssignees,
  useInboxMutation,
} from "@/components/inbox/inbox-api";
import { useInboxCan, useInboxScope } from "@/components/inbox/inbox-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONVERSATION_STATUS_LABELS } from "@/components/inbox/labels";
import type { ConversationStatus } from "@/lib/inbox/constants";
import { displayPhone } from "@/lib/phone/br";
import { useAuth } from "@/providers/auth-provider";

type ConversationHeaderProps = {
  detail: ConversationResponse;
  /** Tela estreita: volta para a lista. */
  onBack: () => void;
  /** Abaixo de `xl` o painel do contato é uma tela à parte. */
  onOpenPanel: () => void;
};

const STATUS_ACTIONS: Record<ConversationStatus, { to: ConversationStatus; label: string }[]> = {
  open: [
    { to: "pending", label: "Marcar como pendente" },
    { to: "closed", label: "Encerrar conversa" },
  ],
  pending: [
    { to: "open", label: "Reabrir (aberta)" },
    { to: "closed", label: "Encerrar conversa" },
  ],
  closed: [{ to: "open", label: "Reabrir conversa" }],
};

export function ConversationHeader({ detail, onBack, onOpenPanel }: ConversationHeaderProps) {
  const { user, billing } = useAuth();
  const can = useInboxCan();
  const inbox = useInboxScope();
  // Só o tenant tem fila, dono, assumir e transferir; a plataforma tem só a lista.
  const tenantMode = inbox.mode === "tenant";
  const { conversation, contact } = detail;
  const base = `${inbox.api}/conversations/${conversation.id}`;
  const readOnly =
    Boolean(user?.impersonatedBy) || (tenantMode && billing?.state === "read_only");
  const canReply = can("inbox", "reply") && !readOnly;
  const canAssign = can("inbox", "assign") && !readOnly;
  const owner = conversation.assignedTo;
  const mine = owner?.id === user?.id;

  const scope = { conversationId: conversation.id, messages: false };
  const claim = useInboxMutation({ success: "Conversa assumida.", ...scope });
  const release = useInboxMutation({ success: "Conversa devolvida à fila.", ...scope });
  const transfer = useInboxMutation({ success: "Conversa transferida.", ...scope });
  const status = useInboxMutation({ success: "Situação atualizada.", ...scope });
  const assignees = useAssignees(canAssign);

  const label = contactLabel({ displayName: contact.displayName, phone: contact.phone });
  const phone = displayPhone(`+${contact.phone}`);
  const busy = claim.isPending || release.isPending || transfer.isPending || status.isPending;
  const transferTargets = (assignees.data ?? []).filter(({ id }) => id !== owner?.id);

  return (
    <header className="space-y-2 border-b border-border bg-background px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Voltar para a lista" onClick={onBack}>
          <ArrowLeft />
        </Button>

        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
          aria-hidden
        >
          {initialsOf(label)}
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{label}</h2>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {contact.displayName && phone ? <span>{phone}</span> : null}
            <ChannelBadge type={conversation.channel.type} name={conversation.channel.name} className="text-xs" />
          </p>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="xl:hidden"
          aria-label="Dados do contato"
          onClick={onOpenPanel}
        >
          <PanelRight />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={conversation.status === "closed" ? "outline" : "secondary"}>
          {CONVERSATION_STATUS_LABELS[conversation.status]}
        </Badge>
        {tenantMode ? (
          <span className="text-xs text-muted-foreground">
            {owner ? (mine ? "Com você" : `Com ${owner.name}`) : "Na fila"}
          </span>
        ) : null}

        {tenantMode && canReply && !owner ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => claim.mutate({ path: `${base}/claim`, method: "POST" })}
          >
            <Hand />
            Assumir
          </Button>
        ) : null}

        {owner && ((mine && canReply) || canAssign) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              release.mutate({ path: `${base}/assign`, method: "POST", body: { userId: null } })
            }
          >
            <Undo2 />
            Devolver à fila
          </Button>
        ) : null}

        {canAssign ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>
              <UserRoundCog />
              Transferir
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 min-w-48 overflow-y-auto">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Transferir para</DropdownMenuLabel>
                {assignees.isPending ? <DropdownMenuLabel>Carregando…</DropdownMenuLabel> : null}
                {assignees.isError ? <DropdownMenuLabel>Não foi possível carregar.</DropdownMenuLabel> : null}
                {assignees.data && transferTargets.length === 0 ? (
                  <DropdownMenuLabel>Ninguém mais pode receber.</DropdownMenuLabel>
                ) : null}
                {transferTargets.map((target) => (
                  <DropdownMenuItem
                    key={target.id}
                    onClick={() =>
                      transfer.mutate({
                        path: `${base}/assign`,
                        method: "POST",
                        body: { userId: target.id },
                      })
                    }
                  >
                    {target.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {canReply ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="outline" disabled={busy} />}>
              Situação
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {STATUS_ACTIONS[conversation.status].map((action) => (
                <DropdownMenuItem
                  key={action.to}
                  onClick={() =>
                    status.mutate({ path: `${base}/status`, method: "POST", body: { status: action.to } })
                  }
                >
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  );
}
