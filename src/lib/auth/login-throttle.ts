/**
 * Bloqueio de login por tentativas: a decisão, pura. Quem lê e grava o estado é
 * `login-throttle-store.ts`; quem aplica no login é `src/api/login-throttle.ts`.
 *
 * `LOGIN_LOCKOUT_SCOPE` diz o que fica bloqueado:
 * - `email`: o e-mail, venha de onde vier. Segura ataque distribuído; um terceiro consegue
 *   bloquear a conta errando a senha de propósito (a saída do dono é redefinir a senha).
 * - `email_ip`: o par e-mail e IP. O dono nunca fica trancado por causa de outro IP; não
 *   segura ataque vindo de muitos IPs.
 * - `off`: nada. Fica só o limite por IP do Better Auth.
 */

export const loginLockoutScopes = ["email", "email_ip", "off"] as const;
export type LoginLockoutScope = (typeof loginLockoutScopes)[number];

export type LoginThrottleConfig = {
  /** Falhas, dentro da janela, que abrem o bloqueio. */
  maxAttempts: number;
  /** Janela em que as falhas se somam. */
  windowMs: number;
  /** Duração do bloqueio. */
  lockoutMs: number;
};

/** Tempos em milissegundos desde a época. `null` é quem nunca falhou. */
export type LoginThrottleState = {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number | null;
} | null;

/** Milissegundos que faltam do bloqueio; `0` quando o login pode ser tentado. */
export function lockRemainingMs(state: LoginThrottleState, now: number) {
  if (!state?.lockedUntil) return 0;
  return Math.max(state.lockedUntil - now, 0);
}

/**
 * O estado depois de mais uma falha. A janela recomeça quando venceu ou quando o bloqueio
 * anterior já passou: quem cumpriu a espera volta com a contagem zerada.
 */
export function registerFailure(
  state: LoginThrottleState,
  now: number,
  { maxAttempts, windowMs, lockoutMs }: LoginThrottleConfig,
): NonNullable<LoginThrottleState> {
  const expired =
    !state ||
    now - state.windowStartedAt >= windowMs ||
    (state.lockedUntil !== null && state.lockedUntil <= now);

  const failures = expired ? 1 : state.failures + 1;

  return {
    failures,
    windowStartedAt: expired ? now : state.windowStartedAt,
    lockedUntil: failures >= maxAttempts ? now + lockoutMs : null,
  };
}

/** `Retry-After`, em segundos inteiros, nunca zero. */
export function retryAfterSeconds(remainingMs: number) {
  return Math.max(Math.ceil(remainingMs / 1000), 1);
}

/** O e-mail na forma em que vira chave: o mesmo para `Ana@X.com ` e `ana@x.com`. */
export function normalizeLoginEmail(email: string) {
  return email.trim().toLowerCase();
}

/**
 * Devolve a tentativa reservada quando a resposta não disse nada sobre a senha (400, 429 do
 * limite por IP, 5xx). `null` é "sem linha". O bloqueio aberto pela própria reserva cai junto:
 * quem reservou não confirmou a falha.
 */
export function releaseAttempt(state: LoginThrottleState): LoginThrottleState {
  if (!state || state.failures <= 1) return null;

  return { ...state, failures: state.failures - 1, lockedUntil: null };
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * O IP na forma em que entra na chave do escopo `email_ip`. IPv6 conta pelo /64, a unidade
 * que um assinante recebe: com o endereço inteiro, bastaria trocar de endereço dentro do
 * próprio prefixo a cada bloqueio. IPv4 mapeado em IPv6 vira IPv4.
 */
export function throttleIp(ip: string) {
  const address = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = IPV4_MAPPED.exec(address);

  if (mapped?.[1]) return mapped[1];
  if (!address.includes(":")) return address;

  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(8 - left.length - right.length, 0)).fill("0"), ...right];

  // Malformado: fica como veio, e ainda assim é uma chave estável.
  if (groups.length !== 8) return address;

  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ""));
  return `${prefix.join(":")}::/64`;
}
