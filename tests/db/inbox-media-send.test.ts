import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import { conversation, file, message, messageTemplate } from "@/db/schema";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { ProviderError } from "@/lib/channels/errors";
import { setProvidersForTests } from "@/lib/channels/registry";
import type {
  ChannelProvider,
  SendMedia,
  SendResult,
  SendTemplate,
  SendText,
} from "@/lib/channels/types";
import { signMediaOutToken } from "@/lib/inbox/media-out";
import { setStorageForTests } from "@/lib/storage";
import { withScope } from "@/db/rls";
import { bodyOf } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, seedQrChannel, tenantScope } from "./channels-helpers";
import {
  attachMedia,
  memoryStorage,
  readAll,
  seedConversation,
  seedMessage,
} from "./inbox-helpers";
import {
  addMember,
  call,
  callForm,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * C5: anexo de saída, modelo e citação, pela API, com o provedor simulado e o armazenamento em memória.
 * Foco nas recusas: tipo falso, arquivo grande, janela fechada, número desconectado, tenant
 * `read_only`, conversa de outro, citação de outra conversa, token expirado, adulterado e de outro arquivo.
 * Em toda recusa, nada fica gravado (nem `file`, nem objeto, nem mensagem).
 */

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 7),
]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(300, 9)]);
const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(100, 3)]);

type View = {
  id: string;
  type: string;
  text: string | null;
  status: string | null;
  template: { name: string } | null;
  error: { code: string | null; message: string | null } | null;
  media: { url: string; mime: string | null; size: number | null; name: string | null; status: string } | null;
  replyTo: { id: string } | null;
};

type SentMedia = Omit<SendMedia, "content"> & { content?: { body: Buffer; mime: string } };

describe("/api/inbox: anexo, modelo e citação (C5)", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let cloudId: string;
  let qrId: string;
  let downId: string;
  const WABA = `waba-${randomUUID().slice(0, 8)}`;
  const users: Record<string, TestUser> = {};
  const memory = memoryStorage();
  const sentText: SendText[] = [];
  const sentMedia: SentMedia[] = [];
  const sentTemplates: SendTemplate[] = [];
  let mediaReply: (input: SendMedia) => Promise<SendResult>;
  let templateReply: (input: SendTemplate) => Promise<SendResult>;

  const fake = (type: "whatsapp_cloud" | "whatsapp_qr") =>
    ({
      type,
      sendText: async (_ctx: unknown, input: SendText) => {
        sentText.push(input);
        return { providerMessageId: `wamid.${randomUUID()}` };
      },
      sendMedia: async (_ctx: unknown, input: SendMedia) => {
        // A Cloud lê o arquivo (sobe e envia pelo id); a Evolution usa o endereço e nunca chama `content`.
        const content = type === "whatsapp_cloud" ? await input.content?.() : undefined;
        sentMedia.push({ ...input, content });
        return mediaReply(input);
      },
      sendTemplate: async (_ctx: unknown, input: SendTemplate) => {
        sentTemplates.push(input);
        return templateReply(input);
      },
    }) as unknown as ChannelProvider;

  beforeAll(async () => {
    owner = connectOwner();
    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;
    for (const role of ["memberA", "memberB", "memberC", "limited"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, "member");
      users[role] = user;
    }
    await createRole(users.owner, "leitor", ["inbox:read"]);
    users.reader = await createUser(owner);
    await addMember(owner, tenantId, users.reader, "leitor");
    cloudId = (await seedCloudChannel(tenantScope(tenantId), { wabaId: WABA })).id;
    qrId = (await seedQrChannel(tenantScope(tenantId))).id;
    downId = (await seedCloudChannel(tenantScope(tenantId), { status: "disconnected" })).id;

    await withScope(tenantScope(tenantId), async (tx) => {
      await tx.insert(messageTemplate).values([
        { tenantId, wabaId: WABA, name: "boas_vindas", language: "pt_BR", status: "APPROVED", category: "UTILITY",
          components: [{ type: "BODY", text: "Olá {{1}}, seu pedido {{2}} está pronto." }, { type: "FOOTER", text: "Equipe" }] },
        { tenantId, wabaId: WABA, name: "sem_variavel", language: "pt_BR", status: "APPROVED",
          components: [{ type: "BODY", text: "Estamos abertos." }] },
        { tenantId, wabaId: WABA, name: "com_imagem", language: "pt_BR", status: "APPROVED",
          components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Promoção" }] },
        { tenantId, wabaId: WABA, name: "pendente", language: "pt_BR", status: "PENDING",
          components: [{ type: "BODY", text: "Ainda não" }] },
        { tenantId, wabaId: "outro-waba", name: "de_outro_waba", language: "pt_BR", status: "APPROVED",
          components: [{ type: "BODY", text: "Outro número" }] },
      ]);
    });
  });

  beforeEach(() => {
    setStorageForTests(memory.storage);
    setProvidersForTests([fake("whatsapp_cloud"), fake("whatsapp_qr")]);
    mediaReply = async () => ({ providerMessageId: `wamid.${randomUUID()}` });
    templateReply = async () => ({ providerMessageId: `wamid.${randomUUID()}` });
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    setStorageForTests(undefined);
    sentText.length = 0;
    sentMedia.length = 0;
    sentTemplates.length = 0;
    memory.objects.clear();
    await waitForBackgroundTasks();
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id = ${tenantId}`;
      await tx`delete from file where tenant_id = ${tenantId}`;
    });
  });

  afterAll(async () => {
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from message_template where tenant_id = ${tenantId}`;
    });
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);
  const clientId = () => `c-${randomUUID()}`;

  const upload = (
    role: string,
    conversationId: string,
    content: Buffer,
    options: { name?: string; type?: string; caption?: string; replyTo?: string; clientId?: string } = {},
  ) => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(content)], options.name ?? "arquivo.bin", { type: options.type ?? "" }));
    form.set("clientId", options.clientId ?? clientId());
    if (options.caption !== undefined) form.set("caption", options.caption);
    if (options.replyTo) form.set("replyTo", options.replyTo);
    return callForm("POST", `/api/inbox/conversations/${conversationId}/messages`, { cookie: as(role), form });
  };

  const sendJson = (role: string, conversationId: string, body: Record<string, unknown>) =>
    call("POST", `/api/inbox/conversations/${conversationId}/messages`, {
      cookie: as(role),
      body: { clientId: clientId(), ...body },
    });

  const messagesOf = (conversationId: string) =>
    readAll((tx) => tx.select().from(message).where(eq(message.conversationId, conversationId)));
  const filesOf = () => readAll((tx) => tx.select().from(file).where(eq(file.tenantId, tenantId)));
  const noTrace = async (conversationId: string) => {
    expect(await messagesOf(conversationId)).toHaveLength(0);
    expect(await filesOf()).toHaveLength(0);
    expect(memory.objects.size).toBe(0);
  };
  const templateId = async (name: string) =>
    (await readAll((tx) => tx.select().from(messageTemplate).where(eq(messageTemplate.name, name))))
      .filter((row) => row.tenantId === tenantId)[0]?.id as string;

  // -------------------------------------------------------------------------
  // Anexo
  // -------------------------------------------------------------------------

  describe("anexo de saída", () => {
    it("Cloud: grava o arquivo antes, sobe o conteúdo, envia imagem com legenda e assume a conversa", async () => {
      const q = await seedConversation(scope(), cloudId, { unreadCount: 2 });

      const response = await upload("memberA", q.id, PNG, { name: "foto.png", type: "application/octet-stream", caption: "Olha isso" });
      expect(response.status).toBe(201);
      const view = (await bodyOf(response)).message as View;

      expect(view).toMatchObject({ type: "image", text: "Olha isso", status: "sent" });
      expect(view.media).toMatchObject({ mime: "image/png", name: "foto.png", size: PNG.byteLength, status: "ready" });

      // O tipo veio do conteúdo (o navegador disse octet-stream) e o arquivo está gravado.
      const [stored] = await filesOf();
      expect(stored).toMatchObject({ ownerType: "message", ownerId: view.id, mime: "image/png", size: PNG.byteLength });
      expect(stored?.key).toMatch(new RegExp(`^inbox/${tenantId}/`));
      expect(memory.objects.get(stored?.key as string)?.equals(PNG)).toBe(true);

      // O provedor recebeu o arquivo (Cloud sobe e envia pelo id) e a legenda.
      expect(sentMedia).toHaveLength(1);
      expect(sentMedia[0]).toMatchObject({ kind: "image", caption: "Olha isso", filename: "foto.png" });
      expect(sentMedia[0]?.content?.body.equals(PNG)).toBe(true);
      expect(sentMedia[0]?.content?.mime).toBe("image/png");

      const [conv] = await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, q.id)));
      expect(conv).toMatchObject({ assignedUserId: users.memberA?.id, unreadCount: 0, lastMessagePreview: "Olha isso" });

      // A mídia enviada se abre pela rota autenticada, com o tipo do conteúdo e `nosniff`.
      const served = await call("GET", view.media?.url as string, { cookie: as("memberA") });
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("Evolution: envia pelo endereço assinado, que serve o arquivo sem sessão e só a esse arquivo", async () => {
      const q = await seedConversation(scope(), qrId);

      const response = await upload("memberA", q.id, PDF, { name: "contrato.pdf", type: "application/pdf" });
      expect(response.status).toBe(201);
      const view = (await bodyOf(response)).message as View;
      expect(view).toMatchObject({ type: "document", text: null, status: "sent" });

      const input = sentMedia[0] as SentMedia;
      expect(input.kind).toBe("document");
      expect(input.filename).toBe("contrato.pdf");
      // A Evolution baixa pelo endereço; o conteúdo nunca é lido para ela.
      expect(input.content).toBeUndefined();
      const url = new URL(input.url as string);
      expect(url.pathname).toMatch(/^\/api\/inbox\/media-out\/[0-9a-f-]{36}\.\d+\.[\w-]+$/);

      // Sem cookie: o token autoriza. Anexo, `nosniff`, sem cache compartilhado.
      const served = await api.request(url.pathname, { headers: { "X-Forwarded-For": "10.77.0.1" } });
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("application/pdf");
      expect(served.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await served.arrayBuffer()).equals(PDF)).toBe(true);

      const [stored] = await filesOf();
      const fileId = stored?.id as string;
      const get = (path: string, ip: string) => api.request(path, { headers: { "X-Forwarded-For": ip } });

      // Vencido.
      const expired = signMediaOutToken(fileId, Date.now() - 6 * 60 * 1000);
      expect((await get(`/api/inbox/media-out/${expired}`, "10.77.0.2")).status).toBe(404);
      // Adulterado (um caractere da assinatura).
      const valid = signMediaOutToken(fileId);
      const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
      expect((await get(`/api/inbox/media-out/${tampered}`, "10.77.0.3")).status).toBe(404);
      // Assinatura de um arquivo no id de outro.
      const [, expires, signature] = valid.split(".");
      expect((await get(`/api/inbox/media-out/${randomUUID()}.${expires}.${signature}`, "10.77.0.4")).status).toBe(404);
      // Não lista nada: sem token, a rota é só a do atendimento autenticado (sem sessão, 401).
      expect([401, 404]).toContain((await get("/api/inbox/media-out/", "10.77.0.5")).status);
      expect([401, 404]).toContain((await get("/api/inbox/media-out", "10.77.0.6")).status);
    });

    it("um token válido de mídia recebida (não é anexo da equipe) não abre nada", async () => {
      const q = await seedConversation(scope(), qrId);
      const received = await seedMessage(scope(), { conversationId: q.id, channelId: qrId }, { type: "image" });
      const fileId = await attachMedia(scope(), memory, received.id, PNG, "image/png", "recebida.png");

      const token = signMediaOutToken(fileId);
      const response = await api.request(`/api/inbox/media-out/${token}`, { headers: { "X-Forwarded-For": "10.77.1.1" } });

      expect(response.status).toBe(404);
    });

    it("tipo falso (HTML declarado como imagem) é 415 e não grava nada", async () => {
      const q = await seedConversation(scope(), cloudId);

      for (const content of [HTML, Buffer.from("MZ\x90\x00 programa"), Buffer.from("<svg/>")]) {
        const response = await upload("memberA", q.id, content, { name: "foto.png", type: "image/png" });
        expect(response.status).toBe(415);
        expect((await bodyOf(response)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
      }

      await noTrace(q.id);
      expect(sentMedia).toHaveLength(0);
    });

    it("acima de 16 MB é 413 antes de gravar (tanto o que passa do limite do corpo quanto o que não)", async () => {
      const q = await seedConversation(scope(), cloudId);
      const header = PNG.subarray(0, 8);
      const big = (size: number) => Buffer.concat([header, Buffer.alloc(size - header.length)]);

      const just = await upload("memberA", q.id, big(16 * 1024 * 1024 + 1), { type: "image/png" });
      const way = await upload("memberA", q.id, big(20 * 1024 * 1024), { type: "image/png" });

      expect(just.status).toBe(413);
      expect(way.status).toBe(413);
      expect((await bodyOf(way)).code).toBe("FILE_TOO_LARGE");
      await noTrace(q.id);

      // Exatamente 16 MB passa.
      const ok = await upload("memberA", q.id, big(16 * 1024 * 1024), { type: "image/png" });
      expect(ok.status).toBe(201);
    }, 30_000);

    it("arquivo vazio, ausente, legenda em áudio e clientId inválido são 400", async () => {
      const q = await seedConversation(scope(), cloudId);

      expect((await upload("memberA", q.id, Buffer.alloc(0), { type: "image/png" })).status).toBe(400);
      expect((await upload("memberA", q.id, OGG, { type: "audio/ogg", caption: "não cabe" })).status).toBe(400);
      expect((await upload("memberA", q.id, PNG, { clientId: "curto" })).status).toBe(400);

      const form = new FormData();
      form.set("clientId", clientId());
      const missing = await callForm("POST", `/api/inbox/conversations/${q.id}/messages`, { cookie: as("memberA"), form });
      expect(missing.status).toBe(400);

      await noTrace(q.id);
    });

    it("janela de 24 h fechada com anexo: 409 e nada gravado", async () => {
      const closed = await seedConversation(scope(), cloudId, { lastInboundAt: new Date(Date.now() - 30 * 3600_000) });

      const response = await upload("memberA", closed.id, PNG, { type: "image/png" });
      expect(response.status).toBe(409);
      expect((await bodyOf(response)).code).toBe("SESSION_WINDOW_CLOSED");
      await noTrace(closed.id);

      // Na Evolution não há janela: o anexo sai.
      const qr = await seedConversation(scope(), qrId, { lastInboundAt: new Date(Date.now() - 30 * 3600_000) });
      expect((await upload("memberA", qr.id, PNG, { type: "image/png" })).status).toBe(201);
    });

    it("número desconectado: 409 e nada gravado", async () => {
      const q = await seedConversation(scope(), downId);

      const response = await upload("memberA", q.id, PNG, { type: "image/png" });

      expect(response.status).toBe(409);
      expect((await bodyOf(response)).code).toBe("CHANNEL_NOT_CONNECTED");
      await noTrace(q.id);
    });

    it("tenant em somente leitura: 403 e nada gravado; a leitura segue", async () => {
      const q = await seedConversation(scope(), cloudId);
      const setMode = (mode: string) =>
        owner.begin(async (tx) => {
          await tx`select set_config('app.bypass_tenant', 'on', true)`;
          await tx`update organization set access_mode = ${mode} where id = ${tenantId}`;
        });
      await setMode("read_only");

      try {
        const response = await upload("memberA", q.id, PNG, { type: "image/png" });
        expect(response.status).toBe(403);
        expect((await bodyOf(response)).code).toBe("TENANT_READ_ONLY");
        await noTrace(q.id);
      } finally {
        await setMode("full");
      }
    });

    it("conversa de outro atendente: 404 e nada gravado", async () => {
      const mine = await seedConversation(scope(), cloudId, { assignedUserId: users.memberB?.id });

      const response = await upload("memberA", mine.id, PNG, { type: "image/png" });

      expect(response.status).toBe(404);
      await noTrace(mine.id);
    });

    it("sem inbox:reply não envia anexo (o corpo nem é lido)", async () => {
      const q = await seedConversation(scope(), cloudId);
      // Papel personalizado que só lê: não responde.
      const form = new FormData();
      form.set("file", new File([new Uint8Array(PNG)], "a.png", { type: "image/png" }));
      form.set("clientId", clientId());
      const response = await callForm("POST", `/api/inbox/conversations/${q.id}/messages`, { cookie: as("reader"), form });

      expect(response.status).toBe(403);
      await noTrace(q.id);
    });

    it("anexos têm limite próprio: 20 por minuto por pessoa (o 21º é 429 e não grava)", async () => {
      const q = await seedConversation(scope(), qrId);
      const statuses: number[] = [];

      for (let index = 0; index < 21; index += 1) {
        statuses.push((await upload("limited", q.id, PNG, { type: "image/png" })).status);
      }

      expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
      expect(statuses[20]).toBe(429);
      expect(await messagesOf(q.id)).toHaveLength(20);
    });

    it("clientId repetido devolve a mesma mensagem: um arquivo, um objeto, um envio", async () => {
      const q = await seedConversation(scope(), cloudId);
      const id = clientId();

      const first = await upload("memberA", q.id, PNG, { type: "image/png", clientId: id });
      const second = await upload("memberA", q.id, PNG, { type: "image/png", clientId: id });

      expect(((await bodyOf(first)).message as View).id).toBe(((await bodyOf(second)).message as View).id);
      expect(sentMedia).toHaveLength(1);
      expect(await filesOf()).toHaveLength(1);
      expect(memory.objects.size).toBe(1);
    });

    it("falha do provedor: a mensagem fica failed com o arquivo; reenviar reaproveita o file, sem novo upload", async () => {
      const q = await seedConversation(scope(), cloudId);
      mediaReply = async () => {
        throw new ProviderError("(#131053) Falha no envio da mídia", 400, 131053);
      };

      const response = await upload("memberA", q.id, PNG, { name: "foto.png", type: "image/png", caption: "legenda" });
      expect(response.status).toBe(200);
      const failed = (await bodyOf(response)).message as View;
      expect(failed).toMatchObject({ status: "failed", error: { code: "131053" }, type: "image" });

      const [before] = await filesOf();
      expect(memory.objects.size).toBe(1);

      mediaReply = async () => ({ providerMessageId: "wamid.retry-media" });
      const retried = await call("POST", `/api/inbox/messages/${failed.id}/retry`, { cookie: as("memberA") });
      expect(retried.status).toBe(201);
      const view = (await bodyOf(retried)).message as View;

      expect(view).toMatchObject({ status: "sent", type: "image", text: "legenda" });
      expect(view.id).not.toBe(failed.id);

      // O mesmo `file` e o mesmo objeto, agora da mensagem nova; a que falhou saiu.
      const after = await filesOf();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: before?.id, key: before?.key, ownerId: view.id });
      expect(memory.objects.size).toBe(1);
      expect((await messagesOf(q.id)).map((row) => row.id)).toEqual([view.id]);

      // O provedor recebeu de novo o mesmo conteúdo, lido do armazenamento.
      expect(sentMedia).toHaveLength(2);
      expect(sentMedia[1]?.content?.body.equals(PNG)).toBe(true);
      expect(sentMedia[1]?.caption).toBe("legenda");

      // A mídia da mensagem nova abre.
      expect((await call("GET", view.media?.url as string, { cookie: as("memberA") })).status).toBe(200);
    });

    it("reenviar várias vezes seguidas mantém um só arquivo e um só objeto", async () => {
      const q = await seedConversation(scope(), cloudId);
      mediaReply = async () => {
        throw new ProviderError("recusado", 400, 1);
      };
      const first = (await bodyOf(await upload("memberA", q.id, PDF, { name: "a.pdf", type: "application/pdf" }))).message as View;
      const second = (await bodyOf(await call("POST", `/api/inbox/messages/${first.id}/retry`, { cookie: as("memberA") }))).message as View;
      expect(second.status).toBe("failed");
      const third = (await bodyOf(await call("POST", `/api/inbox/messages/${second.id}/retry`, { cookie: as("memberA") }))).message as View;
      expect(third.status).toBe("failed");

      expect(await filesOf()).toHaveLength(1);
      expect(memory.objects.size).toBe(1);
      expect(await messagesOf(q.id)).toHaveLength(1);
    });

    it("o eco do aparelho que chegou antes da gravação do id leva o file e o objeto junto", async () => {
      const q = await seedConversation(scope(), qrId);
      const providerId = `wamid.${randomUUID()}`;

      // O provedor responde depois que o eco já virou mensagem `device` com mídia gravada.
      mediaReply = async () => {
        const echo = await readAll(async (tx) => {
          const [row] = await tx
            .insert(message)
            .values({
              tenantId,
              conversationId: q.id,
              channelId: qrId,
              direction: "out",
              senderType: "device",
              type: "document",
              status: "sent",
              mediaStatus: "ready",
              providerMessageId: providerId,
            })
            .returning({ id: message.id });
          return row;
        });
        await attachMedia(scope(), memory, echo?.id as string, PDF, "application/pdf", "eco.pdf");
        return { providerMessageId: providerId };
      };

      const response = await upload("memberA", q.id, PDF, { name: "contrato.pdf", type: "application/pdf" });
      expect(response.status).toBe(201);
      const view = (await bodyOf(response)).message as View;

      const rows = await messagesOf(q.id);
      expect(rows.map((row) => row.id)).toEqual([view.id]);
      // Só o anexo enviado por aqui: o `file` do eco e o objeto dele saíram.
      const files = await filesOf();
      expect(files).toHaveLength(1);
      expect(files[0]?.ownerId).toBe(view.id);
      expect(memory.objects.size).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Citação
  // -------------------------------------------------------------------------

  describe("resposta citada", () => {
    it("texto e anexo citam a mensagem; o provedor recebe o id dela", async () => {
      const q = await seedConversation(scope(), cloudId);
      const original = await seedMessage(scope(), { conversationId: q.id, channelId: cloudId }, { text: "Qual o prazo?" });
      await readAll((tx) => tx.update(message).set({ providerMessageId: "wamid.original" }).where(eq(message.id, original.id)));

      const text = await sendJson("memberC", q.id, { type: "text", text: "Dois dias", replyTo: original.id });
      expect(text.status).toBe(201);
      expect(((await bodyOf(text)).message as View).replyTo?.id).toBe(original.id);
      expect(sentText[0]).toMatchObject({ text: "Dois dias", quotedProviderMessageId: "wamid.original" });

      const media = await upload("memberC", q.id, PNG, { type: "image/png", replyTo: original.id });
      expect(media.status).toBe(201);
      expect(((await bodyOf(media)).message as View).replyTo?.id).toBe(original.id);
      expect(sentMedia[0]?.quotedProviderMessageId).toBe("wamid.original");
    });

    it("citar mensagem de outra conversa é 400, no texto e no anexo, e não grava nada", async () => {
      const a = await seedConversation(scope(), cloudId);
      const b = await seedConversation(scope(), cloudId);
      const foreign = await seedMessage(scope(), { conversationId: b.id, channelId: cloudId });
      const before = await messagesOf(a.id);

      const text = await sendJson("memberC", a.id, { type: "text", text: "oi", replyTo: foreign.id });
      const media = await upload("memberC", a.id, PNG, { type: "image/png", replyTo: foreign.id });
      const missing = await sendJson("memberC", a.id, { type: "text", text: "oi", replyTo: randomUUID() });

      for (const response of [text, media, missing]) {
        expect(response.status).toBe(400);
        expect((await bodyOf(response)).code).toBe("INVALID_REPLY");
      }
      expect(await messagesOf(a.id)).toEqual(before);
      expect(await filesOf()).toHaveLength(0);
      expect(memory.objects.size).toBe(0);
      expect(sentText).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Modelo
  // -------------------------------------------------------------------------

  describe("modelo de mensagem", () => {
    it("lista só os aprovados do WABA do canal, com as variáveis e o que não é suportado", async () => {
      const q = await seedConversation(scope(), cloudId);

      const response = await call("GET", `/api/inbox/conversations/${q.id}/templates`, { cookie: as("memberA") });
      expect(response.status).toBe(200);
      const { templates } = (await bodyOf(response)) as {
        templates: { name: string; supported: boolean; reason: string | null; slots: { component: string; name: string }[]; body: string | null }[];
      };

      expect(templates.map((item) => item.name)).toEqual(["boas_vindas", "com_imagem", "sem_variavel"]);
      const boasVindas = templates.find((item) => item.name === "boas_vindas");
      expect(boasVindas).toMatchObject({ supported: true, body: "Olá {{1}}, seu pedido {{2}} está pronto." });
      expect(boasVindas?.slots).toHaveLength(2);
      expect(templates.find((item) => item.name === "com_imagem")).toMatchObject({ supported: false });
      expect(templates.find((item) => item.name === "com_imagem")?.reason).toMatch(/mídia/);
    });

    it("canal sem modelos (Evolution): lista vazia e envio recusado", async () => {
      const q = await seedConversation(scope(), qrId);

      const list = await call("GET", `/api/inbox/conversations/${q.id}/templates`, { cookie: as("memberA") });
      expect((await bodyOf(list)).templates).toEqual([]);

      const send = await sendJson("memberA", q.id, { type: "template", templateId: await templateId("sem_variavel"), variables: [] });
      expect(send.status).toBe(400);
      expect((await bodyOf(send)).code).toBe("TEMPLATES_NOT_SUPPORTED");
      expect(sentTemplates).toHaveLength(0);
      expect(await messagesOf(q.id)).toHaveLength(0);
    });

    it("com a janela fechada o modelo sai: texto preenchido gravado, components enviados, janela intacta", async () => {
      const q = await seedConversation(scope(), cloudId, { lastInboundAt: null, unreadCount: 1 });

      const response = await sendJson("memberA", q.id, {
        type: "template",
        templateId: await templateId("boas_vindas"),
        variables: ["Maria", " 4521 "],
      });
      expect(response.status).toBe(201);
      const view = (await bodyOf(response)).message as View;

      expect(view).toMatchObject({
        type: "template",
        status: "sent",
        template: { name: "boas_vindas" },
        text: "Olá Maria, seu pedido 4521 está pronto.\n\nEquipe",
      });
      expect(sentTemplates).toEqual([
        {
          to: q.phone,
          name: "boas_vindas",
          language: "pt_BR",
          components: [{ type: "body", parameters: [{ type: "text", text: "Maria" }, { type: "text", text: "4521" }] }],
        },
      ]);

      const [row] = await messagesOf(q.id);
      expect(row).toMatchObject({ type: "template", templateName: "boas_vindas", direction: "out" });
      const payload = (row?.payload ?? { template: { variables: [] } }) as { template: { variables: string[] } };
      expect(payload.template.variables).toEqual(["Maria", "4521"]);

      // Mandar modelo não abre a janela (só a mensagem do contato abre) e assume a conversa.
      const [conv] = await readAll((tx) => tx.select().from(conversation).where(eq(conversation.id, q.id)));
      expect(conv).toMatchObject({ lastInboundAt: null, assignedUserId: users.memberA?.id, unreadCount: 0 });

      // Texto livre na mesma conversa continua recusado.
      const free = await sendJson("memberA", q.id, { type: "text", text: "oi" });
      expect(free.status).toBe(409);
    });

    it("variáveis: contagem errada, vazia, com quebra de linha e fora do tipo são 400, sem gravar", async () => {
      const q = await seedConversation(scope(), cloudId);
      const id = await templateId("boas_vindas");

      for (const variables of [[], ["só uma"], ["a", "b", "c"], ["a", "  "], ["a", "linha\nquebrada"]]) {
        const response = await sendJson("memberA", q.id, { type: "template", templateId: id, variables });
        expect(response.status).toBe(400);
        expect((await bodyOf(response)).code).toBe("INVALID_TEMPLATE_VARIABLES");
      }
      expect((await sendJson("memberA", q.id, { type: "template", templateId: "nao-uuid", variables: [] })).status).toBe(400);
      expect(await messagesOf(q.id)).toHaveLength(0);
      expect(sentTemplates).toHaveLength(0);
    });

    it("modelo pendente, de outro WABA, inexistente ou com mídia no cabeçalho não sai", async () => {
      const q = await seedConversation(scope(), cloudId);

      const pending = await sendJson("memberA", q.id, { type: "template", templateId: await templateId("pendente"), variables: [] });
      expect(pending.status).toBe(409);
      expect((await bodyOf(pending)).code).toBe("TEMPLATE_NOT_APPROVED");

      for (const id of [await templateId("de_outro_waba"), randomUUID()]) {
        const response = await sendJson("memberA", q.id, { type: "template", templateId: id, variables: [] });
        expect(response.status).toBe(404);
      }

      const media = await sendJson("memberA", q.id, { type: "template", templateId: await templateId("com_imagem"), variables: [] });
      expect(media.status).toBe(400);
      expect((await bodyOf(media)).code).toBe("TEMPLATE_NOT_SUPPORTED");

      expect(await messagesOf(q.id)).toHaveLength(0);
      expect(sentTemplates).toHaveLength(0);
    });

    it("número desconectado e conversa de outro atendente não enviam modelo", async () => {
      const down = await seedConversation(scope(), downId);
      const other = await seedConversation(scope(), cloudId, { assignedUserId: users.memberB?.id });
      const body = { type: "template", templateId: await templateId("sem_variavel"), variables: [] };

      const disconnected = await sendJson("memberA", down.id, body);
      expect(disconnected.status).toBe(409);
      expect((await bodyOf(disconnected)).code).toBe("CHANNEL_NOT_CONNECTED");
      expect((await sendJson("memberA", other.id, body)).status).toBe(404);
      expect((await call("GET", `/api/inbox/conversations/${other.id}/templates`, { cookie: as("memberA") })).status).toBe(404);
      expect(sentTemplates).toHaveLength(0);
    });

    it("falha do provedor: failed; reenviar o modelo vale com a janela fechada", async () => {
      const q = await seedConversation(scope(), cloudId, { lastInboundAt: null });
      templateReply = async () => {
        throw new ProviderError("(#132001) Modelo não existe", 400, 132001);
      };

      const response = await sendJson("memberA", q.id, { type: "template", templateId: await templateId("sem_variavel"), variables: [] });
      expect(response.status).toBe(200);
      const failed = (await bodyOf(response)).message as View;
      expect(failed).toMatchObject({ status: "failed", error: { code: "132001" } });

      templateReply = async () => ({ providerMessageId: "wamid.tpl-retry" });
      const retried = await call("POST", `/api/inbox/messages/${failed.id}/retry`, { cookie: as("memberA") });
      expect(retried.status).toBe(201);
      const view = (await bodyOf(retried)).message as View;
      expect(view).toMatchObject({ status: "sent", type: "template", text: "Estamos abertos." });
      expect((await messagesOf(q.id)).map((row) => row.id)).toEqual([view.id]);
      expect(sentTemplates).toHaveLength(2);
    });
  });
});
