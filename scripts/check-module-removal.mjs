#!/usr/bin/env node
// Prova que um módulo opcional sai apagando a pasta: tira a pasta do lugar, roda typecheck
// e testes sem ela e devolve a pasta, mesmo se algo falhar.
//
//   npm run check:module-removal -- stripe   (pagamento: providers/<id>/)
//   npm run check:module-removal -- sentry   (monitoramento: src/lib/monitoring/sentry/)
//   npm run check:module-removal -- s3       (arquivos: src/lib/storage/providers/s3/)
//   npm run check:module-removal -- whatsapp_cloud | whatsapp_qr   (canais: src/lib/channels/providers/<id>/)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const id = process.argv[2] ?? "stripe";

if (!/^[a-z][a-z0-9_]*$/.test(id)) {
  console.error(`Id de módulo inválido: ${id}`);
  process.exit(1);
}

// Módulos que não são provedor de pagamento: pasta e variável que os liga.
const OTHER_MODULES = {
  sentry: {
    dir: path.join("src", "lib", "monitoring", "sentry"),
    env: { SENTRY_DSN: "" },
  },
  s3: {
    dir: path.join("src", "lib", "storage", "providers", "s3"),
    env: { STORAGE_PROVIDER: "local" },
  },
};

// Canais de mensagem: a pasta sai e CHANNEL_PROVIDERS volta a ficar vazio.
for (const channel of ["whatsapp_cloud", "whatsapp_qr"]) {
  OTHER_MODULES[channel] = {
    dir: path.join("src", "lib", "channels", "providers", channel),
    env: { CHANNEL_PROVIDERS: "" },
  };
}

const other = OTHER_MODULES[id];
const moduleDir =
  other?.dir ?? path.join("src", "lib", "payments", "providers", id);
const moduleEnv = other?.env ?? { PAYMENT_PROVIDERS: "" };
const parkingDir = ".tmp-module-removal";
const parked = path.join(parkingDir, id);

if (!existsSync(moduleDir)) {
  console.error(`Módulo não encontrado: ${moduleDir}`);
  process.exit(1);
}

function restore() {
  if (existsSync(parked)) renameSync(parked, moduleDir);
  rmSync(parkingDir, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}

function run(script) {
  console.log(`\n> npm run ${script}, sem ${moduleDir}`);

  const { status } = spawnSync(`npm run ${script}`, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...moduleEnv },
  });

  return status === 0;
}

mkdirSync(parkingDir, { recursive: true });
renameSync(moduleDir, parked);

let ok = false;
try {
  ok = run("typecheck") && run("test");
} finally {
  restore();
}

console.log(
  ok
    ? `\nOK: o sistema compila e passa nos testes sem o módulo ${id}.`
    : `\nFALHOU: algo fora de ${moduleDir} ainda depende do módulo.`,
);
process.exit(ok ? 0 : 1);
