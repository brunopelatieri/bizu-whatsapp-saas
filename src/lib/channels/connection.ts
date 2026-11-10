import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Scope, Tx } from "@/db/rls";
import { channel, channelEvent, channelEvolution } from "@/db/schema";
import { audit, auditInTransaction } from "@/lib/audit";
import { transferPairingSecrets } from "@/lib/channels/credentials";
import { applyChannelStatus, electDefault, lockScopeType, scopeWhere } from "@/lib/channels/service";
import type { ChannelContext, ChannelStatus } from "@/lib/channels/types";

/**
 * Estado de conexão dos canais com pareamento: o que o aviso `connection` (ou a consulta ao
 * provedor) informa vira `channel.status`, telefone conectado e auditoria. Também faz a
 * **readoção**: o mesmo número que reconecta em um canal novo volta para o canal antigo do
 * escopo, para o histórico de conversas não se partir (spec, "Mesmo número, canal novo").
 */

type ChannelRow = typeof channel.$inferSelect;

export type ConnectionState = {
  status: Extract<ChannelStatus, "connected" | "connecting" | "disconnected">;
  detail: string | null;
  phone: string | null;
  jid: string | null;
};

/** Trabalho para depois do commit (falar com o provedor, auditoria da plataforma). */
export type AfterCommit = Array<() => Promise<void>>;

export type ConnectionResult = {
  /** Canal que ficou com a conexão: o próprio, ou o antigo readotado. */
  channelId: string;
  readopted: boolean;
  changed: boolean;
};

async function recordTransition(
  tx: Tx,
  scope: Scope,
  target: { id: string; type: ChannelRow["type"] },
  action: "channel.connected" | "channel.disconnected",
  after: AfterCommit | undefined,
) {
  const channelId = target.id;
  const entry = {
    actor: { type: "system" as const, id: null },
    target: { type: "channel", id: channelId },
    metadata: { type: target.type, channelId },
  };

  if (scope.kind === "tenant") {
    await auditInTransaction(tx, action, { ...entry, tenantId: scope.tenantId });
  } else {
    // `audit_log` só tem política de tenant: a linha da plataforma sai depois do commit.
    after?.push(() => audit(action, { ...entry, tenantId: null }));
  }
}

/**
 * Canal antigo do mesmo número, no mesmo escopo, que não está conectado: desativado (removido
 * com conversas) ou caído. O mais antigo ganha, porque é onde o histórico começou.
 */
async function findPrevious(tx: Tx, scope: Scope, current: ChannelRow, phone: string) {
  const [row] = await tx
    .select({ channel, evolution: channelEvolution })
    .from(channelEvolution)
    .innerJoin(channel, eq(channel.id, channelEvolution.channelId))
    .where(
      and(
        scopeWhere(scope),
        eq(channel.type, current.type),
        ne(channel.id, current.id),
        ne(channel.status, "connected"),
        eq(channelEvolution.connectedPhone, phone),
      ),
    )
    .orderBy(asc(channel.createdAt))
    .limit(1)
    .for("update");

  return row ?? null;
}

/**
 * Passa a instância do canal novo para o antigo e apaga o novo. Os segredos são recifrados
 * (o `aad` leva o id do canal). Os avisos pendentes do canal novo seguem para o antigo.
 */
async function readopt(
  tx: Tx,
  current: ChannelRow,
  previous: NonNullable<Awaited<ReturnType<typeof findPrevious>>>,
  after: AfterCommit | undefined,
  destroyRemote: ((ctx: ChannelContext) => Promise<void>) | undefined,
) {
  const [mine] = await tx
    .select()
    .from(channelEvolution)
    .where(eq(channelEvolution.channelId, current.id))
    .for("update");
  if (!mine) return false;

  const oldId = previous.channel.id;
  const leftover = previous.evolution.remoteInstanceId;
  const secrets = transferPairingSecrets(mine, oldId);

  // Avisos do canal novo passam ao antigo; o que colidir na única some com o canal novo.
  await tx.execute(sql`
    update ${channelEvent} set channel_id = ${oldId}
    where channel_id = ${current.id}
      and not exists (
        select 1 from ${channelEvent} other
        where other.channel_id = ${oldId} and other.dedupe_key = ${channelEvent}.dedupe_key
      )
  `);

  // Apaga antes de gravar no antigo: nome da instância e hash do segredo são únicos.
  await tx.delete(channel).where(eq(channel.id, current.id));
  await tx
    .update(channelEvolution)
    .set({
      remoteInstanceId: mine.remoteInstanceId,
      remoteInstanceName: mine.remoteInstanceName,
      webhookSecretHash: mine.webhookSecretHash,
      advancedSettings: mine.advancedSettings,
      lastQrAt: mine.lastQrAt,
      lastError: null,
      ...secrets,
    })
    .where(eq(channelEvolution.channelId, oldId));

  // Volta à vida com o nome que o usuário acabou de dar; `applyChannelStatus` não mexe em
  // canal `disabled`, então o estado intermediário sai daqui.
  await tx
    .update(channel)
    .set({ name: current.name, status: "connecting", statusDetail: null })
    .where(eq(channel.id, oldId));

  // Instância velha que ainda vivia no servidor (canal caído, não removido): fica órfã.
  if (leftover && destroyRemote && leftover !== mine.remoteInstanceId) {
    after?.push(() =>
      destroyRemote({
        channelId: oldId,
        type: current.type,
        credentials: { remoteInstanceId: leftover },
      }),
    );
  }

  return true;
}

/**
 * Aplica o estado de conexão. Idempotente: o mesmo aviso de novo não audita nem readota.
 * `destroyRemote` é o `destroy` do módulo, para a instância que sobra na readoção.
 */
export async function applyConnectionState(
  tx: Tx,
  scope: Scope,
  origin: Pick<ChannelRow, "id">,
  state: ConnectionState,
  options: {
    after?: AfterCommit;
    destroyRemote?: (ctx: ChannelContext) => Promise<void>;
    now?: Date;
  } = {},
): Promise<ConnectionResult> {
  const [current] = await tx
    .select()
    .from(channel)
    .where(and(eq(channel.id, origin.id), scopeWhere(scope)))
    .for("update");

  // Canal apagado (ou readotado por um aviso anterior) ou desativado: nada a aplicar.
  if (!current || current.status === "disabled") {
    return { channelId: origin.id, readopted: false, changed: false };
  }

  let targetId = current.id;
  let previousStatus: ChannelStatus = current.status;
  let readopted = false;

  if (state.status === "connected" && state.phone) {
    await lockScopeType(tx, scope, current.type);
    const previous = await findPrevious(tx, scope, current, state.phone);

    if (previous) {
      readopted = await readopt(tx, current, previous, options.after, options.destroyRemote);
      if (readopted) {
        targetId = previous.channel.id;
        previousStatus = previous.channel.status;
      }
    }
  }

  await applyChannelStatus(
    tx,
    targetId,
    { status: state.status, detail: state.detail, identifier: state.phone },
    options.now,
  );

  if (state.phone || state.jid) {
    await tx
      .update(channelEvolution)
      .set({
        ...(state.phone ? { connectedPhone: state.phone } : {}),
        ...(state.jid ? { connectedJid: state.jid } : {}),
      })
      .where(eq(channelEvolution.channelId, targetId));
  }

  const changed = readopted || previousStatus !== state.status;

  if (changed && state.status === "connected") {
    await recordTransition(tx, scope, { id: targetId, type: current.type }, "channel.connected", options.after);
  } else if (changed && state.status === "disconnected" && previousStatus === "connected") {
    await recordTransition(
      tx,
      scope,
      { id: targetId, type: current.type },
      "channel.disconnected",
      options.after,
    );
  }

  // Conectou (pode ser o primeiro ativo do tipo) ou caiu o padrão: o padrão é reavaliado.
  if (changed) await electDefault(tx, scope, current.type);

  return { channelId: targetId, readopted, changed };
}
