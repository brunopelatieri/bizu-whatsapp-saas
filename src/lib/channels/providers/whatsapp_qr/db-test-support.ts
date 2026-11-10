import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { type Scope, withScope } from "@/db/rls";
import { channelEvolution } from "@/db/schema";
import { sealSecret } from "@/lib/channels/credentials";
import { createEvolutionProvider } from "@/lib/channels/providers/whatsapp_qr";
import type { EvolutionConfig } from "@/lib/channels/providers/whatsapp_qr/client";
import { jsonResponse } from "@/lib/channels/test-fixtures";
import type { StorageProvider } from "@/lib/storage";
import { seedQrChannel } from "../../../../../tests/db/channels-helpers";

/** Apoio dos testes com banco deste módulo. Nada do app importa isto. */

/** Os avisos de `tests/fixtures/channels/evolution/` trazem esta instância e este token. */
export const FIXTURE_INSTANCE_ID = "11111111-2222-3333-4444-555555555555";
export const FIXTURE_TOKEN = "test-instance-token-0001";
export const GLOBAL_KEY = "chave-global-de-teste";

/** Canal QR cuja instância e token batem com as fixtures de aviso. */
export async function seedFixtureChannel(
  scope: Scope,
  options: Parameters<typeof seedQrChannel>[1] = {},
) {
  const row = await seedQrChannel(scope, { instanceId: FIXTURE_INSTANCE_ID, ...options });

  await withScope(scope, (tx) =>
    tx
      .update(channelEvolution)
      .set({ instanceTokenEnc: sealSecret(row.id, "instanceToken", FIXTURE_TOKEN) })
      .where(eq(channelEvolution.channelId, row.id)),
  );
  return row;
}

export function memoryStorage() {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const storage: StorageProvider = {
    id: "local",
    async put(key, body, options) {
      objects.set(key, { body, contentType: options?.contentType });
    },
    async get() {
      return null as Readable | null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };

  return { objects, storage };
}

type Call = { method: string; path: string; key: string | null; body: unknown };
type Handler = (call: Call) => Response;

const ok = () => Response.json({ message: "success" });

/**
 * Servidor Evolution simulado (nenhuma chamada sai da máquina). As respostas são as fixtures de
 * `evolution/api/`; `overrides` troca uma rota (`"GET /instance/all"`).
 */
export function fakeEvolution(
  overrides: Record<string, Handler> = {},
  config: Partial<EvolutionConfig> = {},
) {
  const calls: Call[] = [];
  const routes: Record<string, Handler> = {
    "GET /instance/all": () => jsonResponse("evolution/api/all-ok"),
    "POST /instance/create": (call) =>
      Response.json({
        data: { id: randomUUID(), name: (call.body as { name: string }).name },
        message: "success",
      }),
    "POST /instance/connect": () => jsonResponse("evolution/api/connect-ok"),
    "GET /instance/qr": () => jsonResponse("evolution/api/qr-ok"),
    "POST /instance/pair": () => jsonResponse("evolution/api/pair-ok"),
    "GET /instance/status": () => jsonResponse("evolution/api/status-connecting"),
    "POST /instance/disconnect": ok,
    "DELETE /instance/logout": ok,
    "POST /instance/reconnect": ok,
    "DELETE /instance/delete": ok,
    "PUT /advanced-settings": (call) => Response.json(call.body),
    ...overrides,
  };

  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const call: Call = {
      method,
      path: url.pathname,
      key: headers.get("apikey"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    const base = url.pathname.startsWith("/instance/delete/")
      ? "/instance/delete"
      : url.pathname.endsWith("/advanced-settings")
        ? "/advanced-settings"
        : url.pathname;
    const handler = routes[`${method} ${base}`];

    return handler ? handler(call) : new Response("not found", { status: 404 });
  });

  const provider = createEvolutionProvider({
    apiUrl: "https://evolution.test",
    globalApiKey: GLOBAL_KEY,
    requestTimeoutMs: 5000,
    mediaTimeoutMs: 5000,
    webhookPublicUrl: "https://app.test",
    instancePrefix: "bizu",
    maxInstancesTotal: 500,
    mediaOrigins: [],
    fetchFn,
    ...config,
  });

  const called = (method: string, path: string) =>
    calls.filter((call) => call.method === method && call.path.startsWith(path));

  return { provider, calls, called, fetchFn };
}
