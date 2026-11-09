import { describe, expect, it } from "vitest";
import { normalizeCloudEvents } from "@/lib/channels/providers/whatsapp_cloud/normalize";
import { fixture } from "@/lib/channels/test-fixtures";
import type { NormalizedMessage, NormalizedStatus, NormalizedTemplate } from "@/lib/channels/types";

const normalize = (name: string) => normalizeCloudEvents(fixture(`cloud/${name}`));
const only = <T>(events: unknown[]) => {
  expect(events).toHaveLength(1);
  return events[0] as T;
};

describe("mensagens", () => {
  it("texto: telefone, nome do WhatsApp, hora do provedor e número que recebeu", () => {
    const message = only<NormalizedMessage>(normalize("message-text"));

    expect(message).toMatchObject({
      type: "message",
      fromPhone: "5511988880001",
      pushName: "Cliente Teste",
      fromMe: false,
      messageType: "text",
      text: "Olá, quero saber o preço",
      media: null,
      replyToProviderMessageId: null,
      channelPhoneNumberId: "200000000000001",
    });
    expect(message.occurredAt).toEqual(new Date(1793620800 * 1000));
  });

  it.each([
    ["message-image", "image", "Segue o comprovante", "300000000000001", "image/jpeg"],
    ["message-audio", "audio", null, "300000000000002", "audio/ogg; codecs=opus"],
    ["message-document", "document", "contrato.pdf", "300000000000003", "application/pdf"],
    ["message-sticker", "sticker", null, "300000000000004", "image/webp"],
  ])("mídia %s: id da mídia (baixado pelo job) e legenda ou nome do arquivo", (name, kind, text, id, mime) => {
    const message = only<NormalizedMessage>(normalize(name));

    expect(message.messageType).toBe(kind);
    expect(message.text).toBe(text);
    expect(message.media).toMatchObject({ kind, providerMediaId: id, mime });
    // O corpo nunca leva bytes: só a referência.
    expect(message.media).not.toHaveProperty("base64");
  });

  it("localização vira texto legível", () => {
    expect(only<NormalizedMessage>(normalize("message-location"))).toMatchObject({
      messageType: "location",
      text: "Escritório - Av. Exemplo, 100 - -23.55,-46.63",
    });
  });

  it("resposta a botão (interactive e template) usa o título e vira interactive", () => {
    expect(only<NormalizedMessage>(normalize("message-interactive-button"))).toMatchObject({
      messageType: "interactive",
      text: "Sim, quero",
      replyToProviderMessageId: "wamid.OUT0001",
    });
    expect(only<NormalizedMessage>(normalize("message-template-button"))).toMatchObject({
      messageType: "interactive",
      text: "Confirmar",
    });
  });

  it("contato compartilhado e citação", () => {
    expect(only<NormalizedMessage>(normalize("message-contacts"))).toMatchObject({
      messageType: "contacts",
      text: "Fulano de Tal",
    });
    expect(only<NormalizedMessage>(normalize("message-reply"))).toMatchObject({
      text: "Isso mesmo",
      replyToProviderMessageId: "wamid.OUT0002",
    });
  });

  it("tipo que não lemos vira unsupported; reação some (não é mensagem)", () => {
    expect(only<NormalizedMessage>(normalize("message-unsupported"))).toMatchObject({
      messageType: "unsupported",
      text: null,
      media: null,
    });
    expect(normalize("message-reaction")).toEqual([]);
  });

  it("casa o contato pelo wa_id, não pela posição", () => {
    expect(only<NormalizedMessage>(normalize("message-two-contacts")).pushName).toBe("Cliente Teste");
  });
});

describe("status", () => {
  it.each(["sent", "delivered", "read"])("%s: id da mensagem, destinatário e hora", (status) => {
    const event = only<NormalizedStatus>(normalize(`status-${status}`));

    expect(event).toMatchObject({
      type: "status",
      status,
      providerMessageId: "wamid.OUT0001",
      recipientPhone: "5511988880001",
      error: null,
      channelPhoneNumberId: "200000000000001",
    });
    expect(event.occurredAt).toEqual(new Date(1793620860 * 1000));
  });

  it("failed: erro no formato (#código) título: mensagem", () => {
    expect(only<NormalizedStatus>(normalize("status-failed"))).toMatchObject({
      status: "failed",
      error: "(#131047) Re-engagement message: Re-engagement message",
    });
  });

  it("status que não conhecemos (deleted) é descartado", () => {
    expect(normalize("status-deleted")).toEqual([]);
  });
});

describe("modelos e campos desconhecidos", () => {
  it("status do modelo, com WABA e motivo", () => {
    expect(only<NormalizedTemplate>(normalize("template-status-rejected"))).toMatchObject({
      type: "template",
      event: "status",
      providerTemplateId: "400000000000002",
      name: "promo",
      language: "pt_BR",
      templateStatus: "REJECTED",
      reason: "INVALID_FORMAT",
      wabaId: "100000000000001",
    });
    expect(only<NormalizedTemplate>(normalize("template-status-approved")).templateStatus).toBe(
      "APPROVED",
    );
  });

  it("qualidade e componentes viram eventos próprios, sem status", () => {
    expect(only<NormalizedTemplate>(normalize("template-quality"))).toMatchObject({
      event: "quality",
      templateStatus: null,
    });
    expect(only<NormalizedTemplate>(normalize("template-components")).event).toBe("components");
  });

  it("campo novo da Meta não derruba o aviso", () => {
    expect(normalize("unknown-field")).toEqual([]);
  });

  it.each([null, undefined, 42, "texto", [], {}, { entry: "x" }, { entry: [null, { changes: 3 }] }])(
    "entrada malformada (%j) devolve vazio sem lançar",
    (raw) => {
      expect(normalizeCloudEvents(raw)).toEqual([]);
    },
  );
});

describe("vários números no mesmo aplicativo", () => {
  it("cada mudança leva o phone_number_id dela, para o job rotear dentro do escopo", () => {
    const events = normalize("two-numbers-same-waba") as NormalizedMessage[];

    expect(events.map((event) => [event.channelPhoneNumberId, event.fromPhone])).toEqual([
      ["200000000000001", "5511988880001"],
      ["200000000000002", "5511988880003"],
    ]);
  });
});
