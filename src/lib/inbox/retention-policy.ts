import type { ChannelType } from "@/lib/channels/types";

/**
 * Precedência da retenção de mensagens (bloco R, SPEC `pre-producao`). Módulo puro: sem banco, sem
 * `getEnv`, sem relógio escondido. Quem apaga (R2) e quem mostra (R3) perguntam aqui o que vale;
 * nada neste arquivo apaga linha.
 *
 * A cadeia, do mais específico ao mais geral:
 *
 *   linha de `retention_policy` → padrão do `.env` do tipo de canal → sem limite
 *
 * - `NULL` (ou sem linha) na dimensão **herda** o padrão do `.env`.
 * - `0` é **sem limite**, explícito: o que a pessoa fixou, nunca "apague tudo". Vale na linha e no
 *   `.env`.
 * - Toda ausência (variável faltando, valor torto, tipo de canal sem variável, retenção desligada)
 *   resulta em **não apagar**.
 * - O piso de idade (`MESSAGE_RETENTION_MIN_AGE_HOURS`, nunca abaixo de 24 h) prevalece sobre
 *   qualquer política, nas três fases.
 */

export const retentionDimensions = ["maxMessages", "retentionDays", "maxFavorites"] as const;
export type RetentionDimension = (typeof retentionDimensions)[number];

/** Um limite já resolvido: `null` é sem limite (não confundir com `0` da linha, que vira `null` aqui). */
export type RetentionLimit = number | null;
export type RetentionLimits = Record<RetentionDimension, RetentionLimit>;

/**
 * Linha de `retention_policy` (ou `null` sem linha). `null` ou campo ausente herda; `0` é sem limite.
 * Os nomes são os de `retentionPolicy` em `src/db/schema/inbox.ts`: a linha do Drizzle serve direto.
 */
export type RetentionPolicyRow = { [D in RetentionDimension]?: number | null | undefined };

/** De onde veio o valor: a linha (`policy`), o `.env` (`default`) ou ninguém (`unlimited`). */
export type RetentionSource = "policy" | "default" | "unlimited";

/** Teto de cada dimensão, para o Zod da rota do `/admin` (R3) e para o `.env`: o mesmo número nos dois. */
export const RETENTION_LIMIT_MAX = {
  maxMessages: 10_000_000,
  retentionDays: 3650,
  maxFavorites: 1_000_000,
} as const satisfies Record<RetentionDimension, number>;

/** Piso absoluto: nenhuma configuração leva a idade mínima abaixo disto (24 h). */
export const MIN_AGE_HOURS_FLOOR = 24;
export const DEFAULT_MIN_AGE_HOURS = 72;
export const DEFAULT_BATCH_LIMIT = 5000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Sufixo, no `.env`, de cada tipo de canal: `MESSAGE_RETENTION_<SUFIXO>_MAX_MESSAGES`, `_DAYS` e
 * `_MAX_FAVORITES`. O mapa é exaustivo sobre `ChannelType` (um tipo novo não compila até ganhar o
 * seu) e só conhece o vocabulário de `channels/types.ts`: o núcleo não importa pasta de módulo.
 */
const ENV_SUFFIX = {
  whatsapp_cloud: "WHATSAPP_CLOUD",
  whatsapp_qr: "WHATSAPP_QR",
} as const satisfies Record<ChannelType, string>;

/** Nomes das três variáveis de limite de um tipo de canal (para mensagens e documentação). */
export function retentionEnvKeys(channelType: ChannelType): Record<RetentionDimension, string> {
  const prefix = `MESSAGE_RETENTION_${ENV_SUFFIX[channelType]}`;
  return {
    maxMessages: `${prefix}_MAX_MESSAGES`,
    retentionDays: `${prefix}_DAYS`,
    maxFavorites: `${prefix}_MAX_FAVORITES`,
  };
}

/** Configuração lida do `.env`, já normalizada. `defaults[tipo]` tem `null` onde não há limite. */
export type RetentionConfig = {
  /** `MESSAGE_RETENTION_ENABLED`. Falso: nenhuma limpeza apaga nada. */
  enabled: boolean;
  /** Piso efetivo, em horas, nunca abaixo de `MIN_AGE_HOURS_FLOOR`. */
  minAgeHours: number;
  /** Teto de linhas que uma fase altera por escopo e execução. */
  batchLimit: number;
  defaults: Record<ChannelType, RetentionLimits>;
};

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** `0`, ausente, torto ou negativo viram `null` (sem limite): nunca "apague tudo". */
function normalizeLimit(value: unknown): RetentionLimit {
  return isCount(value) && value > 0 ? value : null;
}

/** Piso efetivo: valor torto cai em 72 h, e nada fica abaixo de 24 h. */
export function effectiveMinAgeHours(value: unknown): number {
  if (!isCount(value)) return DEFAULT_MIN_AGE_HOURS;
  return Math.max(value, MIN_AGE_HOURS_FLOOR);
}

const effectiveBatchLimit = (value: unknown): number =>
  isCount(value) && value > 0 ? value : DEFAULT_BATCH_LIMIT;

/**
 * Monta a configuração a partir do `Env` já validado (`getEnv()`); aceita um objeto qualquer, então o
 * teste não precisa de `process.env`. Só `MESSAGE_RETENTION_ENABLED === true` liga.
 */
export function retentionConfigFromEnv(env: Readonly<Record<string, unknown>>): RetentionConfig {
  const defaults = {} as Record<ChannelType, RetentionLimits>;
  for (const channelType of Object.keys(ENV_SUFFIX) as ChannelType[]) {
    const keys = retentionEnvKeys(channelType);
    defaults[channelType] = {
      maxMessages: normalizeLimit(env[keys.maxMessages]),
      retentionDays: normalizeLimit(env[keys.retentionDays]),
      maxFavorites: normalizeLimit(env[keys.maxFavorites]),
    };
  }
  return {
    enabled: env.MESSAGE_RETENTION_ENABLED === true,
    minAgeHours: effectiveMinAgeHours(env.MESSAGE_RETENTION_MIN_AGE_HOURS),
    batchLimit: effectiveBatchLimit(env.MESSAGE_RETENTION_BATCH_LIMIT),
    defaults,
  };
}

const NO_LIMITS: RetentionLimits = { maxMessages: null, retentionDays: null, maxFavorites: null };

function resolveDimension(
  policyValue: number | null | undefined,
  defaultValue: RetentionLimit,
): { value: RetentionLimit; source: RetentionSource } {
  // Herda: `NULL` na coluna e linha ausente são a mesma coisa.
  if (policyValue === null || policyValue === undefined) {
    const value = normalizeLimit(defaultValue);
    return { value, source: value === null ? "unlimited" : "default" };
  }
  // O banco recusa negativo (`CHECK`), mas o módulo não confia: valor torto é sem limite, nunca
  // herda um padrão que talvez apague mais do que a pessoa quis.
  if (!isCount(policyValue)) return { value: null, source: "unlimited" };
  // `0` explícito: a origem continua sendo a política (a pessoa escolheu), o valor é sem limite.
  return { value: policyValue === 0 ? null : policyValue, source: "policy" };
}

export type EffectiveRetention = {
  limits: RetentionLimits;
  sources: Record<RetentionDimension, RetentionSource>;
};

/**
 * Os três limites do escopo, pela precedência e **sem** olhar se a retenção está ligada: serve à
 * tela e à prévia ("o que a política manda"). Quem apaga usa `planRetention().run`.
 */
export function resolveRetention(
  row: RetentionPolicyRow | null | undefined,
  defaults: RetentionLimits | undefined,
): EffectiveRetention {
  const base = defaults ?? NO_LIMITS;
  const limits = {} as RetentionLimits;
  const sources = {} as Record<RetentionDimension, RetentionSource>;
  for (const dimension of retentionDimensions) {
    const resolved = resolveDimension(row?.[dimension], base[dimension]);
    limits[dimension] = resolved.value;
    sources[dimension] = resolved.source;
  }
  return { limits, sources };
}

export type RetentionPlan = {
  channelType: ChannelType;
  enabled: boolean;
  /** Piso efetivo em horas (>= 24). */
  floorHours: number;
  batchLimit: number;
  /** O que a política manda (linha, depois `.env`), ligada a retenção ou não: tela e prévia. */
  effective: RetentionLimits;
  sources: Record<RetentionDimension, RetentionSource>;
  /**
   * O que uma limpeza de verdade pode aplicar. **Tudo `null` com a retenção desligada**: quem apaga
   * lê só isto, então esquecer de olhar `enabled` não apaga nada.
   */
  run: RetentionLimits;
  /** Ligada e com pelo menos um limite: se for `false`, a execução não tem o que fazer. */
  canPurge: boolean;
};

/** Plano de um escopo (organização ou plataforma) e tipo de canal. */
export function planRetention(
  config: RetentionConfig,
  channelType: ChannelType,
  row: RetentionPolicyRow | null | undefined,
): RetentionPlan {
  const { limits, sources } = resolveRetention(row, config.defaults[channelType]);
  const enabled = config.enabled === true;
  const run = enabled ? limits : NO_LIMITS;
  return {
    channelType,
    enabled,
    floorHours: effectiveMinAgeHours(config.minAgeHours),
    batchLimit: effectiveBatchLimit(config.batchLimit),
    effective: limits,
    sources,
    run,
    canPurge: retentionDimensions.some((dimension) => run[dimension] !== null),
  };
}

export type RetentionCutoffs = {
  /**
   * Instante do piso: `created_at` **menor** que isto é elegível. Vale nas três fases (idade,
   * contagem e rebaixamento de favoritas), e nenhuma fase toca mensagem a partir daqui.
   */
  floorAt: Date;
  /**
   * Corte da fase por idade: `created_at < ageCutoff`. `null` sem prazo. Nunca é mais recente que o
   * `floorAt`: prazo menor que o piso vira o piso.
   */
  ageCutoff: Date | null;
};

export function retentionCutoffs(
  floorHours: number,
  retentionDays: RetentionLimit,
  now: Date,
): RetentionCutoffs {
  const floorAt = new Date(now.getTime() - effectiveMinAgeHours(floorHours) * HOUR_MS);
  const days = normalizeLimit(retentionDays);
  if (days === null) return { floorAt, ageCutoff: null };
  const byDays = new Date(now.getTime() - days * DAY_MS);
  return { floorAt, ageCutoff: byDays < floorAt ? byDays : floorAt };
}

/**
 * O que uma limpeza (ou a prévia dela) conta. É o formato de `message_retention_state.last_result`
 * (só contagens, nunca texto de mensagem) e do que a prévia devolve: o R2 grava, o R3 lê.
 *
 * - `byAge`, `byCount`: mensagens apagadas (na prévia, as que seriam) em cada fase.
 * - `favoritesDemoted`: favoritas que perderam a estrela por passar do teto (só somem no ciclo seguinte).
 * - `filesDeleted`: linhas `file` (e objetos) das mensagens apagadas.
 * - `messagesTotal`, `favoritesTotal`: o escopo depois da execução (na prévia, o estado atual).
 * - `truncated`: sobrou o que apagar além de `batchLimit` numa fase.
 */
export type RetentionRunResult = {
  byAge: number;
  byCount: number;
  favoritesDemoted: number;
  filesDeleted: number;
  messagesTotal: number;
  favoritesTotal: number;
  truncated: boolean;
};

export const emptyRunResult: RetentionRunResult = {
  byAge: 0,
  byCount: 0,
  favoritesDemoted: 0,
  filesDeleted: 0,
  messagesTotal: 0,
  favoritesTotal: 0,
  truncated: false,
};

/** Lê `last_result` (jsonb) sem confiar nele: campo ausente ou torto vira zero. `{}` é "nunca rodou". */
export function readRunResult(value: unknown): RetentionRunResult {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const count = (key: keyof RetentionRunResult) => (isCount(source[key]) ? (source[key] as number) : 0);
  return {
    byAge: count("byAge"),
    byCount: count("byCount"),
    favoritesDemoted: count("favoritesDemoted"),
    filesDeleted: count("filesDeleted"),
    messagesTotal: count("messagesTotal"),
    favoritesTotal: count("favoritesTotal"),
    truncated: source.truncated === true,
  };
}
