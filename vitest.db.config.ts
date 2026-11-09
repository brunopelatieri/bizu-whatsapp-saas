import path from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

// `npm run test:db`: testes que exigem o Postgres do Docker com as migrations
// aplicadas. Lê DATABASE_URL e DIRECT_URL de .env.local (ou do ambiente, no CI).
config({ path: ".env.local" });
config();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts", "src/lib/channels/providers/**/*.db.test.ts"],
    // Fixos: os testes simulam um proxy e nunca enviam e-mail de verdade.
    env: {
      NODE_ENV: "test",
      APP_URL: "http://localhost:5173",
      EMAIL_PROVIDER: "memory",
      TRUSTED_PROXY_HOPS: "1",
      // Os testes de auth cobrem o fluxo com verificação; `auth-no-verification.test.ts`
      // troca para o padrão do template (desligada).
      EMAIL_VERIFICATION_REQUIRED: "true",
    },
    // Testes compartilham um banco: nada de paralelismo entre arquivos.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
