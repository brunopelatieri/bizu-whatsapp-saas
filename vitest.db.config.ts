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
    // Fila de `phone.verify` desligada por padrão (ver o arquivo).
    setupFiles: ["tests/db/setup.ts"],
    // Fixos: os testes simulam um proxy e nunca enviam e-mail de verdade.
    env: {
      NODE_ENV: "test",
      APP_URL: "http://localhost:5173",
      EMAIL_PROVIDER: "memory",
      TRUSTED_PROXY_HOPS: "1",
      // Os testes de auth cobrem o fluxo com verificação; `auth-no-verification.test.ts`
      // troca para o padrão do template (desligada).
      EMAIL_VERIFICATION_REQUIRED: "true",
      // O contrário do padrão (D-2, `true`): os outros arquivos criam contas com o telefone
      // pendente para conferir outras regras (pedidos, envio, unicidade, vínculo). O portão é
      // conferido em `tests/db/phone-gate.test.ts`, que liga a variável e percorre todas as rotas.
      PHONE_VERIFICATION_REQUIRED: "false",
    },
    // Testes compartilham um banco: nada de paralelismo entre arquivos.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
