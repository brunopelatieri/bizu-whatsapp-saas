import path from "node:path";
import { defineConfig } from "vitest/config";

// Separado do vite.config.ts: os plugins do React Router não rodam no Vitest.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Teste com banco de um módulo opcional mora na pasta dele e roda em `npm run test:db`.
    exclude: ["**/node_modules/**", "src/**/*.db.test.ts"],
  },
});
