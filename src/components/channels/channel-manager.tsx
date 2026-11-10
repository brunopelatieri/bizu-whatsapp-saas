import { Plus } from "lucide-react";
import { createElement, useState } from "react";
import { QueryState } from "@/components/admin/query-state";
import { ChannelBadge } from "@/components/channels/channel-badge";
import { CHANNEL_DIALOGS } from "@/components/channels/channel-dialogs";
import { CHANNEL_KINDS } from "@/components/channels/channel-kinds";
import { ChannelStatus } from "@/components/channels/channel-status";
import {
  type Channel,
  type ChannelsResponse,
  TENANT_CHANNELS_PATH,
  useChannelMutation,
  useChannels,
} from "@/components/channels/channels-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type ChannelType, channelTypes } from "@/lib/channels/types";

/** Tipos que este servidor oferece e que a tela sabe conectar. */
function connectableTypes(data: ChannelsResponse | undefined) {
  return channelTypes.filter((type) => data?.providers[type]?.enabled && CHANNEL_DIALOGS[type]);
}

const limitReason = (type: ChannelType, limit: number | null) =>
  `Seu plano permite ${limit ?? 0} número(s) de ${CHANNEL_KINDS[type].label}.`;

/** "Conectar número": escolhe o tipo. No limite do plano, a opção fica desabilitada com o motivo. */
function TypeChooser({
  open,
  data,
  onPick,
  onClose,
}: {
  open: boolean;
  data: ChannelsResponse | undefined;
  onPick: (type: ChannelType) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conectar número</DialogTitle>
          <DialogDescription>Escolha como este número vai se conectar.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2">
          {connectableTypes(data).map((type) => {
            const { label, description, icon: Icon } = CHANNEL_KINDS[type];
            const limit = data?.limits[type];
            const full = limit ? !limit.allowed : false;

            return (
              <li key={type}>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => onPick(type)}
                  className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium text-foreground">{label}</span>
                    <span className="block text-xs text-muted-foreground">{description}</span>
                    {full ? (
                      <span className="block text-xs font-medium text-destructive">
                        {limitReason(type, limit?.limit ?? null)}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/** O diálogo do tipo (`CHANNEL_DIALOGS`), para conectar ou gerenciar. */
function TypeDialog({
  type,
  channel,
  basePath,
  onClose,
}: {
  type: ChannelType | null | undefined;
  channel?: Channel;
  basePath: string;
  onClose: () => void;
}) {
  const dialog = type ? CHANNEL_DIALOGS[type] : undefined;
  if (!dialog) return null;

  return createElement(dialog, { open: true, channel, basePath, onClose });
}

/** Remover pede o nome digitado. Com conversas, o número é desativado e o histórico fica. */
function RemoveDialog({
  channel,
  basePath,
  onClose,
}: {
  channel: Channel | null;
  basePath: string;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const remove = useChannelMutation<{ outcome: "deleted" | "disabled" }>();

  function close() {
    setTyped("");
    onClose();
  }

  async function confirm() {
    if (!channel) return;
    await remove
      .mutateAsync({
        path: `${basePath}/${channel.id}`,
        method: "DELETE",
        body: { confirm: typed },
      })
      .then(close)
      .catch(() => undefined);
  }

  return (
    <Dialog open={channel !== null} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remover número</DialogTitle>
          <DialogDescription>
            {channel?.hasConversations
              ? "Este número tem conversas: ele será desativado, as credenciais apagadas e o histórico mantido."
              : "O número e as credenciais dele serão apagados daqui. Na Meta, nada muda."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor="remove-channel-name" className="text-sm">
            Digite <strong>{channel?.name}</strong> para confirmar
          </label>
          <Input
            id="remove-channel-name"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending || typed !== channel?.name}
            onClick={confirm}
          >
            Remover
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Números de WhatsApp de um escopo: os do tenant (`/app/configuracoes/canais`, base padrão) ou os
 * da plataforma (`/admin/configuracoes/canais`, `basePath = /api/admin/channels`). Mostra estado,
 * tipo e padrão de cada um; conectar, gerenciar, tornar padrão e remover só com `canManage`
 * (`channel:manage` no tenant, `platform_owner` na plataforma). A API decide.
 */
export function ChannelManager({
  basePath = TENANT_CHANNELS_PATH,
  canManage,
}: {
  basePath?: string;
  canManage: boolean;
}) {
  const query = useChannels(basePath);
  const setDefault = useChannelMutation("Número padrão alterado.");
  const [choosing, setChoosing] = useState(false);
  const [connecting, setConnecting] = useState<ChannelType | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Channel | null>(null);

  const channels = query.data?.channels ?? [];
  const managing = channels.find((item) => item.id === managingId);
  const types = connectableTypes(query.data);
  const anyRoom = types.some((type) => query.data?.limits[type]?.allowed);
  const blocked =
    types.length === 0
      ? "Nenhum tipo de número está habilitado neste servidor."
      : !anyRoom
        ? types.map((type) => limitReason(type, query.data?.limits[type]?.limit ?? null)).join(" ")
        : null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">Números de WhatsApp</CardTitle>
        {canManage ? (
          <div className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              disabled={query.isPending || blocked !== null}
              aria-describedby={blocked ? "connect-blocked" : undefined}
              onClick={() => (types.length === 1 && types[0] ? setConnecting(types[0]) : setChoosing(true))}
            >
              <Plus className="size-4" aria-hidden />
              Conectar número
            </Button>
            {blocked && !query.isPending ? (
              <p id="connect-blocked" className="max-w-xs text-right text-xs text-muted-foreground">
                {blocked}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        <QueryState {...query}>
          {channels.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhum número conectado
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {channels.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ChannelBadge type={item.type} name={item.name} />
                      <ChannelStatus status={item.status} detail={item.statusDetail} />
                      {item.isDefault ? <Badge variant="secondary">Padrão</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {CHANNEL_KINDS[item.type].label}
                      {item.identifier ? ` · ${item.identifier}` : ""}
                      {item.verifiedName ? ` · ${item.verifiedName}` : ""}
                    </p>
                    {item.status === "error" && item.statusDetail ? (
                      <p className="text-xs text-destructive">{item.statusDetail}</p>
                    ) : null}
                  </div>
                  {canManage ? (
                    <div className="flex flex-wrap gap-1">
                      {CHANNEL_DIALOGS[item.type] && item.status !== "disabled" ? (
                        <Button variant="outline" size="sm" onClick={() => setManagingId(item.id)}>
                          Gerenciar
                        </Button>
                      ) : null}
                      {!item.isDefault && item.status !== "disabled" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={setDefault.isPending}
                          onClick={() =>
                            setDefault.mutate({
                              path: `${basePath}/${item.id}/default`,
                              method: "POST",
                            })
                          }
                        >
                          Tornar padrão
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(item)}>
                        Remover
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </CardContent>

      <TypeChooser
        open={choosing}
        data={query.data}
        onClose={() => setChoosing(false)}
        onPick={(type) => {
          setChoosing(false);
          setConnecting(type);
        }}
      />
      <TypeDialog type={connecting} basePath={basePath} onClose={() => setConnecting(null)} />
      <TypeDialog
        type={managing?.type}
        channel={managing}
        basePath={basePath}
        onClose={() => setManagingId(null)}
      />
      <RemoveDialog channel={removing} basePath={basePath} onClose={() => setRemoving(null)} />
    </Card>
  );
}
