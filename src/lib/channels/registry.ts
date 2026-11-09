import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ChannelNotConfiguredError } from "@/lib/channels/errors";
import { type ChannelProvider, type ChannelType, channelTypes } from "@/lib/channels/types";
import { type Env, getEnv } from "@/lib/env";

/**
 * Registro dos módulos de canal. Um módulo é uma pasta em `providers/<id>/` cujo `index.ts`
 * exporta `default: ChannelModule`. Entra em uso quando o id está em `CHANNEL_PROVIDERS`;
 * apagar a pasta e tirar o id remove o motor. Mesma descoberta de `payments/registry.ts`.
 */

export type ChannelModule = {
  id: ChannelType;
  /** Só monta o objeto: nada de rede nem erro por falta de provedor aqui. */
  createProvider(env: Env): ChannelProvider;
};

type ModuleFile = { default: ChannelModule };

/** `tsx` (seed, worker em dev) não é Vite: lá o `glob` não existe e a pasta é lida à mão. */
async function discover(): Promise<ModuleFile[]> {
  try {
    return Object.values(import.meta.glob<ModuleFile>("./providers/*/index.ts", { eager: true }));
  } catch {
    const root = path.join(import.meta.dirname, "providers");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

    return Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(
          (entry) =>
            import(pathToFileURL(path.join(root, entry.name, "index.ts")).href) as Promise<ModuleFile>,
        ),
    );
  }
}

const discovered = await discover();

/** Monta os provedores ativos. Id desconhecido ou sem pasta é erro de configuração. */
export function buildRegistry(
  ids: readonly string[],
  modules: readonly ChannelModule[],
  env: Env,
) {
  const providers = new Map<ChannelType, ChannelProvider>();

  for (const id of ids) {
    const known = channelTypes.find((value) => value === id);
    const found = modules.find((module) => module.id === id);

    if (!known || !found) {
      throw new Error(`CHANNEL_PROVIDERS: módulo "${id}" não encontrado.`);
    }
    providers.set(known, found.createProvider(env));
  }

  return providers;
}

let registry: Map<ChannelType, ChannelProvider> | undefined;

function loadRegistry() {
  if (!registry) {
    const env = getEnv();
    registry = buildRegistry(
      env.CHANNEL_PROVIDERS,
      discovered.map((file) => file.default),
      env,
    );
  }

  return registry;
}

export function getProviders(): ChannelProvider[] {
  return [...loadRegistry().values()];
}

/** O módulo do tipo, ou `null` se não está ativo. */
export function findProvider(type: string): ChannelProvider | null {
  return loadRegistry().get(type as ChannelType) ?? null;
}

/** O módulo do tipo. Inativo é erro de configuração: o canal existe, o motor não. */
export function getProvider(type: string): ChannelProvider {
  const provider = findProvider(type);

  if (!provider) throw new ChannelNotConfiguredError(type);
  return provider;
}

export function isProviderEnabled(type: ChannelType) {
  return findProvider(type) !== null;
}

/** Troca os provedores em testes; `undefined` volta ao de `CHANNEL_PROVIDERS`. */
export function setProvidersForTests(next: ChannelProvider[] | undefined) {
  registry = next && new Map(next.map((provider) => [provider.type, provider]));
}
