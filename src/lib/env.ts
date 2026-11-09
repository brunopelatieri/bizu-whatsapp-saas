import { z } from "zod";

/**
 * Variáveis de ambiente do servidor, validadas uma vez na inicialização.
 *
 * - Nova variável entra aqui e em `.env.example`, com comentário de uso.
 * - Falta ou valor inválido derruba o processo listando os nomes, nunca os valores.
 * - Em produção, segredos com o valor de exemplo (`change-me...`) e senhas de banco fracas
 *   são recusados.
 * - Só o servidor lê este módulo. O navegador recebe apenas `VITE_*`.
 */

const PLACEHOLDER_PREFIX = "change-me";
/** A chave de exemplo é base64 válido de um texto que começa com `change-me`. */
const PLACEHOLDER_KEY_PREFIX = Buffer.from(PLACEHOLDER_PREFIX).toString("base64");
/**
 * Mesmo piso de `secret`. Cobre as senhas de desenvolvimento do `init.sql` (o nome do papel),
 * que ele aplica em silêncio quando rodado à mão sem as variáveis do psql.
 */
const MIN_DATABASE_PASSWORD_LENGTH = 16;
/** Banco na própria máquina: é o smoke de `npm run start`, em produção com o `.env.local`. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const booleanString = (defaultValue: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(["true", "false", "1", "0"])
      .default(defaultValue ? "true" : "false")
      .transform((value) => value === "true" || value === "1"),
  );

const integerString = (defaultValue: number) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().default(defaultValue),
  );

const csvList = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
);

const secret = z.string().min(16, "mínimo de 16 caracteres");

/** `openssl rand -base64 32`: AES-256 precisa de exatamente 32 bytes. */
const encryptionKey = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "use 32 bytes em base64 (openssl rand -base64 32)");

const decodeUrlPart = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Motivo para recusar a senha da URL em produção. URL malformada fica com o `z.url`. */
function databasePasswordProblem(url: string) {
  if (!URL.canParse(url)) return undefined;

  const { hostname, username, password: encoded } = new URL(url);
  const password = decodeUrlPart(encoded);

  if (password.startsWith(PLACEHOLDER_PREFIX)) {
    return "use uma senha gerada, não o exemplo do .env.prod.example";
  }
  if (LOOPBACK_HOSTS.has(hostname)) return undefined;
  if (
    password.length < MIN_DATABASE_PASSWORD_LENGTH ||
    password.toLowerCase() === decodeUrlPart(username).toLowerCase()
  ) {
    return `senha fraca (vazia, igual ao usuário ou com menos de ${MIN_DATABASE_PASSWORD_LENGTH} caracteres): gere com openssl rand -hex 24, aplique com ALTER ROLE e atualize a URL`;
  }
  return undefined;
}

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: integerString(3000),
    APP_URL: z.url({ protocol: /^https?$/ }),
    TRUSTED_PROXY_HOPS: integerString(0),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DIRECT_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    BETTER_AUTH_SECRET: secret,
    CREDENTIALS_ENCRYPTION_KEY: encryptionKey,
    // Na rotação: a chave da versão anterior e o número da atual (`tech/26-seguranca.md`).
    CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: z.preprocess(
      emptyToUndefined,
      encryptionKey.optional(),
    ),
    CREDENTIALS_KEY_VERSION: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(1),
    ),
    AUDIT_SALT: secret,

    // Desligada (padrão), o cadastro entra direto; ligada, exige o link de /verificar-email.
    EMAIL_VERIFICATION_REQUIRED: booleanString(false),

    EMAIL_PROVIDER: z.enum(["smtp", "resend", "memory"]).default("smtp"),
    EMAIL_FROM: z.string().min(3).default("Bizu SaaS <no-reply@localhost>"),
    EMAIL_REPLY_TO: optionalString,
    SMTP_HOST: optionalString,
    SMTP_PORT: integerString(1025),
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    SMTP_SECURE: booleanString(false),
    RESEND_API_KEY: optionalString,
    RESEND_WEBHOOK_SECRET: optionalString,

    JOBS_MODE: z.enum(["inline", "worker", "off"]).default("inline"),
    RATE_LIMIT_STORE: z.enum(["memory", "postgres"]).default("memory"),

    PAYMENT_PROVIDERS: csvList,
    STRIPE_SECRET_KEY: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,

    // Canais de mensagem (`docs/context/tech/29-canais-whatsapp.md`): módulos ativos, como
    // PAYMENT_PROVIDERS. A Cloud API não tem variável: as credenciais são de cada canal.
    CHANNEL_PROVIDERS: csvList,
    EVOLUTION_API_URL: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
    EVOLUTION_GLOBAL_API_KEY: optionalString,
    // Endereço do bizu que o servidor Evolution alcança (padrão: APP_URL).
    EVOLUTION_WEBHOOK_PUBLIC_URL: z.preprocess(
      emptyToUndefined,
      z.url({ protocol: /^https?$/ }).optional(),
    ),
    EVOLUTION_INSTANCE_PREFIX: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[a-z0-9]{1,16}$/, "1 a 16 letras minúsculas ou números")
        .default("bizu"),
    ),
    EVOLUTION_MAX_INSTANCES_TOTAL: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).default(20),
    ),
    // Origens (`esquema://host[:porta]`) de onde o job aceita baixar `mediaUrl` pré-assinada.
    EVOLUTION_MEDIA_ORIGINS: csvList,
    EVOLUTION_REQUEST_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1000).default(15_000),
    ),
    EVOLUTION_MEDIA_TIMEOUT_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1000).default(60_000),
    ),

    STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default(".data/storage"),
    S3_BUCKET: optionalString,
    S3_REGION: optionalString,
    S3_ENDPOINT: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    // Teto de um upload em `/api/files`: também o `bodyLimit` da rota.
    MAX_UPLOAD_MB: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(100).default(10),
    ),

    CSP_REPORT_ONLY: booleanString(true),
    SEED_PASSWORD: optionalString,
    SEED_ALLOW_PRODUCTION: optionalString,
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    SENTRY_DSN: optionalString,
  })
  .superRefine((env, ctx) => {
    const requireWhen = (
      condition: boolean,
      keys: Array<keyof typeof env>,
      reason: string,
    ) => {
      if (!condition) return;
      for (const key of keys) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: "custom", path: [key], message: reason });
        }
      }
    };

    requireWhen(
      env.EMAIL_PROVIDER === "smtp",
      ["SMTP_HOST"],
      "obrigatória com EMAIL_PROVIDER=smtp",
    );
    requireWhen(
      env.EMAIL_PROVIDER === "resend",
      ["RESEND_API_KEY"],
      "obrigatória com EMAIL_PROVIDER=resend",
    );
    requireWhen(
      env.PAYMENT_PROVIDERS.includes("stripe"),
      ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      "obrigatória com stripe em PAYMENT_PROVIDERS",
    );
    requireWhen(
      env.CHANNEL_PROVIDERS.includes("whatsapp_qr"),
      ["EVOLUTION_API_URL", "EVOLUTION_GLOBAL_API_KEY"],
      "obrigatória com whatsapp_qr em CHANNEL_PROVIDERS",
    );
    for (const origin of env.EVOLUTION_MEDIA_ORIGINS) {
      const valid =
        URL.canParse(origin) &&
        /^https?:$/.test(new URL(origin).protocol) &&
        new URL(origin).origin === origin;

      if (!valid) {
        ctx.addIssue({
          code: "custom",
          path: ["EVOLUTION_MEDIA_ORIGINS"],
          message: "use origens exatas, como https://s3.exemplo.com (sem caminho nem barra final)",
        });
        break;
      }
    }
    requireWhen(
      env.STORAGE_PROVIDER === "s3",
      ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
      "obrigatória com STORAGE_PROVIDER=s3",
    );

    if (env.NODE_ENV === "production") {
      for (const key of [
        "BETTER_AUTH_SECRET",
        "CREDENTIALS_ENCRYPTION_KEY",
        "AUDIT_SALT",
      ] as const) {
        if (
          env[key].startsWith(PLACEHOLDER_PREFIX) ||
          env[key].startsWith(PLACEHOLDER_KEY_PREFIX)
        ) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "use um valor gerado, não o exemplo do .env.example",
          });
        }
      }
      if (env.EVOLUTION_GLOBAL_API_KEY?.startsWith(PLACEHOLDER_PREFIX)) {
        ctx.addIssue({
          code: "custom",
          path: ["EVOLUTION_GLOBAL_API_KEY"],
          message: "use o valor gerado no servidor Evolution, não o exemplo do .env.example",
        });
      }
      for (const key of ["DATABASE_URL", "DIRECT_URL"] as const) {
        const message = databasePasswordProblem(env[key]);
        if (message) ctx.addIssue({ code: "custom", path: [key], message });
      }
      // Com memória, cada réplica contaria sozinha e o limite cairia em silêncio no
      // primeiro `scale`. Recusar na subida é mais barato que descobrir no incidente.
      if (env.RATE_LIMIT_STORE === "memory") {
        ctx.addIssue({
          code: "custom",
          path: ["RATE_LIMIT_STORE"],
          message: "use postgres em produção",
        });
      }
      if (env.EMAIL_PROVIDER === "memory") {
        ctx.addIssue({
          code: "custom",
          path: ["EMAIL_PROVIDER"],
          message: "memory só serve para testes",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Variáveis de ambiente inválidas:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        "Confira .env.local (dev) ou as variáveis do container, usando .env.example como referência.",
    );
    this.name = "EnvError";
  }
}

/** Valida um objeto de variáveis. Lança `EnvError` só com nomes e motivos. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);

  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join(".") || "(raiz)";
    const reason =
      issue.code === "invalid_type" && issue.message.includes("undefined")
        ? "obrigatória"
        : issue.message;
    return `${name}: ${reason}`;
  });

  throw new EnvError(problems);
}

let cached: Env | undefined;

/** Variáveis validadas do processo. A primeira chamada valida; as demais reaproveitam. */
export function getEnv(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** Descarta o cache. Só para testes. */
export function resetEnvForTests() {
  cached = undefined;
}
