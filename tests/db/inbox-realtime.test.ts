import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  openInboxStreams,
  SSE_MAX_STREAMS_PER_USER,
  setInboxEventTimingForTests,
} from "@/api/inbox-events";
import { withScope } from "@/db/rls";
import { channel } from "@/db/schema";
import { ingestStatus } from "@/lib/inbox/ingest";
import {
  dropRealtimeConnectionForTests,
  realtimeAvailable,
  stopRealtime,
} from "@/lib/inbox/realtime";
import { cleanUpChannels, seedCloudChannel, tenantScope } from "./channels-helpers";
import { randomMobile, seedConversation, seedMessage } from "./inbox-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * Tempo real da caixa de entrada (SPEC, passo 7), com Postgres real: `pg_notify` no `COMMIT`, a
 * conexão `LISTEN` do processo e o SSE de `/api/inbox/events` filtrado por pessoa. Inclui um
 * processo à parte fazendo a ingestão (o `--worker`), a queda da escuta, o limite de fluxos e a
 * reautenticação periódica.
 */

type SseMessage = { event: string; data: string };

type Stream = {
  status: number;
  messages: SseMessage[];
  pings: number;
  /** Resolve quando o servidor encerra o fluxo. */
  ended: Promise<void>;
  isEnded: () => boolean;
  waitFor: (match: (message: SseMessage) => boolean, ms?: number) => Promise<SseMessage>;
  close: () => Promise<void>;
};

const open: Stream[] = [];

async function openEvents(cookie?: string): Promise<Stream> {
  const response = await call("GET", "/api/inbox/events", { cookie });
  const messages: SseMessage[] = [];
  let pings = 0;
  let ended = false;

  if (response.status !== 200 || !response.body) {
    return {
      status: response.status,
      messages,
      pings,
      ended: Promise.resolve(),
      isEnded: () => true,
      waitFor: () => Promise.reject(new Error(`fluxo não abriu (${response.status})`)),
      close: async () => {},
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const stream: Stream = {
    status: 200,
    messages,
    get pings() {
      return pings;
    },
    ended: (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf("\n\n");
          while (cut >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            let event = "message";
            const data: string[] = [];
            let comment = false;
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) comment = true;
              else if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
            }
            if (comment && data.length === 0) pings += 1;
            else messages.push({ event, data: data.join("\n") });
            cut = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Cancelado pelo teste.
      } finally {
        ended = true;
      }
    })(),
    isEnded: () => ended,
    async waitFor(match, ms = 5_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = messages.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error("evento não chegou a tempo");
        if (ended) throw new Error("fluxo encerrado antes do evento");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
      await stream.ended;
    },
  };
  open.push(stream);

  // Depois de registrar: uma asserção que falha aqui não deixa o fluxo aberto para o próximo teste.
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  return stream;
}

const inbox = (message: SseMessage) =>
  message.event === "inbox" ? (JSON.parse(message.data) as Record<string, unknown>) : null;
const about = (conversationId: string) => (message: SseMessage) => inbox(message)?.c === conversationId;

async function until(condition: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condição não atingida");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
const workerScript = path.resolve("tests/db/fixtures/inbox-realtime-worker.ts");

describe("/api/inbox/events: tempo real", () => {
  let owner: postgres.Sql;
  let tenantId: string;
  let otherTenantId: string;
  let channelId: string;
  let otherChannelId: string;
  const users: Record<string, TestUser> = {};
  /** Cargas cruas do canal `inbox`, por uma conexão à parte (como um segundo processo web). */
  const raw: string[] = [];
  let unlisten: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    owner = connectOwner();
    users.owner = await createUser(owner);
    tenantId = (await createTenant(users.owner)).id;
    users.stranger = await createUser(owner);
    otherTenantId = (await createTenant(users.stranger, "Outra Clínica")).id;

    for (const role of ["memberA", "memberB"]) {
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, "member");
      users[role] = user;
    }
    await createRole(users.owner, "sem-atendimento", ["customer:read"]);
    users.noInbox = await createUser(owner);
    await addMember(owner, tenantId, users.noInbox, "sem-atendimento");

    channelId = (await seedCloudChannel(tenantScope(tenantId))).id;
    otherChannelId = (await seedCloudChannel(tenantScope(otherTenantId))).id;

    const listening = await owner.listen("inbox", (payload) => raw.push(payload));
    unlisten = listening.unlisten;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((stream) => stream.close()));
    setInboxEventTimingForTests(undefined);
    raw.length = 0;
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from chat_contact where tenant_id in (${tenantId}, ${otherTenantId})`;
    });
  });

  afterAll(async () => {
    await stopRealtime();
    await unlisten?.();
    await cleanUpChannels(owner, []);
    await cleanUp(owner);
    await owner.end();
  });

  const as = (role: string) => users[role]?.cookie as string;
  const scope = () => tenantScope(tenantId);

  describe("acesso", () => {
    it("exige sessão, tenant e inbox:read", async () => {
      expect((await openEvents()).status).toBe(401);
      const denied = await call("GET", "/api/inbox/events", { cookie: as("noInbox") });
      expect(denied.status).toBe(403);
      expect((await denied.json()).code).toBe("PERMISSION_DENIED");

      const allowed = await openEvents(as("memberA"));
      expect(allowed.status).toBe(200);
      await allowed.waitFor((message) => message.event === "ready");
    });
  });

  describe("filtro por pessoa", () => {
    it("membro A não recebe evento de conversa do membro B; entrar e sair da fila chega a quem deve", async () => {
      const b = await seedConversation(scope(), channelId, { assignedUserId: users.memberB?.id });
      const q = await seedConversation(scope(), channelId);
      const x = await seedConversation(tenantScope(otherTenantId), otherChannelId);

      const streamA = await openEvents(as("memberA"));
      const streamB = await openEvents(as("memberB"));
      const streamOwner = await openEvents(as("owner"));
      await Promise.all([streamA, streamB, streamOwner].map((s) => s.waitFor((m) => m.event === "ready")));

      // 1) Conversa de B muda de situação: só B e o owner (supervise) recebem.
      const status = await call("POST", `/api/inbox/conversations/${b.id}/status`, {
        cookie: as("memberB"),
        body: { status: "pending" },
      });
      expect(status.status).toBe(200);
      await streamB.waitFor(about(b.id));
      await streamOwner.waitFor(about(b.id));

      // 2) B assume a da fila: sai da fila de A (A recebe), entra nas de B.
      expect((await call("POST", `/api/inbox/conversations/${q.id}/claim`, { cookie: as("memberB") })).status).toBe(200);
      const claimed = inbox(await streamA.waitFor(about(q.id)));
      expect(claimed).toMatchObject({ c: q.id, k: "conversation", a: users.memberB?.id, p: null, u: users.memberB?.id });
      await streamB.waitFor(about(q.id));

      // 3) Mexer na conversa, agora de B, não chega mais a A.
      expect(
        (await call("POST", `/api/inbox/conversations/${q.id}/status`, { cookie: as("memberB"), body: { status: "pending" } }))
          .status,
      ).toBe(200);
      await until(() => streamB.messages.filter(about(q.id)).length >= 2);

      // 4) B devolve à fila: entra de volta na fila de A.
      expect(
        (await call("POST", `/api/inbox/conversations/${q.id}/assign`, { cookie: as("memberB"), body: { userId: null } }))
          .status,
      ).toBe(200);
      await streamA.waitFor((m) => inbox(m)?.c === q.id && inbox(m)?.a === null);

      // A recebeu só a saída e a volta da fila; nada da conversa de B nem do passo 3.
      expect(streamA.messages.filter(about(b.id))).toHaveLength(0);
      expect(streamA.messages.filter(about(q.id))).toHaveLength(2);
      // Outro tenant nunca chega, nem ao owner.
      for (const stream of [streamA, streamB, streamOwner]) {
        expect(stream.messages.filter(about(x.id))).toHaveLength(0);
      }
    });

    it("status de entrega sem dono informado: o servidor completa o dono e A não recebe o de B", async () => {
      const b = await seedConversation(scope(), channelId, { assignedUserId: users.memberB?.id });
      const sent = await seedMessage(scope(), { conversationId: b.id, channelId }, { direction: "out", status: "sent" });
      const providerMessageId = `wamid.${randomUUID()}`;
      await owner.begin(async (tx) => {
        await tx`select set_config('app.bypass_tenant', 'on', true)`;
        await tx`update message set provider_message_id = ${providerMessageId} where id = ${sent.id}`;
      });

      const streamA = await openEvents(as("memberA"));
      const streamB = await openEvents(as("memberB"));
      await Promise.all([streamA, streamB].map((s) => s.waitFor((m) => m.event === "ready")));

      await withScope(scope(), async (tx) => {
        const [target] = await tx.select().from(channel).where(eq(channel.id, channelId));
        if (!target) throw new Error("canal");
        expect(
          await ingestStatus(tx, scope(), target, {
            type: "status",
            providerMessageId,
            status: "delivered",
            occurredAt: new Date(),
            error: null,
            recipientPhone: null,
          }),
        ).toBe(true);
      });

      const received = inbox(await streamB.waitFor(about(b.id)));
      expect(received).toMatchObject({ k: "status", m: sent.id, a: users.memberB?.id });
      // A fila de A segue viva: um aviso dela chega, e o de B não chegou antes dele.
      const q = await seedConversation(scope(), channelId);
      await call("POST", `/api/inbox/conversations/${q.id}/claim`, { cookie: as("owner") });
      await streamA.waitFor(about(q.id));
      expect(streamA.messages.filter(about(b.id))).toHaveLength(0);
    });
  });

  describe("JOBS_MODE=worker: o aviso atravessa processos", () => {
    it("ingestão em outro processo chega ao SSE deste, com a carga só de ids", async () => {
      const streamA = await openEvents(as("memberA"));
      await streamA.waitFor((m) => m.event === "ready");

      const phone = randomMobile();
      const secret = `texto sigiloso ${randomUUID()}`;
      await promisify(execFile)(process.execPath, [tsxCli, "--tsconfig", "tsconfig.app.json", workerScript], {
        env: {
          ...process.env,
          JOBS_MODE: "worker",
          REALTIME_TEST_TENANT: tenantId,
          REALTIME_TEST_CHANNEL: channelId,
          REALTIME_TEST_PHONE: phone,
          REALTIME_TEST_TEXT: secret,
          REALTIME_TEST_ID: `wamid.${randomUUID()}`,
        },
        timeout: 60_000,
      });

      const event = inbox(await streamA.waitFor((m) => inbox(m)?.k === "message", 10_000));
      expect(event).toMatchObject({ k: "message", a: null });
      expect(Object.keys(event ?? {}).sort()).toEqual(["a", "c", "k", "m"]);

      // A carga crua (o que o Postgres transmitiu) não leva texto, telefone nem nome.
      await until(() => raw.some((payload) => payload.includes(String(event?.c))));
      for (const payload of raw) {
        expect(payload).not.toContain(secret);
        expect(payload).not.toContain(phone.slice(-8));
        expect(payload).not.toContain("Contato do Worker");
        expect(Object.keys(JSON.parse(payload)).every((key) => "sckmapu".includes(key))).toBe(true);
      }
      // O evento SSE também não traz o escopo.
      expect(streamA.messages.some((m) => m.data.includes(tenantId))).toBe(false);

      // A tela relê pela API, que aplica a visibilidade: a mensagem está lá.
      const messages = await call("GET", `/api/inbox/conversations/${event?.c}/messages`, { cookie: as("memberA") });
      expect(((await messages.json()).items as { text: string }[])[0]?.text).toBe(secret);
    }, 90_000);
  });

  describe("conexão", () => {
    it("batimento periódico em comentário SSE", async () => {
      setInboxEventTimingForTests({ heartbeatMs: 50 });
      const stream = await openEvents(as("memberA"));
      await until(() => stream.pings >= 2, 3_000);
    });

    it(`limite de ${SSE_MAX_STREAMS_PER_USER} fluxos por pessoa; ao fechar um, abre de novo`, async () => {
      const streams = [];
      for (let i = 0; i < SSE_MAX_STREAMS_PER_USER; i++) streams.push(await openEvents(as("memberA")));
      expect(streams.every((s) => s.status === 200)).toBe(true);

      const fourth = await call("GET", "/api/inbox/events", { cookie: as("memberA") });
      expect(fourth.status).toBe(429);
      expect((await fourth.json()).code).toBe("TOO_MANY_STREAMS");
      // Outra pessoa não é afetada.
      expect((await openEvents(as("memberB"))).status).toBe(200);

      await streams[0]?.close();
      await until(() => openInboxStreams(users.memberA?.id as string) < SSE_MAX_STREAMS_PER_USER);
      expect((await openEvents(as("memberA"))).status).toBe(200);
    });

    it("reautenticação periódica: o servidor encerra o fluxo e a reconexão passa pela sessão de novo", async () => {
      setInboxEventTimingForTests({ lifetimeMs: 300 });
      const user = await createUser(owner);
      await addMember(owner, tenantId, user, "member");

      const stream = await openEvents(user.cookie);
      expect(stream.status).toBe(200);
      await stream.ended;
      expect(stream.isEnded()).toBe(true);
      await until(() => openInboxStreams(user.id) === 0);

      // Sessão revogada enquanto o fluxo estava aberto: a reconexão é recusada.
      await owner`delete from session where user_id = ${user.id}`;
      expect((await openEvents(user.cookie)).status).toBe(401);
    });

    it("queda da conexão LISTEN encerra o fluxo, responde 503 (polling) e volta", async () => {
      const stream = await openEvents(as("memberA"));
      await stream.waitFor((m) => m.event === "ready");

      await dropRealtimeConnectionForTests();
      await stream.ended;
      expect(realtimeAvailable()).toBe(false);

      const down = await call("GET", "/api/inbox/events", { cookie: as("memberA") });
      expect(down.status).toBe(503);
      expect((await down.json()).code).toBe("REALTIME_UNAVAILABLE");

      await until(() => realtimeAvailable(), 15_000);
      const again = await openEvents(as("memberA"));
      expect(again.status).toBe(200);
      await again.waitFor((m) => m.event === "ready");

      const q = await seedConversation(scope(), channelId);
      await call("POST", `/api/inbox/conversations/${q.id}/claim`, { cookie: as("memberB") });
      await again.waitFor(about(q.id));
    }, 30_000);
  });
});
