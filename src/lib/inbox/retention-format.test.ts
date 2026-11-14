import { describe, expect, it } from "vitest";
import {
  DIMENSIONS,
  describeLastRun,
  describePreview,
  draftFromLimit,
  draftFromPolicy,
  floorLabel,
  inheritLabel,
  isDirty,
  isIdleRun,
  limitFromDraft,
  limitLabel,
  effectiveAfterSave,
  platformSourceLabel,
  policyFromDraft,
  saveConfirmation,
  savedPolicy,
  sourceLabel,
  stateNotice,
  tightenedLimits,
} from "@/lib/inbox/retention-format";
import { emptyRunResult, RETENTION_LIMIT_MAX } from "@/lib/inbox/retention-policy";
import { retentionPolicySchema } from "@/lib/schemas/retention";

const [messages, days, favorites] = DIMENSIONS;

describe("as três opções de cada limite", () => {
  it("lê a linha gravada: null herda, 0 é sem limite, o resto é número", () => {
    expect(draftFromLimit(null)).toEqual({ mode: "inherit", value: "" });
    expect(draftFromLimit(undefined)).toEqual({ mode: "inherit", value: "" });
    expect(draftFromLimit(0)).toEqual({ mode: "unlimited", value: "" });
    expect(draftFromLimit(90)).toEqual({ mode: "number", value: "90" });
  });

  it("herdar vira null e sem limite vira 0: nunca se confundem", () => {
    expect(limitFromDraft({ mode: "inherit", value: "" }, 10)).toEqual({ ok: true, value: null });
    expect(limitFromDraft({ mode: "unlimited", value: "" }, 10)).toEqual({ ok: true, value: 0 });
    // O número digitado em outro modo não vaza para o corpo.
    expect(limitFromDraft({ mode: "inherit", value: "50" }, 10)).toEqual({ ok: true, value: null });
    expect(limitFromDraft({ mode: "unlimited", value: "50" }, 10)).toEqual({ ok: true, value: 0 });
  });

  it("definir um valor exige inteiro de 1 até o teto; vazio e 0 não valem", () => {
    expect(limitFromDraft({ mode: "number", value: "30" }, 3650)).toEqual({ ok: true, value: 30 });
    expect(limitFromDraft({ mode: "number", value: " 7 " }, 3650)).toEqual({ ok: true, value: 7 });
    expect(limitFromDraft({ mode: "number", value: "3650" }, 3650)).toEqual({
      ok: true,
      value: 3650,
    });

    for (const value of ["", "   ", "0", "00", "-3", "1,5", "1.5", "abc", "1e3"]) {
      expect(limitFromDraft({ mode: "number", value }, 3650).ok, JSON.stringify(value)).toBe(false);
    }
    expect(limitFromDraft({ mode: "number", value: "3651" }, 3650)).toEqual({
      ok: false,
      error: "No máximo 3.650.",
    });
    expect(limitFromDraft({ mode: "number", value: "0" }, 10)).toMatchObject({
      error: 'Para não limitar, escolha "Sem limite".',
    });
  });

  it("os tetos da tela são os da API", () => {
    expect(messages.max).toBe(RETENTION_LIMIT_MAX.maxMessages);
    expect(days.max).toBe(RETENTION_LIMIT_MAX.retentionDays);
    expect(favorites.max).toBe(RETENTION_LIMIT_MAX.maxFavorites);
  });

  it("o corpo montado passa no Zod da rota, nas três combinações", () => {
    const draft = draftFromPolicy({ maxMessages: 5000, retentionDays: 0, maxFavorites: null });
    const result = policyFromDraft(draft);
    expect(result).toEqual({
      ok: true,
      policy: { maxMessages: 5000, retentionDays: 0, maxFavorites: null },
    });
    if (result.ok) expect(retentionPolicySchema.safeParse(result.policy).success).toBe(true);
  });

  it("um campo torto bloqueia o corpo inteiro e aponta qual", () => {
    const draft = draftFromPolicy(null);
    draft.retentionDays = { mode: "number", value: "" };
    const result = policyFromDraft(draft);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(["retentionDays"]);
  });
});

describe("alterações não salvas", () => {
  it("sem linha, tudo herdado é igual ao gravado", () => {
    expect(savedPolicy(null)).toEqual({ maxMessages: null, retentionDays: null, maxFavorites: null });
    expect(isDirty(draftFromPolicy(null), null)).toBe(false);
  });

  it("0 e herdar diferem; trocar de modo é alteração", () => {
    const policy = { maxMessages: 0, retentionDays: null, maxFavorites: 10 };
    const draft = draftFromPolicy(policy);
    expect(isDirty(draft, policy)).toBe(false);

    expect(isDirty({ ...draft, maxMessages: { mode: "inherit", value: "" } }, policy)).toBe(true);
    expect(isDirty({ ...draft, retentionDays: { mode: "unlimited", value: "" } }, policy)).toBe(true);
    expect(isDirty({ ...draft, maxFavorites: { mode: "number", value: "11" } }, policy)).toBe(true);
  });

  it("rascunho inválido conta como alterado", () => {
    const draft = draftFromPolicy(null);
    draft.maxMessages = { mode: "number", value: "" };
    expect(isDirty(draft, null)).toBe(true);
  });
});

describe("confirmação ao salvar com a retenção ligada (R3b-4)", () => {
  const defaults = { maxMessages: 5000, retentionDays: 90, maxFavorites: 200 };
  const current = (over: Partial<typeof defaults> | Record<string, number | null> = {}, enabled = true) => ({
    enabled,
    defaults,
    effective: { ...defaults, ...over },
  });
  const inherit = { maxMessages: null, retentionDays: null, maxFavorites: null };

  it("o que passa a valer: nulo herda o padrão, 0 tira o limite, número fica", () => {
    expect(effectiveAfterSave(null, 5000)).toBe(5000);
    expect(effectiveAfterSave(null, null)).toBeNull();
    expect(effectiveAfterSave(0, 5000)).toBeNull();
    expect(effectiveAfterSave(1000, 5000)).toBe(1000);
  });

  it("desligada nunca pede confirmação, mesmo apertando", () => {
    expect(saveConfirmation(current({}, false), { ...inherit, maxMessages: 10 })).toBeNull();
  });

  it("ligada e sem apertar nada (afrouxar, tirar o limite, manter) salva direto", () => {
    expect(saveConfirmation(current(), { ...inherit, maxMessages: 9000 })).toBeNull();
    expect(saveConfirmation(current(), { maxMessages: 0, retentionDays: 0, maxFavorites: 0 })).toBeNull();
    expect(saveConfirmation(current(), { ...inherit, retentionDays: 90 })).toBeNull();
    expect(saveConfirmation(current(), inherit)).toBeNull();
  });

  it("número menor que o que vale hoje pede confirmação e diz de quanto para quanto", () => {
    const confirmation = saveConfirmation(current(), { ...inherit, maxMessages: 1000 });
    expect(confirmation?.lines).toEqual(["Máximo de mensagens: de 5.000 mensagens para 1.000 mensagens"]);
    expect(confirmation?.intro).toContain("sem volta");
    expect(confirmation?.note).toContain("prévia");
  });

  it("limite onde não havia nenhum também aperta", () => {
    const now = current({ retentionDays: null });
    expect(tightenedLimits(now, { ...inherit, retentionDays: 30 })).toMatchObject([{ from: null, to: 30 }]);
    expect(saveConfirmation(now, { ...inherit, retentionDays: 30 })?.lines).toEqual([
      "Guardar por quantos dias: de sem limite para 30 dias",
    ]);
  });

  it("voltar a herdar um padrão mais baixo que o valor fixado aperta", () => {
    // Hoje vale 20.000 (fixado); herdar traz o padrão de 5.000.
    const now = current({ maxMessages: 20_000 });
    expect(saveConfirmation(now, inherit)?.lines).toEqual([
      "Máximo de mensagens: de 20.000 mensagens para 5.000 mensagens",
    ]);
  });

  it("o teto de favoritas conta, e vários limites saem em linhas separadas", () => {
    const confirmation = saveConfirmation(current(), { maxMessages: 100, retentionDays: 0, maxFavorites: 1 });
    expect(confirmation?.lines).toEqual([
      "Máximo de mensagens: de 5.000 mensagens para 100 mensagens",
      "Máximo de favoritas: de 200 favoritas para 1 favorita",
    ]);
  });
});

describe("de onde vem o que vale", () => {
  it("rotula as três origens", () => {
    expect(sourceLabel("policy")).toBe("fixado para esta organização");
    expect(sourceLabel("default")).toBe("padrão do sistema");
    expect(sourceLabel("unlimited")).toBe("nenhum limite definido");
  });

  it("a plataforma nunca fala em organização", () => {
    expect(platformSourceLabel("default")).toBe("padrão do sistema");
    expect(platformSourceLabel("unlimited")).toBe("nenhum limite definido");
    expect(platformSourceLabel("policy")).not.toMatch(/organiza/);
  });

  it("escreve o limite com a unidade certa e o sem limite", () => {
    expect(limitLabel(messages, 5000)).toBe("5.000 mensagens");
    expect(limitLabel(messages, 1)).toBe("1 mensagem");
    expect(limitLabel(days, 90)).toBe("90 dias");
    expect(limitLabel(favorites, 200)).toBe("200 favoritas");
    expect(limitLabel(days, null)).toBe("sem limite");
  });

  it("a opção de herdar mostra o padrão que seria herdado", () => {
    expect(inheritLabel(days, 90)).toBe("Herdar o padrão do sistema (90 dias)");
    expect(inheritLabel(days, null)).toBe("Herdar o padrão do sistema (sem limite)");
  });

  it("escreve o piso", () => {
    expect(floorLabel(24)).toBe("24 horas");
    expect(floorLabel(72)).toBe("72 horas (3 dias)");
    expect(floorLabel(36)).toBe("36 horas");
  });
});

describe("o resumo da última execução", () => {
  it("nunca rodou", () => {
    expect(describeLastRun(null)).toEqual({
      headline: "Nunca rodou.",
      rows: [],
      totals: null,
      truncatedNote: null,
    });
  });

  it("mostra quando rodou, as contagens e o estado depois dela", () => {
    const summary = describeLastRun(
      {
        at: "2026-11-14T04:45:00.000Z",
        result: {
          byAge: 12,
          byCount: 3,
          favoritesDemoted: 1,
          filesDeleted: 2,
          messagesTotal: 480,
          favoritesTotal: 20,
          truncated: false,
        },
      },
      (iso) => `<${iso}>`,
    );
    expect(summary.headline).toBe("Rodou em <2026-11-14T04:45:00.000Z>.");
    expect(summary.rows).toEqual([
      { label: "Apagadas por idade", value: 12 },
      { label: "Apagadas por contagem", value: 3 },
      { label: "Favoritas rebaixadas", value: 1 },
      { label: "Arquivos apagados", value: 2 },
    ]);
    expect(summary.totals).toBe("Depois dela, 480 mensagens e 20 favoritas.");
    expect(summary.truncatedNote).toBeNull();
  });

  it("avisa quando o lote foi cortado e quando a data é desconhecida", () => {
    const summary = describeLastRun({ at: null, result: { ...emptyRunResult, truncated: true } });
    expect(summary.headline).toBe("Rodou em data desconhecida.");
    expect(summary.truncatedNote).toMatch(/dia seguinte/);
  });
});

describe("o resumo da prévia", () => {
  it("nada a fazer", () => {
    const summary = describePreview({ ...emptyRunResult, messagesTotal: 1, favoritesTotal: 0 }, 5000);
    expect(summary.headline).toBe("Se a limpeza rodasse agora, nada seria apagado nem rebaixado.");
    expect(summary.totals).toBe("Hoje há 1 mensagem e 0 favoritas neste escopo.");
    expect(summary.truncatedNote).toBeNull();
    expect(isIdleRun(emptyRunResult)).toBe(true);
  });

  it("conta cada fase e avisa o lote cortado, com o limite", () => {
    const summary = describePreview(
      {
        byAge: 1,
        byCount: 1234,
        favoritesDemoted: 0,
        filesDeleted: 5,
        messagesTotal: 9000,
        favoritesTotal: 10,
        truncated: true,
      },
      5000,
    );
    expect(summary.headline).toContain("1 mensagem apagada por idade");
    expect(summary.headline).toContain("1.234 por contagem");
    expect(summary.headline).toContain("0 favoritas rebaixadas");
    expect(summary.headline).toContain("5 arquivos apagados");
    expect(summary.rows.map((row) => row.value)).toEqual([1, 1234, 0, 5]);
    expect(summary.truncatedNote).toContain("5.000");
  });
});

describe("o aviso de estado", () => {
  it("desligada: política gravada, nada é apagado", () => {
    const notice = stateNotice(false, 72);
    expect(notice.tone).toBe("off");
    expect(notice.body).toMatch(/gravada/);
    expect(notice.body).toMatch(/nenhuma mensagem é apagada/);
  });

  it("ligada: roda uma vez por dia, apaga sem volta e poupa favorita e o piso", () => {
    const notice = stateNotice(true, 72);
    expect(notice.tone).toBe("on");
    expect(notice.body).toMatch(/uma vez por dia/);
    expect(notice.body).toMatch(/sem volta/);
    expect(notice.body).toMatch(/favorita/);
    expect(notice.body).toContain("72 horas (3 dias)");
  });
});
