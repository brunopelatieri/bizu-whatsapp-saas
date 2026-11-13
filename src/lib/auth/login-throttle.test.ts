import { describe, expect, it } from "vitest";
import {
  type LoginThrottleConfig,
  lockRemainingMs,
  normalizeLoginEmail,
  registerFailure,
  releaseAttempt,
  retryAfterSeconds,
  throttleIp,
} from "./login-throttle";

const MINUTE = 60_000;
const config: LoginThrottleConfig = {
  maxAttempts: 3,
  windowMs: 15 * MINUTE,
  lockoutMs: 10 * MINUTE,
};
const T0 = 1_800_000_000_000;

describe("registerFailure", () => {
  it("abre a janela na primeira falha, sem bloquear", () => {
    expect(registerFailure(null, T0, config)).toEqual({
      failures: 1,
      windowStartedAt: T0,
      lockedUntil: null,
    });
  });

  it("soma dentro da janela e mantém o início dela", () => {
    const first = registerFailure(null, T0, config);
    const second = registerFailure(first, T0 + MINUTE, config);

    expect(second).toEqual({ failures: 2, windowStartedAt: T0, lockedUntil: null });
  });

  it("bloqueia exatamente na falha de número maxAttempts", () => {
    let state = registerFailure(null, T0, config);
    state = registerFailure(state, T0 + 1, config);
    expect(state.lockedUntil).toBeNull();

    state = registerFailure(state, T0 + 2, config);
    expect(state.failures).toBe(3);
    expect(state.lockedUntil).toBe(T0 + 2 + config.lockoutMs);
  });

  it("recomeça quando a janela venceu", () => {
    const old = { failures: 2, windowStartedAt: T0, lockedUntil: null };

    expect(registerFailure(old, T0 + config.windowMs, config)).toEqual({
      failures: 1,
      windowStartedAt: T0 + config.windowMs,
      lockedUntil: null,
    });
  });

  it("um milissegundo antes do fim da janela ainda soma", () => {
    const old = { failures: 2, windowStartedAt: T0, lockedUntil: null };
    const next = registerFailure(old, T0 + config.windowMs - 1, config);

    expect(next.failures).toBe(3);
    expect(next.lockedUntil).not.toBeNull();
  });

  it("recomeça depois de um bloqueio cumprido, mesmo dentro da janela", () => {
    const locked = { failures: 3, windowStartedAt: T0, lockedUntil: T0 + MINUTE };

    expect(registerFailure(locked, T0 + MINUTE, config)).toEqual({
      failures: 1,
      windowStartedAt: T0 + MINUTE,
      lockedUntil: null,
    });
  });

  it("com maxAttempts 1, a primeira falha já bloqueia", () => {
    const state = registerFailure(null, T0, { ...config, maxAttempts: 1 });

    expect(state.lockedUntil).toBe(T0 + config.lockoutMs);
  });
});

describe("lockRemainingMs", () => {
  it("é zero para quem nunca falhou ou não está bloqueado", () => {
    expect(lockRemainingMs(null, T0)).toBe(0);
    expect(
      lockRemainingMs({ failures: 2, windowStartedAt: T0, lockedUntil: null }, T0),
    ).toBe(0);
  });

  it("devolve o que falta e zera no instante em que o bloqueio vence", () => {
    const state = { failures: 3, windowStartedAt: T0, lockedUntil: T0 + 5_000 };

    expect(lockRemainingMs(state, T0 + 1_000)).toBe(4_000);
    expect(lockRemainingMs(state, T0 + 5_000)).toBe(0);
    expect(lockRemainingMs(state, T0 + 9_000)).toBe(0);
  });
});

describe("retryAfterSeconds", () => {
  it("arredonda para cima e nunca devolve zero", () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(0)).toBe(1);
  });
});

describe("releaseAttempt", () => {
  it("devolve uma tentativa e desfaz o bloqueio que ela abriu", () => {
    const locked = { failures: 3, windowStartedAt: T0, lockedUntil: T0 + 5_000 };

    expect(releaseAttempt(locked)).toEqual({
      failures: 2,
      windowStartedAt: T0,
      lockedUntil: null,
    });
  });

  it("a única tentativa devolvida não deixa linha", () => {
    expect(releaseAttempt({ failures: 1, windowStartedAt: T0, lockedUntil: null })).toBeNull();
    expect(releaseAttempt(null)).toBeNull();
  });
});

describe("throttleIp", () => {
  it("mantém o IPv4 e desfaz o IPv4 mapeado em IPv6", () => {
    expect(throttleIp("203.0.113.7")).toBe("203.0.113.7");
    expect(throttleIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(throttleIp("::FFFF:203.0.113.7")).toBe("203.0.113.7");
  });

  it("agrupa o IPv6 pelo /64: trocar de endereço no mesmo prefixo não muda a chave", () => {
    const a = throttleIp("2001:db8:abcd:12:1111:2222:3333:4444");
    const b = throttleIp("2001:0db8:abcd:0012::1");

    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(b).toBe(a);
    expect(throttleIp("2001:db8:abcd:13::1")).not.toBe(a);
  });

  it("expande a forma abreviada, com colchetes e zona", () => {
    expect(throttleIp("::1")).toBe("0:0:0:0::/64");
    expect(throttleIp("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(throttleIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("o que não é endereço fica como veio", () => {
    expect(throttleIp("unknown")).toBe("unknown");
    expect(throttleIp("1:2:3")).toBe("1:2:3");
  });
});

describe("normalizeLoginEmail", () => {
  it("ignora caixa e espaço nas pontas", () => {
    expect(normalizeLoginEmail("  Ana@Exemplo.COM ")).toBe("ana@exemplo.com");
  });
});
