import { count, eq, ne } from "drizzle-orm";
import { type Scope, withPlatformScope, withScope } from "@/db/rls";
import { channel, channelEvolution } from "@/db/schema";
import { can } from "@/lib/channels/capabilities";
import { type AfterCommit, applyConnectionState } from "@/lib/channels/connection";
import {
  generateInstanceToken,
  generateWebhookSecret,
  hashWebhookSecret,
  sealSecret,
} from "@/lib/channels/credentials";
import { ChannelNotConfiguredError, ProviderError } from "@/lib/channels/errors";
import { logChannelError } from "@/lib/channels/log";
import { findProvider } from "@/lib/channels/registry";
import {
  applyChannelStatus,
  assertChannelWithinLimit,
  type ChannelActor,
  type ChannelView,
  contextFor,
  getChannelView,
  insertChannelRow,
  lockScopeType,
  requireChannelRow,
  runInScope,
} from "@/lib/channels/service";
import type {
  ChannelContext,
  ChannelProvider,
  ChannelType,
  PairingOperations,
  PairingQr,
} from "@/lib/channels/types";
import { TenantRuleError } from "@/lib/tenant/errors";

/**
 * Canais com pareamento (capacidade `pairing`: QR Code e código digitado no celular), para os
 * dois escopos. O módulo só fala com o servidor do provedor (`provider.pairing`); aqui ficam
 * os limites, a transação, o estado e a auditoria.
 *
 * Regras: falar com o provedor vem **antes** da transação local; o teto do servidor vem antes
 * do limite do plano; o token da instância nunca sai daqui (a resposta é `ChannelView`).
 */

type ChannelRow = typeof channel.$inferSelect;

const unavailable = () =>
  new TenantRuleError(
    503,
    "PROVIDER_UNAVAILABLE",
    "Não foi possível falar com o servidor agora. Tente de novo em instantes.",
  );

function pairingOf(type: ChannelType): { provider: ChannelProvider; pairing: PairingOperations } {
  const provider = can(type, "pairing") ? findProvider(type) : null;

  // Módulo fora de `CHANNEL_PROVIDERS`, ou tipo sem pareamento: a tela nem devia oferecer.
  if (!provider?.pairing) throw unavailable();
  return { provider, pairing: provider.pairing };
}

/**
 * Chama o provedor e traduz a falha: nada do texto dele chega ao cliente. 401 ou 403 quer dizer
 * que o token da instância não vale mais (rotacionado ou instância apagada no servidor): o
 * canal vai para `error`, para a lista mostrar o motivo.
 */
async function callProvider<T>(
  scope: Scope,
  row: Pick<ChannelRow, "id"> | null,
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ProviderError) && !(error instanceof ChannelNotConfiguredError)) {
      throw error;
    }
    logChannelError(context, error);

    if (row && error instanceof ProviderError && error.isAuthFailure) {
      await withScope(scope, (tx) =>
        applyChannelStatus(tx, row.id, {
          status: "error",
          detail: "O servidor recusou a credencial deste número. Remova e conecte de novo.",
        }),
      ).catch((writeError) => logChannelError("Falha ao marcar canal com erro", writeError));
    }
    throw unavailable();
  }
}

/** Canais com instância no servidor, de todos os escopos: a outra metade do teto. */
async function countLocalInstances() {
  const [row] = await withPlatformScope("canais: teto do servidor", (tx) =>
    tx
      .select({ total: count() })
      .from(channelEvolution)
      .innerJoin(channel, eq(channel.id, channelEvolution.channelId))
      .where(ne(channel.status, "disabled")),
  );

  return row?.total ?? 0;
}

/**
 * Cria o canal em `connecting`. Ordem (spec, "Criar"): teto do servidor → limite do plano →
 * instância no servidor → transação local. Se a transação falhar, a instância é apagada.
 */
export async function createPairingChannel(
  scope: Scope,
  type: ChannelType,
  name: string,
  actor: ChannelActor,
): Promise<ChannelView> {
  const { provider, pairing } = pairingOf(type);

  // 1. Teto do servidor, somando todos os escopos. Vem antes do plano: é da infraestrutura.
  const [capacity, local] = await Promise.all([
    callProvider(scope, null, "Falha ao contar instâncias no servidor", () => pairing.capacity()),
    countLocalInstances(),
  ]);
  if (Math.max(capacity.used, local) >= capacity.max) {
    throw new TenantRuleError(
      409,
      "SERVER_LIMIT_REACHED",
      "O servidor atingiu o limite de números por QR Code. Fale com o suporte.",
    );
  }

  // 2. Limite do plano, antes de criar algo no servidor (confere de novo dentro da transação).
  await assertChannelWithinLimit(scope, type);

  // 3. Instância no servidor. O token nasce aqui e só existe cifrado depois disto.
  const instanceToken = generateInstanceToken();
  const remote = await callProvider(scope, null, "Falha ao criar instância no servidor", () =>
    pairing.createInstance({
      scopeKey: scope.kind === "tenant" ? scope.tenantId : "platform",
      label: name,
      instanceToken,
    }),
  );

  const destroyRemote = async () => {
    if (!remote.remoteInstanceId || !provider.destroy) return;

    await provider
      .destroy({ channelId: "", type, credentials: { remoteInstanceId: remote.remoteInstanceId } })
      .catch((error) => logChannelError("Falha ao desfazer instância no servidor", error));
  };

  // Sem id não há como conferir o aviso (2º fator da cadeia) nem apagar a instância depois.
  if (!remote.remoteInstanceId) {
    logChannelError("Servidor não devolveu o id da instância", new Error("create sem id"));
    throw unavailable();
  }

  // 4. Transação local, com a trava do escopo e do tipo.
  try {
    const id = await runInScope(scope, actor, async (tx, record) => {
      await lockScopeType(tx, scope, type);
      await assertChannelWithinLimit(scope, type);

      const row = await insertChannelRow(tx, scope, {
        type,
        name,
        status: "connecting",
        createdBy: actor.userId,
      });
      const webhookSecret = generateWebhookSecret();

      await tx.insert(channelEvolution).values({
        channelId: row.id,
        tenantId: row.tenantId,
        remoteInstanceId: remote.remoteInstanceId,
        remoteInstanceName: remote.remoteInstanceName,
        instanceTokenEnc: sealSecret(row.id, "instanceToken", instanceToken),
        webhookSecretEnc: sealSecret(row.id, "webhookSecret", webhookSecret),
        webhookSecretHash: hashWebhookSecret(webhookSecret),
      });
      await record("channel.created", { id: row.id, type });

      return row.id;
    });

    return await getChannelView(scope, id);
  } catch (error) {
    await destroyRemote();
    throw error;
  }
}

type Loaded = {
  row: ChannelRow;
  ctx: ChannelContext;
  provider: ChannelProvider;
  pairing: PairingOperations;
};

/** Canal do escopo (404 se de outro), com pareamento e não desativado, pronto para o provedor. */
async function loadPairing(scope: Scope, id: string): Promise<Loaded> {
  const { row, ctx } = await withScope(scope, async (tx) => {
    const found = await requireChannelRow(tx, scope, id);

    return { row: found, ctx: await contextFor(tx, found) };
  });

  if (!can(row.type, "pairing")) {
    throw new TenantRuleError(
      400,
      "UNSUPPORTED_FOR_CHANNEL",
      "Esta ação só existe para número conectado por QR Code.",
    );
  }
  if (row.status === "disabled") {
    throw new TenantRuleError(409, "CHANNEL_DISABLED", "Este número está desativado.");
  }

  return { row, ctx, ...pairingOf(row.type) };
}

/** Tarefas de depois do commit (auditoria da plataforma, instância que sobrou na readoção). */
async function runAfter(after: AfterCommit) {
  for (const effect of after) {
    await effect().catch((error) => logChannelError("Falha em tarefa pós-conexão", error));
  }
}

/**
 * Gera um QR novo. Registra o webhook antes (`connect` é reexecutável), para o aviso de conexão
 * ter para onde ir. O QR nunca é gravado: só a hora em que foi pedido.
 */
export async function requestPairingQr(scope: Scope, id: string): Promise<PairingQr> {
  const { row, ctx, provider, pairing } = await loadPairing(scope, id);

  if (row.status === "connected") return { alreadyConnected: true };

  const qr = await callProvider(scope, row, "Falha ao gerar QR Code", async () => {
    await pairing.connect(ctx);
    return pairing.qr(ctx);
  });

  if (qr.alreadyConnected) {
    // O servidor diz que já pareou e o aviso não chegou (ou ainda não): alinha o estado.
    const after: AfterCommit = [];
    await withScope(scope, (tx) =>
      applyConnectionState(
        tx,
        scope,
        row,
        { status: "connected", detail: null, phone: null, jid: null },
        { after, destroyRemote: provider.destroy },
      ),
    );
    await runAfter(after);
    return qr;
  }

  await withScope(scope, async (tx) => {
    await tx
      .update(channelEvolution)
      .set({ lastQrAt: new Date() })
      .where(eq(channelEvolution.channelId, id));
    await applyChannelStatus(tx, id, { status: "connecting", detail: null });
  });

  return qr;
}

/** Código de 8 caracteres para digitar no celular. `phone` já chega só com dígitos. */
export async function requestPairingCode(scope: Scope, id: string, phone: string) {
  const { row, ctx, pairing } = await loadPairing(scope, id);

  if (row.status === "connected") {
    throw new TenantRuleError(409, "CHANNEL_ALREADY_CONNECTED", "Este número já está conectado.");
  }

  const result = await callProvider(scope, row, "Falha ao gerar código de pareamento", async () => {
    await pairing.connect(ctx);
    return pairing.pairingCode(ctx, phone);
  });

  await withScope(scope, (tx) => applyChannelStatus(tx, id, { status: "connecting", detail: null }));
  return result;
}

export type PairingStatus = {
  status: ChannelRow["status"];
  statusDetail: string | null;
  identifier: string | null;
  lastSeenAt: Date | null;
  /** O mesmo número voltou para um canal antigo do escopo: este canal deixou de existir. */
  readoptedInto?: string;
};

const statusOf = (row: ChannelRow): PairingStatus => ({
  status: row.status,
  statusDetail: row.statusDetail,
  identifier: row.identifier,
  lastSeenAt: row.lastSeenAt,
});

/**
 * Estado gravado. Enquanto o canal está em `connecting` (a tela consulta a cada 4 s), pergunta
 * também ao provedor: se o aviso de conexão não chegar (webhook inalcançável), a tela fecha
 * mesmo assim. Falha do provedor não muda nada: responde o que está gravado.
 */
export async function getPairingStatus(scope: Scope, id: string): Promise<PairingStatus> {
  const row = await withScope(scope, (tx) => requireChannelRow(tx, scope, id));
  const provider = row.status === "connecting" ? findProvider(row.type) : null;

  if (!provider) return statusOf(row);

  try {
    const ctx = await withScope(scope, (tx) => contextFor(tx, row));
    const probe = await provider.probe(ctx);

    if (probe.status === "connecting") return statusOf(row);

    if (probe.status === "error") {
      await withScope(scope, (tx) => applyChannelStatus(tx, id, probe));
    } else {
      const after: AfterCommit = [];
      const status = probe.status;
      const result = await withScope(scope, (tx) =>
        applyConnectionState(
          tx,
          scope,
          row,
          {
            status,
            detail: probe.detail,
            phone: probe.identifier ?? null,
            jid: null,
          },
          { after, destroyRemote: provider.destroy },
        ),
      );
      await runAfter(after);

      if (result.readopted) {
        const adopted = await withScope(scope, (tx) => requireChannelRow(tx, scope, result.channelId));
        return { ...statusOf(adopted), readoptedInto: adopted.id };
      }
    }
  } catch (error) {
    if (error instanceof TenantRuleError) throw error;
    logChannelError("Falha ao consultar o estado do canal", error);
    return statusOf(row);
  }

  return statusOf(await withScope(scope, (tx) => requireChannelRow(tx, scope, id)));
}

export type PairingAction = "disconnect" | "logout" | "reconnect";

const ACTION_DETAIL: Record<Exclude<PairingAction, "reconnect">, string> = {
  disconnect: "Desconectado pelo painel.",
  logout: "Sessão encerrada pelo painel.",
};

/**
 * `disconnect` fecha a sessão (o pareamento continua), `logout` desfaz o pareamento (pede QR de
 * novo) e `reconnect` reabre a sessão. O telefone conectado fica gravado: é ele que permite
 * readotar este canal se o mesmo número voltar.
 */
export async function runPairingAction(
  scope: Scope,
  id: string,
  action: PairingAction,
  actor: ChannelActor,
): Promise<ChannelView> {
  const { row, ctx, pairing } = await loadPairing(scope, id);

  await callProvider(scope, row, `Falha na ação do canal (${action})`, () => pairing[action](ctx));

  await runInScope(scope, actor, async (tx, record) => {
    await requireChannelRow(tx, scope, id, true);

    if (action === "reconnect") {
      await applyChannelStatus(tx, id, { status: "connecting", detail: null });
      await record("channel.updated", { id, type: row.type });
    } else {
      await applyChannelStatus(tx, id, { status: "disconnected", detail: ACTION_DETAIL[action] });
      await record("channel.disconnected", { id, type: row.type });
    }
  });

  return getChannelView(scope, id);
}

/** Ajustes da instância (sempre online, recusar chamada...). Grava o que o servidor aceitou. */
export async function updatePairingSettings(
  scope: Scope,
  id: string,
  settings: Record<string, unknown>,
  actor: ChannelActor,
): Promise<ChannelView> {
  const { row, ctx, pairing } = await loadPairing(scope, id);

  const accepted = await callProvider(scope, row, "Falha ao gravar ajustes do canal", () =>
    pairing.updateSettings(ctx, settings),
  );

  await runInScope(scope, actor, async (tx, record) => {
    const [current] = await tx
      .select({ settings: channelEvolution.advancedSettings })
      .from(channelEvolution)
      .where(eq(channelEvolution.channelId, id))
      .for("update");

    await tx
      .update(channelEvolution)
      // Só as chaves do contrato: o servidor pode devolver campos que não são nossos.
      .set({ advancedSettings: { ...current?.settings, ...pickKnown(settings, accepted) } })
      .where(eq(channelEvolution.channelId, id));
    await record("channel.updated", { id, type: row.type });
  });

  return getChannelView(scope, id);
}

/** Para cada chave pedida, o valor que o servidor devolveu (ou o pedido, se ele não ecoar). */
function pickKnown(requested: Record<string, unknown>, accepted: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(requested).map((key) => [
      key,
      typeof accepted[key] === typeof requested[key] ? accepted[key] : requested[key],
    ]),
  );
}
