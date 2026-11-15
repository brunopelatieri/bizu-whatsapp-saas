import { describe, expect, it } from "vitest";
import { channelTypes } from "@/lib/channels/types";
import {
  DEFAULT_BATCH_LIMIT,
  DEFAULT_MIN_AGE_HOURS,
  effectiveMinAgeHours,
  emptyRunResult,
  MIN_AGE_HOURS_FLOOR,
  planRetention,
  readRunResult,
  type RetentionConfig,
  type RetentionLimits,
  resolveRetention,
  retentionConfigFromEnv,
  retentionCutoffs,
  retentionEnvKeys,
} from "@/lib/inbox/retention-policy";

const none: RetentionLimits = { maxMessages: null, retentionDays: null, maxFavorites: null };
const defaults: RetentionLimits = { maxMessages: 5000, retentionDays: 90, maxFavorites: 200 };

function config(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    enabled: true,
    minAgeHours: 72,
    batchLimit: 5000,
    defaults: { whatsapp_cloud: defaults, whatsapp_qr: none },
    ...overrides,
  };
}

describe("resolveRetention: precedência", () => {
  it("sem linha herda os três padrões do .env", () => {
    const { limits, sources } = resolveRetention(null, defaults);

    expect(limits).toEqual(defaults);
    expect(sources).toEqual({
      maxMessages: "default",
      retentionDays: "default",
      maxFavorites: "default",
    });
  });

  it("NULL na coluna herda, e o campo ausente também", () => {
    const row = { maxMessages: null, retentionDays: undefined };

    expect(resolveRetention(row, defaults).limits).toEqual(defaults);
  });

  it("a linha vence o padrão, dimensão por dimensão", () => {
    const { limits, sources } = resolveRetention({ retentionDays: 30 }, defaults);

    expect(limits).toEqual({ maxMessages: 5000, retentionDays: 30, maxFavorites: 200 });
    expect(sources.retentionDays).toBe("policy");
    expect(sources.maxMessages).toBe("default");
  });

  it("0 na linha é sem limite, mesmo com padrão no .env, e a origem segue sendo a política", () => {
    const { limits, sources } = resolveRetention(
      { maxMessages: 0, retentionDays: 0, maxFavorites: 0 },
      defaults,
    );

    expect(limits).toEqual(none);
    expect(sources).toEqual({
      maxMessages: "policy",
      retentionDays: "policy",
      maxFavorites: "policy",
    });
  });

  it("0 nunca vira um limite de zero: não existe 'apagar tudo'", () => {
    const { limits } = resolveRetention({ maxMessages: 0 }, defaults);

    expect(limits.maxMessages).toBeNull();
    expect(limits.maxMessages).not.toBe(0);
  });

  it("0 no padrão do .env também é sem limite", () => {
    const { limits, sources } = resolveRetention(null, { ...defaults, maxMessages: 0 });

    expect(limits.maxMessages).toBeNull();
    expect(sources.maxMessages).toBe("unlimited");
  });

  it("sem linha e sem padrão não há limite", () => {
    expect(resolveRetention(null, none).limits).toEqual(none);
    expect(resolveRetention(null, undefined).limits).toEqual(none);
    expect(resolveRetention(undefined, undefined).sources.maxMessages).toBe("unlimited");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "valor torto (%s) na linha é sem limite, sem herdar o padrão",
    (bad) => {
      const { limits, sources } = resolveRetention({ maxMessages: bad }, defaults);

      expect(limits.maxMessages).toBeNull();
      expect(sources.maxMessages).toBe("unlimited");
    },
  );

  it.each([-5, 2.5, Number.NaN, "90" as unknown as number])(
    "padrão torto (%s) no .env é sem limite",
    (bad) => {
      const { limits } = resolveRetention(null, { ...none, retentionDays: bad });

      expect(limits.retentionDays).toBeNull();
    },
  );
});

describe("planRetention: o que uma limpeza pode aplicar", () => {
  it("ligada, aplica os limites resolvidos", () => {
    const plan = planRetention(config(), "whatsapp_cloud", null);

    expect(plan.run).toEqual(defaults);
    expect(plan.effective).toEqual(defaults);
    expect(plan.canPurge).toBe(true);
  });

  it("desligada nunca apaga, mas a política segue visível para a tela", () => {
    const plan = planRetention(config({ enabled: false }), "whatsapp_cloud", {
      maxMessages: 10,
      retentionDays: 1,
      maxFavorites: 1,
    });

    expect(plan.enabled).toBe(false);
    expect(plan.run).toEqual(none);
    expect(plan.canPurge).toBe(false);
    expect(plan.effective).toEqual({ maxMessages: 10, retentionDays: 1, maxFavorites: 1 });
  });

  it("ligada sem nenhum limite não tem o que apagar", () => {
    const plan = planRetention(config(), "whatsapp_qr", null);

    expect(plan.run).toEqual(none);
    expect(plan.canPurge).toBe(false);
  });

  it("ligada com tudo em 0 na linha não tem o que apagar, mesmo com padrão no .env", () => {
    const plan = planRetention(config(), "whatsapp_cloud", {
      maxMessages: 0,
      retentionDays: 0,
      maxFavorites: 0,
    });

    expect(plan.run).toEqual(none);
    expect(plan.canPurge).toBe(false);
  });

  it("um limite só basta para poder apagar", () => {
    const plan = planRetention(config(), "whatsapp_qr", { retentionDays: 7 });

    expect(plan.run).toEqual({ ...none, retentionDays: 7 });
    expect(plan.canPurge).toBe(true);
  });

  it("tipo de canal sem padrão no mapa não apaga nada por herança", () => {
    const sparse = config({ defaults: {} as RetentionConfig["defaults"] });

    const plan = planRetention(sparse, "whatsapp_cloud", null);

    expect(plan.run).toEqual(none);
    expect(plan.canPurge).toBe(false);
  });

  it("só enabled === true liga", () => {
    const loose = config({ enabled: "true" as unknown as boolean });

    expect(planRetention(loose, "whatsapp_cloud", null).canPurge).toBe(false);
  });

  it("o piso do plano nunca fica abaixo de 24 h, mesmo com configuração torta", () => {
    expect(planRetention(config({ minAgeHours: 1 }), "whatsapp_cloud", null).floorHours).toBe(24);
    expect(planRetention(config({ minAgeHours: 0 }), "whatsapp_cloud", null).floorHours).toBe(24);
    expect(planRetention(config({ minAgeHours: 200 }), "whatsapp_cloud", null).floorHours).toBe(
      200,
    );
  });

  it("lote torto cai no padrão", () => {
    expect(planRetention(config({ batchLimit: 0 }), "whatsapp_cloud", null).batchLimit).toBe(
      DEFAULT_BATCH_LIMIT,
    );
  });
});

describe("retentionCutoffs: o piso vence a política", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);

  it("sem prazo não há corte por idade, mas o piso existe", () => {
    expect(retentionCutoffs(72, null, now)).toEqual({ floorAt: hoursAgo(72), ageCutoff: null });
  });

  it("prazo maior que o piso manda", () => {
    const { ageCutoff, floorAt } = retentionCutoffs(72, 90, now);

    expect(ageCutoff).toEqual(hoursAgo(90 * 24));
    expect(floorAt).toEqual(hoursAgo(72));
  });

  it("prazo menor que o piso vira o piso (1 dia com piso de 72 h)", () => {
    expect(retentionCutoffs(72, 1, now).ageCutoff).toEqual(hoursAgo(72));
  });

  it("prazo 0 é sem prazo", () => {
    expect(retentionCutoffs(72, 0, now).ageCutoff).toBeNull();
  });

  it("piso abaixo de 24 h é levantado para 24 h", () => {
    expect(retentionCutoffs(1, 1, now)).toEqual({
      floorAt: hoursAgo(24),
      ageCutoff: hoursAgo(24),
    });
  });

  it("o corte nunca é mais recente que o piso, para qualquer prazo", () => {
    for (const days of [1, 2, 3, 4, 30, 3650]) {
      const { ageCutoff, floorAt } = retentionCutoffs(72, days, now);

      expect(ageCutoff !== null && ageCutoff <= floorAt).toBe(true);
    }
  });
});

describe("effectiveMinAgeHours", () => {
  it.each([
    [72, 72],
    [24, 24],
    [23, MIN_AGE_HOURS_FLOOR],
    [0, MIN_AGE_HOURS_FLOOR],
    [8760, 8760],
    [-1, DEFAULT_MIN_AGE_HOURS],
    [Number.NaN, DEFAULT_MIN_AGE_HOURS],
    [undefined, DEFAULT_MIN_AGE_HOURS],
    ["72", DEFAULT_MIN_AGE_HOURS],
  ])("%s horas viram %s", (input, expected) => {
    expect(effectiveMinAgeHours(input)).toBe(expected);
  });
});

describe("retentionConfigFromEnv", () => {
  it("env vazio: desligada, sem limites, piso e lote padrão (ausência nunca apaga)", () => {
    const result = retentionConfigFromEnv({});

    expect(result.enabled).toBe(false);
    expect(result.minAgeHours).toBe(DEFAULT_MIN_AGE_HOURS);
    expect(result.batchLimit).toBe(DEFAULT_BATCH_LIMIT);
    for (const type of channelTypes) expect(result.defaults[type]).toEqual(none);
  });

  it("lê as variáveis de cada tipo de canal, e 0 vira sem limite", () => {
    const result = retentionConfigFromEnv({
      MESSAGE_RETENTION_ENABLED: true,
      MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES: 5000,
      MESSAGE_RETENTION_WHATSAPP_QR_DAYS: 0,
      MESSAGE_RETENTION_WHATSAPP_QR_MAX_FAVORITES: 200,
      MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS: 30,
      MESSAGE_RETENTION_MIN_AGE_HOURS: 48,
      MESSAGE_RETENTION_BATCH_LIMIT: 100,
    });

    expect(result.enabled).toBe(true);
    expect(result.minAgeHours).toBe(48);
    expect(result.batchLimit).toBe(100);
    expect(result.defaults.whatsapp_qr).toEqual({
      maxMessages: 5000,
      retentionDays: null,
      maxFavorites: 200,
    });
    expect(result.defaults.whatsapp_cloud).toEqual({ ...none, retentionDays: 30 });
  });

  it("não liga com texto: só o booleano true", () => {
    expect(retentionConfigFromEnv({ MESSAGE_RETENTION_ENABLED: "true" }).enabled).toBe(false);
  });

  it("piso do .env abaixo de 24 h é levantado", () => {
    expect(retentionConfigFromEnv({ MESSAGE_RETENTION_MIN_AGE_HOURS: 1 }).minAgeHours).toBe(24);
  });

  it("os nomes saem do tipo do canal", () => {
    expect(retentionEnvKeys("whatsapp_qr")).toEqual({
      maxMessages: "MESSAGE_RETENTION_WHATSAPP_QR_MAX_MESSAGES",
      retentionDays: "MESSAGE_RETENTION_WHATSAPP_QR_DAYS",
      maxFavorites: "MESSAGE_RETENTION_WHATSAPP_QR_MAX_FAVORITES",
    });
  });

  it("ponta a ponta: ligada, linha com 0 em uma dimensão, padrão do .env nas outras", () => {
    const cfg = retentionConfigFromEnv({
      MESSAGE_RETENTION_ENABLED: true,
      MESSAGE_RETENTION_WHATSAPP_CLOUD_MAX_MESSAGES: 5000,
      MESSAGE_RETENTION_WHATSAPP_CLOUD_DAYS: 90,
    });

    const plan = planRetention(cfg, "whatsapp_cloud", { maxMessages: 0 });

    expect(plan.run).toEqual({ maxMessages: null, retentionDays: 90, maxFavorites: null });
  });
});

describe("readRunResult", () => {
  it("{} (nunca rodou) e lixo viram zeros", () => {
    expect(readRunResult({})).toEqual(emptyRunResult);
    expect(readRunResult(null)).toEqual(emptyRunResult);
    expect(readRunResult("x")).toEqual(emptyRunResult);
  });

  it("lê o que o job gravou e descarta campo torto", () => {
    const stored = {
      byAge: 3,
      byCount: 2,
      favoritesDemoted: 1,
      filesDeleted: 4,
      messagesTotal: 100,
      favoritesTotal: 7,
      truncated: true,
    };

    expect(readRunResult(stored)).toEqual(stored);
    expect(readRunResult({ ...stored, byAge: -1, byCount: "2", truncated: "sim" })).toEqual({
      ...stored,
      byAge: 0,
      byCount: 0,
      truncated: false,
    });
  });
});
