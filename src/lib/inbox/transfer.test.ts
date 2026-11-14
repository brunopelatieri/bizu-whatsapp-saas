import { describe, expect, it } from "vitest";
import {
  eligibleTransferChannels,
  type TransferChannel,
  type TransferDestination,
} from "@/lib/inbox/transfer";

const NOW = new Date("2026-11-14T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const channel = (id: string, overrides: Partial<TransferChannel> = {}): TransferChannel => ({
  id,
  tenantId: "t1",
  name: `Número ${id}`,
  type: "whatsapp_qr",
  status: "connected",
  ...overrides,
});

const options = (
  channels: TransferChannel[],
  destinations: Record<string, TransferDestination> = {},
  scopeTenantId: string | null = "t1",
) =>
  eligibleTransferChannels({
    scopeTenantId,
    currentChannelId: "atual",
    channels,
    destinations: new Map(Object.entries(destinations)),
    now: NOW,
  });

describe("eligibleTransferChannels", () => {
  it("oferece o outro número conectado e nunca o da conversa atual", () => {
    const result = options([channel("atual"), channel("qr")]);

    expect(result).toEqual([
      { channel: { id: "qr", name: "Número qr", type: "whatsapp_qr" }, eligible: true, reason: null },
    ]);
  });

  it("deixa de fora o número de outro escopo e o desativado, sem motivo", () => {
    const result = options([
      channel("alheio", { tenantId: "t2" }),
      channel("plataforma", { tenantId: null }),
      channel("desativado", { status: "disabled" }),
    ]);

    expect(result).toEqual([]);
  });

  it("na plataforma só valem os números sem tenant", () => {
    const result = options([channel("p", { tenantId: null }), channel("t")], {}, null);

    expect(result.map((option) => option.channel.id)).toEqual(["p"]);
  });

  it.each(["disconnected", "connecting", "error"] as const)(
    "número %s aparece recusado como desconectado",
    (status) => {
      const [option] = options([channel("caido", { status })]);

      expect(option).toMatchObject({ eligible: false, reason: "disconnected" });
    },
  );

  it("número sem janela (QR) serve com ou sem conversa do contato por lá", () => {
    const result = options([channel("novo"), channel("antigo")], {
      antigo: { visible: true, lastInboundAt: hoursAgo(72) },
    });

    expect(result.map((option) => option.eligible)).toEqual([true, true]);
  });

  it("número oficial sem conversa do contato: janela fechada (só modelo começa)", () => {
    const [option] = options([channel("cloud", { type: "whatsapp_cloud" })]);

    expect(option).toMatchObject({ eligible: false, reason: "window_closed" });
  });

  it("número oficial: vale a janela daquela conversa de destino", () => {
    const cloud = [channel("cloud", { type: "whatsapp_cloud" })];

    expect(options(cloud, { cloud: { visible: true, lastInboundAt: hoursAgo(23) } })[0]).toMatchObject({
      eligible: true,
      reason: null,
    });
    expect(options(cloud, { cloud: { visible: true, lastInboundAt: hoursAgo(25) } })[0]).toMatchObject({
      eligible: false,
      reason: "window_closed",
    });
    expect(options(cloud, { cloud: { visible: true, lastInboundAt: null } })[0]).toMatchObject({
      eligible: false,
      reason: "window_closed",
    });
  });

  it("conversa de destino fora do alcance: recusa sem dizer nada da janela", () => {
    const result = options(
      [channel("cloud", { type: "whatsapp_cloud" }), channel("qr")],
      {
        cloud: { visible: false, lastInboundAt: hoursAgo(1) },
        qr: { visible: false, lastInboundAt: null },
      },
    );

    expect(result.map((option) => option.reason)).toEqual(["assigned_to_other", "assigned_to_other"]);
  });

  it("número desconectado vem antes de qualquer fato da conversa de destino", () => {
    const [option] = options([channel("caido", { status: "disconnected" })], {
      caido: { visible: false, lastInboundAt: hoursAgo(1) },
    });

    expect(option?.reason).toBe("disconnected");
  });

  it("mantém a ordem recebida e não devolve estado nem tenant do número", () => {
    const result = options([channel("b"), channel("a", { status: "error" })]);

    expect(result.map((option) => option.channel.id)).toEqual(["b", "a"]);
    expect(Object.keys(result[0]?.channel ?? {}).sort()).toEqual(["id", "name", "type"]);
  });
});
