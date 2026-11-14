import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Scope, withPlatformScope } from "@/db/rls";
import { conversation, file, message, messageRetentionState, retentionPolicy } from "@/db/schema";
import { QUEUE, queueDefinitions, scheduleDefinitions } from "@/jobs/queues";
import {
  processChannelEvent,
  receiveChannelEvent,
  scopeOf,
  setChannelQueueForTests,
} from "@/lib/channels/events";
import { setProvidersForTests } from "@/lib/channels/registry";
import type { ChannelProvider, ChannelType, NormalizedEvent, NormalizedMessage } from "@/lib/channels/types";
import {
  lastRetentionRun,
  listRetentionTargets,
  type RetentionTarget,
  runRetention,
  runRetentionCycle,
} from "@/lib/inbox/retention";
import { type RetentionConfig, retentionConfigFromEnv } from "@/lib/inbox/retention-policy";
import { setStorageForTests } from "@/lib/storage";
import {
  cleanUpChannels,
  createTenantRow,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "./channels-helpers";
import { attachMedia, memoryStorage, seedConversation, seedMessage } from "./inbox-helpers";
import { connectOwner } from "./tenant-helpers";

/**
 * Bloco R, fase R2: a limpeza de mensagens (`src/lib/inbox/retention.ts`) e o job `inbox.retention`.
 *
 * **Isto apaga dado.** Os testes só rodam a limpeza de verdade em organizações criadas aqui; o
 * escopo da plataforma (compartilhado com o banco local de desenvolvimento) só com o corte de
 * 3650 dias e mensagens semeadas com mais de 10 anos, e o ciclo do job só com escopos explícitos.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

/** Configuração pelo módulo de precedência, como o `.env` validado a entregaria. */
function config(env: Record<string, unknown> = {}, enabled = true): RetentionConfig {
  return retentionConfigFromEnv({ MESSAGE_RETENTION_ENABLED: enabled, ...env });
}

const CLOUD_DAYS = "MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS";
const CLOUD_MAX = "MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES";
const CLOUD_FAV = "MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_FAVORITES";
const QR_MAX = "MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES";

describe("limpeza de mensagens (R2)", () => {
  let owner: postgres.Sql;
  let tenantA: string;
  let tenantB: string;
  const memory = memoryStorage();
  const platformContacts: string[] = [];
  let savedPlatformState: { channel_type: string; last_run_at: Date | null; last_result: unknown }[] = [];

  const read = <T>(fn: Parameters<typeof withPlatformScope<T>>[1]) => withPlatformScope("teste", fn);

  beforeAll(async () => {
    owner = connectOwner();
    tenantA = await createTenantRow(owner, "ret-a");
    tenantB = await createTenantRow(owner, "ret-b");
    setStorageForTests(memory.storage);
    setChannelQueueForTests(async () => {});
    // O estado da plataforma é do banco compartilhado: guardado e devolvido no fim.
    savedPlatformState = await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      return tx<typeof savedPlatformState>`select channel_type, last_run_at, last_result from message_retention_state where tenant_id is null`;
    });
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    memory.objects.clear();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id in (${tenantA}, ${tenantB})`;
      await tx`delete from file where tenant_id in (${tenantA}, ${tenantB})`;
      if (platformContacts.length) {
        await tx`delete from file where tenant_id is null and owner_type = 'message' and owner_id in (select m.id from message m join conversation c on c.id = m.conversation_id where c.contact_id = any(${platformContacts}))`;
        await tx`delete from chat_contact where id = any(${platformContacts})`;
      }
      await tx`delete from channel where tenant_id in (${tenantA}, ${tenantB})`;
      await tx`delete from retention_policy where tenant_id in (${tenantA}, ${tenantB})`;
      await tx`delete from message_retention_state where tenant_id in (${tenantA}, ${tenantB})`;
      await tx`delete from message_retention_state where tenant_id is null`;
      for (const row of savedPlatformState) {
        await tx`insert into message_retention_state (tenant_id, channel_type, last_run_at, last_result) values (null, ${row.channel_type}, ${row.last_run_at}, ${tx.json(row.last_result as never)})`;
      }
    });
    platformContacts.length = 0;
  });

  afterAll(async () => {
    setStorageForTests(undefined);
    setChannelQueueForTests(undefined);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from channel where tenant_id is null and name like ${"%-rettest-chtest"}`;
    });
    await cleanUpChannels(owner, [tenantA, tenantB]);
    await owner.end();
  });

  // ---------------------------------------------------------------------------
  // Apoio
  // ---------------------------------------------------------------------------

  async function thread(scope: Scope, type: ChannelType = "whatsapp_cloud", seed: Parameters<typeof seedConversation>[2] = {}) {
    const name = `Ret ${randomUUID().slice(0, 6)}-rettest-chtest`;
    const ch = type === "whatsapp_cloud" ? await seedCloudChannel(scope, { name }) : await seedQrChannel(scope, { name });
    const conv = await seedConversation(scope, ch.id, seed);
    if (scope.kind === "platform") platformContacts.push(conv.contactId);
    return { channelId: ch.id, conversationId: conv.id, contactId: conv.contactId };
  }

  /** Mensagem com a idade dada; `favorite` marca a estrela como a rota da R3 faria. */
  async function msg(scope: Scope, target: { conversationId: string; channelId: string }, age: number, options: { favorite?: boolean; at?: Date } = {}) {
    const row = await seedMessage(scope, target, { createdAt: options.at ?? ago(age), text: "conteúdo pessoal" });
    if (options.favorite) {
      await read((tx) => tx.update(message).set({ isFavorite: true, favoritedAt: new Date() }).where(eq(message.id, row.id)));
    }
    return row.id;
  }

  const existing = (ids: string[]) =>
    read(async (tx) => {
      if (ids.length === 0) return new Set<string>();
      const rows = await tx.select({ id: message.id }).from(message).where(inArray(message.id, ids));
      return new Set(rows.map(({ id }) => id));
    });

  const favoritesOf = (ids: string[]) =>
    read((tx) =>
      tx
        .select({ id: message.id, isFavorite: message.isFavorite, favoritedAt: message.favoritedAt, favoritedBy: message.favoritedBy })
        .from(message)
        .where(inArray(message.id, ids)),
    );

  const countIn = (conversationId: string) =>
    read(async (tx) => (await tx.select({ id: message.id }).from(message).where(eq(message.conversationId, conversationId))).length);

  const stateOf = (tenantId: string | null, channelType: ChannelType = "whatsapp_cloud") =>
    read(async (tx) => {
      const [row] = await tx
        .select()
        .from(messageRetentionState)
        .where(
          and(
            tenantId === null ? isNull(messageRetentionState.tenantId) : eq(messageRetentionState.tenantId, tenantId),
            eq(messageRetentionState.channelType, channelType),
          ),
        );
      return row ?? null;
    });

  async function setPolicy(tenantId: string, channelType: ChannelType, row: { maxMessages?: number | null; retentionDays?: number | null; maxFavorites?: number | null }) {
    await read((tx) =>
      tx
        .insert(retentionPolicy)
        .values({ tenantId, channelType, maxMessages: row.maxMessages ?? null, retentionDays: row.retentionDays ?? null, maxFavorites: row.maxFavorites ?? null })
        .onConflictDoUpdate({
          target: [retentionPolicy.tenantId, retentionPolicy.channelType],
          set: { maxMessages: row.maxMessages ?? null, retentionDays: row.retentionDays ?? null, maxFavorites: row.maxFavorites ?? null },
        }),
    );
  }

  const targetA = (channelType: ChannelType = "whatsapp_cloud"): RetentionTarget => ({ tenantId: tenantA, channelType });

  // ---------------------------------------------------------------------------
  // O que nunca apaga
  // ---------------------------------------------------------------------------

  describe("o que nunca apaga", () => {
    it("desligada: nada é apagado, nada é rebaixado e o estado não é gravado", async () => {
      const t = await thread(tenantScope(tenantA));
      const old = await msg(tenantScope(tenantA), t, 400 * DAY);
      const fav = await msg(tenantScope(tenantA), t, 400 * DAY, { favorite: true });
      await msg(tenantScope(tenantA), t, 300 * DAY, { favorite: true });

      const outcome = await runRetention(targetA(), {
        config: config({ [CLOUD_DAYS]: 1, [CLOUD_MAX]: 1, [CLOUD_FAV]: 1 }, false),
      });

      expect(outcome.ran).toBe(false);
      expect(outcome.plan.canPurge).toBe(false);
      expect(await existing([old, fav])).toEqual(new Set([old, fav]));
      expect((await favoritesOf([fav]))[0]?.isFavorite).toBe(true);
      expect(await stateOf(tenantA)).toBeNull();
    });

    it("o ciclo do job com a retenção desligada não percorre escopo nenhum", async () => {
      const t = await thread(tenantScope(tenantA));
      const old = await msg(tenantScope(tenantA), t, 400 * DAY);
      const run = vi.fn(runRetention);

      const summary = await runRetentionCycle({
        config: config({ [CLOUD_DAYS]: 1 }, false),
        targets: [targetA()],
        run,
      });

      expect(summary).toEqual({ scopes: 0, ran: 0, failed: 0, truncated: 0 });
      expect(run).not.toHaveBeenCalled();
      expect(await existing([old])).toEqual(new Set([old]));
    });

    it("sem limite (nem `.env` nem linha): nada é apagado", async () => {
      const t = await thread(tenantScope(tenantA));
      const old = await msg(tenantScope(tenantA), t, 4000 * DAY);

      const outcome = await runRetention(targetA(), { config: config() });

      expect(outcome.ran).toBe(false);
      expect(await existing([old])).toEqual(new Set([old]));
      expect(await stateOf(tenantA)).toBeNull();
    });

    it("`0` na linha é sem limite: vence o padrão do `.env` e não apaga", async () => {
      const t = await thread(tenantScope(tenantA));
      const old = await msg(tenantScope(tenantA), t, 400 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { maxMessages: 0, retentionDays: 0, maxFavorites: 0 });

      const outcome = await runRetention(targetA(), { config: config({ [CLOUD_DAYS]: 1, [CLOUD_MAX]: 1 }) });

      expect(outcome.ran).toBe(false);
      expect(await existing([old])).toEqual(new Set([old]));
    });

    it("o piso protege a mensagem recente nas três fases", async () => {
      const t = await thread(tenantScope(tenantA));
      // Todas com 48 h: abaixo do piso de 72 h.
      const recent = [
        await msg(tenantScope(tenantA), t, 48 * HOUR),
        await msg(tenantScope(tenantA), t, 48 * HOUR + 1000),
        await msg(tenantScope(tenantA), t, 48 * HOUR + 2000),
      ];
      const recentFavs = [
        await msg(tenantScope(tenantA), t, 48 * HOUR + 3000, { favorite: true }),
        await msg(tenantScope(tenantA), t, 48 * HOUR + 4000, { favorite: true }),
      ];
      const beyond = await msg(tenantScope(tenantA), t, 100 * HOUR);

      // 1 dia de prazo, 1 mensagem e 1 favorita: sem o piso, sobraria quase nada.
      const outcome = await runRetention(targetA(), {
        config: config({ [CLOUD_DAYS]: 1, [CLOUD_MAX]: 1, [CLOUD_FAV]: 1 }),
      });

      expect(outcome.ran).toBe(true);
      expect(await existing([...recent, ...recentFavs, beyond])).toEqual(new Set([...recent, ...recentFavs]));
      expect((await favoritesOf(recentFavs)).every((row) => row.isFavorite)).toBe(true);
      expect(outcome.result).toMatchObject({ byAge: 1, byCount: 0, favoritesDemoted: 0 });
    });

    it("o piso nunca fica abaixo de 24 h, mesmo com a configuração torta", async () => {
      const t = await thread(tenantScope(tenantA));
      const young = await msg(tenantScope(tenantA), t, 20 * HOUR);
      const older = await msg(tenantScope(tenantA), t, 30 * HOUR);

      await runRetention(targetA(), { config: { ...config({ [CLOUD_MAX]: 1 }), minAgeHours: 1 } });

      // Com 2 mensagens e teto 1, a mais antiga sai só porque passou de 24 h; a de 20 h fica.
      expect(await existing([young, older])).toEqual(new Set([young]));
    });
  });

  // ---------------------------------------------------------------------------
  // As três fases
  // ---------------------------------------------------------------------------

  describe("as três fases", () => {
    it("idade: leva as não favoritas mais velhas que o prazo; a favorita sobrevive", async () => {
      const t = await thread(tenantScope(tenantA));
      const old = await msg(tenantScope(tenantA), t, 40 * DAY);
      const oldFav = await msg(tenantScope(tenantA), t, 41 * DAY, { favorite: true });
      const kept = await msg(tenantScope(tenantA), t, 10 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });

      const outcome = await runRetention(targetA(), { config: config() });

      expect(await existing([old, oldFav, kept])).toEqual(new Set([oldFav, kept]));
      expect(outcome.result).toMatchObject({ byAge: 1, byCount: 0, favoritesDemoted: 0, messagesTotal: 2, favoritesTotal: 1 });
    });

    it("contagem: o teto vale para o escopo inteiro (todas as conversas), favorita fora do ranque", async () => {
      const t1 = await thread(tenantScope(tenantA));
      const t2 = await seedConversation(tenantScope(tenantA), t1.channelId);
      const target2 = { conversationId: t2.id, channelId: t1.channelId };
      const m1 = await msg(tenantScope(tenantA), t1, 10 * DAY);
      const m2 = await msg(tenantScope(tenantA), target2, 9 * DAY);
      const fav = await msg(tenantScope(tenantA), t1, 20 * DAY, { favorite: true });
      const m3 = await msg(tenantScope(tenantA), target2, 8 * DAY);
      const m4 = await msg(tenantScope(tenantA), t1, 7 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { maxMessages: 2 });

      const outcome = await runRetention(targetA(), { config: config() });

      // Ficam as duas não favoritas mais novas do escopo, mais a favorita.
      expect(await existing([m1, m2, m3, m4, fav])).toEqual(new Set([m3, m4, fav]));
      expect(outcome.result).toMatchObject({ byAge: 0, byCount: 2, messagesTotal: 3, favoritesTotal: 1 });
    });

    it("contagem: empate de `created_at` (lote do webhook) desempata por id, de forma estável", async () => {
      const t = await thread(tenantScope(tenantA));
      const at = ago(10 * DAY);
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await msg(tenantScope(tenantA), t, 0, { at }));
      await setPolicy(tenantA, "whatsapp_cloud", { maxMessages: 2 });

      await runRetention(targetA(), { config: config() });

      const sorted = [...ids].sort();
      // `created_at DESC, id DESC`: ficam os dois maiores ids.
      expect(await existing(ids)).toEqual(new Set(sorted.slice(2)));
    });

    it("favoritas acima do teto: as mais velhas perdem a estrela, e só somem no ciclo seguinte", async () => {
      const t = await thread(tenantScope(tenantA));
      const fav1 = await msg(tenantScope(tenantA), t, 60 * DAY, { favorite: true });
      const fav2 = await msg(tenantScope(tenantA), t, 50 * DAY, { favorite: true });
      const fav3 = await msg(tenantScope(tenantA), t, 40 * DAY, { favorite: true });
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30, maxFavorites: 1 });

      const first = await runRetention(targetA(), { config: config() });

      expect(first.result).toMatchObject({ byAge: 0, byCount: 0, favoritesDemoted: 2, favoritesTotal: 1, messagesTotal: 3 });
      expect(await existing([fav1, fav2, fav3])).toEqual(new Set([fav1, fav2, fav3]));
      const rows = await favoritesOf([fav1, fav2, fav3]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      // O `CHECK` exige os três juntos: estrela, data e quem marcou.
      expect(byId.get(fav1)).toMatchObject({ isFavorite: false, favoritedAt: null, favoritedBy: null });
      expect(byId.get(fav2)).toMatchObject({ isFavorite: false, favoritedAt: null, favoritedBy: null });
      expect(byId.get(fav3)?.isFavorite).toBe(true);

      const second = await runRetention(targetA(), { config: config() });

      expect(second.result).toMatchObject({ byAge: 2, favoritesDemoted: 0, messagesTotal: 1, favoritesTotal: 1 });
      expect(await existing([fav1, fav2, fav3])).toEqual(new Set([fav3]));
    });

    it("as três fases juntas: a contagem ranqueia o que a idade deixou", async () => {
      const t = await thread(tenantScope(tenantA));
      const veryOld = [await msg(tenantScope(tenantA), t, 100 * DAY), await msg(tenantScope(tenantA), t, 99 * DAY)];
      const mid = [
        await msg(tenantScope(tenantA), t, 20 * DAY),
        await msg(tenantScope(tenantA), t, 19 * DAY),
        await msg(tenantScope(tenantA), t, 18 * DAY),
      ];
      const fav = await msg(tenantScope(tenantA), t, 200 * DAY, { favorite: true });
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30, maxMessages: 2 });

      const outcome = await runRetention(targetA(), { config: config() });

      // Idade leva as duas de 100 dias; das três de ~20 dias, a contagem (teto 2) leva a mais velha.
      expect(outcome.result).toMatchObject({ byAge: 2, byCount: 1, messagesTotal: 3 });
      expect(await existing([...veryOld, ...mid, fav])).toEqual(new Set([mid[1] as string, mid[2] as string, fav]));
    });
  });

  // ---------------------------------------------------------------------------
  // Prévia
  // ---------------------------------------------------------------------------

  describe("prévia", () => {
    async function richState() {
      const scope = tenantScope(tenantA);
      const t = await thread(scope);
      const withFile = await msg(scope, t, 100 * DAY);
      await attachMedia(scope, memory, withFile, Buffer.from("conteudo"), "text/plain");
      await msg(scope, t, 90 * DAY);
      for (let i = 0; i < 4; i++) await msg(scope, t, (20 - i) * DAY);
      for (let i = 0; i < 3; i++) await msg(scope, t, (50 - i) * DAY, { favorite: true });
      await msg(scope, t, 1 * HOUR);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30, maxMessages: 2, maxFavorites: 1 });
      return t;
    }

    it("conta o mesmo que a execução apaga no mesmo estado, sem alterar nada nem gravar o estado", async () => {
      const t = await richState();
      const before = await countIn(t.conversationId);

      const preview = await runRetention(targetA(), { dryRun: true, config: config() });

      expect(preview.ran).toBe(false);
      expect(await countIn(t.conversationId)).toBe(before);
      expect(memory.objects.size).toBe(1);
      expect(await stateOf(tenantA)).toBeNull();
      expect(preview.result).toMatchObject({ byAge: 2, byCount: 3, favoritesDemoted: 2, filesDeleted: 1, truncated: false });
      expect(preview.result.messagesTotal).toBe(before);
      expect(preview.result.favoritesTotal).toBe(3);

      const real = await runRetention(targetA(), { config: config() });

      const { messagesTotal: _a, favoritesTotal: _b, ...previewCounts } = preview.result;
      const { messagesTotal, favoritesTotal, ...realCounts } = real.result;
      expect(realCounts).toEqual(previewCounts);
      expect(messagesTotal).toBe(before - preview.result.byAge - preview.result.byCount);
      expect(favoritesTotal).toBe(3 - preview.result.favoritesDemoted);
      expect(memory.objects.size).toBe(0);
    });

    it("funciona com a retenção desligada (usa a política efetiva) e não apaga", async () => {
      const t = await richState();
      const before = await countIn(t.conversationId);

      const off = await runRetention(targetA(), { dryRun: true, config: config({}, false) });
      const on = await runRetention(targetA(), { dryRun: true, config: config() });

      expect(off.plan.enabled).toBe(false);
      expect(off.result).toEqual(on.result);
      expect(off.result.byAge).toBeGreaterThan(0);
      expect(await countIn(t.conversationId)).toBe(before);
    });

    it("bate com a execução também quando o lote corta (`truncated`)", async () => {
      const scope = tenantScope(tenantA);
      const t = await thread(scope);
      for (let i = 0; i < 5; i++) await msg(scope, t, (100 - i) * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });
      const small = { ...config(), batchLimit: 2 };

      const preview = await runRetention(targetA(), { dryRun: true, config: small });
      const real = await runRetention(targetA(), { config: small });

      expect(preview.result).toMatchObject({ byAge: 2, truncated: true });
      expect(real.result).toMatchObject({ byAge: 2, truncated: true });
    });
  });

  // ---------------------------------------------------------------------------
  // Escopo
  // ---------------------------------------------------------------------------

  describe("escopo", () => {
    it("uma organização nunca alcança mensagem de outra", async () => {
      const a = await thread(tenantScope(tenantA));
      const b = await thread(tenantScope(tenantB));
      const oldA = await msg(tenantScope(tenantA), a, 400 * DAY);
      const oldB = await msg(tenantScope(tenantB), b, 400 * DAY);
      const favB = await msg(tenantScope(tenantB), b, 400 * DAY, { favorite: true });
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30, maxMessages: 1, maxFavorites: 1 });

      await runRetention(targetA(), { config: config() });

      expect(await existing([oldA, oldB, favB])).toEqual(new Set([oldB, favB]));
      expect((await favoritesOf([favB]))[0]?.isFavorite).toBe(true);
      expect(await stateOf(tenantB)).toBeNull();
    });

    it("a plataforma e as organizações não se alcançam", async () => {
      const a = await thread(tenantScope(tenantA));
      const p = await thread(platformScope);
      // Mais de 10 anos: o corte de 3650 dias não alcança dado local de desenvolvimento.
      const ancient = 3700 * DAY;
      const oldA = await msg(tenantScope(tenantA), a, ancient);
      const oldP = await msg(platformScope, p, ancient);
      const env = config({ [CLOUD_DAYS]: 3650 });

      const platformRun = await runRetention({ tenantId: null, channelType: "whatsapp_cloud" }, { config: env });

      expect(platformRun.ran).toBe(true);
      expect(await existing([oldA, oldP])).toEqual(new Set([oldA]));
      expect(await stateOf(null)).not.toBeNull();
      expect(await stateOf(tenantA)).toBeNull();

      const oldP2 = await msg(platformScope, p, ancient);
      await runRetention(targetA(), { config: env });

      expect(await existing([oldA, oldP2])).toEqual(new Set([oldP2]));
    });

    it("cada tipo de canal é um escopo: a política de um não alcança o outro", async () => {
      const cloud = await thread(tenantScope(tenantA), "whatsapp_cloud");
      const qr = await thread(tenantScope(tenantA), "whatsapp_qr");
      const cloudOld = [await msg(tenantScope(tenantA), cloud, 12 * DAY), await msg(tenantScope(tenantA), cloud, 11 * DAY)];
      const qrOld = [
        await msg(tenantScope(tenantA), qr, 30 * DAY),
        await msg(tenantScope(tenantA), qr, 29 * DAY),
        await msg(tenantScope(tenantA), qr, 28 * DAY),
      ];
      await setPolicy(tenantA, "whatsapp_cloud", { maxMessages: 1 });
      const env = config({ [QR_MAX]: 2 });

      await runRetention(targetA("whatsapp_cloud"), { config: env });

      // Teto 1 no Cloud: sai a mais velha do Cloud; as do QR (mais velhas ainda) não entram no ranque.
      expect(await existing([...cloudOld, ...qrOld])).toEqual(new Set([cloudOld[1] as string, ...qrOld]));

      await runRetention(targetA("whatsapp_qr"), { config: env });

      expect(await existing(qrOld)).toEqual(new Set([qrOld[1] as string, qrOld[2] as string]));
      expect(await stateOf(tenantA, "whatsapp_qr")).not.toBeNull();
    });

    it("`batchLimit` por fase: o que sobra fica para a próxima execução, com `truncated`", async () => {
      const t = await thread(tenantScope(tenantA));
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await msg(tenantScope(tenantA), t, (100 - i) * DAY));
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });
      const small = { ...config(), batchLimit: 2 };

      const first = await runRetention(targetA(), { config: small });
      // As mais velhas primeiro.
      expect(await existing(ids)).toEqual(new Set(ids.slice(2)));
      expect(first.result).toMatchObject({ byAge: 2, truncated: true });

      expect((await runRetention(targetA(), { config: small })).result).toMatchObject({ byAge: 2, truncated: true });
      expect((await runRetention(targetA(), { config: small })).result).toMatchObject({ byAge: 1, truncated: false });
      expect(await existing(ids)).toEqual(new Set());
    });
  });

  describe("lote grande", () => {
    it("com mais ids que o limite de parâmetros do Postgres (65.535), a prévia e a execução batem", async () => {
      const t = await thread(tenantScope(tenantA));
      const bulk = 66_000;
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`
          insert into message (tenant_id, conversation_id, channel_id, direction, sender_type, type, text, created_at)
          select ${tenantA}, ${t.conversationId}, ${t.channelId}, 'in', 'contact', 'text', 'x',
                 now() - interval '100 days' - (g * interval '1 second')
          from generate_series(1, ${bulk}) g`;
      });
      const recent = [
        await msg(tenantScope(tenantA), t, 12 * DAY),
        await msg(tenantScope(tenantA), t, 11 * DAY),
        await msg(tenantScope(tenantA), t, 10 * DAY),
      ];
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30, maxMessages: 1 });
      const big = { ...config(), batchLimit: 70_000 };

      const preview = await runRetention(targetA(), { dryRun: true, config: big });
      const real = await runRetention(targetA(), { config: big });

      expect(preview.result).toMatchObject({ byAge: bulk, byCount: 2, truncated: false, messagesTotal: bulk + 3 });
      expect(real.result).toMatchObject({ byAge: bulk, byCount: 2, truncated: false, messagesTotal: 1 });
      expect(await existing(recent)).toEqual(new Set([recent[2] as string]));
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  // O que vai junto e o que fica
  // ---------------------------------------------------------------------------

  describe("o que vai junto e o que fica", () => {
    it("a mídia da mensagem apagada sai: a linha `file` e o objeto do armazenamento", async () => {
      const scope = tenantScope(tenantA);
      const t = await thread(scope);
      const old = await msg(scope, t, 100 * DAY);
      const kept = await msg(scope, t, 1 * DAY);
      const oldFile = await attachMedia(scope, memory, old, Buffer.from("velho"), "text/plain");
      const keptFile = await attachMedia(scope, memory, kept, Buffer.from("novo"), "text/plain");
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });

      const outcome = await runRetention(targetA(), { config: config() });

      expect(outcome.result.filesDeleted).toBe(1);
      const files = await read((tx) => tx.select({ id: file.id }).from(file).where(inArray(file.id, [oldFile, keptFile])));
      expect(files.map(({ id }) => id)).toEqual([keptFile]);
      expect([...memory.objects.keys()]).toEqual([`inbox/test/${kept}`]);
    });

    it("a conversa esvaziada permanece, com as âncoras e sem a prévia do texto", async () => {
      const lastAt = ago(40 * DAY);
      const t = await thread(tenantScope(tenantA), "whatsapp_cloud", { lastMessageAt: lastAt, lastInboundAt: lastAt, unreadCount: 2 });
      await msg(tenantScope(tenantA), t, 41 * DAY);
      await msg(tenantScope(tenantA), t, 40 * DAY);
      const partial = await seedConversation(tenantScope(tenantA), t.channelId);
      await msg(tenantScope(tenantA), { conversationId: partial.id, channelId: t.channelId }, 40 * DAY);
      await msg(tenantScope(tenantA), { conversationId: partial.id, channelId: t.channelId }, 1 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });

      await runRetention(targetA(), { config: config() });

      const rows = await read((tx) => tx.select().from(conversation).where(inArray(conversation.id, [t.conversationId, partial.id])));
      const emptied = rows.find((row) => row.id === t.conversationId);
      const kept = rows.find((row) => row.id === partial.id);
      expect(await countIn(t.conversationId)).toBe(0);
      expect(emptied).toMatchObject({ lastMessagePreview: null, lastMessageDirection: "in", unreadCount: 2, status: "open" });
      expect(emptied?.lastMessageAt?.getTime()).toBe(lastAt.getTime());
      expect(emptied?.lastInboundAt?.getTime()).toBe(lastAt.getTime());
      // A parcialmente podada guarda a prévia (ainda tem mensagem).
      expect(kept?.lastMessagePreview).toBe("oi");
    });

    const conversationOf = async (id: string) => {
      const [row] = await read((tx) => tx.select().from(conversation).where(eq(conversation.id, id)));
      return row;
    };

    it("última mensagem apagada por idade, com favorita mais antiga sobrando: a prévia sai, as âncoras ficam", async () => {
      const lastAt = ago(40 * DAY);
      const t = await thread(tenantScope(tenantA), "whatsapp_cloud", { lastMessageAt: lastAt, lastInboundAt: lastAt, unreadCount: 1 });
      const fav = await msg(tenantScope(tenantA), t, 50 * DAY, { favorite: true });
      const last = await msg(tenantScope(tenantA), t, 40 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });

      await runRetention(targetA(), { config: config() });

      expect(await existing([fav, last])).toEqual(new Set([fav]));
      const row = await conversationOf(t.conversationId);
      expect(row).toMatchObject({ lastMessagePreview: null, lastMessageDirection: "in", unreadCount: 1 });
      expect(row?.lastMessageAt?.getTime()).toBe(lastAt.getTime());
      expect(row?.lastInboundAt?.getTime()).toBe(lastAt.getTime());
    });

    it("última mensagem apagada pela contagem, com favorita mais antiga sobrando: a prévia sai", async () => {
      const lastAt = ago(20 * DAY);
      const x = await thread(tenantScope(tenantA), "whatsapp_cloud", { lastMessageAt: lastAt, lastInboundAt: lastAt });
      const fav = await msg(tenantScope(tenantA), x, 50 * DAY, { favorite: true });
      const lastX = await msg(tenantScope(tenantA), x, 20 * DAY);
      // Outra conversa do mesmo escopo, mais nova: com teto 1, a última de X passa do teto.
      const y = await seedConversation(tenantScope(tenantA), x.channelId);
      const lastY = await msg(tenantScope(tenantA), { conversationId: y.id, channelId: x.channelId }, 5 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { maxMessages: 1 });

      const outcome = await runRetention(targetA(), { config: config() });

      expect(outcome.result).toMatchObject({ byCount: 1 });
      expect(await existing([fav, lastX, lastY])).toEqual(new Set([fav, lastY]));
      const rowX = await conversationOf(x.conversationId);
      expect(rowX?.lastMessagePreview).toBeNull();
      expect(rowX?.lastMessageAt?.getTime()).toBe(lastAt.getTime());
      expect(rowX?.lastInboundAt?.getTime()).toBe(lastAt.getTime());
      expect((await conversationOf(y.id))?.lastMessagePreview).toBe("oi");
    });

    it("só mensagens antigas saem e a última fica: a prévia continua", async () => {
      const t = await thread(tenantScope(tenantA));
      const old = await msg(tenantScope(tenantA), t, 40 * DAY);
      const last = await msg(tenantScope(tenantA), t, 10 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });

      await runRetention(targetA(), { config: config() });

      expect(await existing([old, last])).toEqual(new Set([last]));
      expect((await conversationOf(t.conversationId))?.lastMessagePreview).toBe("oi");
    });

    it("mensagem citada por outra pode sair: a citação fica sem alvo e a resposta continua", async () => {
      const scope = tenantScope(tenantA);
      const t = await thread(scope);
      const quoted = await msg(scope, t, 100 * DAY);
      const reply = await msg(scope, t, 1 * DAY);
      await read((tx) => tx.update(message).set({ replyToMessageId: quoted }).where(eq(message.id, reply)));
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });

      await runRetention(targetA(), { config: config() });

      const [row] = await read((tx) => tx.select().from(message).where(eq(message.id, reply)));
      expect(await existing([quoted])).toEqual(new Set());
      expect(row).toMatchObject({ id: reply, replyToMessageId: null, text: "conteúdo pessoal" });
    });

    it("grava a última execução (só contagens) depois da execução de verdade", async () => {
      const t = await thread(tenantScope(tenantA));
      await msg(tenantScope(tenantA), t, 100 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });
      const now = new Date();

      const outcome = await runRetention(targetA(), { config: config(), now });

      const state = await stateOf(tenantA);
      expect(state?.lastRunAt?.getTime()).toBe(now.getTime());
      expect(state?.lastResult).toEqual(outcome.result);
      expect(JSON.stringify(state?.lastResult)).not.toContain("conteúdo");
      expect(await lastRetentionRun(targetA())).toEqual({ lastRunAt: now, result: outcome.result });

      // Segunda execução: upsert, uma linha só por escopo.
      await runRetention(targetA(), { config: config() });
      const rows = await read((tx) => tx.select().from(messageRetentionState).where(eq(messageRetentionState.tenantId, tenantA)));
      expect(rows).toHaveLength(1);
    });

    it("avisa as telas só com ids (`pg_notify('inbox')`)", async () => {
      const t = await thread(tenantScope(tenantA));
      await msg(tenantScope(tenantA), t, 100 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });
      const payloads: string[] = [];
      const listener = await owner.listen("inbox", (payload) => payloads.push(payload));

      try {
        await runRetention(targetA(), { config: config() });
        await vi.waitFor(() => expect(payloads.some((p) => p.includes(t.conversationId))).toBe(true));
      } finally {
        await listener.unlisten();
      }

      const notice = JSON.parse(payloads.find((p) => p.includes(t.conversationId)) as string);
      expect(notice).toEqual({ s: tenantA, c: t.conversationId, k: "message", a: null });
    });
  });

  // ---------------------------------------------------------------------------
  // Reentrega de aviso antigo
  // ---------------------------------------------------------------------------

  describe("reentrega de um aviso antigo depois da limpeza", () => {
    const passThrough = (type: ChannelType) =>
      ({
        type,
        normalizeEvents: (raw: unknown) =>
          (raw as NormalizedEvent[]).map((event) =>
            "occurredAt" in event ? { ...event, occurredAt: new Date(event.occurredAt) } : event,
          ),
        probe: async () => ({ status: "connected", detail: null }),
      }) as unknown as ChannelProvider;

    async function deliver(row: { id: string; tenantId: string | null; type: ChannelType }, events: NormalizedEvent[]) {
      setProvidersForTests([passThrough(row.type)]);
      const { id } = await receiveChannelEvent({
        scope: scopeOf(row.tenantId),
        channelId: row.id,
        provider: row.type,
        dedupeKey: randomUUID(),
        kind: "message",
        raw: events,
      });
      return processChannelEvent(id);
    }

    it("a mensagem volta como nova (limite conhecido), sem recuar as âncoras da conversa, e o próximo ciclo a leva", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA), { name: `Ret ${randomUUID().slice(0, 6)}-rettest-chtest` });
      const oldEvent: NormalizedMessage = {
        type: "message",
        fromPhone: "5511977770001",
        fromExternalId: null,
        pushName: "Ana",
        providerMessageId: `wamid.${randomUUID()}`,
        fromMe: false,
        messageType: "text",
        text: "antiga",
        media: null,
        replyToProviderMessageId: null,
        occurredAt: ago(100 * DAY),
      };
      const recentEvent: NormalizedMessage = { ...oldEvent, providerMessageId: `wamid.${randomUUID()}`, text: "recente", occurredAt: ago(1 * HOUR) };
      await deliver(ch, [oldEvent]);
      await deliver(ch, [recentEvent]);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });

      const first = await runRetention(targetA(), { config: config() });
      expect(first.result.byAge).toBe(1);

      const [before] = await read((tx) => tx.select().from(conversation).where(eq(conversation.channelId, ch.id)));

      await expect(deliver(ch, [oldEvent])).resolves.toBe("processed");

      const [after] = await read((tx) => tx.select().from(conversation).where(eq(conversation.channelId, ch.id)));
      const messages = await read((tx) => tx.select().from(message).where(eq(message.channelId, ch.id)));
      expect(messages).toHaveLength(2);
      expect(after?.lastMessageAt?.getTime()).toBe(before?.lastMessageAt?.getTime());
      expect(after?.lastInboundAt?.getTime()).toBe(before?.lastInboundAt?.getTime());
      expect(after?.lastMessagePreview).toBe(before?.lastMessagePreview);

      const second = await runRetention(targetA(), { config: config() });
      expect(second.result.byAge).toBe(1);
      expect(await read((tx) => tx.select({ id: message.id }).from(message).where(eq(message.channelId, ch.id)))).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Job
  // ---------------------------------------------------------------------------

  describe("job `inbox.retention`", () => {
    it("fila `exclusive`, cron diário e `singletonKey` fixo", () => {
      const queue = queueDefinitions.find(({ name }) => name === QUEUE.inboxRetention);
      expect(queue?.options).toMatchObject({ policy: "exclusive", deadLetter: QUEUE.inboxRetentionDead });
      const schedule = scheduleDefinitions.find(({ queue: name }) => name === QUEUE.inboxRetention);
      expect(schedule?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
      expect(schedule?.singletonKey).toBe("inbox.retention");
    });

    it("lista os escopos com conversa, por organização e tipo de canal, e a plataforma com `null`", async () => {
      await thread(tenantScope(tenantA), "whatsapp_cloud");
      await thread(tenantScope(tenantA), "whatsapp_qr");
      await thread(tenantScope(tenantB), "whatsapp_cloud");

      const targets = await listRetentionTargets();

      expect(targets).toEqual(
        expect.arrayContaining([
          { tenantId: tenantA, channelType: "whatsapp_cloud" },
          { tenantId: tenantA, channelType: "whatsapp_qr" },
          { tenantId: tenantB, channelType: "whatsapp_cloud" },
        ]),
      );
      expect(targets).not.toContainEqual({ tenantId: tenantB, channelType: "whatsapp_qr" });
    });

    it("uma organização que falha não impede as outras", async () => {
      const a = await thread(tenantScope(tenantA));
      const b = await thread(tenantScope(tenantB));
      const oldA = await msg(tenantScope(tenantA), a, 100 * DAY);
      const oldB = await msg(tenantScope(tenantB), b, 100 * DAY);
      await setPolicy(tenantA, "whatsapp_cloud", { retentionDays: 30 });
      await setPolicy(tenantB, "whatsapp_cloud", { retentionDays: 30 });
      const summary = await runRetentionCycle({
        config: config(),
        // B primeiro: a falha dela não pode parar A.
        targets: [
          { tenantId: tenantB, channelType: "whatsapp_cloud" },
          { tenantId: tenantA, channelType: "whatsapp_cloud" },
        ],
        run: (target, options) =>
          target.tenantId === tenantB ? Promise.reject(new Error("falha simulada")) : runRetention(target, options),
      });

      expect(summary).toEqual({ scopes: 2, ran: 1, failed: 1, truncated: 0 });
      expect(await existing([oldA, oldB])).toEqual(new Set([oldB]));
      expect(await stateOf(tenantA)).not.toBeNull();
      expect(await stateOf(tenantB)).toBeNull();
    });
  });
});
