import {
  RETENTION_LIMIT_MAX,
  type RetentionDimension,
  type RetentionLimit,
  type RetentionRunResult,
  type RetentionSource,
  retentionDimensions,
} from "@/lib/inbox/retention-policy";
import type { RetentionPolicyInput } from "@/lib/schemas/retention";

/**
 * O que a tela de retenção do `/admin` (bloco R, R3b) formata e decide. Módulo puro: sem React, sem
 * banco e sem relógio escondido. Os números e as origens vêm prontos de `GET /api/admin/retention/*`
 * (`RetentionView`); a precedência continua só em `retention-policy.ts`.
 */

/** As três formas de um limite no formulário. `null` herda, `0` é sem limite: nunca se confundem. */
export type LimitMode = "inherit" | "unlimited" | "number";

export type LimitDraft = { mode: LimitMode; value: string };
export type PolicyDraft = Record<RetentionDimension, LimitDraft>;

export const LIMIT_MODES: ReadonlyArray<LimitMode> = ["inherit", "unlimited", "number"];

export type DimensionInfo = {
  key: RetentionDimension;
  label: string;
  /** Unidade no plural, depois do número: "5.000 mensagens". */
  unit: string;
  /** No singular, para o número 1. */
  unitOne: string;
  hint: string;
  max: number;
};

export const DIMENSIONS: ReadonlyArray<DimensionInfo> = [
  {
    key: "maxMessages",
    label: "Máximo de mensagens",
    unit: "mensagens",
    unitOne: "mensagem",
    hint: "Vale para a organização inteira neste tipo de canal, não por conversa. As mais antigas saem primeiro.",
    max: RETENTION_LIMIT_MAX.maxMessages,
  },
  {
    key: "retentionDays",
    label: "Guardar por quantos dias",
    unit: "dias",
    unitOne: "dia",
    hint: "A mensagem mais velha que isto é apagada.",
    max: RETENTION_LIMIT_MAX.retentionDays,
  },
  {
    key: "maxFavorites",
    label: "Máximo de favoritas",
    unit: "favoritas",
    unitOne: "favorita",
    hint: "Acima disto, as favoritas mais antigas deixam de ser favoritas e só podem ser apagadas no ciclo seguinte.",
    max: RETENTION_LIMIT_MAX.maxFavorites,
  },
];

const numberFormat = new Intl.NumberFormat("pt-BR");

export const formatCount = (value: number): string => numberFormat.format(value);

/** "5.000 mensagens", "1 dia", ou "sem limite" para `null`. */
export function limitLabel(dimension: DimensionInfo, value: RetentionLimit): string {
  if (value === null) return "sem limite";
  return `${formatCount(value)} ${value === 1 ? dimension.unitOne : dimension.unit}`;
}

/** Valor da linha gravada → como o formulário o mostra: `null` herda, `0` é sem limite. */
export function draftFromLimit(value: number | null | undefined): LimitDraft {
  if (value === null || value === undefined) return { mode: "inherit", value: "" };
  if (value === 0) return { mode: "unlimited", value: "" };
  return { mode: "number", value: String(value) };
}

export function draftFromPolicy(policy: RetentionPolicyInput | null): PolicyDraft {
  return {
    maxMessages: draftFromLimit(policy?.maxMessages),
    retentionDays: draftFromLimit(policy?.retentionDays),
    maxFavorites: draftFromLimit(policy?.maxFavorites),
  };
}

export type LimitResult = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Formulário → valor da API. "Herdar" é `null`, "Sem limite" é `0` e "Definir" é um inteiro de 1 até o
 * teto. Em "Definir", campo vazio e `0` não valem: ninguém herda nem fica sem limite por engano.
 */
export function limitFromDraft(draft: LimitDraft, max: number): LimitResult {
  if (draft.mode === "inherit") return { ok: true, value: null };
  if (draft.mode === "unlimited") return { ok: true, value: 0 };

  const text = draft.value.trim();
  if (text === "") return { ok: false, error: "Informe um número ou escolha outra opção." };
  if (!/^\d+$/.test(text)) return { ok: false, error: "Use um número inteiro, sem sinal." };

  const value = Number(text);
  if (value === 0) return { ok: false, error: 'Para não limitar, escolha "Sem limite".' };
  if (value > max) return { ok: false, error: `No máximo ${formatCount(max)}.` };
  return { ok: true, value };
}

export type PolicyResult =
  | { ok: true; policy: RetentionPolicyInput }
  | { ok: false; errors: Partial<Record<RetentionDimension, string>> };

export function policyFromDraft(draft: PolicyDraft): PolicyResult {
  const errors: Partial<Record<RetentionDimension, string>> = {};
  const values: Partial<RetentionPolicyInput> = {};

  for (const info of DIMENSIONS) {
    const result = limitFromDraft(draft[info.key], info.max);
    if (result.ok) values[info.key] = result.value;
    else errors[info.key] = result.error;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, policy: values as RetentionPolicyInput };
}

/** A política gravada, ou tudo herdado quando não há linha: o ponto de comparação do "tem alteração". */
export function savedPolicy(policy: RetentionPolicyInput | null): RetentionPolicyInput {
  return {
    maxMessages: policy?.maxMessages ?? null,
    retentionDays: policy?.retentionDays ?? null,
    maxFavorites: policy?.maxFavorites ?? null,
  };
}

/** O rascunho (válido) difere do que está gravado? Rascunho inválido conta como alterado. */
export function isDirty(draft: PolicyDraft, policy: RetentionPolicyInput | null): boolean {
  const result = policyFromDraft(draft);
  if (!result.ok) return true;
  const saved = savedPolicy(policy);
  return retentionDimensions.some((key) => result.policy[key] !== saved[key]);
}

/** De onde vem o limite que vale. `unlimited` quer dizer que nem a política nem o padrão definem um. */
export function sourceLabel(source: RetentionSource): string {
  switch (source) {
    case "policy":
      return "fixado para esta organização";
    case "default":
      return "padrão do sistema";
    case "unlimited":
      return "nenhum limite definido";
  }
}

/** Na plataforma não há linha de política: o que vale é só o padrão do sistema. */
export function platformSourceLabel(source: RetentionSource): string {
  return source === "default" ? "padrão do sistema" : "nenhum limite definido";
}

/** O texto da opção "herdar": mostra o padrão que seria herdado. */
export function inheritLabel(dimension: DimensionInfo, defaultValue: RetentionLimit): string {
  return `Herdar o padrão do sistema (${limitLabel(dimension, defaultValue)})`;
}

/** "72 horas (3 dias)", "24 horas", "48 horas (2 dias)". */
export function floorLabel(hours: number): string {
  const base = `${formatCount(hours)} ${hours === 1 ? "hora" : "horas"}`;
  if (hours < 48 || hours % 24 !== 0) return base;
  return `${base} (${formatCount(hours / 24)} dias)`;
}

const plural = (count: number, one: string, many: string) =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

export type RunRow = { label: string; value: number };

/** As quatro contagens do que a limpeza apaga ou rebaixa, na ordem das fases. */
export function runRows(result: RetentionRunResult): RunRow[] {
  return [
    { label: "Apagadas por idade", value: result.byAge },
    { label: "Apagadas por contagem", value: result.byCount },
    { label: "Favoritas rebaixadas", value: result.favoritesDemoted },
    { label: "Arquivos apagados", value: result.filesDeleted },
  ];
}

/** Nada a fazer: nenhuma das quatro contagens tem valor. */
export function isIdleRun(result: RetentionRunResult): boolean {
  return runRows(result).every((row) => row.value === 0);
}

export type PreviewSummary = {
  rows: RunRow[];
  /** Frase que resume o que a limpeza faria agora. */
  headline: string;
  /** Mensagens e favoritas que existem hoje no escopo. */
  totals: string;
  /** Só quando o lote foi cortado. */
  truncatedNote: string | null;
};

/** A prévia: o que a limpeza faria agora, com a política já gravada. Não apaga nada. */
export function describePreview(result: RetentionRunResult, batchLimit: number): PreviewSummary {
  const idle = isIdleRun(result);
  return {
    rows: runRows(result),
    headline: idle
      ? "Se a limpeza rodasse agora, nada seria apagado nem rebaixado."
      : `Se a limpeza rodasse agora: ${plural(result.byAge, "mensagem apagada por idade", "mensagens apagadas por idade")}, ${formatCount(
          result.byCount,
        )} por contagem, ${plural(result.favoritesDemoted, "favorita rebaixada", "favoritas rebaixadas")} e ${plural(
          result.filesDeleted,
          "arquivo apagado",
          "arquivos apagados",
        )}.`,
    totals: `Hoje há ${plural(result.messagesTotal, "mensagem", "mensagens")} e ${plural(
      result.favoritesTotal,
      "favorita",
      "favoritas",
    )} neste escopo.`,
    truncatedNote: result.truncated
      ? `Cada fase apaga no máximo ${formatCount(batchLimit)} por dia: o que passar disso fica para os próximos dias.`
      : null,
  };
}

export type LastRunSummary = {
  /** "Nunca rodou" ou "Rodou em 14/11/2026 04:45". */
  headline: string;
  rows: RunRow[];
  /** Estado depois da execução; só quando rodou. */
  totals: string | null;
  truncatedNote: string | null;
};

const defaultFormatAt = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** A última execução de verdade (`lastRun` da rota); `null` é "nunca rodou". */
export function describeLastRun(
  lastRun: { at: string | null; result: RetentionRunResult } | null,
  formatAt: (iso: string) => string = defaultFormatAt,
): LastRunSummary {
  if (!lastRun) {
    return { headline: "Nunca rodou.", rows: [], totals: null, truncatedNote: null };
  }

  const { at, result } = lastRun;
  return {
    headline: at ? `Rodou em ${formatAt(at)}.` : "Rodou em data desconhecida.",
    rows: runRows(result),
    totals: `Depois dela, ${plural(result.messagesTotal, "mensagem", "mensagens")} e ${plural(
      result.favoritesTotal,
      "favorita",
      "favoritas",
    )}.`,
    truncatedNote: result.truncated
      ? "O lote foi cortado: o que sobrou fica para o dia seguinte."
      : null,
  };
}

export type StateNotice = {
  tone: "off" | "on";
  title: string;
  body: string;
};

/** O aviso de estado do topo da tela: retenção desligada (nada se apaga) ou ligada (apaga sem volta). */
export function stateNotice(enabled: boolean, floorHours: number): StateNotice {
  if (!enabled) {
    return {
      tone: "off",
      title: "A retenção está desligada neste servidor",
      body: "A política fica gravada, mas nenhuma mensagem é apagada até a retenção ser ligada (MESSAGE_RETENTION_ENABLED). A prévia mostra o que aconteceria.",
    };
  }

  return {
    tone: "on",
    title: "A retenção está ligada",
    body: `A limpeza roda uma vez por dia e apaga mensagens sem volta. Mensagem favorita e mensagem mais nova que o piso de idade, de ${floorLabel(floorHours)}, não são apagadas.`,
  };
}
