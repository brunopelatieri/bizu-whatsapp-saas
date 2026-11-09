import { randomBytes } from "node:crypto";
import { pickBoolean, pickString } from "@/lib/channels/payload";
import {
  type EvolutionConfig,
  EvolutionApiError,
  evolutionRequest,
  isAlreadyLoggedInError,
  unwrap,
} from "@/lib/channels/providers/whatsapp_qr/client";

/**
 * Chamadas de gerenciamento de instância. Só HTTP: gravar no banco, limites e auditoria são
 * do serviço (`src/lib/channels/service.ts`). O token da instância chega decifrado e não sai
 * daqui em resposta nenhuma (o `/instance/info` da Evolution o devolve; nunca repassamos).
 */

/** Famílias que se inscrevem. O que chega em `event` são nomes específicos (`Receipt`...). */
export const SUBSCRIBED_EVENTS = [
  "MESSAGE",
  "SEND_MESSAGE",
  "READ_RECEIPT",
  "CONNECTION",
  "QRCODE",
] as const;

const MAX_SLUG_LENGTH = 24;

/** `[a-z0-9-]+`, sem acento. Cai em `"instancia"` se não sobrar nada (ex.: só emoji). */
export function slugifyLabel(label: string) {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  return slug || "instancia";
}

/**
 * `<prefixo>_<8 hex do escopo>_<slug até 24>_<4 hex>`. O nome é **global** no servidor
 * Evolution (compartilhado por todos os escopos): o namespace evita colisão e deixa auditar
 * o que é nosso. `scopeKey` é o `tenantId`, ou qualquer texto estável para a plataforma.
 */
export function buildInstanceName(prefix: string, scopeKey: string, label: string) {
  const scopeHex = scopeKey.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8).padEnd(8, "0");

  return `${prefix}_${scopeHex}_${slugifyLabel(label)}_${randomBytes(2).toString("hex")}`;
}

export type RemoteInstance = { id: string | null; name: string };

/** `POST /instance/create` com a chave global. O token da instância é nosso (`randomUUID`). */
export async function createRemoteInstance(
  config: EvolutionConfig,
  input: { name: string; token: string },
): Promise<RemoteInstance> {
  const created = unwrap(
    await evolutionRequest(config, "/instance/create", {
      method: "POST",
      key: config.globalApiKey,
      body: { name: input.name, token: input.token },
    }),
  );

  return { id: pickString(created, "id"), name: input.name };
}

/** `DELETE /instance/delete/<id>`. "Não existe mais" (404) é sucesso. */
export async function deleteRemoteInstance(config: EvolutionConfig, remoteInstanceId: string) {
  try {
    await evolutionRequest(config, `/instance/delete/${encodeURIComponent(remoteInstanceId)}`, {
      method: "DELETE",
      key: config.globalApiKey,
    });
  } catch (error) {
    if (!(error instanceof EvolutionApiError && error.kind === "not_found")) throw error;
  }
}

/** Quantas instâncias o servidor tem, de todos os escopos (para o teto global). */
export async function countRemoteInstances(config: EvolutionConfig) {
  const body = await evolutionRequest(config, "/instance/all", {
    key: config.globalApiKey,
  });
  const list = Array.isArray(body)
    ? body
    : Array.isArray(unwrap(body).instances)
      ? (unwrap(body).instances as unknown[])
      : Array.isArray((body as { data?: unknown } | null)?.data)
        ? ((body as { data: unknown[] }).data as unknown[])
        : [];

  return list.length;
}

/** Endereço do webhook de uma instância. O segredo vai no caminho. */
export function webhookUrlFor(config: EvolutionConfig, webhookSecret: string) {
  return `${config.webhookPublicUrl}/api/webhooks/whatsapp/evolution/${webhookSecret}`;
}

/**
 * `POST /instance/connect`: registra o webhook e as famílias de evento. Reexecutável: gerar
 * o QR chama de novo, para o webhook estar registrado mesmo se o primeiro `connect` falhou.
 * `eventStringMismatch` avisa quando o servidor aceitou menos eventos do que pedimos.
 */
export async function connectInstance(
  config: EvolutionConfig,
  input: { instanceToken: string; webhookSecret: string },
) {
  const result = unwrap(
    await evolutionRequest(config, "/instance/connect", {
      method: "POST",
      key: input.instanceToken,
      body: {
        immediate: true,
        subscribe: [...SUBSCRIBED_EVENTS],
        webhookUrl: webhookUrlFor(config, input.webhookSecret),
      },
    }),
  );
  const accepted = new Set(
    (pickString(result, "eventString") ?? "")
      .split(",")
      .map((event) => event.trim())
      .filter(Boolean),
  );

  return { eventStringMismatch: SUBSCRIBED_EVENTS.some((event) => !accepted.has(event)) };
}

export type QrResult =
  | { alreadyConnected: true }
  | { alreadyConnected: false; qrcode: string | null; code: string | null };

/**
 * `GET /instance/qr` custa cerca de 3 s e o QR vale 60 s: não buscar em laço curto.
 * `qrcode` é data URI (imagem); `code` é o texto, que `qrcode.react` desenha sem `img-src data:`.
 */
export async function fetchQr(
  config: EvolutionConfig,
  instanceToken: string,
): Promise<QrResult> {
  try {
    const data = unwrap(await evolutionRequest(config, "/instance/qr", { key: instanceToken }));

    return {
      alreadyConnected: false,
      qrcode: pickString(data, "qrcode"),
      code: pickString(data, "code"),
    };
  } catch (error) {
    if (isAlreadyLoggedInError(error)) return { alreadyConnected: true };
    throw error;
  }
}

/** `POST /instance/pair`: código de 8 caracteres para digitar no celular. */
export async function fetchPairingCode(
  config: EvolutionConfig,
  input: { instanceToken: string; phone: string },
) {
  const data = unwrap(
    await evolutionRequest(config, "/instance/pair", {
      method: "POST",
      key: input.instanceToken,
      body: { phone: input.phone, subscribe: [...SUBSCRIBED_EVENTS] },
    }),
  );
  const pairingCode = pickString(data, "pairingCode");

  if (!pairingCode) {
    throw new EvolutionApiError("bad_request", 400, "O servidor não devolveu o código de pareamento.");
  }
  return { pairingCode };
}

export type InstanceStatus = {
  status: "connected" | "connecting" | "disconnected";
  /** Telefone conectado, quando a instância já pareou (a Evolution devolve o JID). */
  phone: string | null;
  jid: string | null;
};

/** `Connected` (sessão aberta) e `LoggedIn` (pareada) juntos = conectado. */
export async function fetchStatus(
  config: EvolutionConfig,
  instanceToken: string,
): Promise<InstanceStatus> {
  const data = unwrap(await evolutionRequest(config, "/instance/status", { key: instanceToken }));
  const connected = pickBoolean(data, "Connected") === true;
  const loggedIn = pickBoolean(data, "LoggedIn") === true;
  // Não medido: o JID pode não vir aqui. O telefone conectado chega no aviso de conexão.
  const jid = pickString(data, "JID");
  const phone = jid?.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/)?.[1] ?? null;

  return {
    status: connected && loggedIn ? "connected" : connected ? "connecting" : "disconnected",
    phone,
    jid,
  };
}

export async function disconnectInstance(config: EvolutionConfig, instanceToken: string) {
  await evolutionRequest(config, "/instance/disconnect", {
    method: "POST",
    key: instanceToken,
  });
}

export async function logoutInstance(config: EvolutionConfig, instanceToken: string) {
  await evolutionRequest(config, "/instance/logout", { method: "DELETE", key: instanceToken });
}

export async function reconnectInstance(config: EvolutionConfig, instanceToken: string) {
  await evolutionRequest(config, "/instance/reconnect", { method: "POST", key: instanceToken });
}

export async function updateAdvancedSettings(
  config: EvolutionConfig,
  input: { remoteInstanceId: string; instanceToken: string; settings: Record<string, unknown> },
) {
  return unwrap(
    await evolutionRequest(
      config,
      `/instance/${encodeURIComponent(input.remoteInstanceId)}/advanced-settings`,
      { method: "PUT", key: input.instanceToken, body: input.settings },
    ),
  );
}
