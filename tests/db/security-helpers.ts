import { createHmac } from "node:crypto";
import { expect } from "vitest";
import { call, type TestUser } from "./tenant-helpers";

/** 2FA e personificação pela API, com Postgres real. */

export const PASSWORD = "Senha-forte-123";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(value: string) {
  let bits = "";

  for (const char of value.replace(/=+$/, "")) {
    bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  }

  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

/** RFC 6238, do jeito que um aplicativo autenticador calcula. */
export function totpCode(totpURI: string, at = Date.now()) {
  const secret = new URL(totpURI).searchParams.get("secret") ?? "";
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));

  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = (digest.at(-1) as number) & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;

  return String(value % 1_000_000).padStart(6, "0");
}

/** Aplica os `Set-Cookie` da resposta, como o navegador: o último vale, vazio apaga. */
export function applyCookies(cookie: string, response: Response) {
  const jar = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return [pair.slice(0, index), pair.slice(index + 1)] as const;
      }),
  );

  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] as string;
    const index = pair.indexOf("=");
    const [name, value] = [pair.slice(0, index), pair.slice(index + 1)];

    if (value) jar.set(name, value);
    else jar.delete(name);
  }

  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

export type TwoFactorSetup = { totpURI: string; backupCodes: string[] };

/** Ativa o 2FA e devolve a sessão nova: o plugin troca a sessão ao confirmar. */
export async function enableTwoFactor(user: TestUser): Promise<TwoFactorSetup> {
  const enabled = await call("POST", "/api/auth/two-factor/enable", {
    cookie: user.cookie,
    body: { password: PASSWORD },
  });
  expect(enabled.status).toBe(200);

  const setup = (await enabled.json()) as TwoFactorSetup;
  const verified = await call("POST", "/api/auth/two-factor/verify-totp", {
    cookie: user.cookie,
    body: { code: totpCode(setup.totpURI) },
  });
  expect(verified.status).toBe(200);

  user.cookie = applyCookies(user.cookie, verified);
  return setup;
}

export function signInWithPassword(email: string) {
  return call("POST", "/api/auth/sign-in/email", {
    body: { email, password: PASSWORD },
  });
}
