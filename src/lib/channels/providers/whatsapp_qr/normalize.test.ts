import { describe, expect, it } from "vitest";
import {
  eventKindOf,
  isEncryptedWhatsappUrl,
  normalizeEventName,
  normalizeEvolutionEvents,
  parseJid,
} from "@/lib/channels/providers/whatsapp_qr/normalize";
import { fixture } from "@/lib/channels/test-fixtures";
import type {
  NormalizedConnection,
  NormalizedMessage,
  NormalizedStatus,
} from "@/lib/channels/types";

const NOW = new Date("2026-11-02T00:00:00Z");
const normalize = (name: string) => normalizeEvolutionEvents(fixture(`evolution/${name}`), NOW);
const only = <T>(events: unknown[]) => {
  expect(events).toHaveLength(1);
  return events[0] as T;
};

describe("nomes de evento", () => {
  it("a grafia do evento não importa: SendMessage, SEND_MESSAGE e send message", () => {
    expect(normalizeEventName("SEND_MESSAGE")).toBe("SENDMESSAGE");
    expect(normalizeEventName("SendMessage")).toBe("SENDMESSAGE");
    expect(normalizeEventName("send message")).toBe("SENDMESSAGE");
  });

  it.each([
    ["Message", "message"],
    ["SendMessage", "send_message"],
    ["Receipt", "receipt"],
    ["READ_RECEIPT", "receipt"],
    ["Connected", "connection"],
    ["LoggedOut", "connection"],
    ["PairSuccess", "connection"],
    ["QRCode", "qrcode"],
  ])("%s → %s", (event, kind) => {
    expect(eventKindOf({ event })).toBe(kind);
  });

  it("evento desconhecido não tem tipo", () => {
    expect(eventKindOf({ event: "HistorySync" })).toBeNull();
    expect(eventKindOf({})).toBeNull();
  });
});

describe("parseJid", () => {
  it.each([
    ["5511988880001@s.whatsapp.net", { phone: "5511988880001", lid: null }],
    ["5511988880001:12@s.whatsapp.net", { phone: "5511988880001", lid: null }],
    ["226559659127039@lid", { phone: null, lid: "226559659127039@lid" }],
    ["226559659127039:11@lid", { phone: null, lid: "226559659127039@lid" }],
    ["120363000000000001@g.us", { phone: null, lid: null }],
    ["status@broadcast", { phone: null, lid: null }],
    ["", { phone: null, lid: null }],
    [null, { phone: null, lid: null }],
  ])("%s", (jid, expected) => {
    expect(parseJid(jid)).toEqual(expected);
  });
});

describe("mensagens recebidas", () => {
  it("texto: telefone sem sufixo, nome, id e hora do provedor", () => {
    const message = only<NormalizedMessage>(normalize("message-text"));

    expect(message).toMatchObject({
      type: "message",
      fromPhone: "5511988880001",
      fromExternalId: null,
      pushName: "Cliente Teste",
      providerMessageId: "3EB0AAAA0001",
      fromMe: false,
      messageType: "text",
      text: "Oi, tudo bem?",
      media: null,
    });
    expect(message.occurredAt).toEqual(new Date("2026-11-02T10:00:00-03:00"));
  });

  it("texto estendido com citação", () => {
    expect(only<NormalizedMessage>(normalize("message-extended-text"))).toMatchObject({
      text: "Respondendo você",
      replyToProviderMessageId: "3EB0OUT00001",
    });
  });

  it("remetente por LID: sem telefone, com o LID canônico (sem sufixo de dispositivo)", () => {
    expect(only<NormalizedMessage>(normalize("message-lid"))).toMatchObject({
      fromPhone: null,
      fromExternalId: "226559659127039@lid",
      text: "Mensagem por LID",
    });
  });

  it("áudio: o base64 é irmão do proto; a URL cifrada do CDN não vira fonte", () => {
    const message = only<NormalizedMessage>(normalize("message-audio-base64"));

    expect(message.messageType).toBe("audio");
    expect(message.media).toEqual({
      kind: "audio",
      mime: "audio/ogg; codecs=opus",
      filename: null,
      base64: "T2dnUwACAAAAAAAAAAA=",
    });
  });

  it("imagem com legenda e base64", () => {
    expect(only<NormalizedMessage>(normalize("message-image-base64-caption"))).toMatchObject({
      messageType: "image",
      text: "Olha isso",
      media: { kind: "image", mime: "image/jpeg", base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/" },
    });
  });

  it("mediaUrl em claro (S3) é guardado como candidata; a verificação de origem é do job", () => {
    const { media } = only<NormalizedMessage>(normalize("message-image-mediaurl"));

    expect(media?.mediaUrl).toContain("s3.exemplo.test");
    expect(media?.base64).toBeUndefined();
  });

  it("só URL cifrada do CDN: a mensagem entra sem mídia (não vira player mudo)", () => {
    expect(only<NormalizedMessage>(normalize("message-image-encrypted-only"))).toMatchObject({
      messageType: "image",
      text: "sem conteúdo utilizável",
      media: { kind: "image", mime: "image/jpeg" },
    });
    const { media } = only<NormalizedMessage>(normalize("message-image-encrypted-only"));
    expect(media).not.toHaveProperty("base64");
    expect(media).not.toHaveProperty("mediaUrl");
  });

  it("documento com nome e localização", () => {
    expect(only<NormalizedMessage>(normalize("message-document")).media).toMatchObject({
      kind: "document",
      filename: "proposta.pdf",
      mime: "application/pdf",
    });
    expect(only<NormalizedMessage>(normalize("message-location"))).toMatchObject({
      messageType: "location",
      text: "Casa - -23.55,-46.63",
    });
  });

  it("grupo, revogação, reação e proto desconhecido são descartados (nada de bolha vazia)", () => {
    for (const name of ["message-group", "message-revoke", "message-reaction", "message-unknown-proto"]) {
      expect(normalize(name), name).toEqual([]);
    }
  });

  it("aviso sem Info ou sem ID é descartado", () => {
    expect(normalizeEvolutionEvents({ event: "Message", data: {} }, NOW)).toEqual([]);
    expect(
      normalizeEvolutionEvents({ event: "Message", data: { Info: { Chat: "5511988880001@s.whatsapp.net" } } }, NOW),
    ).toEqual([]);
  });

  it("sem hora do provedor, usa o `now` injetado", () => {
    const raw = fixture<{ data: { Info: Record<string, unknown> } }>("evolution/message-text");
    delete raw.data.Info.Timestamp;

    expect(only<NormalizedMessage>(normalizeEvolutionEvents(raw, NOW)).occurredAt).toEqual(NOW);
  });
});

describe("eco do celular (SendMessage)", () => {
  it("fromMe, com o contato em Chat (nunca o nosso próprio número)", () => {
    expect(only<NormalizedMessage>(normalize("send-message-echo"))).toMatchObject({
      fromMe: true,
      fromPhone: "5511988880001",
      providerMessageId: "3EB0OUT00002",
      text: "Enviado pelo celular",
    });
  });

  it("no eco, sem Chat, não cai em Sender (que é o número do dono)", () => {
    const raw = fixture<{ data: { Info: Record<string, unknown> } }>("evolution/send-message-echo");
    delete raw.data.Info.Chat;

    expect(normalizeEvolutionEvents(raw, NOW)).toEqual([]);
  });
});

describe("recibos", () => {
  it("o estado vem em `state` no envelope: Delivered com vários ids vira um status por id", () => {
    const events = normalize("receipt-delivered") as NormalizedStatus[];

    expect(events.map((event) => [event.providerMessageId, event.status])).toEqual([
      ["3EB0OUT00001", "delivered"],
      ["3EB0OUT00002", "delivered"],
    ]);
    expect(events[0]).toMatchObject({
      recipientPhone: "5511988880001",
      error: null,
      occurredAt: new Date("2026-11-02T10:01:00-03:00"),
    });
  });

  it("Read e ReadSelf viram read", () => {
    expect(only<NormalizedStatus>(normalize("receipt-read")).status).toBe("read");
    expect(only<NormalizedStatus>(normalize("receipt-readself")).status).toBe("read");
  });

  it("estado que não conhecemos (Played) é descartado", () => {
    expect(normalize("receipt-played")).toEqual([]);
  });
});

describe("conexão: o nome do evento carrega o estado", () => {
  it("Connected → connected, com o telefone do JID sem sufixo de dispositivo", () => {
    expect(only<NormalizedConnection>(normalize("connected"))).toMatchObject({
      type: "connection",
      status: "connected",
      phone: "5511999990001",
      jid: "5511999990001:12@s.whatsapp.net",
    });
  });

  it("PairSuccess → connected, com o telefone", () => {
    expect(only<NormalizedConnection>(normalize("pair-success"))).toMatchObject({
      status: "connected",
      phone: "5511999990001",
    });
  });

  it("LoggedOut → disconnected, com o motivo em português (o estado não vem de booleano)", () => {
    expect(only<NormalizedConnection>(normalize("logged-out"))).toMatchObject({
      status: "disconnected",
      detail: "Desconectado no celular.",
      phone: null,
    });
  });

  it("família genérica CONNECTION usa o status do corpo", () => {
    expect(only<NormalizedConnection>(normalize("connection-generic-open")).status).toBe("connected");
    expect(
      only<NormalizedConnection>(
        normalizeEvolutionEvents({ event: "CONNECTION", data: { status: "close" } }, NOW),
      ).status,
    ).toBe("disconnected");
    expect(
      only<NormalizedConnection>(
        normalizeEvolutionEvents({ event: "CONNECTION", data: { Connected: true, LoggedIn: false } }, NOW),
      ).status,
    ).toBe("connecting");
  });

  it("QR e evento desconhecido não geram evento (o QR nunca é gravado)", () => {
    expect(normalize("qrcode")).toEqual([]);
    expect(normalize("unknown-event")).toEqual([]);
  });

  it.each([null, undefined, 1, "x", [], {}])("entrada malformada (%j) devolve vazio", (raw) => {
    expect(normalizeEvolutionEvents(raw, NOW)).toEqual([]);
  });
});

describe("isEncryptedWhatsappUrl", () => {
  it.each([
    ["https://mmg.whatsapp.net/v/t62/x.enc?ccb=1", true],
    ["https://media.whatsapp.net/x", true],
    ["https://s3.exemplo.test/x.jpg", false],
    ["https://s3.exemplo.test/x.enc", true],
    ["não é url", false],
  ])("%s = %s", (url, expected) => {
    expect(isEncryptedWhatsappUrl(url)).toBe(expected);
  });
});
