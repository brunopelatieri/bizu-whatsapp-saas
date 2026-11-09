import { and, count, desc, eq, lt, type SQL, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { type Scope, type Tx, withPlatformScope, withScope } from "@/db/rls";
import {
  channel,
  channelEvent,
  channelEvolution,
  channelWhatsappCloud,
  messageTemplate,
  organization,
} from "@/db/schema";
import { getBoss } from "@/jobs/boss";
import { type ChannelInboundJob, QUEUE } from "@/jobs/queues";
import { ChannelNotConfiguredError } from "@/lib/channels/errors";
import { logChannelError, sanitizeChannelError } from "@/lib/channels/log";
import { findProvider } from "@/lib/channels/registry";
import { applyChannelStatus } from "@/lib/channels/service";
import type {
  ChannelEventKind,
  ChannelEventStatus,
  ChannelType,
  NormalizedConnection,
  NormalizedEvent,
  NormalizedMessage,
  NormalizedStatus,
  NormalizedTemplate,
} from "@/lib/channels/types";
import { PAGE_SIZE } from "@/lib/schemas/admin";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Caixa de entrada dos avisos de provedor (`channel_event`). O webhook grava e enfileira; o job
 * `channel.inbound` aplica, com retry e fila morta. Reconhecer rápido evita a Meta e a Evolution
 * reenviarem à toa, e a unique `(channel_id, dedupe_key)` torna o reenvio inofensivo.
 */

type ChannelRow = typeof channel.$inferSelect;

export const scopeOf = (tenantId: string | null): Scope =>
  tenantId ? { kind: "tenant", tenantId } : { kind: "platform" };

/** Só informativo: um corpo da Meta pode misturar mensagens e status; vale o primeiro evento. */
export function classifyEvents(events: readonly NormalizedEvent[]): ChannelEventKind {
  return events[0]?.type ?? "other";
}

// ---------------------------------------------------------------------------
// Recebimento
// ---------------------------------------------------------------------------

/** `duplicate`: o aviso já estava na caixa. `pending`: ainda não terminou lá. */
export async function receiveChannelEvent(input: {
  scope: Scope;
  channelId: string;
  provider: ChannelType;
  dedupeKey: string;
  kind: ChannelEventKind;
  raw: unknown;
}) {
  return withScope(input.scope, async (tx) => {
    const [created] = await tx
      .insert(channelEvent)
      .values({
        tenantId: input.scope.kind === "tenant" ? input.scope.tenantId : null,
        channelId: input.channelId,
        provider: input.provider,
        dedupeKey: input.dedupeKey,
        kind: input.kind,
        raw: input.raw ?? {},
      })
      .onConflictDoNothing({ target: [channelEvent.channelId, channelEvent.dedupeKey] })
      .returning({ id: channelEvent.id });

    if (created) return { id: created.id, duplicate: false, pending: true };

    const [existing] = await tx
      .select({ id: channelEvent.id, status: channelEvent.status })
      .from(channelEvent)
      .where(
        and(
          eq(channelEvent.channelId, input.channelId),
          eq(channelEvent.dedupeKey, input.dedupeKey),
        ),
      );
    if (!existing) throw new Error("aviso não encontrado após conflito");

    return { id: existing.id, duplicate: true, pending: existing.status === "pending" };
  });
}

type Enqueue = (channelEventId: string) => Promise<void>;

const enqueueWithBoss: Enqueue = async (channelEventId) => {
  const boss = await getBoss();
  const job: ChannelInboundJob = { channelEventId };
  // A fila é `exclusive`: com um job vivo para o aviso, `send` não cria outro.
  await boss.send(QUEUE.channelInbound, job, { singletonKey: channelEventId });
};

let enqueue: Enqueue = enqueueWithBoss;

export const enqueueChannelEvent: Enqueue = (channelEventId) => enqueue(channelEventId);

/** Sem pg-boss nos testes de fluxo: eles chamam o job direto. `undefined` restaura. */
export function setChannelQueueForTests(next: Enqueue | undefined) {
  enqueue = next ?? enqueueWithBoss;
}

// ---------------------------------------------------------------------------
// Aplicação (job)
// ---------------------------------------------------------------------------

/** `message` e `status` são da caixa de entrada (C1): até lá ficam `ignored`. */
export type InboxHandlers = {
  message?: (tx: Tx, scope: Scope, target: ChannelRow, event: NormalizedMessage) => Promise<boolean>;
  status?: (tx: Tx, scope: Scope, target: ChannelRow, event: NormalizedStatus) => Promise<boolean>;
};

let inboxHandlers: InboxHandlers = {};

/** A caixa de entrada registra aqui como aplica mensagens e status. */
export function setInboxHandlers(next: InboxHandlers) {
  inboxHandlers = next;
}

/**
 * Número que o aviso cita, entre os canais **do mesmo escopo** do canal cuja assinatura foi
 * conferida. Um aplicativo da Meta tem um endereço para todos os números assinados nele: o aviso
 * que chega na chave do canal A pode trazer mudança do número B. Número de outro escopo é
 * descartado: o RLS e o filtro de escopo recusam, e o evento não toca em ninguém.
 */
async function resolveTarget(
  tx: Tx,
  scope: Scope,
  origin: ChannelRow,
  phoneNumberId: string | undefined,
): Promise<ChannelRow | null> {
  if (!phoneNumberId) return origin;

  const [own] = await tx
    .select({ phoneNumberId: channelWhatsappCloud.phoneNumberId })
    .from(channelWhatsappCloud)
    .where(eq(channelWhatsappCloud.channelId, origin.id));
  if (!own || own.phoneNumberId === phoneNumberId) return origin;

  const [row] = await tx
    .select({ channel })
    .from(channelWhatsappCloud)
    .innerJoin(channel, eq(channel.id, channelWhatsappCloud.channelId))
    .where(
      and(
        eq(channelWhatsappCloud.phoneNumberId, phoneNumberId),
        scope.kind === "tenant"
          ? eq(channel.tenantId, scope.tenantId)
          : sql`${channel.tenantId} is null`,
      ),
    );

  return row?.channel ?? null;
}

async function applyConnection(tx: Tx, target: ChannelRow, event: NormalizedConnection) {
  await applyChannelStatus(tx, target.id, {
    status: event.status,
    detail: event.detail,
    identifier: event.phone,
  });

  if (event.phone || event.jid) {
    await tx
      .update(channelEvolution)
      .set({
        ...(event.phone ? { connectedPhone: event.phone } : {}),
        ...(event.jid ? { connectedJid: event.jid } : {}),
      })
      .where(eq(channelEvolution.channelId, target.id));
  }

  return true;
}

/**
 * Estado do modelo, só de modelo que já existe neste escopo: criar é da sincronização
 * (`templates/sync`). WABA que não é de nenhum canal do escopo é descartado.
 */
async function applyTemplate(tx: Tx, scope: Scope, event: NormalizedTemplate) {
  if (event.event !== "status" || !event.templateStatus || !event.wabaId) return false;

  const owned = await tx
    .select({ id: channelWhatsappCloud.channelId })
    .from(channelWhatsappCloud)
    .where(eq(channelWhatsappCloud.wabaId, event.wabaId))
    .limit(1);
  if (owned.length === 0) return false;

  const tenantId = scope.kind === "tenant" ? scope.tenantId : null;
  const where: SQL[] = [
    eq(messageTemplate.wabaId, event.wabaId),
    tenantId ? eq(messageTemplate.tenantId, tenantId) : sql`${messageTemplate.tenantId} is null`,
  ];

  if (event.providerTemplateId) {
    where.push(eq(messageTemplate.providerTemplateId, event.providerTemplateId));
  } else if (event.name && event.language) {
    where.push(eq(messageTemplate.name, event.name), eq(messageTemplate.language, event.language));
  } else {
    return false;
  }

  const updated = await tx
    .update(messageTemplate)
    .set({ status: event.templateStatus })
    .where(and(...where))
    .returning({ id: messageTemplate.id });

  return updated.length > 0;
}

/** `true` quando mudou algo; `false` vira `ignored`. Idempotente. */
export async function applyChannelEvent(
  tx: Tx,
  scope: Scope,
  origin: ChannelRow,
  event: NormalizedEvent,
): Promise<boolean> {
  switch (event.type) {
    case "connection":
      return applyConnection(tx, origin, event);
    case "template":
      return applyTemplate(tx, scope, event);
    case "message":
    case "status": {
      const target = await resolveTarget(tx, scope, origin, event.channelPhoneNumberId);
      if (!target || target.status === "disabled") return false;

      const handler = event.type === "message" ? inboxHandlers.message : inboxHandlers.status;
      // Sem a caixa de entrada, o aviso fica `ignored`: nada é aplicado.
      return handler ? handler(tx, scope, target, event as never) : false;
    }
  }
}

type Outcome = "processed" | "ignored" | "skipped";

async function tenantIsActive(tenantId: string) {
  const [row] = await getDb()
    .select({ status: organization.status })
    .from(organization)
    .where(eq(organization.id, tenantId));

  return row?.status === "active";
}

async function markIgnored(id: string, reason: string, now: Date) {
  await withPlatformScope("channel.inbound: ignora aviso", (tx) =>
    tx
      .update(channelEvent)
      .set({ status: "ignored", error: reason, processedAt: now })
      .where(and(eq(channelEvent.id, id), eq(channelEvent.status, "pending"))),
  );
}

/**
 * Aplica um aviso da caixa. Tentativa que falha soma `attempts` e guarda o erro sem dado
 * pessoal; na última tentativa o aviso vira `failed` e o job segue para a fila morta.
 */
export async function processChannelEvent(
  id: string,
  options: { now?: Date; lastAttempt?: boolean } = {},
): Promise<Outcome> {
  const now = options.now ?? new Date();

  const row = await withPlatformScope("channel.inbound: carrega aviso", async (tx) => {
    const [event] = await tx.select().from(channelEvent).where(eq(channelEvent.id, id));
    if (event?.status !== "pending") return null;

    const [origin] = await tx.select().from(channel).where(eq(channel.id, event.channelId));
    return origin ? { event, origin } : null;
  });
  if (!row) return "skipped";

  const { event, origin } = row;
  const scope = scopeOf(origin.tenantId);

  try {
    if (origin.status === "disabled") {
      await markIgnored(id, "canal desativado", now);
      return "ignored";
    }
    // Organização suspensa ou em exclusão: o webhook segue recebendo, mas nada é aplicado.
    if (origin.tenantId && !(await tenantIsActive(origin.tenantId))) {
      await markIgnored(id, "organização inativa", now);
      return "ignored";
    }

    const provider = findProvider(origin.type);
    if (!provider) throw new ChannelNotConfiguredError(origin.type);

    const normalized = provider.normalizeEvents(event.raw);

    return await withScope(scope, async (tx) => {
      // Dois jobs do mesmo aviso: o segundo espera aqui e encontra o trabalho feito.
      const [current] = await tx
        .select({ status: channelEvent.status })
        .from(channelEvent)
        .where(eq(channelEvent.id, id))
        .for("update");
      if (current?.status !== "pending") return "skipped" as const;

      let applied = false;
      for (const item of normalized) {
        applied = (await applyChannelEvent(tx, scope, origin, item)) || applied;
      }

      const status: ChannelEventStatus = applied ? "processed" : "ignored";
      await tx
        .update(channelEvent)
        .set({ status, processedAt: now, error: null })
        .where(eq(channelEvent.id, id));

      return status;
    });
  } catch (error) {
    await recordFailure(id, error, options.lastAttempt ?? false);
    throw error;
  }
}

async function recordFailure(id: string, error: unknown, lastAttempt: boolean) {
  try {
    await withPlatformScope("channel.inbound: marca falha", (tx) =>
      tx
        .update(channelEvent)
        .set({
          attempts: sql`${channelEvent.attempts} + 1`,
          error: sanitizeChannelError(error),
          // Só a última tentativa fecha o aviso; as outras o deixam para o retry.
          ...(lastAttempt ? { status: "failed" as const } : {}),
        })
        .where(eq(channelEvent.id, id)),
    );
  } catch (writeError) {
    logChannelError("Falha ao registrar erro de aviso de canal", writeError);
  }
}

// ---------------------------------------------------------------------------
// Administração
// ---------------------------------------------------------------------------

/** `raw` tem dado pessoal e fica fora da listagem. */
export async function listChannelEvents(input: { status?: ChannelEventStatus; page: number }) {
  const where = input.status ? eq(channelEvent.status, input.status) : undefined;

  return withPlatformScope("admin: lista avisos de canal", async (tx) => {
    const [total] = await tx.select({ total: count() }).from(channelEvent).where(where);
    const items = await tx
      .select({
        id: channelEvent.id,
        channelId: channelEvent.channelId,
        channelName: channel.name,
        tenantId: channelEvent.tenantId,
        provider: channelEvent.provider,
        kind: channelEvent.kind,
        status: channelEvent.status,
        attempts: channelEvent.attempts,
        error: channelEvent.error,
        receivedAt: channelEvent.receivedAt,
        processedAt: channelEvent.processedAt,
      })
      .from(channelEvent)
      .innerJoin(channel, eq(channel.id, channelEvent.channelId))
      .where(where)
      .orderBy(desc(channelEvent.receivedAt))
      .limit(PAGE_SIZE)
      .offset((input.page - 1) * PAGE_SIZE);

    return { items, total: total?.total ?? 0, pageSize: PAGE_SIZE };
  });
}

/** Só `failed` ou `ignored` voltam: o que já foi processado não repete. */
export async function reprocessChannelEvent(id: string) {
  const [event] = await withPlatformScope("admin: reprocessa aviso de canal", async (tx) => {
    const [row] = await tx
      .select({ status: channelEvent.status })
      .from(channelEvent)
      .where(eq(channelEvent.id, id))
      .for("update");

    if (!row) throw notFound("Evento não encontrado.");
    if (row.status !== "failed" && row.status !== "ignored") {
      throw new TenantRuleError(409, "NOT_REPROCESSABLE", "Este evento não pode ser reprocessado.");
    }

    return tx
      .update(channelEvent)
      .set({ status: "pending", error: null, processedAt: null, attempts: 0 })
      .where(eq(channelEvent.id, id))
      .returning({ id: channelEvent.id });
  });

  if (event) await enqueueChannelEvent(event.id);
  return event;
}

/** Aviso que ficou sem job (fila fora do ar na hora): `channel.health` o devolve. */
export async function requeueStuckChannelEvents(now: Date, ageMinutes = 10) {
  const cutoff = new Date(now.getTime() - ageMinutes * 60_000);
  const stuck = await withPlatformScope("channel.health: avisos parados", (tx) =>
    tx
      .select({ id: channelEvent.id })
      .from(channelEvent)
      .where(
        and(
          eq(channelEvent.status, "pending"),
          lt(channelEvent.receivedAt, sql`${cutoff.toISOString()}::timestamptz`),
        ),
      ),
  );

  for (const { id } of stuck) await enqueueChannelEvent(id);
  return stuck.length;
}
