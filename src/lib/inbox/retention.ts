import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { logError } from "@/api/log";
import { type Scope, type Tx, withPlatformData, withPlatformScope, withScope } from "@/db/rls";
import {
  channel,
  conversation,
  file,
  message,
  messageRetentionState,
  organization,
  retentionPolicy,
} from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import type { ChannelType } from "@/lib/channels/types";
import { getEnv } from "@/lib/env";
import { notifyInbox } from "@/lib/inbox/notify";
import {
  emptyRunResult,
  planRetention,
  readRunResult,
  type RetentionConfig,
  retentionConfigFromEnv,
  type RetentionLimits,
  type RetentionPlan,
  type RetentionRunResult,
  retentionCutoffs,
  type RetentionSource,
} from "@/lib/inbox/retention-policy";
import type { RetentionPolicyInput } from "@/lib/schemas/retention";
import { getStorage } from "@/lib/storage";

/**
 * Limpeza de mensagens (bloco R, fase R2, `docs/specs/pre-producao/spec.md`). **Apaga dado sem
 * volta.** A precedência e o piso vêm só de `retention-policy.ts`; aqui só se aplica o plano.
 *
 * Escopo = organização × tipo de canal (ou plataforma × tipo): `message` → `conversation` →
 * `channel.type`. Os tetos valem para o escopo inteiro (C-3), com o ranque `created_at DESC, id DESC`.
 *
 * Três fases, nesta ordem, cada uma com `LIMIT batchLimit`:
 *
 * 1. **idade**: não favorita e `created_at < ageCutoff` (o corte nunca passa do piso);
 * 2. **contagem**: não favorita, ranque (entre as não favoritas que sobraram) acima de
 *    `maxMessages` e `created_at < floorAt`;
 * 3. **favoritas**: ranque (entre as favoritas) acima de `maxFavorites` e `created_at < floorAt`
 *    perdem a estrela; **não são apagadas** agora, só no ciclo seguinte, pelas fases 1 e 2.
 *
 * A prévia e a execução escolhem as vítimas pelo **mesmo código** (`selectVictims`): a prévia só
 * conta, a execução apaga exatamente aquelas (e cada sentença de escrita confere de novo o
 * escopo, o tipo de canal, a estrela e o corte, para uma favorita marcada no meio do caminho não
 * sair). Por isso o que a prévia conta bate com o que a execução apaga no mesmo estado.
 *
 * Toda sentença que toca `message` leva o `tenant_id` do escopo (ou `IS NULL` na plataforma) e o
 * tipo de canal, além do RLS do escopo (`withScope`): uma execução de uma organização nunca
 * alcança mensagem de outra. O conteúdo de mensagem nunca sai daqui: o resultado só tem contagens.
 */

/** Um escopo da limpeza: organização (ou `null`, a plataforma) e tipo de canal. */
export type RetentionTarget = { tenantId: string | null; channelType: ChannelType };

export type RetentionOptions = {
  /** Conta o que seria feito, sem alterar nada (nem `message_retention_state`). Usa `plan.effective`. */
  dryRun?: boolean;
  now?: Date;
  /** Padrão: `retentionConfigFromEnv(getEnv())`. Os testes passam a sua. */
  config?: RetentionConfig;
};

export type RetentionOutcome = {
  plan: RetentionPlan;
  result: RetentionRunResult;
  /** `false` quando a execução de verdade não tinha o que fazer (`!plan.canPurge`): nada foi tocado. */
  ran: boolean;
};

const scopeOf = (tenantId: string | null): Scope =>
  tenantId === null ? { kind: "platform" } : { kind: "tenant", tenantId };

const currentConfig = () => retentionConfigFromEnv(getEnv());

/** `tenant_id = $1` ou `tenant_id IS NULL`: o escopo explícito de cada sentença. */
const tenantIs = (column: PgColumn, tenantId: string | null): SQL =>
  tenantId === null ? isNull(column) : eq(column, tenantId);

const at = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/**
 * `coluna = any($1::uuid[])` com a lista num parâmetro só. `inArray` gera um parâmetro por id, e com
 * `MESSAGE_RETENTION_BATCH_LIMIT` alto (até 100.000) a sentença passaria do limite do Postgres
 * (65.535 parâmetros). Lista vazia: `any` é falso e `all` é verdadeiro, sem caso especial.
 */
const idArray = (ids: string[]) => sql`${sql.param(ids)}::uuid[]`;
const anyId = (column: PgColumn, ids: string[]): SQL => sql`${column} = any(${idArray(ids)})`;
const notAnyId = (column: PgColumn, ids: string[]): SQL => sql`${column} <> all(${idArray(ids)})`;

/** A linha de `retention_policy` da organização (só a plataforma lê); a plataforma não tem linha. */
async function loadPolicyRow(target: RetentionTarget) {
  if (target.tenantId === null) return null;
  const tenantId = target.tenantId;
  return withPlatformData(async (tx) => {
    const [row] = await tx
      .select({
        maxMessages: retentionPolicy.maxMessages,
        retentionDays: retentionPolicy.retentionDays,
        maxFavorites: retentionPolicy.maxFavorites,
      })
      .from(retentionPolicy)
      .where(and(eq(retentionPolicy.tenantId, tenantId), eq(retentionPolicy.channelType, target.channelType)));
    return row ?? null;
  });
}

/** O plano de um escopo, pela precedência de `retention-policy.ts`. */
export async function loadRetentionPlan(
  target: RetentionTarget,
  config: RetentionConfig = currentConfig(),
): Promise<RetentionPlan> {
  return planRetention(config, target.channelType, await loadPolicyRow(target));
}

/** As conversas do escopo: organização (ou plataforma) e tipo de canal. */
function scopeConversations(tx: Tx, target: RetentionTarget) {
  return tx
    .select({ id: conversation.id })
    .from(conversation)
    .innerJoin(channel, eq(channel.id, conversation.channelId))
    .where(
      and(
        tenantIs(conversation.tenantId, target.tenantId),
        tenantIs(channel.tenantId, target.tenantId),
        eq(channel.type, target.channelType),
      ),
    );
}

/** Mensagem do escopo: o `tenant_id` dela e a conversa num canal do tipo, no mesmo escopo. */
const messageInScope = (tx: Tx, target: RetentionTarget) =>
  and(
    tenantIs(message.tenantId, target.tenantId),
    inArray(message.conversationId, scopeConversations(tx, target)),
  ) as SQL;

/** Corta a seleção (`LIMIT batchLimit + 1`) no teto e diz se sobrou. */
function cap(rows: { id: string }[], batchLimit: number) {
  return {
    ids: rows.slice(0, batchLimit).map(({ id }) => id),
    truncated: rows.length > batchLimit,
  };
}

/**
 * As mensagens do escopo (favoritas ou não) cujo ranque `created_at DESC, id DESC`, entre as do mesmo
 * tipo, passa de `max`, e que são mais velhas que o piso. `exclude` tira do ranque o que a fase de
 * idade já escolheu (na seleção; na escrita elas já saíram). Serve à seleção e à reconferência do
 * `DELETE`/`UPDATE`, então as duas sempre usam a mesma regra.
 */
function overCap(
  tx: Tx,
  target: RetentionTarget,
  options: { favorite: boolean; max: number; floorAt: Date; exclude?: string[] },
) {
  const ranked = tx
    .select({
      id: message.id,
      createdAt: message.createdAt,
      rank: sql<number>`row_number() over (order by ${message.createdAt} desc, ${message.id} desc)`.as("rank"),
    })
    .from(message)
    .where(
      and(
        messageInScope(tx, target),
        eq(message.isFavorite, options.favorite),
        options.exclude ? notAnyId(message.id, options.exclude) : undefined,
      ),
    )
    .as("ranked");
  return { ranked, past: and(gt(ranked.rank, options.max), lt(ranked.createdAt, at(options.floorAt))) };
}

/** Ids acima do teto, para reconferir na escrita (o ranque é recalculado na hora da sentença). */
function overCapIds(tx: Tx, target: RetentionTarget, options: { favorite: boolean; max: number; floorAt: Date }) {
  const { ranked, past } = overCap(tx, target, options);
  return tx.select({ id: ranked.id }).from(ranked).where(past);
}

type Victims = {
  byAge: string[];
  byCount: string[];
  demote: string[];
  truncated: boolean;
};

/**
 * Escolhe, sem alterar nada, o que cada fase leva. A fase de contagem ranqueia as não favoritas
 * **que a fase de idade não levou**: é o mesmo conjunto que sobraria depois de apagar, então a
 * prévia (que não apaga) e a execução chegam às mesmas linhas. As favoritas não mudam nas fases 1 e
 * 2, então o ranque delas é o mesmo antes e depois.
 */
async function selectVictims(
  tx: Tx,
  target: RetentionTarget,
  limits: RetentionLimits,
  plan: RetentionPlan,
  now: Date,
): Promise<Victims> {
  const { floorAt, ageCutoff } = retentionCutoffs(plan.floorHours, limits.retentionDays, now);
  const take = plan.batchLimit + 1;
  const inScope = messageInScope(tx, target);
  let truncated = false;

  let byAge: string[] = [];
  if (ageCutoff !== null) {
    const rows = await tx
      .select({ id: message.id })
      .from(message)
      .where(and(inScope, eq(message.isFavorite, false), lt(message.createdAt, at(ageCutoff))))
      .orderBy(asc(message.createdAt), asc(message.id))
      .limit(take);
    const capped = cap(rows, plan.batchLimit);
    byAge = capped.ids;
    truncated ||= capped.truncated;
  }

  const pastCap = async (favorite: boolean, max: number, exclude?: string[]) => {
    const { ranked, past } = overCap(tx, target, { favorite, max, floorAt, exclude });
    const rows = await tx.select({ id: ranked.id }).from(ranked).where(past).orderBy(desc(ranked.rank)).limit(take);
    const capped = cap(rows, plan.batchLimit);
    truncated ||= capped.truncated;
    return capped.ids;
  };

  // A contagem ranqueia as não favoritas que a idade deixou; o lote leva as mais velhas primeiro.
  const byCount = limits.maxMessages !== null ? await pastCap(false, limits.maxMessages, byAge) : [];
  const demote = limits.maxFavorites !== null ? await pastCap(true, limits.maxFavorites) : [];

  return { byAge, byCount, demote, truncated };
}

/**
 * As linhas `file` da mídia das mensagens `ids`: a dona (`owner_type = 'message'`) e a apontada por
 * `message.file_id`, no escopo. Nunca a que outra mensagem (fora de `ids`) ainda aponta.
 */
function mediaOf(tx: Tx, target: RetentionTarget, ids: string[]) {
  const others = tx
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.fileId, file.id), notAnyId(message.id, ids)));
  return and(
    tenantIs(file.tenantId, target.tenantId),
    or(
      and(eq(file.ownerType, "message"), anyId(file.ownerId, ids)),
      inArray(
        file.id,
        tx
          .select({ id: sql<string>`${message.fileId}` })
          .from(message)
          .where(and(anyId(message.id, ids), isNotNull(message.fileId))),
      ),
    ),
    notExists(others),
  ) as SQL;
}

async function scopeTotals(tx: Tx, target: RetentionTarget) {
  const [row] = await tx
    .select({
      messages: sql<number>`count(*)::int`,
      favorites: sql<number>`(count(*) filter (where ${message.isFavorite}))::int`,
    })
    .from(message)
    .where(messageInScope(tx, target));
  return { messages: row?.messages ?? 0, favorites: row?.favorites ?? 0 };
}

/** Prévia: conta o que a execução faria no estado atual, sem gravar nada. */
async function previewInScope(
  tx: Tx,
  target: RetentionTarget,
  plan: RetentionPlan,
  now: Date,
): Promise<RetentionRunResult> {
  const victims = await selectVictims(tx, target, plan.effective, plan, now);
  const doomed = [...victims.byAge, ...victims.byCount];
  const totals = await scopeTotals(tx, target);

  let filesDeleted = 0;
  if (doomed.length > 0) {
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(file)
      .where(mediaOf(tx, target, doomed));
    filesDeleted = row?.total ?? 0;
  }

  return {
    byAge: victims.byAge.length,
    byCount: victims.byCount.length,
    favoritesDemoted: victims.demote.length,
    filesDeleted,
    // Na prévia, os totais são o estado atual (o formato de `RetentionRunResult`).
    messagesTotal: totals.messages,
    favoritesTotal: totals.favorites,
    truncated: victims.truncated,
  };
}

/** Execução de verdade, numa transação do escopo. Devolve as chaves para apagar depois do commit. */
async function purgeInScope(
  tx: Tx,
  target: RetentionTarget,
  plan: RetentionPlan,
  now: Date,
): Promise<{ result: RetentionRunResult; storageKeys: string[] }> {
  const limits = plan.run;
  const { floorAt, ageCutoff } = retentionCutoffs(plan.floorHours, limits.retentionDays, now);
  const victims = await selectVictims(tx, target, limits, plan, now);
  const doomed = [...victims.byAge, ...victims.byCount];

  // Trava as conversas afetadas antes de apagar (a ordem é a da ingestão e do envio: conversa,
  // depois mensagem): uma mensagem nova espera o commit e acerta a prévia da conversa depois.
  const touched =
    doomed.length > 0
      ? await tx
          .select({ id: conversation.id, assignedUserId: conversation.assignedUserId })
          .from(conversation)
          .where(
            and(
              tenantIs(conversation.tenantId, target.tenantId),
              inArray(
                conversation.id,
                tx
                  .selectDistinct({ id: message.conversationId })
                  .from(message)
                  .where(and(anyId(message.id, doomed), tenantIs(message.tenantId, target.tenantId))),
              ),
            ),
          )
          .orderBy(asc(conversation.id))
          .for("update")
      : [];
  const touchedIds = touched.map(({ id }) => id);

  // A mensagem mais recente de cada conversa travada, lida **depois** da trava (nada novo entra até o
  // commit). Se ela estiver entre as apagadas, a prévia do texto da conversa sai (abaixo). Comparar
  // ids evita comparar `created_at`, que perde os microssegundos no caminho para o JavaScript.
  const newestBefore =
    touchedIds.length > 0
      ? await tx
          .select({
            id: conversation.id,
            newest: sql<string | null>`(${tx
              .select({ id: message.id })
              .from(message)
              .where(and(eq(message.conversationId, conversation.id), tenantIs(message.tenantId, target.tenantId)))
              .orderBy(desc(message.createdAt), desc(message.id))
              .limit(1)})`,
          })
          .from(conversation)
          .where(and(anyId(conversation.id, touchedIds), tenantIs(conversation.tenantId, target.tenantId)))
      : [];

  // Cada sentença confere de novo escopo, tipo, estrela e corte: o que mudou desde a seleção
  // (uma estrela marcada agora) não sai.
  const deletedByAge =
    victims.byAge.length > 0 && ageCutoff !== null
      ? await tx
          .delete(message)
          .where(
            and(
              anyId(message.id, victims.byAge),
              messageInScope(tx, target),
              eq(message.isFavorite, false),
              lt(message.createdAt, at(ageCutoff)),
            ),
          )
          .returning({ id: message.id, fileId: message.fileId })
      : [];

  // O ranque é recalculado aqui (as da idade já saíram): uma exclusão concorrente que traga a
  // mensagem de volta para dentro do teto a salva.
  const deletedByCount =
    victims.byCount.length > 0 && limits.maxMessages !== null
      ? await tx
          .delete(message)
          .where(
            and(
              anyId(message.id, victims.byCount),
              messageInScope(tx, target),
              eq(message.isFavorite, false),
              lt(message.createdAt, at(floorAt)),
              inArray(message.id, overCapIds(tx, target, { favorite: false, max: limits.maxMessages, floorAt })),
            ),
          )
          .returning({ id: message.id, fileId: message.fileId })
      : [];

  const deleted = [...deletedByAge, ...deletedByCount];
  const deletedIds = deleted.map(({ id }) => id);
  const deletedFileIds = deleted.flatMap(({ fileId }) => (fileId ? [fileId] : []));

  // A mídia das apagadas: a linha sai aqui, o objeto depois do commit (como `purgeContacts`).
  const files =
    deletedIds.length > 0
      ? await tx
          .delete(file)
          .where(
            and(
              tenantIs(file.tenantId, target.tenantId),
              or(
                and(eq(file.ownerType, "message"), anyId(file.ownerId, deletedIds)),
                anyId(file.id, deletedFileIds),
              ),
              // Mensagem que sobrou e ainda aponta para o arquivo o mantém.
              notExists(tx.select({ id: message.id }).from(message).where(eq(message.fileId, file.id))),
            ),
          )
          .returning({ key: file.key })
      : [];

  const demoted =
    victims.demote.length > 0 && limits.maxFavorites !== null
      ? await tx
          .update(message)
          .set({ isFavorite: false, favoritedAt: null, favoritedBy: null })
          .where(
            and(
              anyId(message.id, victims.demote),
              messageInScope(tx, target),
              eq(message.isFavorite, true),
              lt(message.createdAt, at(floorAt)),
              inArray(message.id, overCapIds(tx, target, { favorite: true, max: limits.maxFavorites, floorAt })),
            ),
          )
          .returning({ conversationId: message.conversationId })
      : [];

  // A prévia do texto (`last_message_preview`) guarda a última mensagem: sai sempre que a mais
  // recente da conversa foi apagada, esvaziada a conversa ou não (sobrando uma favorita mais antiga,
  // por exemplo). Não é recalculada a partir de uma mais antiga. `last_message_at`,
  // `last_inbound_at` (âncora da janela de 24 h e do aviso da tela) e a direção ficam como estão.
  const removed = new Set(deletedIds);
  const lostLatest = newestBefore.flatMap(({ id, newest }) => (newest && removed.has(newest) ? [id] : []));
  if (lostLatest.length > 0) {
    await tx
      .update(conversation)
      .set({ lastMessagePreview: null })
      .where(
        and(
          anyId(conversation.id, lostLatest),
          tenantIs(conversation.tenantId, target.tenantId),
          isNotNull(conversation.lastMessagePreview),
        ),
      );
  }

  // Aviso só com ids: a tela relê a conversa (lista, detalhe e mensagens) pela API. O dono vai
  // junto (lido na trava ou, para a conversa só com favorita rebaixada, numa consulta só).
  const owners = new Map(touched.map(({ id, assignedUserId }) => [id, assignedUserId]));
  const onlyDemoted = [...new Set(demoted.map(({ conversationId }) => conversationId))].filter(
    (id) => !owners.has(id),
  );
  if (onlyDemoted.length > 0) {
    const rows = await tx
      .select({ id: conversation.id, assignedUserId: conversation.assignedUserId })
      .from(conversation)
      .where(and(anyId(conversation.id, onlyDemoted), tenantIs(conversation.tenantId, target.tenantId)));
    for (const { id, assignedUserId } of rows) owners.set(id, assignedUserId);
  }
  for (const [conversationId, assignedUserId] of owners) {
    await notifyInbox(tx, { s: target.tenantId, c: conversationId, k: "message", a: assignedUserId });
  }

  const totals = await scopeTotals(tx, target);

  return {
    result: {
      byAge: deletedByAge.length,
      byCount: deletedByCount.length,
      favoritesDemoted: demoted.length,
      filesDeleted: files.length,
      messagesTotal: totals.messages,
      favoritesTotal: totals.favorites,
      truncated: victims.truncated,
    },
    storageKeys: [...new Set(files.map(({ key }) => key))],
  };
}

/** Grava a última execução do escopo (upsert). Só depois de uma execução de verdade. */
async function saveRunState(target: RetentionTarget, result: RetentionRunResult, now: Date) {
  const lastResult: Record<string, unknown> = { ...result };
  await withPlatformData(async (tx) => {
    const values = {
      tenantId: target.tenantId,
      channelType: target.channelType,
      lastRunAt: now,
      lastResult,
    };
    const set = { lastRunAt: now, lastResult, updatedAt: sql`now()` };
    // Os dois índices únicos são parciais: o da plataforma (`tenant_id` nulo) é só por tipo.
    const conflict =
      target.tenantId === null
        ? { target: messageRetentionState.channelType, targetWhere: sql`${messageRetentionState.tenantId} is null` }
        : {
            target: [messageRetentionState.tenantId, messageRetentionState.channelType],
            targetWhere: sql`${messageRetentionState.tenantId} is not null`,
          };
    await tx.insert(messageRetentionState).values(values).onConflictDoUpdate({ ...conflict, set });
  });
}

/**
 * Limpeza (ou prévia) de um escopo.
 *
 * - Prévia (`dryRun`): `plan.effective`, funciona com a retenção desligada; não altera nada.
 * - Execução: só com `plan.canPurge` (senão nada é tocado, nem o estado); aplica `plan.run`, apaga
 *   os objetos do armazenamento depois do commit e grava `message_retention_state`.
 */
export async function runRetention(
  target: RetentionTarget,
  options: RetentionOptions = {},
): Promise<RetentionOutcome> {
  const now = options.now ?? new Date();
  const plan = await loadRetentionPlan(target, options.config ?? currentConfig());
  const scope = scopeOf(target.tenantId);

  if (options.dryRun) {
    const result = await withScope(scope, (tx) => previewInScope(tx, target, plan, now));
    return { plan, result, ran: false };
  }

  if (!plan.canPurge) return { plan, result: { ...emptyRunResult }, ran: false };

  const { result, storageKeys } = await withScope(scope, (tx) => purgeInScope(tx, target, plan, now));

  for (const key of storageKeys) {
    await getStorage()
      .delete(key)
      .catch((error) => logError("Falha ao apagar arquivo na limpeza de mensagens", error));
  }

  await saveRunState(target, result, now);
  return { plan, result, ran: true };
}

/** Última execução gravada do escopo, ou `null` se nunca rodou. */
export async function lastRetentionRun(
  target: RetentionTarget,
): Promise<{ lastRunAt: Date | null; result: RetentionRunResult } | null> {
  return withPlatformData(async (tx) => {
    const [row] = await tx
      .select({ lastRunAt: messageRetentionState.lastRunAt, lastResult: messageRetentionState.lastResult })
      .from(messageRetentionState)
      .where(
        and(
          tenantIs(messageRetentionState.tenantId, target.tenantId),
          eq(messageRetentionState.channelType, target.channelType),
        ),
      );
    return row ? { lastRunAt: row.lastRunAt, result: readRunResult(row.lastResult) } : null;
  });
}

/**
 * Os escopos com conversa: a plataforma e cada organização, por tipo de canal. Infraestrutura (o job
 * atravessa organizações): só lê ids e tipos.
 */
export async function listRetentionTargets(): Promise<RetentionTarget[]> {
  return withPlatformScope("retenção: escopos com conversa", (tx) =>
    tx
      .selectDistinct({ tenantId: conversation.tenantId, channelType: channel.type })
      .from(conversation)
      .innerJoin(channel, eq(channel.id, conversation.channelId))
      .orderBy(asc(conversation.tenantId), asc(channel.type)),
  );
}

export type RetentionCycleSummary = {
  scopes: number;
  ran: number;
  failed: number;
  truncated: number;
};

/**
 * `inbox.retention`: uma passada por todos os escopos. Desligada, não faz nada. Um escopo que falha
 * vai a `logError` (sem texto de mensagem, sem ids de pessoa) e não impede os demais.
 */
export async function runRetentionCycle(
  options: {
    now?: Date;
    config?: RetentionConfig;
    /** Só para teste: os escopos a percorrer (padrão: `listRetentionTargets()`, todos). */
    targets?: RetentionTarget[];
    /** Só para teste: troca a execução de um escopo (para simular uma falha). */
    run?: typeof runRetention;
  } = {},
): Promise<RetentionCycleSummary> {
  const config = options.config ?? currentConfig();
  const summary: RetentionCycleSummary = { scopes: 0, ran: 0, failed: 0, truncated: 0 };
  if (!config.enabled) return summary;

  const now = options.now ?? new Date();
  const run = options.run ?? runRetention;

  for (const target of options.targets ?? (await listRetentionTargets())) {
    summary.scopes += 1;
    try {
      const outcome = await run(target, { now, config });
      if (outcome.ran) summary.ran += 1;
      if (outcome.result.truncated) summary.truncated += 1;
    } catch (error) {
      summary.failed += 1;
      logError("Falha na limpeza de mensagens de um escopo", error);
    }
  }

  return summary;
}

// ── Leitura e gravação da política pelo `/admin` (rotas `/api/admin/retention/*`) ──────────────

/** O que a tela de retenção mostra de um escopo e tipo de canal. Só números e datas. */
export type RetentionView = {
  channelType: ChannelType;
  /** `MESSAGE_RETENTION_ENABLED`: desligada, a política vale só para a prévia. */
  enabled: boolean;
  floorHours: number;
  batchLimit: number;
  /** A linha de `retention_policy` como está (`null` no campo herda); `null` sem linha (e na plataforma). */
  policy: RetentionPolicyInput | null;
  policyUpdatedAt: string | null;
  /** Padrões do `.env` do tipo de canal (`null` = sem limite). */
  defaults: RetentionLimits;
  /** O que a política manda (linha, depois `.env`): o que a prévia usa. */
  effective: RetentionLimits;
  sources: Record<keyof RetentionLimits, RetentionSource>;
  /** Última execução de verdade, ou `null` se nunca rodou. */
  lastRun: { at: string | null; result: RetentionRunResult } | null;
};

/** Organização que existe e não foi excluída (a anonimizada não tem o que limpar nem ajustar). */
export async function retentionTenantExists(tenantId: string): Promise<boolean> {
  const [row] = await withPlatformScope("retenção: organização do /admin", (tx) =>
    tx
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.id, tenantId), sql`${organization.status} <> 'deleted'`)),
  );
  return Boolean(row);
}

export async function getRetentionView(
  target: RetentionTarget,
  config: RetentionConfig = currentConfig(),
): Promise<RetentionView> {
  const row =
    target.tenantId === null
      ? null
      : await withPlatformData(async (tx) => {
          const [found] = await tx
            .select({
              maxMessages: retentionPolicy.maxMessages,
              retentionDays: retentionPolicy.retentionDays,
              maxFavorites: retentionPolicy.maxFavorites,
              updatedAt: retentionPolicy.updatedAt,
            })
            .from(retentionPolicy)
            .where(
              and(
                eq(retentionPolicy.tenantId, target.tenantId as string),
                eq(retentionPolicy.channelType, target.channelType),
              ),
            );
          return found ?? null;
        });

  const plan = planRetention(config, target.channelType, row);
  const last = await lastRetentionRun(target);

  return {
    channelType: target.channelType,
    enabled: plan.enabled,
    floorHours: plan.floorHours,
    batchLimit: plan.batchLimit,
    policy: row
      ? { maxMessages: row.maxMessages, retentionDays: row.retentionDays, maxFavorites: row.maxFavorites }
      : null,
    policyUpdatedAt: row ? row.updatedAt.toISOString() : null,
    defaults: { ...config.defaults[target.channelType] },
    effective: plan.effective,
    sources: plan.sources,
    lastRun: last ? { at: last.lastRunAt?.toISOString() ?? null, result: last.result } : null,
  };
}

/**
 * Grava a linha de `retention_policy` da organização e tipo de canal (upsert) e audita na mesma
 * transação, sem `tenant_id` (só a plataforma lê) e só com números. Quem chama já conferiu a
 * organização (`retentionTenantExists`).
 */
export async function saveRetentionPolicy(
  tenantId: string,
  channelType: ChannelType,
  input: RetentionPolicyInput,
  actor: { userId: string; ip: string | null },
): Promise<void> {
  await withPlatformData(async (tx) => {
    const values = {
      maxMessages: input.maxMessages,
      retentionDays: input.retentionDays,
      maxFavorites: input.maxFavorites,
      updatedBy: actor.userId,
    };
    await tx
      .insert(retentionPolicy)
      .values({ tenantId, channelType, ...values })
      .onConflictDoUpdate({
        target: [retentionPolicy.tenantId, retentionPolicy.channelType],
        set: { ...values, updatedAt: sql`now()` },
      });
    await auditInTransaction(tx, "admin.retention_policy_updated", {
      actor: { type: "platform", id: actor.userId },
      tenantId: null,
      ip: actor.ip,
      target: { type: "tenant", id: tenantId },
      metadata: { channelType, ...input },
    });
  });
}
