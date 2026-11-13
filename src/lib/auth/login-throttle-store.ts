import { createHmac } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { type LoginThrottleRealm, loginThrottle } from "@/db/schema";
import {
  type LoginLockoutScope,
  type LoginThrottleConfig,
  type LoginThrottleState,
  lockRemainingMs,
  normalizeLoginEmail,
  registerFailure,
  releaseAttempt,
  throttleIp,
} from "@/lib/auth/login-throttle";
import { getEnv } from "@/lib/env";

const MINUTE_MS = 60_000;

/** O que as variáveis `LOGIN_*` pedem. Lido a cada login: os testes trocam o ambiente. */
export function loginThrottleSettings(): {
  scope: LoginLockoutScope;
  config: LoginThrottleConfig;
} {
  const env = getEnv();

  return {
    scope: env.LOGIN_LOCKOUT_SCOPE,
    config: {
      maxAttempts: env.LOGIN_MAX_ATTEMPTS,
      windowMs: env.LOGIN_ATTEMPT_WINDOW_MINUTES * MINUTE_MS,
      lockoutMs: env.LOGIN_LOCKOUT_MINUTES * MINUTE_MS,
    },
  };
}

/** E-mail e IP nunca ficam em claro: sem `AUDIT_SALT`, o hash seria reversível por tabela. */
function digest(value: string) {
  return createHmac("sha256", getEnv().AUDIT_SALT).update(value).digest("hex");
}

export type LoginThrottleKeys = { keyHash: string; subjectHash: string };

/**
 * `subjectHash` é o e-mail; `keyHash` é o que o contador bloqueia. Com `email` os dois
 * coincidem; com `email_ip`, cada IP (IPv6 pelo /64, `throttleIp`) tem a própria chave para o
 * mesmo e-mail.
 */
export function loginThrottleKeys(
  realm: LoginThrottleRealm,
  email: string,
  ip: string,
  scope: Exclude<LoginLockoutScope, "off">,
): LoginThrottleKeys {
  const subject = `login:${realm}:${normalizeLoginEmail(email)}`;
  const subjectHash = digest(subject);

  return {
    subjectHash,
    keyHash: scope === "email_ip" ? digest(`${subject}:${throttleIp(ip)}`) : subjectHash,
  };
}

type Row = Pick<
  typeof loginThrottle.$inferSelect,
  "failures" | "windowStartedAt" | "lockedUntil"
>;

const toState = (row: Row | undefined): LoginThrottleState =>
  row
    ? {
        failures: row.failures,
        windowStartedAt: row.windowStartedAt.getTime(),
        lockedUntil: row.lockedUntil?.getTime() ?? null,
      }
    : null;

const sameKey = (realm: LoginThrottleRealm, keyHash: string) =>
  and(eq(loginThrottle.realm, realm), eq(loginThrottle.keyHash, keyHash));

const columns = {
  failures: loginThrottle.failures,
  windowStartedAt: loginThrottle.windowStartedAt,
  lockedUntil: loginThrottle.lockedUntil,
};

type Writer = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** Serializa tudo o que mexe na mesma chave: sem isto, duas tentativas leriam a mesma contagem. */
async function lockKey(tx: Writer, realm: LoginThrottleRealm, keyHash: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`login_throttle:${realm}:${keyHash}`}, 0))`,
  );

  const [row] = await tx
    .select(columns)
    .from(loginThrottle)
    .where(sameKey(realm, keyHash));

  return toState(row);
}

const toValues = (state: NonNullable<LoginThrottleState>, now: number) => ({
  failures: state.failures,
  windowStartedAt: new Date(state.windowStartedAt),
  lockedUntil: state.lockedUntil === null ? null : new Date(state.lockedUntil),
  updatedAt: new Date(now),
});

export type LoginAttempt =
  | { blockedMs: number; lockedNow?: undefined }
  /** A tentativa pode seguir. `lockedNow`: foi ela que atingiu o limite. */
  | { blockedMs: 0; lockedNow: boolean };

/**
 * Lê o bloqueio e já conta a tentativa, na mesma transação e sob a trava da chave. A falha é
 * reservada ANTES de a senha ser conferida: tentativas simultâneas não passam todas pela
 * leitura "ainda não bloqueado", e no máximo `maxAttempts` chegam a conferir a senha por
 * janela. Quem chama zera a chave no login certo e devolve a reserva
 * (`releaseLoginAttempt`) quando a resposta não disse nada sobre a senha.
 */
export async function reserveLoginAttempt(
  realm: LoginThrottleRealm,
  { keyHash, subjectHash }: LoginThrottleKeys,
  now: number,
  config: LoginThrottleConfig,
): Promise<LoginAttempt> {
  return getDb().transaction(async (tx) => {
    const state = await lockKey(tx, realm, keyHash);
    const blockedMs = lockRemainingMs(state, now);

    if (blockedMs > 0) return { blockedMs };

    const next = registerFailure(state, now, config);
    const values = toValues(next, now);

    await tx
      .insert(loginThrottle)
      .values({ realm, keyHash, subjectHash, ...values })
      .onConflictDoUpdate({
        target: [loginThrottle.realm, loginThrottle.keyHash],
        set: values,
      });

    return { blockedMs: 0, lockedNow: next.lockedUntil !== null };
  });
}

/** Desfaz a reserva de `reserveLoginAttempt`. Linha já zerada por um login certo fica como está. */
export async function releaseLoginAttempt(
  realm: LoginThrottleRealm,
  keyHash: string,
  now: number,
) {
  await getDb().transaction(async (tx) => {
    const state = await lockKey(tx, realm, keyHash);
    if (!state) return;

    const next = releaseAttempt(state);

    if (next) {
      await tx
        .update(loginThrottle)
        .set(toValues(next, now))
        .where(sameKey(realm, keyHash));
    } else {
      await tx.delete(loginThrottle).where(sameKey(realm, keyHash));
    }
  });
}

/** Login certo: a contagem daquela chave recomeça. */
export async function clearLoginThrottle(realm: LoginThrottleRealm, keyHash: string) {
  await getDb().delete(loginThrottle).where(sameKey(realm, keyHash));
}

/** Senha redefinida: todas as chaves do e-mail, de qualquer IP, são zeradas. */
export async function clearLoginThrottleForEmail(
  realm: LoginThrottleRealm,
  email: string,
) {
  const subjectHash = digest(`login:${realm}:${normalizeLoginEmail(email)}`);

  await getDb()
    .delete(loginThrottle)
    .where(
      and(eq(loginThrottle.realm, realm), eq(loginThrottle.subjectHash, subjectHash)),
    );
}

/**
 * `maintenance.prune`: sai a linha cuja janela e cujo bloqueio já venceram. A última escrita
 * é a última falha, e nada dela vale depois de `janela + bloqueio`.
 */
export async function pruneLoginThrottle(now = new Date()) {
  const { config } = loginThrottleSettings();
  const cutoff = new Date(now.getTime() - (config.windowMs + config.lockoutMs));

  const rows = await getDb()
    .delete(loginThrottle)
    .where(lt(loginThrottle.updatedAt, cutoff))
    .returning({ realm: loginThrottle.realm });

  return rows.length;
}
