import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Scope } from "@/db/rls";
import { ChannelNotConfiguredError } from "@/lib/channels/errors";
import {
  type ChannelProvider,
  type ChannelStatus,
  type ChannelType,
  channelTypes,
} from "@/lib/channels/types";
import { type Env, getEnv } from "@/lib/env";
import type { UpdateChannelInput } from "@/lib/schemas/channels";

/**
 * Registro dos módulos de canal. Um módulo é uma pasta em `providers/<id>/` cujo `index.ts`
 * exporta `default: ChannelModule`. Entra em uso quando o id está em `CHANNEL_PROVIDERS`;
 * apagar a pasta e tirar o id remove o motor. Mesma descoberta de `payments/registry.ts`.
 */

/** Quem fez a ação, para a auditoria. */
export type ChannelActor = { userId: string | null; ip?: string };

/** Canal achado pela chave do caminho do webhook, com o que a verificação precisa. */
export type ChannelWebhookTarget = {
  channel: { id: string; tenantId: string | null; type: ChannelType; status: ChannelStatus };
  /** Segredos decifrados; vazio se não decifram (a verificação falha fechada). */
  credentials: Record<string, string>;
  /** Dados não secretos do canal. */
  config: Record<string, string>;
};

/**
 * Porta de entrada dos avisos do provedor. `src/api/webhooks-channels.ts` monta
 * `POST /api/webhooks/whatsapp/<segment>/:key` (e o `GET`, se houver `handshake`) e roda o
 * fluxo comum: achar o canal, `verifyWebhook`, gravar em `channel_event`, enfileirar.
 */
export type ChannelWebhook = {
  /** Trecho do caminho: `cloud`, `evolution`. */
  segment: string;
  maxBodyBytes: number;
  /** Só a linha de configuração do canal dono da chave; `null` se a chave não existe. */
  findTarget(key: string): Promise<ChannelWebhookTarget | null>;
  /**
   * `GET` de verificação do endereço (Meta). Devolve o texto da resposta ou `null` (403).
   * Recebe `null` com chave desconhecida, para as duas recusas custarem o mesmo.
   */
  handshake?(
    target: ChannelWebhookTarget | null,
    query: Record<string, string>,
  ): Promise<string | null>;
  /** Antes de gravar: tira do corpo o que não vai ao banco (mídia em base64). */
  prepareRaw?(target: ChannelWebhookTarget, raw: unknown): Promise<unknown>;
};

/**
 * O que `src/api/channels.ts` entrega ao módulo para ele montar as rotas próprias. O escopo e
 * a autorização são de quem monta (tenant hoje; `/api/admin/channels` na B4).
 */
export type ChannelRouteKit = {
  /** `/api/channels`. */
  base: string;
  canRead: MiddlewareHandler;
  canManage: MiddlewareHandler;
  /** 30 escritas por minuto, por usuário. */
  writeLimit: MiddlewareHandler;
  /** Limite próprio de uma ação, por usuário (`name` único). */
  limit(name: string, perMinute: number): MiddlewareHandler;
  validId: MiddlewareHandler;
  scopeOf(c: Context): Scope;
  actorOf(c: Context): ChannelActor;
};

export type ChannelModule = {
  id: ChannelType;
  /** Só monta o objeto: nada de rede nem erro por falta de provedor aqui. */
  createProvider(env: Env): ChannelProvider;
  webhook?: ChannelWebhook;
  /** Rotas do tipo (criar, testar, modelos, QR...). Cada uma confere se o módulo está ativo. */
  // biome-ignore lint/suspicious/noExplicitAny: o ambiente do Hono é de quem monta.
  routes?(kit: ChannelRouteKit): Hono<any>;
  /** `PATCH /:id` com campos além do nome. Ausente: o canal só renomeia. */
  update?(scope: Scope, id: string, input: UpdateChannelInput, actor: ChannelActor): Promise<void>;
};

type ModuleFile = { default: ChannelModule };

/**
 * No app (Vite) o `glob` vira import estático. `tsx` (seed, `jobs:install`) não é Vite: lá o
 * `glob` não existe e a pasta só é lida por `loadChannelModules()`. A leitura não pode ser um
 * `await` no topo deste arquivo: o módulo importa o serviço, que importa este registro, e o
 * import dinâmico esperaria por ele mesmo.
 */
function discoverStatic(): ModuleFile[] | undefined {
  try {
    return Object.values(import.meta.glob<ModuleFile>("./providers/*/index.ts", { eager: true }));
  } catch {
    return undefined;
  }
}

let discovered = discoverStatic();

/** Só para scripts `tsx` que precisam dos módulos; no app não faz nada. */
export async function loadChannelModules() {
  if (discovered) return;

  const root = path.join(import.meta.dirname, "providers");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  discovered = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(
        (entry) =>
          import(pathToFileURL(path.join(root, entry.name, "index.ts")).href) as Promise<ModuleFile>,
      ),
  );
}

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
    registry = buildRegistry(env.CHANNEL_PROVIDERS, getModules(), env);
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

/** Todas as pastas de módulo, ativas ou não: as rotas são montadas antes de o `.env` ser lido. */
export function getModules(): ChannelModule[] {
  return (discovered ?? []).map((file) => file.default);
}

/** O módulo do tipo, só se estiver ativo. */
export function findModule(type: string): ChannelModule | null {
  if (!findProvider(type)) return null;

  return getModules().find((module) => module.id === type) ?? null;
}

/** Troca os provedores em testes; `undefined` volta ao de `CHANNEL_PROVIDERS`. */
export function setProvidersForTests(next: ChannelProvider[] | undefined) {
  registry = next && new Map(next.map((provider) => [provider.type, provider]));
}
