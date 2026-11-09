import { and, asc, count, eq, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import { logChannelError } from "@/lib/channels/log";
import { type Scope, type Tx, withScope } from "@/db/rls";
import { channel, channelEvolution, channelWhatsappCloud } from "@/db/schema";
import { audit, type AuditAction, auditInTransaction } from "@/lib/audit";
import { assertWithinLimit, checkLimit } from "@/lib/billing/limits";
import {
  cloudCredentials,
  evolutionConfigOf,
  evolutionCredentials,
  openSecret,
} from "@/lib/channels/credentials";
import { findProvider } from "@/lib/channels/registry";
import {
  CHANNEL_LIMIT_METRICS,
  type ChannelContext,
  type ChannelStatus,
  type ChannelType,
  channelTypes,
} from "@/lib/channels/types";
import { SecretDecryptError } from "@/lib/crypto/secrets";
import { maskSecret } from "@/lib/tenant/credentials";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Regras comuns dos canais, para os dois escopos (`Scope`): as rotas de `/api/channels/*` e
 * `/api/admin/channels/*` só montam o escopo e a autorização. Aqui entram a leitura, o padrão
 * por tipo, a remoção e a criação do registro comum (a criação de cada tipo está no módulo).
 *
 * Nenhuma coluna `*_enc` sai deste arquivo: `ChannelView` não as tem.
 */

export type ChannelActor = { userId: string | null; ip?: string };

type ChannelRow = typeof channel.$inferSelect;
type CloudRow = typeof channelWhatsappCloud.$inferSelect;
type EvolutionRow = typeof channelEvolution.$inferSelect;

export type ChannelView = {
  id: string;
  type: ChannelType;
  name: string;
  identifier: string | null;
  status: ChannelStatus;
  statusDetail: string | null;
  isDefault: boolean;
  connectedAt: Date | null;
  lastSeenAt: Date | null;
  hasConversations: boolean;
  // Cloud
  phoneNumberId?: string;
  wabaId?: string;
  appId?: string | null;
  verifiedName?: string | null;
  qualityRating?: string | null;
  accessTokenHint?: string | null;
  webhookVerifiedAt?: Date | null;
  // QR Code
  connectedPhone?: string | null;
};

const NOT_FOUND = "Canal não encontrado.";

/** Predicado explícito de escopo, somado ao RLS: duas travas para o mesmo isolamento. */
export const scopeWhere = (scope: Scope): SQL =>
  scope.kind === "tenant" ? eq(channel.tenantId, scope.tenantId) : isNull(channel.tenantId);

/**
 * `true` quando já há conversa apontando para o canal. A caixa de entrada (C1) troca este corpo
 * por uma consulta em `conversation`; até lá nenhuma conversa existe, então remover apaga.
 */
export async function channelHasConversations(tx: Tx, channelId: string) {
  return conversationCheck(tx, channelId);
}

type ConversationCheck = (tx: Tx, channelId: string) => Promise<boolean>;

let conversationCheck: ConversationCheck = async () => false;

/** A caixa de entrada (C1) registra a consulta real; os testes simulam o canal com histórico. */
export function setConversationCheck(next: ConversationCheck | undefined) {
  conversationCheck = next ?? (async () => false);
}

/** Texto do provedor pode trazer dado do cliente; só vai a log depois de sanitizado. */
function safeHint(token: string | null, channelId: string) {
  if (!token) return null;

  try {
    return maskSecret(openSecret(channelId, "accessToken", token));
  } catch {
    // Não decifra com as chaves atuais: a tela mostra "sem dica", o canal segue listado.
    return null;
  }
}

async function toViews(tx: Tx, rows: ChannelRow[]): Promise<ChannelView[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const clouds = new Map(
    (
      await tx
        .select()
        .from(channelWhatsappCloud)
        .where(inArray(channelWhatsappCloud.channelId, ids))
    ).map((row): [string, CloudRow] => [row.channelId, row]),
  );
  const evolutions = new Map(
    (
      await tx.select().from(channelEvolution).where(inArray(channelEvolution.channelId, ids))
    ).map((row): [string, EvolutionRow] => [row.channelId, row]),
  );

  return Promise.all(
    rows.map(async (row): Promise<ChannelView> => {
      const view: ChannelView = {
        id: row.id,
        type: row.type,
        name: row.name,
        identifier: row.identifier,
        status: row.status,
        statusDetail: row.statusDetail,
        isDefault: row.isDefault,
        connectedAt: row.connectedAt,
        lastSeenAt: row.lastSeenAt,
        hasConversations: await channelHasConversations(tx, row.id),
      };
      const cloud = clouds.get(row.id);
      const evolution = evolutions.get(row.id);

      if (cloud) {
        Object.assign(view, {
          phoneNumberId: cloud.phoneNumberId,
          wabaId: cloud.wabaId,
          appId: cloud.appId,
          verifiedName: cloud.verifiedName,
          qualityRating: cloud.qualityRating,
          accessTokenHint: safeHint(cloud.accessTokenEnc, row.id),
          webhookVerifiedAt: cloud.webhookVerifiedAt,
        });
      }
      if (evolution) view.connectedPhone = evolution.connectedPhone;

      return view;
    }),
  );
}

export async function listChannels(scope: Scope): Promise<ChannelView[]> {
  return withScope(scope, async (tx) =>
    toViews(
      tx,
      await tx.select().from(channel).where(scopeWhere(scope)).orderBy(asc(channel.createdAt)),
    ),
  );
}

export async function getChannelView(scope: Scope, id: string): Promise<ChannelView> {
  return withScope(scope, async (tx) => {
    const [row] = await tx
      .select()
      .from(channel)
      .where(and(eq(channel.id, id), scopeWhere(scope)));
    if (!row) throw notFound(NOT_FOUND);

    const [view] = await toViews(tx, [row]);
    if (!view) throw notFound(NOT_FOUND);
    return view;
  });
}

/** Linha do canal no escopo, ou 404 (de outro escopo, a resposta é a mesma de inexistente). */
export async function requireChannelRow(tx: Tx, scope: Scope, id: string, lock = false) {
  const query = tx
    .select()
    .from(channel)
    .where(and(eq(channel.id, id), scopeWhere(scope)));
  const [row] = await (lock ? query.for("update") : query);

  if (!row) throw notFound(NOT_FOUND);
  return row;
}

// ---------------------------------------------------------------------------
// Auditoria (no escopo de tenant, na transação; na plataforma, depois dela)
// ---------------------------------------------------------------------------

type AuditFn = (action: AuditAction, target: { id: string; type: ChannelType }) => Promise<void>;

/**
 * `audit_log` só tem política de tenant: a linha da plataforma (`tenant_id` nulo) não se
 * grava dentro de `withPlatformData`. Por isso a auditoria da plataforma sai depois do commit.
 */
export async function runInScope<T>(
  scope: Scope,
  actor: ChannelActor,
  fn: (tx: Tx, record: AuditFn) => Promise<T>,
): Promise<T> {
  const deferred: Array<() => Promise<void>> = [];

  const result = await withScope(scope, (tx) =>
    fn(tx, async (action, target) => {
      const entry = {
        actor: { id: actor.userId },
        target: { type: "channel", id: target.id },
        metadata: { type: target.type, channelId: target.id },
        ip: actor.ip,
      };

      if (scope.kind === "tenant") {
        await auditInTransaction(tx, action, { ...entry, tenantId: scope.tenantId });
      } else {
        deferred.push(() => audit(action, { ...entry, tenantId: null }));
      }
    }),
  );

  for (const write of deferred) await write();
  return result;
}

// ---------------------------------------------------------------------------
// Limites e criação do registro comum
// ---------------------------------------------------------------------------

/** Chave de trava do escopo e do tipo: criações e trocas de padrão se enfileiram. */
function lockKey(scope: Scope, type: ChannelType) {
  return `channel:${scope.kind === "tenant" ? scope.tenantId : "platform"}:${type}`;
}

export async function lockScopeType(tx: Tx, scope: Scope, type: ChannelType) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey(scope, type)}))`);
}

/** Canal `disabled` não conta no limite do plano. */
export async function countActiveChannels(scope: Scope, type: ChannelType) {
  return withScope(scope, async (tx) => {
    const [row] = await tx
      .select({ total: count() })
      .from(channel)
      .where(and(scopeWhere(scope), eq(channel.type, type), ne(channel.status, "disabled")));

    return row?.total ?? 0;
  });
}

/** Cabe mais um canal deste tipo? A plataforma não tem limite de plano. */
export async function channelLimit(scope: Scope, type: ChannelType) {
  const used = await countActiveChannels(scope, type);

  if (scope.kind === "platform") return { limit: null, used, allowed: true };

  const check = await checkLimit(scope.tenantId, CHANNEL_LIMIT_METRICS[type]);
  return { limit: check.limit, used: check.used, allowed: check.allowed };
}

/** Lança 403 `PLAN_LIMIT_REACHED` com a trava já tomada na transação de quem cria. */
export async function assertChannelWithinLimit(scope: Scope, type: ChannelType) {
  if (scope.kind === "platform") return;

  await assertWithinLimit(scope.tenantId, CHANNEL_LIMIT_METRICS[type]);
}

export type NewChannel = {
  type: ChannelType;
  name: string;
  status: ChannelStatus;
  identifier?: string | null;
  createdBy: string | null;
};

/**
 * Cria a linha comum, na transação do módulo. Quem chama já tomou `lockScopeType`: a
 * contagem do limite e a eleição do padrão não correm com outra criação. O primeiro canal
 * ativo do tipo vira padrão.
 */
export async function insertChannelRow(tx: Tx, scope: Scope, input: NewChannel) {
  const [existing] = await tx
    .select({ id: channel.id })
    .from(channel)
    .where(
      and(
        scopeWhere(scope),
        eq(channel.type, input.type),
        eq(channel.isDefault, true),
        ne(channel.status, "disabled"),
      ),
    );

  const [row] = await tx
    .insert(channel)
    .values({
      tenantId: scope.kind === "tenant" ? scope.tenantId : null,
      type: input.type,
      name: input.name,
      status: input.status,
      identifier: input.identifier ?? null,
      createdBy: input.createdBy,
      isDefault: !existing,
    })
    .returning();
  if (!row) throw new Error("canal não criado");

  return row;
}

// ---------------------------------------------------------------------------
// Padrão por escopo e tipo
// ---------------------------------------------------------------------------

/**
 * Garante um padrão entre os canais ativos: se o atual saiu (desativado ou apagado), elege o
 * conectado mais antigo; sem nenhum conectado, o tipo fica sem padrão até haver um.
 */
export async function electDefault(tx: Tx, scope: Scope, type: ChannelType) {
  const rows = await tx
    .select({
      id: channel.id,
      status: channel.status,
      isDefault: channel.isDefault,
      connectedAt: channel.connectedAt,
      createdAt: channel.createdAt,
    })
    .from(channel)
    .where(and(scopeWhere(scope), eq(channel.type, type)))
    .orderBy(asc(channel.createdAt))
    .for("update");

  if (rows.some((row) => row.isDefault && row.status !== "disabled")) return;

  const next = rows
    .filter((row) => row.status === "connected")
    .sort(
      (a, b) =>
        (a.connectedAt ?? a.createdAt).getTime() - (b.connectedAt ?? b.createdAt).getTime(),
    )[0];

  await tx
    .update(channel)
    .set({ isDefault: false })
    .where(and(scopeWhere(scope), eq(channel.type, type), eq(channel.isDefault, true)));

  if (next) await tx.update(channel).set({ isDefault: true }).where(eq(channel.id, next.id));
}

export async function setDefaultChannel(scope: Scope, id: string, actor: ChannelActor) {
  await runInScope(scope, actor, async (tx, record) => {
    const target = await requireChannelRow(tx, scope, id);

    if (target.status === "disabled") {
      throw new TenantRuleError(409, "CHANNEL_DISABLED", "Este número está desativado.");
    }

    await lockScopeType(tx, scope, target.type);
    // Relê com a trava: outra troca pode ter acontecido enquanto esperava.
    const current = await requireChannelRow(tx, scope, id, true);
    if (current.isDefault) return;

    await tx
      .update(channel)
      .set({ isDefault: false })
      .where(and(scopeWhere(scope), eq(channel.type, current.type), eq(channel.isDefault, true)));
    await tx.update(channel).set({ isDefault: true }).where(eq(channel.id, id));

    await record("channel.default_changed", { id, type: current.type });
  });
}

export async function renameChannel(scope: Scope, id: string, name: string, actor: ChannelActor) {
  await runInScope(scope, actor, async (tx, record) => {
    const row = await requireChannelRow(tx, scope, id, true);

    await tx.update(channel).set({ name }).where(eq(channel.id, id));
    await record("channel.updated", { id, type: row.type });
  });
}

// ---------------------------------------------------------------------------
// Remoção
// ---------------------------------------------------------------------------

/**
 * Segredo que não decifra (chave trocada, linha adulterada) não pode impedir remover o canal:
 * cai nos dados que não são segredo. A chamada ao provedor, que precisa do segredo, falha.
 */
function revealOrPublic(reveal: () => Record<string, string>, publicOnly: Record<string, string>) {
  try {
    return reveal();
  } catch (error) {
    if (error instanceof SecretDecryptError) return publicOnly;
    throw error;
  }
}

/** Contexto para chamar o provedor (decifra os segredos). Só dentro do servidor. */
export async function contextFor(tx: Tx, row: ChannelRow): Promise<ChannelContext> {
  if (row.type === "whatsapp_cloud") {
    const [cloud] = await tx
      .select()
      .from(channelWhatsappCloud)
      .where(eq(channelWhatsappCloud.channelId, row.id));

    return {
      channelId: row.id,
      type: row.type,
      credentials: cloud ? revealOrPublic(() => cloudCredentials(cloud), {
        phoneNumberId: cloud.phoneNumberId,
        wabaId: cloud.wabaId,
      }) : {},
    };
  }

  const [evolution] = await tx
    .select()
    .from(channelEvolution)
    .where(eq(channelEvolution.channelId, row.id));

  return {
    channelId: row.id,
    type: row.type,
    credentials: evolution
      ? revealOrPublic(
          () => ({ ...evolutionConfigOf(evolution), ...evolutionCredentials(evolution) }),
          evolutionConfigOf(evolution),
        )
      : {},
  };
}

export type RemoveOutcome = "deleted" | "disabled";

/**
 * Sem conversas, apaga o canal (na Evolution, apaga antes a instância). Com conversas, vira
 * `disabled`, as colunas `_enc` ficam nulas e o histórico continua (FK `restrict`). Falar com o
 * provedor vem antes da transação local.
 */
export async function removeChannel(
  scope: Scope,
  id: string,
  confirm: string,
  actor: ChannelActor,
): Promise<{ outcome: RemoveOutcome }> {
  // 1. Lê, confere o nome digitado e monta o contexto do provedor.
  const { row, ctx, hasConversations } = await withScope(scope, async (tx) => {
    const found = await requireChannelRow(tx, scope, id);

    return {
      row: found,
      ctx: await contextFor(tx, found),
      hasConversations: await channelHasConversations(tx, found.id),
    };
  });

  if (confirm !== row.name) {
    throw new TenantRuleError(
      400,
      "CONFIRMATION_MISMATCH",
      "O nome digitado não confere com o do número.",
    );
  }

  // 2. Apaga o que há no provedor. "Já não existe" é sucesso; outro erro aborta, para não
  //    perdermos o token de uma instância que continua viva no servidor.
  const provider = findProvider(row.type);
  if (provider?.destroy) {
    try {
      await provider.destroy(ctx);
    } catch (error) {
      logChannelError("Falha ao apagar a instância do canal no provedor", error);
      throw new TenantRuleError(
        503,
        "PROVIDER_UNAVAILABLE",
        "Não foi possível falar com o servidor agora. Tente de novo em instantes.",
      );
    }
  }

  // 3. Muda o estado local, com a linha travada.
  return runInScope(scope, actor, async (tx, record) => {
    await lockScopeType(tx, scope, row.type);
    const current = await requireChannelRow(tx, scope, id, true);
    const stillHasConversations = hasConversations || (await channelHasConversations(tx, id));

    if (stillHasConversations) {
      await tx
        .update(channel)
        .set({ status: "disabled", statusDetail: null, isDefault: false })
        .where(eq(channel.id, id));
      await tx
        .update(channelWhatsappCloud)
        .set({ accessTokenEnc: null, appSecretEnc: null, verifyTokenEnc: null })
        .where(eq(channelWhatsappCloud.channelId, id));
      await tx
        .update(channelEvolution)
        .set({ instanceTokenEnc: null, webhookSecretEnc: null, remoteInstanceId: null })
        .where(eq(channelEvolution.channelId, id));

      await record("channel.disabled", { id, type: current.type });
    } else {
      await tx.delete(channel).where(eq(channel.id, id));
      await record("channel.deleted", { id, type: current.type });
    }

    if (current.isDefault) await electDefault(tx, scope, current.type);

    return { outcome: stillHasConversations ? ("disabled" as const) : ("deleted" as const) };
  });
}

/** Grava o estado que o provedor informou. `connected_at` só muda ao conectar. */
export async function applyChannelStatus(
  tx: Tx,
  id: string,
  next: { status: ChannelStatus; detail?: string | null; identifier?: string | null },
  now = new Date(),
) {
  await tx
    .update(channel)
    .set({
      status: next.status,
      // Só limpa o motivo ao conectar: senão o aviso apaga o contexto de por que caiu.
      ...(next.status === "connected" ? { statusDetail: null } : { statusDetail: next.detail ?? null }),
      ...(next.status === "connected" ? { connectedAt: now } : {}),
      ...(next.identifier ? { identifier: next.identifier } : {}),
      lastSeenAt: now,
    })
    .where(and(eq(channel.id, id), ne(channel.status, "disabled")));
}

/** Resumo de uso por tipo, para `GET /api/channels` (`limits`). */
export async function channelLimits(scope: Scope) {
  const entries = await Promise.all(
    channelTypes.map(async (type) => [type, await channelLimit(scope, type)] as const),
  );

  return Object.fromEntries(entries) as Record<ChannelType, Awaited<ReturnType<typeof channelLimit>>>;
}
