import { describe, expect, it } from "vitest";
import { refetchIntervalFor } from "@/components/inbox/inbox-api";
import {
  assignedToMeByOther,
  changeOf,
  connectInboxEvents,
  type EventSourceLike,
  type InboxEventData,
  parseInboxEvent,
} from "@/components/inbox/use-inbox-events";

type Listener = (event: { data?: unknown }) => void;

class FakeSource implements EventSourceLike {
  listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
  close() {
    this.closed = true;
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  const modes: string[] = [];
  const events: InboxEventData[] = [];
  let resyncs = 0;

  const connection = connectInboxEvents({
    createSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.push({ fn, ms, id });
        return id;
      },
      clearTimeout: (id) => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index >= 0) timers.splice(index, 1);
      },
    },
    random: () => 0,
    onMode: (mode) => modes.push(mode),
    onEvent: (event) => events.push(event),
    onResync: () => {
      resyncs += 1;
    },
  });

  const runNextTimer = () => {
    const timer = timers.shift();
    if (!timer) throw new Error("nenhum timer");
    timer.fn();
    return timer.ms;
  };

  return {
    connection,
    sources,
    timers,
    modes,
    events,
    resyncs: () => resyncs,
    runNextTimer,
    last: () => sources[sources.length - 1] as FakeSource,
  };
}

describe("connectInboxEvents", () => {
  it("abre /api/inbox/events, fica ao vivo e entrega os eventos lidos", () => {
    const h = harness();
    expect(h.last().url).toBe("/api/inbox/events");

    h.last().emit("open");
    expect(h.modes).toEqual(["live"]);

    h.last().emit("inbox", JSON.stringify({ c: "c1", k: "message", m: "m1", a: null }));
    h.last().emit("inbox", "não é json");
    h.last().emit("inbox", JSON.stringify({ k: "message" }));
    expect(h.events).toEqual([{ c: "c1", k: "message", m: "m1", a: null }]);
    // Relê tudo ao abrir: o que mudou entre a carga da tela e a assinatura não vem em evento.
    expect(h.resyncs()).toBe(1);
  });

  it("falha ao abrir (503, 429): modo polling e novas tentativas com espera crescente até 60 s", () => {
    const h = harness();
    h.last().emit("error");
    expect(h.last().closed).toBe(true);
    expect(h.modes).toEqual(["polling"]);

    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(h.runNextTimer());
      h.last().emit("error");
    }
    expect(delays).toEqual([2_000, 5_000, 10_000, 30_000, 60_000, 60_000]);

    // Voltou: ao vivo de novo, e relê o que o polling pode não ter pego.
    h.runNextTimer();
    h.last().emit("open");
    expect(h.modes[h.modes.length - 1]).toBe("live");
    expect(h.resyncs()).toBe(1);
  });

  it("fluxo encerrado pelo servidor (15 min): reconecta em 1 s, sem polling, e relê a lista", () => {
    const h = harness();
    h.last().emit("open");
    h.last().emit("error");
    expect(h.modes).toEqual(["live"]);
    expect(h.runNextTimer()).toBe(1_000);

    h.last().emit("open");
    expect(h.resyncs()).toBe(2);
    expect(h.sources).toHaveLength(2);
  });

  it("queda da escuta: a reconexão recusada (503) cai em polling; a volta relê", () => {
    const h = harness();
    h.last().emit("open");
    h.last().emit("error");
    h.runNextTimer();
    h.last().emit("error");
    expect(h.modes).toEqual(["live", "polling"]);

    h.runNextTimer();
    h.last().emit("open");
    expect(h.modes).toEqual(["live", "polling", "live"]);
    expect(h.resyncs()).toBe(2);
  });

  it("tentativa sem resposta em 10 s conta como falha: polling em vez de ficar ao vivo parado", () => {
    const h = harness();
    h.last().emit("open");
    h.last().emit("error");
    h.runNextTimer();
    // A reconexão não abre nem falha: o prazo de abertura dispara.
    const stalled = h.last();
    expect(h.runNextTimer()).toBe(10_000);
    expect(stalled.closed).toBe(true);
    expect(h.modes).toEqual(["live", "polling"]);
    // E a próxima tentativa segue o backoff.
    expect(h.timers.map((timer) => timer.ms)).toEqual([2_000]);
  });

  it("retryNow tenta já quando está fora; close encerra e não reconecta", () => {
    const h = harness();
    h.last().emit("error");
    h.connection.retryNow();
    expect(h.timers.map((timer) => timer.ms)).toEqual([0]);

    h.runNextTimer();
    const source = h.last();
    h.connection.close();
    expect(source.closed).toBe(true);
    source.emit("error");
    expect(h.timers).toHaveLength(0);
    expect(h.sources).toHaveLength(2);
  });
});

describe("parseInboxEvent e toast", () => {
  it("só aceita a forma do evento", () => {
    expect(parseInboxEvent(JSON.stringify({ c: "c", k: "status" }))).toEqual({ c: "c", k: "status" });
    expect(parseInboxEvent(JSON.stringify({ c: "c", k: "outro" }))).toBeNull();
    expect(parseInboxEvent(42)).toBeNull();
    expect(parseInboxEvent("null")).toBeNull();
  });

  it("avisa só a atribuição feita por outra pessoa", () => {
    const base = { c: "c", k: "conversation" as const };
    expect(assignedToMeByOther({ ...base, a: "eu", p: null, u: "chefe" }, "eu")).toBe(true);
    expect(assignedToMeByOther({ ...base, a: "eu", p: "outro", u: "chefe" }, "eu")).toBe(true);
    // Eu assumi, eu respondi, eu iniciei.
    expect(assignedToMeByOther({ ...base, a: "eu", p: null, u: "eu" }, "eu")).toBe(false);
    // Já era minha (situação, lida) ou mensagem nova.
    expect(assignedToMeByOther({ ...base, a: "eu" }, "eu")).toBe(false);
    expect(assignedToMeByOther({ ...base, a: "eu", p: "eu", u: "chefe" }, "eu")).toBe(false);
    expect(assignedToMeByOther({ c: "c", k: "message", a: "eu", p: null, u: "chefe" }, "eu")).toBe(false);
    // Foi para outro.
    expect(assignedToMeByOther({ ...base, a: "outro", p: null, u: "chefe" }, "eu")).toBe(false);
  });
});

describe("changeOf", () => {
  it("status só relê mensagens; conversa, lista e detalhe; mensagem, tudo", () => {
    expect(changeOf("status")).toEqual({ lists: false, detail: false, messages: true });
    expect(changeOf("conversation")).toEqual({ lists: true, detail: true, messages: false });
    expect(changeOf("message")).toEqual({ lists: true, detail: true, messages: true });
  });
});

describe("refetchIntervalFor", () => {
  it("ao vivo: lista a cada 60 s e conversa só pelos eventos; fora dele, 20 s em tudo", () => {
    expect(refetchIntervalFor("live", "list")).toBe(60_000);
    expect(refetchIntervalFor("live", "detail")).toBe(false);
    expect(refetchIntervalFor("polling", "detail")).toBe(20_000);
    expect(refetchIntervalFor("connecting", "list")).toBe(20_000);
  });
});
