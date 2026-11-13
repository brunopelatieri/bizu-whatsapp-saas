import type { Context } from "hono";
import { MINUTE } from "@/api/guards";
import { logError } from "@/api/log";
import { clientKey, rateLimit } from "@/api/rate-limit";
import type { LoginThrottleRealm } from "@/db/schema";
import { audit } from "@/lib/audit";
import { runInBackground } from "@/lib/auth/background";
import { retryAfterSeconds } from "@/lib/auth/login-throttle";
import {
  clearLoginThrottle,
  loginThrottleKeys,
  loginThrottleSettings,
  releaseLoginAttempt,
  reserveLoginAttempt,
} from "@/lib/auth/login-throttle-store";
import { signInRequestSchema } from "@/lib/schemas/auth";

/**
 * Por IP, na frente do bloqueio por e-mail: o caminho bloqueado nem chega ao limite do Better
 * Auth, e sem isto custaria uma transação por requisição, sem teto.
 */
export const signInRateLimit = (name: string) =>
  rateLimit({ name, limit: 20, windowMs: MINUTE });

const invalid = (c: Context) => c.json({ error: "Dados inválidos." }, 400);

/**
 * O `sign-in/email` do Better Auth, com o bloqueio de login por tentativas em volta.
 *
 * O corpo é lido AQUI, e o Better Auth recebe o que foi validado, sempre como JSON. O endpoint
 * dele também aceita `application/x-www-form-urlencoded`: se o proxy repassasse o corpo cru, um
 * formulário faria o login sem passar por nada do que este arquivo lê (o bloqueio, e a troca de
 * senha de `barredSignIn`, no portal).
 *
 * - Bloqueado: 429 com `Retry-After`, sem conferir a senha. É a resposta do rate limit, a
 *   mesma para e-mail com e sem conta.
 * - A tentativa é contada antes de a senha ser conferida (`reserveLoginAttempt`): tentativas
 *   simultâneas não escapam do limite, e falha ao gravar fecha a rota (503), não a abre.
 * - 401 (senha errada, e-mail sem conta, conta não verificada; no portal, também a conta em
 *   carência de exclusão: por fora são a mesma resposta) mantém a tentativa contada. Contar
 *   todas é o que impede o contador de virar oráculo.
 * - 200 zera a chave. Qualquer outra resposta (429 do limite por IP, 400, 403 de conta
 *   banida, 5xx) devolve a tentativa: não disse nada sobre a senha.
 */
export async function throttledSignIn(
  c: Context,
  realm: LoginThrottleRealm,
  run: (body: string) => Promise<Response>,
) {
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Envie os dados em JSON." }, 415);
  }

  let json: unknown;
  try {
    json = JSON.parse(await c.req.text());
  } catch {
    return invalid(c);
  }

  const parsed = signInRequestSchema.safeParse(json);
  if (!parsed.success) return invalid(c);

  const body = JSON.stringify(parsed.data);
  const { scope, config } = loginThrottleSettings();

  if (scope === "off") return run(body);

  const ip = clientKey(c);
  const keys = loginThrottleKeys(realm, parsed.data.email, ip, scope);
  let attempt: Awaited<ReturnType<typeof reserveLoginAttempt>>;

  try {
    attempt = await reserveLoginAttempt(realm, keys, Date.now(), config);
  } catch (error) {
    logError("Falha no bloqueio de login", error);
    return c.json({ error: "Serviço indisponível. Tente novamente." }, 503);
  }

  if (attempt.blockedMs > 0) {
    c.header("Retry-After", String(retryAfterSeconds(attempt.blockedMs)));
    return c.json({ error: "Muitas tentativas. Tente mais tarde." }, 429);
  }

  let response: Response;
  try {
    response = await run(body);
  } catch (error) {
    await releaseLoginAttempt(realm, keys.keyHash, Date.now()).catch((failure: unknown) =>
      logError("Falha ao devolver a tentativa de login", failure),
    );
    throw error;
  }

  try {
    if (response.ok) {
      await clearLoginThrottle(realm, keys.keyHash);
    } else if (response.status !== 401) {
      await releaseLoginAttempt(realm, keys.keyHash, Date.now());
    } else if (attempt.lockedNow) {
      // Só na falha que fecha o bloqueio. Sem ator (o e-mail pode nem ter conta) e sem o hash
      // do e-mail: a auditoria dura muito mais que o contador.
      runInBackground(
        audit("auth.login_locked", {
          actor: { type: realm === "portal" ? "portal_user" : "user", id: null },
          metadata: { realm, scope },
          ip,
        }),
      );
    }
  } catch (error) {
    // A resposta do login já existe. A tentativa fica contada: erra para o lado fechado.
    logError("Falha ao atualizar o bloqueio de login", error);
  }

  return response;
}
