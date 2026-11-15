import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { channelTypes } from "@/lib/channels/types";
import { parseEnv } from "@/lib/env";
import { retentionDimensions, retentionEnvKeys } from "@/lib/inbox/retention-policy";

/**
 * D-7 (SPEC `pre-producao`, bloco R): a retenção nasce desligada no exemplo de desenvolvimento e ligada
 * no de produção, e toda variável que o `env.ts` aceita aparece nos três arquivos. Sem isto, uma variável
 * esquecida no compose some em produção sem aviso (o contêiner nunca a recebe).
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const allKeys = [
  "MESSAGE_RETENTION_ENABLED",
  "MESSAGE_RETENTION_MIN_AGE_HOURS",
  "MESSAGE_RETENTION_BATCH_LIMIT",
  ...channelTypes.flatMap((type) => retentionDimensions.map((dim) => retentionEnvKeys(type)[dim])),
];

/** Linhas `CHAVE=valor` ativas (não comentadas) de um arquivo de exemplo. */
function assignments(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1]) out[match[1]] = (match[2] ?? "").replace(/\s+#.*$/, "").trim();
  }
  return out;
}

const baseEnv = {
  APP_URL: "http://localhost:5173",
  DATABASE_URL: "postgresql://bizu_app:bizu_app@localhost:15437/bizu",
  DIRECT_URL: "postgresql://bizu_owner:bizu_owner@localhost:15437/bizu",
  BETTER_AUTH_SECRET: "change-me-better-auth-secret-with-32-bytes",
  CREDENTIALS_ENCRYPTION_KEY: "Y2hhbmdlLW1lLWNyZWRlbnRpYWxzLWtleS0zMmJ5dGU=",
  AUDIT_SALT: "change-me-audit-salt",
  SMTP_HOST: "localhost",
};

describe("variáveis de retenção nos arquivos de exemplo", () => {
  const dev = assignments(read(".env.example"));
  const prod = assignments(read("docker/.env.prod.example"));
  const compose = read("docker/compose.prod.yml");

  it("desligada no exemplo de desenvolvimento e ligada no de produção (D-7)", () => {
    expect(dev.MESSAGE_RETENTION_ENABLED).toBe("false");
    expect(prod.MESSAGE_RETENTION_ENABLED).toBe("true");
  });

  it.each(allKeys)("%s está nos dois exemplos e no compose", (key) => {
    expect(dev).toHaveProperty(key);
    expect(prod).toHaveProperty(key);
    expect(compose).toContain(`${key}: \${${key}:-`);
  });

  it("os padrões de D-7 e C-3 (5000, 90 e 200) valem para os dois tipos de canal em produção", () => {
    for (const type of channelTypes) {
      const keys = retentionEnvKeys(type);
      expect(prod[keys.maxMessages]).toBe("5000");
      expect(prod[keys.retentionDays]).toBe("90");
      expect(prod[keys.maxFavorites]).toBe("200");
    }
    expect(prod.MESSAGE_RETENTION_MIN_AGE_HOURS).toBe("72");
  });

  it.each([
    ["desenvolvimento", dev],
    ["produção", prod],
  ])("os valores do exemplo de %s passam pela validação do env", (_name, file) => {
    const retention = Object.fromEntries(allKeys.map((key) => [key, file[key]]));

    const env = parseEnv({ ...baseEnv, ...retention });

    expect(env.MESSAGE_RETENTION_ENABLED).toBe(file.MESSAGE_RETENTION_ENABLED === "true");
    expect(env.MESSAGE_RETENTION_MIN_AGE_HOURS).toBe(72);
  });

  it("o compose não fixa limite: sem a variável, sem limite; só o piso e o lote têm padrão", () => {
    expect(compose).toContain(`MESSAGE_RETENTION_ENABLED: \${MESSAGE_RETENTION_ENABLED:-false}`);
    for (const type of channelTypes) {
      for (const dim of retentionDimensions) {
        const key = retentionEnvKeys(type)[dim];
        expect(compose).toContain(`${key}: \${${key}:-}`);
      }
    }
  });
});
