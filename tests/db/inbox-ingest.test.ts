import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Scope, withPlatformScope, withScope } from "@/db/rls";
import { channelEvent, chatContact, conversation, file, message } from "@/db/schema";
import type { InboxMediaJob } from "@/jobs/queues";
import { ProviderError } from "@/lib/channels/errors";
import {
  processChannelEvent,
  receiveChannelEvent,
  scopeOf,
  setChannelQueueForTests,
  setInboxHandlers,
} from "@/lib/channels/events";
import { setProvidersForTests } from "@/lib/channels/registry";
import { channelHasConversations } from "@/lib/channels/service";
import type {
  ChannelProvider,
  ChannelType,
  NormalizedEvent,
  NormalizedMessage,
  NormalizedStatus,
} from "@/lib/channels/types";
import { findContactByPhoneKey, linkCandidates, providerPhone } from "@/lib/inbox/contacts";
import { previewOf } from "@/lib/inbox/ingest";
import { inboundMime, processInboxMedia, setInboxMediaQueueForTests } from "@/lib/inbox/media";
import { canWhatsApp, normalizePhone } from "@/lib/phone/br";
import { phoneValues } from "@/lib/phone/columns";
import { setStorageForTests } from "@/lib/storage";
import type { StorageProvider } from "@/lib/storage/types";
import {
  cleanUpChannels,
  createTenantRow,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "./channels-helpers";
import { uniquePhone } from "./phone-helpers";
import { connectOwner } from "./tenant-helpers";

/**
 * Ingestão da caixa de entrada (SPEC `caixa-de-entrada`, passo 2), pelo job `channel.inbound`
 * real, com um provedor que devolve os eventos já normalizados. Os avisos dos provedores de
 * verdade (fixtures de B0) passam pela mesma ingestão em `providers/<id>/inbox.db.test.ts`.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function memoryStorage() {
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

/** Celular do Brasil sem o 9º dígito, como os provedores costumam entregar. */
const withoutNinth = (normalized: string) => `${normalized.slice(0, 4)}${normalized.slice(5)}`;

describe("ingestão da caixa de entrada", () => {
  let owner: postgres.Sql;
  let tenantA: string;
  let tenantB: string;
  const users: string[] = [];
  const platformKeys: string[] = [];
  const media = memoryStorage();
  const jobs: InboxMediaJob[] = [];
  let fetchMedia: ChannelProvider["fetchMedia"];

  /** O corpo do aviso já é a lista de eventos; as datas voltam do JSON como texto. */
  const passThrough = (type: ChannelType) =>
    ({
      type,
      normalizeEvents: (raw: unknown) =>
        (raw as NormalizedEvent[]).map((event) =>
          "occurredAt" in event ? { ...event, occurredAt: new Date(event.occurredAt) } : event,
        ),
      probe: async () => ({ status: "connected", detail: null }),
      fetchMedia: (...args: Parameters<NonNullable<ChannelProvider["fetchMedia"]>>) => {
        if (!fetchMedia) throw new Error("fetchMedia não simulado");
        return fetchMedia(...args);
      },
    }) as unknown as ChannelProvider;

  beforeAll(async () => {
    owner = connectOwner();
    tenantA = await createTenantRow(owner, "inbox-a");
    tenantB = await createTenantRow(owner, "inbox-b");
    setChannelQueueForTests(async () => {});
    setInboxMediaQueueForTests(async (job) => {
      jobs.push(job);
    });
  });

  afterEach(async () => {
    setProvidersForTests(undefined);
    setStorageForTests(undefined);
    setInboxHandlers(undefined);
    media.objects.clear();
    jobs.length = 0;
    fetchMedia = undefined;
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      // A conversa segura o canal (`restrict`): sai antes, pelo contato.
      await tx`delete from chat_contact where tenant_id in (${tenantA}, ${tenantB})`;
      await tx`delete from file where tenant_id in (${tenantA}, ${tenantB})`;
      if (platformKeys.length) {
        await tx`delete from chat_contact where tenant_id is null and phone_key = any(${platformKeys})`;
        await tx`delete from file where tenant_id is null and owner_type = 'message' and key like 'inbound/inbox-test-%'`;
      }
      await tx`delete from channel where tenant_id in (${tenantA}, ${tenantB})`;
      await tx`delete from member where organization_id in (${tenantA}, ${tenantB})`;
      await tx`delete from customer where tenant_id in (${tenantA}, ${tenantB})`;
      if (users.length) await tx`delete from "user" where id = any(${users})`;
    });
    users.length = 0;
  });

  afterAll(async () => {
    setChannelQueueForTests(undefined);
    setInboxMediaQueueForTests(undefined);
    await cleanUpChannels(owner, [tenantA, tenantB]);
    await owner.end();
  });

  // -------------------------------------------------------------------------
  // Apoio
  // -------------------------------------------------------------------------

  let counter = 0;
  const inbound = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
    type: "message",
    fromPhone: "5511988880001",
    fromExternalId: null,
    pushName: "Ana",
    providerMessageId: `wamid.${randomUUID()}`,
    fromMe: false,
    messageType: "text",
    text: "oi",
    media: null,
    replyToProviderMessageId: null,
    occurredAt: new Date(Date.now() - 60_000 + counter++),
    ...over,
  });

  const statusEvent = (providerMessageId: string, status: NormalizedStatus["status"], error: string | null = null): NormalizedStatus => ({
    type: "status",
    providerMessageId,
    status,
    occurredAt: new Date(),
    error,
    recipientPhone: null,
  });

  /** Grava o aviso e roda o job, como em produção. */
  async function deliver(row: { id: string; tenantId: string | null; type: ChannelType }, events: NormalizedEvent[]) {
    setProvidersForTests([passThrough(row.type)]);
    const { id } = await receiveChannelEvent({
      scope: scopeOf(row.tenantId),
      channelId: row.id,
      provider: row.type,
      dedupeKey: randomUUID(),
      kind: events[0]?.type ?? "other",
      raw: events,
    });
    return processChannelEvent(id);
  }

  const read = <T>(fn: Parameters<typeof withPlatformScope<T>>[1]) => withPlatformScope("teste", fn);

  const contactsOf = (scope: Scope) =>
    read((tx) =>
      tx
        .select()
        .from(chatContact)
        .where(scope.kind === "tenant" ? eq(chatContact.tenantId, scope.tenantId) : isNull(chatContact.tenantId)),
    );
  const conversationsOf = (channelId: string) =>
    read((tx) => tx.select().from(conversation).where(eq(conversation.channelId, channelId)));
  const messagesOf = (channelId: string) =>
    read((tx) => tx.select().from(message).where(eq(message.channelId, channelId)).orderBy(message.createdAt));

  async function createUser(phone: string, options: { memberOf?: string } = {}) {
    const id = randomUUID();
    const values = phoneValues(phone);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`insert into "user" (id, name, email, email_verified, phone, phone_normalized, phone_key) values (${id}, ${`Membro ${id.slice(0, 4)}`}, ${`inbox-${id}@tenant-test.bizu.local`}, true, ${values.phone}, ${values.phoneNormalized}, ${values.phoneKey})`;
      if (options.memberOf) {
        await tx`insert into member (organization_id, user_id, role) values (${options.memberOf}, ${id}, 'member')`;
      }
    });
    users.push(id);
    return id;
  }

  async function createCustomer(tenantId: string, phone: string) {
    const id = randomUUID();
    const values = phoneValues(phone);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`insert into customer (id, tenant_id, name, phone, phone_normalized, phone_key) values (${id}, ${tenantId}, 'Cliente', ${values.phone}, ${values.phoneNormalized}, ${values.phoneKey})`;
    });
    return id;
  }

  /** Mensagem enviada pelo sistema (C2), para os avisos de status e o eco. */
  async function seedOutbound(
    channelRow: { id: string; tenantId: string | null; type: ChannelType },
    status: "queued" | "sent" = "sent",
  ) {
    const providerMessageId = `wamid.out.${randomUUID()}`;
    await deliver(channelRow, [inbound()]);
    const [thread] = await conversationsOf(channelRow.id);
    if (!thread) throw new Error("conversa não criada");
    await read((tx) =>
      tx.insert(message).values({
        tenantId: channelRow.tenantId,
        conversationId: thread.id,
        channelId: channelRow.id,
        direction: "out",
        senderType: "user",
        type: "text",
        text: "resposta",
        providerMessageId,
        status,
      }),
    );
    return { providerMessageId, conversationId: thread.id };
  }

  // -------------------------------------------------------------------------
  // Mensagem
  // -------------------------------------------------------------------------

  describe("evento message", () => {
    it("número novo cria contato não identificado e conversa na fila", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const event = inbound({ text: "oi, tudo bem?" });

      await expect(deliver(ch, [event])).resolves.toBe("processed");

      const [contact] = await contactsOf(tenantScope(tenantA));
      expect(contact).toMatchObject({
        phone: "5511988880001",
        phoneKey: "551188880001",
        waName: "Ana",
        createdVia: "inbound",
        customerId: null,
        userId: null,
      });
      const [thread] = await conversationsOf(ch.id);
      expect(thread).toMatchObject({
        tenantId: tenantA,
        contactId: contact?.id,
        status: "open",
        assignedUserId: null,
        unreadCount: 1,
        lastMessagePreview: "oi, tudo bem?",
        lastMessageDirection: "in",
      });
      expect(thread?.lastInboundAt?.getTime()).toBe(event.occurredAt.getTime());
      const [row] = await messagesOf(ch.id);
      expect(row).toMatchObject({
        direction: "in",
        senderType: "contact",
        type: "text",
        text: "oi, tudo bem?",
        status: null,
        providerMessageId: event.providerMessageId,
        conversationId: thread?.id,
      });
      expect(await read((tx) => channelHasConversations(tx, ch.id))).toBe(true);
    });

    it("segunda mensagem do mesmo número: um contato, uma conversa, soma não lida, atualiza o nome", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));

      await deliver(ch, [inbound({ pushName: "Ana" })]);
      // O mesmo celular, agora sem o 9º dígito.
      await deliver(ch, [inbound({ fromPhone: "551188880001", pushName: "Ana Paula" })]);
      await deliver(ch, [inbound({ fromPhone: "5511988880001", pushName: null, text: "última" })]);

      const contacts = await contactsOf(tenantScope(tenantA));
      expect(contacts).toHaveLength(1);
      expect(contacts[0]?.waName).toBe("Ana Paula");
      const threads = await conversationsOf(ch.id);
      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({ unreadCount: 3, lastMessagePreview: "última" });
      expect(await messagesOf(ch.id)).toHaveLength(3);
    });

    it("mensagem repetida (outro aviso, mesmo id do provedor) não duplica nem soma não lida", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const event = inbound();

      await expect(deliver(ch, [event])).resolves.toBe("processed");
      await expect(deliver(ch, [event])).resolves.toBe("ignored");
      // No mesmo aviso, duas vezes: a segunda é descartada, a primeira fica.
      await expect(deliver(ch, [inbound({ providerMessageId: "wamid.dup" }), inbound({ providerMessageId: "wamid.dup" })])).resolves.toBe("processed");

      expect(await messagesOf(ch.id)).toHaveLength(2);
      expect((await conversationsOf(ch.id))[0]?.unreadCount).toBe(2);
    });

    it("cada número de entrada tem a sua conversa com o mesmo contato", async () => {
      const one = await seedCloudChannel(tenantScope(tenantA));
      const two = await seedQrChannel(tenantScope(tenantA));

      await deliver(one, [inbound()]);
      await deliver(two, [inbound()]);

      expect(await contactsOf(tenantScope(tenantA))).toHaveLength(1);
      expect(await conversationsOf(one.id)).toHaveLength(1);
      expect(await conversationsOf(two.id)).toHaveLength(1);
    });

    it("prévia: legenda, tipo e corte em 120 caracteres", () => {
      expect(previewOf("image", null)).toBe("Imagem");
      expect(previewOf("image", "  foto  da\nloja ")).toBe("foto da loja");
      const long = previewOf("text", "a".repeat(300));
      expect(Array.from(long)).toHaveLength(120);
      expect(long.endsWith("…")).toBe(true);
    });

    it("citação recebida aponta para a mensagem citada", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const first = inbound({ providerMessageId: "wamid.citada" });

      await deliver(ch, [first]);
      await deliver(ch, [inbound({ replyToProviderMessageId: "wamid.citada", text: "isso" })]);

      const rows = await messagesOf(ch.id);
      expect(rows[1]?.replyToMessageId).toBe(rows[0]?.id);
    });

    it("grupo, transmissão e status (sem telefone nem LID) ficam ignored", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));

      await expect(deliver(ch, [inbound({ fromPhone: null, fromExternalId: null })])).resolves.toBe("ignored");
      expect(await contactsOf(tenantScope(tenantA))).toEqual([]);
    });
  });

  describe("vínculo automático", () => {
    it("cliente reconhecido quando o provedor entrega o celular sem o 9º dígito", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const phone = uniquePhone();
      const customerId = await createCustomer(tenantA, phone);
      const delivered = withoutNinth(phoneValues(phone).phoneNormalized);

      await deliver(ch, [inbound({ fromPhone: delivered })]);

      const [contact] = await contactsOf(tenantScope(tenantA));
      expect(contact).toMatchObject({ customerId, userId: null, phone: delivered });
    });

    it("membro da equipe reconhecido (com e sem o 9º dígito); o membro vem antes do cliente", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const phone = uniquePhone();
      const userId = await createUser(phone, { memberOf: tenantA });
      await createCustomer(tenantA, phone);

      await deliver(ch, [inbound({ fromPhone: phoneValues(phone).phoneNormalized })]);

      const [contact] = await contactsOf(tenantScope(tenantA));
      expect(contact).toMatchObject({ userId, customerId: null });

      const other = uniquePhone();
      const otherUser = await createUser(other, { memberOf: tenantA });
      await deliver(ch, [inbound({ fromPhone: withoutNinth(phoneValues(other).phoneNormalized) })]);
      const linked = (await contactsOf(tenantScope(tenantA))).find((row) => row.userId === otherUser);
      expect(linked).toBeDefined();
    });

    it("usuário que não é membro do tenant não é vinculado", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const phone = uniquePhone();
      await createUser(phone, { memberOf: tenantB });

      await deliver(ch, [inbound({ fromPhone: phoneValues(phone).phoneNormalized })]);

      expect((await contactsOf(tenantScope(tenantA)))[0]).toMatchObject({ userId: null, customerId: null });
    });

    it("dois membros com o mesmo número: sem vínculo com user, passa ao cliente e os dois são candidatos", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const phone = uniquePhone();
      const first = await createUser(phone, { memberOf: tenantA });
      const second = await createUser(phone, { memberOf: tenantA });

      await deliver(ch, [inbound({ fromPhone: phoneValues(phone).phoneNormalized })]);

      const [contact] = await contactsOf(tenantScope(tenantA));
      expect(contact).toMatchObject({ userId: null, customerId: null });
      const candidates = await withScope(tenantScope(tenantA), (tx) =>
        linkCandidates(tx, tenantScope(tenantA), phoneValues(phone).phoneKey),
      );
      expect(candidates.users.map(({ id }) => id).sort()).toEqual([first, second].sort());

      // Com um cliente do mesmo número, o vínculo vai para ele.
      const phone2 = uniquePhone();
      await createUser(phone2, { memberOf: tenantA });
      await createUser(phone2, { memberOf: tenantA });
      const customerId = await createCustomer(tenantA, phone2);
      await deliver(ch, [inbound({ fromPhone: phoneValues(phone2).phoneNormalized })]);
      const toCustomer = (await contactsOf(tenantScope(tenantA))).find(
        (row) => row.phoneKey === phoneValues(phone2).phoneKey,
      );
      expect(toCustomer).toMatchObject({ userId: null, customerId });
    });

    it("contato que já existe não é revinculado sozinho", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const phone = uniquePhone();
      await deliver(ch, [inbound({ fromPhone: phoneValues(phone).phoneNormalized })]);
      await createCustomer(tenantA, phone);

      await deliver(ch, [inbound({ fromPhone: phoneValues(phone).phoneNormalized })]);

      expect((await contactsOf(tenantScope(tenantA)))[0]?.customerId).toBeNull();
    });

    it("cliente mobile_legacy salvo a partir do contato continua achando o contato (sem PHONE_NOT_WHATSAPP)", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));
      // Celular antigo de 8 dígitos começando em 9, como o provedor entregou.
      const delivered = "551198887766";
      await deliver(ch, [inbound({ fromPhone: delivered })]);

      // "Salvar como cliente" (C2) grava o número do contato como veio, sem inserir o 9.
      const saved = phoneValues(`+${delivered}`);
      const kind = normalizePhone(`+${delivered}`);
      expect(kind.ok && kind.kind).toBe("mobile_legacy");
      expect(kind.ok && canWhatsApp(kind.kind)).toBe(false);

      // Iniciar conversa (C2) procura o contato pela `phone_key` antes de recusar o número.
      const contact = await withScope(tenantScope(tenantA), (tx) =>
        findContactByPhoneKey(tx, tenantScope(tenantA), saved.phoneKey),
      );
      expect(contact?.phone).toBe(delivered);
    });

    it("plataforma: vincula usuário com número único, nunca consulta cliente de tenant", async () => {
      const ch = await seedCloudChannel(platformScope, { name: "Inbox-chtest" });
      const phone = uniquePhone();
      const key = phoneValues(phone).phoneKey;
      platformKeys.push(key);
      const userId = await createUser(phone);
      await createCustomer(tenantA, phone);

      await expect(deliver(ch, [inbound({ fromPhone: phoneValues(phone).phoneNormalized })])).resolves.toBe("processed");

      const contact = (await contactsOf(platformScope)).find((row) => row.phoneKey === key);
      expect(contact).toMatchObject({ tenantId: null, userId, customerId: null });
      const [thread] = await conversationsOf(ch.id);
      expect(thread).toMatchObject({ tenantId: null, assignedUserId: null });
      const candidates = await withScope(platformScope, (tx) => linkCandidates(tx, platformScope, key));
      expect(candidates.customers).toEqual([]);

      // Dois usuários com o número: sem vínculo.
      const shared = uniquePhone();
      platformKeys.push(phoneValues(shared).phoneKey);
      await createUser(shared);
      await createUser(shared);
      await deliver(ch, [inbound({ fromPhone: phoneValues(shared).phoneNormalized })]);
      const none = (await contactsOf(platformScope)).find((row) => row.phoneKey === phoneValues(shared).phoneKey);
      expect(none).toMatchObject({ userId: null, customerId: null });

      await read((tx) => tx.delete(chatContact).where(isNull(chatContact.tenantId)));
      await cleanUpChannels(owner, []);
    });

    it("número estrangeiro de 11 dígitos não é lido como DDD do Brasil", () => {
      expect(providerPhone("12025550123")).toEqual({ phone: "12025550123", phoneKey: "12025550123" });
      expect(providerPhone("5511988880001")).toEqual({ phone: "5511988880001", phoneKey: "551188880001" });
      expect(providerPhone("123")).toBeNull();
    });
  });

  describe("conversa encerrada e dono", () => {
    it("encerrada reabre sem dono, na fila, mesmo com o dono anterior ainda na equipe", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const agent = await createUser(uniquePhone(), { memberOf: tenantA });
      await deliver(ch, [inbound()]);
      const [thread] = await conversationsOf(ch.id);
      await read((tx) =>
        tx
          .update(conversation)
          .set({ status: "closed", assignedUserId: agent, assignedAt: new Date(), closedAt: new Date(), closedBy: agent, unreadCount: 0 })
          .where(eq(conversation.id, thread?.id ?? "")),
      );

      await deliver(ch, [inbound({ text: "voltei" })]);

      expect((await conversationsOf(ch.id))[0]).toMatchObject({
        status: "open",
        assignedUserId: null,
        assignedAt: null,
        closedAt: null,
        closedBy: null,
        unreadCount: 1,
        lastMessagePreview: "voltei",
      });
    });

    it("conversa aberta ou pendente com dono continua com o dono", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const agent = await createUser(uniquePhone(), { memberOf: tenantA });
      await deliver(ch, [inbound()]);
      const [thread] = await conversationsOf(ch.id);
      await read((tx) =>
        tx.update(conversation).set({ status: "pending", assignedUserId: agent }).where(eq(conversation.id, thread?.id ?? "")),
      );

      await deliver(ch, [inbound()]);

      expect((await conversationsOf(ch.id))[0]).toMatchObject({ status: "pending", assignedUserId: agent, unreadCount: 2 });
    });

    it("mensagem antiga (sincronização) não volta a prévia nem a última hora", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));
      await deliver(ch, [inbound({ text: "recente", occurredAt: new Date(Date.now() - 1_000) })]);
      await deliver(ch, [inbound({ text: "de ontem", occurredAt: new Date(Date.now() - 86_400_000) })]);

      const [thread] = await conversationsOf(ch.id);
      expect(thread?.lastMessagePreview).toBe("recente");
      const rows = await messagesOf(ch.id);
      expect(rows.map((row) => row.text)).toEqual(["de ontem", "recente"]);
    });
  });

  describe("eco do aparelho", () => {
    it("vira mensagem enviada pelo aparelho; não soma não lida nem mexe no dono e na janela", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));
      const agent = await createUser(uniquePhone(), { memberOf: tenantA });
      await deliver(ch, [inbound()]);
      const [before] = await conversationsOf(ch.id);
      await read((tx) => tx.update(conversation).set({ assignedUserId: agent }).where(eq(conversation.id, before?.id ?? "")));

      await expect(
        deliver(ch, [inbound({ fromMe: true, pushName: "Loja", text: "respondi pelo celular" })]),
      ).resolves.toBe("processed");

      const [after] = await conversationsOf(ch.id);
      expect(after).toMatchObject({
        unreadCount: 1,
        assignedUserId: agent,
        lastMessageDirection: "out",
        lastMessagePreview: "respondi pelo celular",
      });
      expect(after?.lastInboundAt?.getTime()).toBe(before?.lastInboundAt?.getTime());
      const echo = (await messagesOf(ch.id)).find((row) => row.direction === "out");
      expect(echo).toMatchObject({ senderType: "device", status: "sent" });
      // O nome do perfil no eco é o do dono do número: não sobrescreve o do contato.
      expect((await contactsOf(tenantScope(tenantA)))[0]?.waName).toBe("Ana");
    });

    it("eco de mensagem enviada pelo sistema não insere de novo", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));
      const { providerMessageId } = await seedOutbound(ch);

      await expect(deliver(ch, [inbound({ fromMe: true, providerMessageId })])).resolves.toBe("ignored");

      expect((await messagesOf(ch.id)).filter((row) => row.providerMessageId === providerMessageId)).toHaveLength(1);
    });

    it("eco em canal sem deviceEcho (Cloud) fica ignored", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));

      await expect(deliver(ch, [inbound({ fromMe: true })])).resolves.toBe("ignored");
      expect(await contactsOf(tenantScope(tenantA))).toEqual([]);
    });

    it("eco para número novo cria o contato como device, sem nome", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));

      await deliver(ch, [inbound({ fromMe: true, pushName: "Loja" })]);

      expect((await contactsOf(tenantScope(tenantA)))[0]).toMatchObject({ createdVia: "device", waName: null });
      expect((await conversationsOf(ch.id))[0]).toMatchObject({ unreadCount: 0, lastInboundAt: null });
    });
  });

  describe("LID", () => {
    it("LID sem telefone conhecido é ignorado; depois de visto com o telefone, vai ao mesmo contato", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));
      const lid = "123456789012345@lid";

      await expect(deliver(ch, [inbound({ fromPhone: null, fromExternalId: lid })])).resolves.toBe("ignored");
      expect(await contactsOf(tenantScope(tenantA))).toEqual([]);

      await deliver(ch, [inbound({ fromExternalId: lid })]);
      await expect(deliver(ch, [inbound({ fromPhone: null, fromExternalId: lid, text: "pelo lid" })])).resolves.toBe("processed");

      expect(await contactsOf(tenantScope(tenantA))).toHaveLength(1);
      expect((await conversationsOf(ch.id))[0]?.unreadCount).toBe(2);
    });

    it("o LID de um tenant não serve a outro", async () => {
      const a = await seedQrChannel(tenantScope(tenantA));
      const b = await seedQrChannel(tenantScope(tenantB));
      const lid = "999999999999999@lid";
      await deliver(a, [inbound({ fromExternalId: lid })]);

      await expect(deliver(b, [inbound({ fromPhone: null, fromExternalId: lid })])).resolves.toBe("ignored");
    });
  });

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  describe("evento status", () => {
    it("fora de ordem (lida antes de entregue) termina lida", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));
      const { providerMessageId } = await seedOutbound(ch);

      await expect(deliver(ch, [statusEvent(providerMessageId, "read")])).resolves.toBe("processed");
      await expect(deliver(ch, [statusEvent(providerMessageId, "delivered")])).resolves.toBe("ignored");
      await expect(deliver(ch, [statusEvent(providerMessageId, "failed", "(#131026) Erro: x")])).resolves.toBe("ignored");

      const row = (await messagesOf(ch.id)).find((item) => item.providerMessageId === providerMessageId);
      expect(row).toMatchObject({ status: "read", errorCode: null });
    });

    it("failed a partir de sent grava código e motivo", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const { providerMessageId } = await seedOutbound(ch);

      await deliver(ch, [statusEvent(providerMessageId, "failed", "(#131047) Re-engagement message: mais de 24 horas")]);

      const row = (await messagesOf(ch.id)).find((item) => item.providerMessageId === providerMessageId);
      expect(row).toMatchObject({
        status: "failed",
        errorCode: "131047",
        errorMessage: "(#131047) Re-engagement message: mais de 24 horas",
      });
    });

    it("status de mensagem desconhecida, recebida ou de outro canal fica ignored", async () => {
      const ch = await seedQrChannel(tenantScope(tenantA));
      const other = await seedQrChannel(tenantScope(tenantA));
      const { providerMessageId } = await seedOutbound(ch);
      const received = inbound();
      await deliver(ch, [received]);

      await expect(deliver(ch, [statusEvent("wamid.nao-existe", "read")])).resolves.toBe("ignored");
      await expect(deliver(ch, [statusEvent(received.providerMessageId, "read")])).resolves.toBe("ignored");
      await expect(deliver(other, [statusEvent(providerMessageId, "read")])).resolves.toBe("ignored");
    });
  });

  // -------------------------------------------------------------------------
  // Mídia
  // -------------------------------------------------------------------------

  describe("mídia", () => {
    it("Evolution: o objeto já gravado vira file e a mensagem nasce ready", async () => {
      setStorageForTests(media.storage);
      const ch = await seedQrChannel(tenantScope(tenantA));
      const storageKey = `inbound/inbox-test-${randomUUID()}`;
      media.objects.set(storageKey, { body: JPEG });

      await deliver(ch, [
        inbound({
          messageType: "image",
          text: "olha",
          media: { kind: "image", mime: "image/jpeg", filename: null, storage: { storageKey, mime: "image/jpeg", size: JPEG.byteLength } },
        }),
      ]);

      const [row] = await messagesOf(ch.id);
      expect(row).toMatchObject({ type: "image", mediaStatus: "ready", text: "olha" });
      const [stored] = await read((tx) => tx.select().from(file).where(eq(file.id, row?.fileId ?? randomUUID())));
      expect(stored).toMatchObject({
        tenantId: tenantA,
        ownerType: "message",
        ownerId: row?.id,
        key: storageKey,
        mime: "image/jpeg",
        size: JPEG.byteLength,
        name: "imagem",
      });
      expect(media.objects.has(storageKey)).toBe(true);
    });

    it("Evolution: referência fora de inbound/ não vira file (falhou)", async () => {
      setStorageForTests(media.storage);
      const ch = await seedQrChannel(tenantScope(tenantA));

      await deliver(ch, [
        inbound({
          messageType: "image",
          media: { kind: "image", mime: "image/jpeg", filename: null, storage: { storageKey: "tenants/outro/arquivo", mime: "image/jpeg", size: 10 } },
        }),
      ]);

      expect((await messagesOf(ch.id))[0]).toMatchObject({ mediaStatus: "failed", fileId: null });
    });

    it("mensagem repetida com mídia nova: o objeto que ninguém cita sai do armazenamento", async () => {
      setStorageForTests(media.storage);
      const ch = await seedQrChannel(tenantScope(tenantA));
      const event = inbound({ messageType: "image" });
      const first = `inbound/inbox-test-${randomUUID()}`;
      const second = `inbound/inbox-test-${randomUUID()}`;
      media.objects.set(first, { body: JPEG });
      media.objects.set(second, { body: JPEG });
      const withKey = (storageKey: string) => ({
        ...event,
        media: { kind: "image" as const, mime: "image/jpeg", filename: null, storage: { storageKey, mime: "image/jpeg", size: 10 } },
      });

      await deliver(ch, [withKey(first)]);
      await expect(deliver(ch, [withKey(second)])).resolves.toBe("ignored");

      expect(media.objects.has(first)).toBe(true);
      expect(media.objects.has(second)).toBe(false);
    });

    it("Cloud: nasce pending e enfileira inbox.media; o job baixa, confere o tipo pelo conteúdo e grava", async () => {
      setStorageForTests(media.storage);
      const ch = await seedCloudChannel(tenantScope(tenantA));

      await deliver(ch, [
        inbound({
          messageType: "document",
          text: null,
          media: { kind: "document", mime: "application/pdf", filename: "contrato.pdf", providerMediaId: "media-1" },
        }),
      ]);

      const [row] = await messagesOf(ch.id);
      expect(row).toMatchObject({ mediaStatus: "pending", providerMediaId: "media-1", fileId: null });
      expect(jobs).toEqual([{ messageId: row?.id, tenantId: tenantA }]);

      // O provedor diz HTML; o conteúdo é JPEG.
      const calls: string[] = [];
      fetchMedia = async (_ctx, mediaId) => {
        calls.push(mediaId);
        return { body: JPEG, mime: "text/html" };
      };
      await expect(processInboxMedia(jobs[0] as InboxMediaJob)).resolves.toBe("ready");
      await expect(processInboxMedia(jobs[0] as InboxMediaJob)).resolves.toBe("skipped");

      expect(calls).toEqual(["media-1"]);
      const [done] = await messagesOf(ch.id);
      expect(done?.mediaStatus).toBe("ready");
      const [stored] = await read((tx) => tx.select().from(file).where(eq(file.id, done?.fileId ?? randomUUID())));
      expect(stored).toMatchObject({ tenantId: tenantA, mime: "image/jpeg", name: "contrato.pdf", ownerId: done?.id });
      expect(stored?.key.startsWith(`inbox/${tenantA}/`)).toBe(true);
      expect(media.objects.get(stored?.key ?? "")?.contentType).toBe("image/jpeg");
    });

    it("Cloud: recusa definitiva marca failed na hora; falha passageira repete e, na última, failed", async () => {
      setStorageForTests(media.storage);
      const ch = await seedCloudChannel(tenantScope(tenantA));
      const image = (id: string) =>
        inbound({ messageType: "image", media: { kind: "image", mime: "image/jpeg", filename: null, providerMediaId: id } });
      await deliver(ch, [image("vencida"), image("instavel")]);
      const [expired, flaky] = jobs as [InboxMediaJob, InboxMediaJob];

      fetchMedia = async (_ctx, id) => {
        throw id === "vencida" ? new ProviderError("Media not found", 404) : new ProviderError("timeout", 0);
      };

      await expect(processInboxMedia(expired)).resolves.toBe("failed");
      await expect(processInboxMedia(flaky)).rejects.toThrow();
      expect((await messagesOf(ch.id)).map((row) => row.mediaStatus).sort()).toEqual(["failed", "pending"]);

      await expect(processInboxMedia(flaky, { lastAttempt: true })).resolves.toBe("failed");
      expect((await messagesOf(ch.id)).every((row) => row.mediaStatus === "failed")).toBe(true);
      expect(media.objects.size).toBe(0);
    });

    it("tipo pelo conteúdo: Office em ZIP, áudio do WhatsApp, desconhecido vira octet-stream", () => {
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
      const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      expect(inboundMime(zip, docx)).toBe(docx);
      expect(inboundMime(zip, "image/png")).toBe("application/zip");
      expect(inboundMime(Buffer.from("OggS\0\0"), "audio/ogg; codecs=opus")).toBe("audio/ogg");
      expect(inboundMime(Buffer.from("<html><script>"), "image/jpeg")).toBe("application/octet-stream");
      expect(inboundMime(Buffer.from("a,b\n1,2"), "text/csv")).toBe("text/csv");
    });
  });

  describe("isolamento", () => {
    it("o mesmo número em dois tenants são contatos e conversas separados", async () => {
      const a = await seedCloudChannel(tenantScope(tenantA));
      const b = await seedCloudChannel(tenantScope(tenantB));

      await deliver(a, [inbound()]);
      await deliver(b, [inbound()]);

      const fromA = await withScope(tenantScope(tenantA), (tx) => tx.select().from(conversation));
      const fromB = await withScope(tenantScope(tenantB), (tx) => tx.select().from(conversation));
      expect(fromA.map((row) => row.channelId)).toEqual([a.id]);
      expect(fromB.map((row) => row.channelId)).toEqual([b.id]);
    });

    it("o aviso processado fica processed; o conteúdo não vai ao erro do aviso", async () => {
      const ch = await seedCloudChannel(tenantScope(tenantA));
      setProvidersForTests([passThrough("whatsapp_cloud")]);
      const { id } = await receiveChannelEvent({
        scope: tenantScope(tenantA),
        channelId: ch.id,
        provider: "whatsapp_cloud",
        dedupeKey: randomUUID(),
        kind: "message",
        raw: [inbound({ text: "segredo" })],
      });

      await processChannelEvent(id);

      const [event] = await read((tx) => tx.select().from(channelEvent).where(and(eq(channelEvent.id, id))));
      expect(event).toMatchObject({ status: "processed", error: null });
    });
  });
});
