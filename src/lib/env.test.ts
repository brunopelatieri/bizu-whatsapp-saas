import { describe, expect, it } from "vitest";
import { EnvError, parseEnv } from "@/lib/env";

const base = {
  APP_URL: "http://localhost:5173",
  DATABASE_URL: "postgresql://bizu_app:bizu_app@localhost:15437/bizu",
  DIRECT_URL: "postgresql://bizu_owner:bizu_owner@localhost:15437/bizu",
  BETTER_AUTH_SECRET: "change-me-better-auth-secret-with-32-bytes",
  CREDENTIALS_ENCRYPTION_KEY: "Y2hhbmdlLW1lLWNyZWRlbnRpYWxzLWtleS0zMmJ5dGU=",
  AUDIT_SALT: "change-me-audit-salt",
  SMTP_HOST: "localhost",
};

function problemsOf(source: Record<string, string | undefined>) {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems;
    throw error;
  }
  return [];
}

describe("parseEnv", () => {
  it("aceita o .env.example em desenvolvimento e aplica padrões", () => {
    const env = parseEnv(base);

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.EMAIL_PROVIDER).toBe("smtp");
    expect(env.JOBS_MODE).toBe("inline");
    expect(env.PAYMENT_PROVIDERS).toEqual([]);
    expect(env.CSP_REPORT_ONLY).toBe(true);
    expect(env.SMTP_SECURE).toBe(false);
  });

  it("lista as obrigatórias que faltam, sem valores", () => {
    const problems = problemsOf({ ...base, DATABASE_URL: undefined, APP_URL: "" });

    expect(problems).toContain("DATABASE_URL: obrigatória");
    expect(problems.some((p) => p.startsWith("APP_URL:"))).toBe(true);
    expect(problems.join("\n")).not.toContain("bizu_owner");
  });

  it("exige variáveis condicionais do provedor escolhido", () => {
    expect(problemsOf({ ...base, SMTP_HOST: "" })).toContain(
      "SMTP_HOST: obrigatória com EMAIL_PROVIDER=smtp",
    );
    expect(problemsOf({ ...base, EMAIL_PROVIDER: "resend" })).toContain(
      "RESEND_API_KEY: obrigatória com EMAIL_PROVIDER=resend",
    );
    expect(problemsOf({ ...base, PAYMENT_PROVIDERS: "stripe" })).toEqual(
      expect.arrayContaining([
        "STRIPE_SECRET_KEY: obrigatória com stripe em PAYMENT_PROVIDERS",
        "STRIPE_WEBHOOK_SECRET: obrigatória com stripe em PAYMENT_PROVIDERS",
      ]),
    );
  });

  it("recusa segredos de exemplo e provedor memory em produção", () => {
    const problems = problemsOf({
      ...base,
      NODE_ENV: "production",
      EMAIL_PROVIDER: "memory",
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        "BETTER_AUTH_SECRET: use um valor gerado, não o exemplo do .env.example",
        "AUDIT_SALT: use um valor gerado, não o exemplo do .env.example",
        "EMAIL_PROVIDER: memory só serve para testes",
        "RATE_LIMIT_STORE: use postgres em produção",
      ]),
    );
  });

  describe("senha de banco em produção", () => {
    const strong = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const production = {
      ...base,
      NODE_ENV: "production",
      DATABASE_URL: `postgresql://bizu_app:${strong}@postgres:5432/bizu`,
      DIRECT_URL: `postgresql://bizu_owner:${strong}@postgres:5432/bizu`,
      RATE_LIMIT_STORE: "postgres",
      BETTER_AUTH_SECRET: "u1Z9x2Qw8eRtYuIoPaSdFgHjKlZxCvBnM0987654321=",
      CREDENTIALS_ENCRYPTION_KEY: "aB3dE6fG9hJ2kL5mN8pQ1rS4tU7vW0xYzA1bC2dE3fg=",
      AUDIT_SALT: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
    };
    const weak =
      "senha fraca (vazia, igual ao usuário ou com menos de 16 caracteres): gere com openssl rand -hex 24, aplique com ALTER ROLE e atualize a URL";

    it("aceita senha gerada", () => {
      expect(problemsOf(production)).toEqual([]);
    });

    it("recusa o valor de exemplo", () => {
      const problems = problemsOf({
        ...production,
        DATABASE_URL: "postgresql://bizu_app:change-me-generate-with-openssl@postgres:5432/bizu",
      });

      expect(problems).toEqual([
        "DATABASE_URL: use uma senha gerada, não o exemplo do .env.prod.example",
      ]);
    });

    it("recusa as senhas de desenvolvimento do init.sql", () => {
      const problems = problemsOf({
        ...production,
        DATABASE_URL: "postgresql://bizu_app:bizu_app@db.example.com:5432/bizu",
        DIRECT_URL: "postgresql://bizu_owner:bizu_owner@db.example.com:5432/bizu",
      });

      expect(problems).toEqual([`DATABASE_URL: ${weak}`, `DIRECT_URL: ${weak}`]);
    });

    it.each([
      ["vazia", "postgresql://bizu_app@db.example.com:5432/bizu"],
      ["vazia depois dos dois-pontos", "postgresql://bizu_app:@db.example.com:5432/bizu"],
      ["curta", "postgresql://bizu_app:Xy7pQ2mK9vT4wL1@db.example.com:5432/bizu"],
      [
        "longa, mas igual ao usuário em outra caixa",
        "postgresql://servico_da_aplicacao:SERVICO_DA_APLICACAO@db.example.com:5432/bizu",
      ],
      ["curta mesmo com escapes", "postgresql://bizu_app:%41%42%43%44%45%46@db.example.com:5432/bizu"],
    ])("recusa senha %s", (_, url) => {
      expect(problemsOf({ ...production, DATABASE_URL: url })).toEqual([`DATABASE_URL: ${weak}`]);
    });

    it("não imprime a senha na mensagem", () => {
      const problems = problemsOf({
        ...production,
        DATABASE_URL: "postgresql://bizu_app:curtinha@db.example.com:5432/bizu",
      });

      expect(problems.join("\n")).not.toContain("curtinha");
    });

    it("não derruba com escape inválido na URL", () => {
      const url = `postgresql://bizu_app:${strong}%ZZ@db.example.com:5432/bizu`;

      expect(problemsOf({ ...production, DATABASE_URL: url })).toEqual([]);
    });

    it.each(["localhost:15437", "127.0.0.1:5432", "[::1]:5432"])(
      "aceita senha de desenvolvimento em loopback: é o smoke de npm run start (%s)",
      (host) => {
        const problems = problemsOf({
          ...production,
          DATABASE_URL: `postgresql://bizu_app:bizu_app@${host}/bizu`,
          DIRECT_URL: `postgresql://bizu_owner:bizu_owner@${host}/bizu`,
        });

        expect(problems).toEqual([]);
      },
    );

    it("loopback não libera o valor de exemplo", () => {
      const url = "postgresql://bizu_app:change-me-generate@localhost:5432/bizu";

      expect(problemsOf({ ...production, DATABASE_URL: url })).toEqual([
        "DATABASE_URL: use uma senha gerada, não o exemplo do .env.prod.example",
      ]);
    });

    it("não vale fora de produção", () => {
      expect(problemsOf({ ...production, NODE_ENV: "test", DATABASE_URL: base.DATABASE_URL })).toEqual(
        [],
      );
      expect(problemsOf(base)).toEqual([]);
    });
  });

  it("exige a chave de credenciais com 32 bytes em base64", () => {
    const problems = problemsOf({
      ...base,
      CREDENTIALS_ENCRYPTION_KEY: "curta-demais-mas-com-mais-de-16",
    });

    expect(problems).toEqual([
      "CREDENTIALS_ENCRYPTION_KEY: use 32 bytes em base64 (openssl rand -base64 32)",
    ]);
  });

  it("aceita segredos gerados em produção", () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://bizu_app:9f8e7d6c5b4a39281706f5e4d3c2b1a0@postgres:5432/bizu",
      DIRECT_URL: "postgresql://bizu_owner:0a1b2c3d4e5f60718293a4b5c6d7e8f9@postgres:5432/bizu",
      BETTER_AUTH_SECRET: "u1Z9x2Qw8eRtYuIoPaSdFgHjKlZxCvBnM0987654321=",
      CREDENTIALS_ENCRYPTION_KEY: "aB3dE6fG9hJ2kL5mN8pQ1rS4tU7vW0xYzA1bC2dE3fg=",
      AUDIT_SALT: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
      RATE_LIMIT_STORE: "postgres",
    });

    expect(env.NODE_ENV).toBe("production");
  });
  describe("canais de mensagem", () => {
    it("sem CHANNEL_PROVIDERS, nenhum módulo e padrões da Evolution", () => {
      const env = parseEnv(base);

      expect(env.CHANNEL_PROVIDERS).toEqual([]);
      expect(env.EVOLUTION_INSTANCE_PREFIX).toBe("bizu");
      expect(env.EVOLUTION_MAX_INSTANCES_TOTAL).toBe(20);
      expect(env.EVOLUTION_MEDIA_ORIGINS).toEqual([]);
      expect(env.EVOLUTION_REQUEST_TIMEOUT_MS).toBe(15_000);
    });

    it("whatsapp_cloud não pede variável", () => {
      expect(problemsOf({ ...base, CHANNEL_PROVIDERS: "whatsapp_cloud" })).toEqual([]);
    });

    it("whatsapp_qr exige URL e chave do servidor Evolution", () => {
      expect(problemsOf({ ...base, CHANNEL_PROVIDERS: "whatsapp_qr" })).toEqual([
        "EVOLUTION_API_URL: obrigatória com whatsapp_qr em CHANNEL_PROVIDERS",
        "EVOLUTION_GLOBAL_API_KEY: obrigatória com whatsapp_qr em CHANNEL_PROVIDERS",
      ]);
    });

    it("recusa origem de mídia com caminho ou barra final", () => {
      for (const origin of ["https://s3.exemplo.com/", "https://s3.exemplo.com/bucket", "ftp://x"]) {
        expect(problemsOf({ ...base, EVOLUTION_MEDIA_ORIGINS: origin })).toEqual([
          "EVOLUTION_MEDIA_ORIGINS: use origens exatas, como https://s3.exemplo.com (sem caminho nem barra final)",
        ]);
      }
      expect(
        problemsOf({
          ...base,
          EVOLUTION_MEDIA_ORIGINS: "https://s3.exemplo.com, http://minio:9000",
        }),
      ).toEqual([]);
    });

    it("recusa a chave global de exemplo em produção", () => {
      const production = {
        ...base,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://bizu_app:9f8e7d6c5b4a39281706f5e4d3c2b1a0@postgres:5432/bizu",
        DIRECT_URL: "postgresql://bizu_owner:0a1b2c3d4e5f60718293a4b5c6d7e8f9@postgres:5432/bizu",
        BETTER_AUTH_SECRET: "u1Z9x2Qw8eRtYuIoPaSdFgHjKlZxCvBnM0987654321=",
        CREDENTIALS_ENCRYPTION_KEY: "aB3dE6fG9hJ2kL5mN8pQ1rS4tU7vW0xYzA1bC2dE3fg=",
        AUDIT_SALT: "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
        RATE_LIMIT_STORE: "postgres",
        CHANNEL_PROVIDERS: "whatsapp_qr",
        EVOLUTION_API_URL: "https://evolution.exemplo.com",
      };

      expect(
        problemsOf({ ...production, EVOLUTION_GLOBAL_API_KEY: "change-me-evolution-global-key" }),
      ).toEqual([
        "EVOLUTION_GLOBAL_API_KEY: use o valor gerado no servidor Evolution, não o exemplo do .env.example",
      ]);
      expect(
        problemsOf({ ...production, EVOLUTION_GLOBAL_API_KEY: "k3y-gerada-no-servidor-evolution" }),
      ).toEqual([]);
    });
  });
});
