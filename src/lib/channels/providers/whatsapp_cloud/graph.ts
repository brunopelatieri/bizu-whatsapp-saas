import { ProviderError } from "@/lib/channels/errors";

/**
 * Cliente da Graph API (WhatsApp Cloud). Só `fetch`, injetável para o teste não sair da
 * máquina. O host é fixo: nenhuma URL vem do tenant (SSRF).
 *
 * Nenhuma função loga nem devolve o token. O texto de erro da Meta pode citar dado do
 * cliente: ele sobe em `ProviderError.message` só para a tela do dono do canal.
 */

/**
 * Versão em um lugar só. Conferida em 2026-11-09 (B0): a origem usava `v21.0`, que já foi
 * desativada; a vigente é `v26.0` (lançada em 2026-07-29). Trocar a versão é um PR com a
 * sincronização de modelos revalidada contra uma conta de teste.
 */
export const GRAPH_VERSION = "v26.0";
export const GRAPH_BASE = "https://graph.facebook.com";
export const GRAPH_TIMEOUT_MS = 15_000;

export type FetchFn = typeof fetch;

export type GraphOptions = { fetchFn?: FetchFn; timeoutMs?: number };

/** Erro da Graph API com o status HTTP e o `error.code` preservados. */
export class MetaApiError extends ProviderError {
  constructor(message: string, status: number, code: number | null) {
    super(message, status, code);
    this.name = "MetaApiError";
  }
}

type MetaErrorBody = {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
  };
};

/** `(#código) título: mensagem`. Mesmo formato do aviso assíncrono de status `failed`. */
export function formatMetaError(
  error: { code?: number; message?: string; title?: string; userMessage?: string } | undefined,
  fallback: string,
) {
  if (!error) return fallback;

  const text = error.userMessage ?? error.message ?? "";
  const body = error.title && text ? `${error.title}: ${text}` : error.title || text;
  const prefix = error.code != null ? `(#${error.code})` : "";

  // A Meta às vezes já embute "(#N)" no texto: não duplica.
  const clean = prefix && body.includes(prefix) ? body : `${prefix} ${body}`.trim();
  return clean || fallback;
}

async function toMetaError(response: Response, fallback: string): Promise<MetaApiError> {
  let message = fallback;
  let code: number | null = null;

  try {
    const data = (await response.json()) as MetaErrorBody;
    const error = data.error;

    if (error) {
      code = error.code ?? null;
      message = formatMetaError(
        {
          code: error.code,
          message: error.message,
          title: error.error_user_title,
          userMessage: error.error_user_msg,
        },
        fallback,
      );
    }
  } catch {
    // Corpo que não é JSON: fica o texto genérico.
  }

  return new MetaApiError(message, response.status, code);
}

/** Id de recurso da Meta é numérico. Recusa qualquer coisa que mude o caminho da URL. */
export function assertGraphId(value: string, label: string) {
  if (!/^\d{1,32}$/.test(value)) {
    throw new MetaApiError(`${label} inválido.`, 400, null);
  }
  return value;
}

type RequestInput = {
  path: string;
  accessToken: string;
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: BodyInit | Record<string, unknown>;
};

async function request(input: RequestInput, options: GraphOptions): Promise<Response> {
  const url = new URL(`${GRAPH_BASE}/${GRAPH_VERSION}/${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const isForm = input.body instanceof FormData;
  const headers: Record<string, string> = { Authorization: `Bearer ${input.accessToken}` };
  let body: BodyInit | undefined;

  if (input.body !== undefined) {
    if (isForm) {
      body = input.body as FormData;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(input.body);
    }
  }

  try {
    return await (options.fetchFn ?? fetch)(url, {
      method: input.method ?? "GET",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? GRAPH_TIMEOUT_MS),
    });
  } catch {
    // Rede ou timeout. Sem a mensagem original: ela pode trazer a URL com a query.
    throw new MetaApiError("A Meta não respondeu a tempo.", 0, null);
  }
}

async function json<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw await toMetaError(response, fallback);
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Número e conta
// ---------------------------------------------------------------------------

export type MetaPhoneInfo = {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
};

type Credentials = { accessToken: string };

export async function verifyPhoneNumber(
  args: Credentials & { phoneNumberId: string },
  options: GraphOptions = {},
): Promise<MetaPhoneInfo> {
  const response = await request(
    {
      path: assertGraphId(args.phoneNumberId, "phone_number_id"),
      accessToken: args.accessToken,
      query: { fields: "id,display_phone_number,verified_name,quality_rating" },
    },
    options,
  );

  return json<MetaPhoneInfo>(response, `Meta API error: ${response.status}`);
}

/**
 * Registra o número para este aplicativo. Exige o PIN de duas etapas do número.
 * "Já registrado" é sucesso (código 133005 ou o texto da Meta).
 */
export async function registerPhoneNumber(
  args: Credentials & { phoneNumberId: string; pin: string },
  options: GraphOptions = {},
): Promise<{ alreadyRegistered: boolean }> {
  const response = await request(
    {
      path: `${assertGraphId(args.phoneNumberId, "phone_number_id")}/register`,
      accessToken: args.accessToken,
      method: "POST",
      body: { messaging_product: "whatsapp", pin: args.pin },
    },
    options,
  );

  if (response.ok) return { alreadyRegistered: false };

  const error = await toMetaError(response, `Meta API error: ${response.status}`);
  if (error.code === 133005 || /already.*registered/i.test(error.message)) {
    return { alreadyRegistered: true };
  }
  throw error;
}

/** Idempotente: a Meta responde sucesso se a assinatura já existe. */
export async function subscribeWabaToApp(
  args: Credentials & { wabaId: string },
  options: GraphOptions = {},
): Promise<void> {
  const response = await request(
    {
      path: `${assertGraphId(args.wabaId, "waba_id")}/subscribed_apps`,
      accessToken: args.accessToken,
      method: "POST",
    },
    options,
  );

  await json(response, `Meta API error: ${response.status}`);
}

export type SubscribedApp = {
  whatsapp_business_api_data?: { id?: string; name?: string; link?: string };
};

export async function getSubscribedApps(
  args: Credentials & { wabaId: string },
  options: GraphOptions = {},
): Promise<SubscribedApp[]> {
  const response = await request(
    {
      path: `${assertGraphId(args.wabaId, "waba_id")}/subscribed_apps`,
      accessToken: args.accessToken,
    },
    options,
  );
  const data = await json<{ data?: SubscribedApp[] }>(response, `Meta API error: ${response.status}`);

  return data.data ?? [];
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

type SendResponse = { messages?: Array<{ id?: string }> };

async function sendMessage(
  args: Credentials & { phoneNumberId: string; payload: Record<string, unknown> },
  options: GraphOptions,
): Promise<{ messageId: string }> {
  const response = await request(
    {
      path: `${assertGraphId(args.phoneNumberId, "phone_number_id")}/messages`,
      accessToken: args.accessToken,
      method: "POST",
      body: { messaging_product: "whatsapp", recipient_type: "individual", ...args.payload },
    },
    options,
  );
  const data = await json<SendResponse>(response, `Meta API error: ${response.status}`);
  const messageId = data.messages?.[0]?.id;

  // A mensagem já saiu: sem id é erro nosso de leitura, não da Meta.
  if (!messageId) throw new MetaApiError("A Meta não devolveu o id da mensagem.", response.status, null);
  return { messageId };
}

export function sendText(
  args: Credentials & {
    phoneNumberId: string;
    to: string;
    text: string;
    contextMessageId?: string;
  },
  options: GraphOptions = {},
) {
  return sendMessage(
    {
      ...args,
      payload: {
        to: args.to,
        type: "text",
        text: { body: args.text },
        ...(args.contextMessageId ? { context: { message_id: args.contextMessageId } } : {}),
      },
    },
    options,
  );
}

export type MediaKind = "image" | "video" | "audio" | "document";

export function sendMedia(
  args: Credentials & {
    phoneNumberId: string;
    to: string;
    kind: MediaKind;
    /** Um dos dois: endereço público de curta duração ou id devolvido por `uploadMedia`. */
    link?: string;
    mediaId?: string;
    caption?: string;
    filename?: string;
    contextMessageId?: string;
  },
  options: GraphOptions = {},
) {
  if (!args.link && !args.mediaId) {
    throw new MetaApiError("Informe o endereço ou o id da mídia.", 400, null);
  }

  // Áudio não aceita legenda nem nome de arquivo; só documento aceita nome.
  const media: Record<string, unknown> = args.mediaId ? { id: args.mediaId } : { link: args.link };
  if (args.caption && args.kind !== "audio") media.caption = args.caption;
  if (args.kind === "document" && args.filename) media.filename = args.filename;

  return sendMessage(
    {
      ...args,
      payload: {
        to: args.to,
        type: args.kind,
        [args.kind]: media,
        ...(args.contextMessageId ? { context: { message_id: args.contextMessageId } } : {}),
      },
    },
    options,
  );
}

export function sendTemplate(
  args: Credentials & {
    phoneNumberId: string;
    to: string;
    name: string;
    language: string;
    components?: unknown[];
  },
  options: GraphOptions = {},
) {
  return sendMessage(
    {
      ...args,
      payload: {
        to: args.to,
        type: "template",
        template: {
          name: args.name,
          language: { code: args.language },
          ...(args.components?.length ? { components: args.components } : {}),
        },
      },
    },
    options,
  );
}

/** `POST /{phone_number_id}/media`: sobe um anexo de saída e devolve o id. */
export async function uploadMedia(
  args: Credentials & { phoneNumberId: string; body: Buffer; mime: string; filename: string },
  options: GraphOptions = {},
): Promise<{ mediaId: string }> {
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", args.mime);
  form.set("file", new Blob([new Uint8Array(args.body)], { type: args.mime }), args.filename);

  const response = await request(
    {
      path: `${assertGraphId(args.phoneNumberId, "phone_number_id")}/media`,
      accessToken: args.accessToken,
      method: "POST",
      body: form,
    },
    // Upload é maior que as chamadas comuns.
    { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
  );
  const data = await json<{ id?: string }>(response, `Meta API error: ${response.status}`);

  if (!data.id) throw new MetaApiError("A Meta não devolveu o id da mídia.", response.status, null);
  return { mediaId: data.id };
}

// ---------------------------------------------------------------------------
// Mídia recebida
// ---------------------------------------------------------------------------

/** O download leva o token: só vai a hosts da própria Meta, por HTTPS. */
const MEDIA_HOST_SUFFIXES = ["fbsbx.com", "fbcdn.net", "facebook.com", "whatsapp.net", "whatsapp.com"];

export function isTrustedMediaUrl(value: string) {
  if (!URL.canParse(value)) return false;

  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) return false;
  return MEDIA_HOST_SUFFIXES.some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`),
  );
}

export async function getMediaUrl(
  args: Credentials & { mediaId: string },
  options: GraphOptions = {},
): Promise<{ url: string; mime: string }> {
  const response = await request(
    { path: assertGraphId(args.mediaId, "media_id"), accessToken: args.accessToken },
    options,
  );
  const data = await json<{ url?: string; mime_type?: string }>(
    response,
    `Media fetch failed: ${response.status}`,
  );

  if (!data.url || !isTrustedMediaUrl(data.url)) {
    throw new MetaApiError("A Meta devolveu um endereço de mídia inesperado.", response.status, null);
  }
  return { url: data.url, mime: data.mime_type ?? "application/octet-stream" };
}

export async function downloadMedia(
  args: Credentials & { url: string; maxBytes: number },
  options: GraphOptions = {},
): Promise<{ body: Buffer; mime: string }> {
  if (!isTrustedMediaUrl(args.url)) {
    throw new MetaApiError("Endereço de mídia não confiável.", 400, null);
  }

  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(args.url, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch {
    throw new MetaApiError("O download da mídia não respondeu a tempo.", 0, null);
  }

  if (!response.ok) throw await toMetaError(response, `Media download failed: ${response.status}`);

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > args.maxBytes) throw new MetaApiError("Mídia acima do limite.", 413, null);

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > args.maxBytes) throw new MetaApiError("Mídia acima do limite.", 413, null);

  return { body, mime: response.headers.get("content-type") ?? "application/octet-stream" };
}

// ---------------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------------

export type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  category?: string;
  status: string;
  components?: unknown[];
};

/** Lê todas as páginas dos modelos do WABA. Para em 20 páginas (2000 modelos). */
export async function listTemplates(
  args: Credentials & { wabaId: string },
  options: GraphOptions = {},
): Promise<MetaTemplate[]> {
  const templates: MetaTemplate[] = [];
  let after: string | undefined;

  for (let page = 0; page < 20; page++) {
    const response = await request(
      {
        path: `${assertGraphId(args.wabaId, "waba_id")}/message_templates`,
        accessToken: args.accessToken,
        query: {
          fields: "id,name,language,category,status,components",
          limit: 100,
          after,
        },
      },
      options,
    );
    const data = await json<{
      data?: MetaTemplate[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(response, `Meta API error: ${response.status}`);

    templates.push(...(data.data ?? []));
    after = data.paging?.next ? data.paging.cursors?.after : undefined;
    if (!after) break;
  }

  return templates;
}
