import { describe, expect, it } from "vitest";
import { transferEntry } from "@/components/inbox/transfer-entry";
import type { TransferOption, TransferRefusal } from "@/lib/inbox/transfer";

const option = (name: string, reason: TransferRefusal | null = null): TransferOption => ({
  channel: { id: name, name, type: reason === "window_closed" ? "whatsapp_cloud" : "whatsapp_qr" },
  eligible: reason === null,
  reason,
});

describe("transferEntry", () => {
  it("sem resposta do servidor ou sem outro número: não aparece", () => {
    expect(transferEntry(undefined)).toEqual({ kind: "hidden" });
    expect(transferEntry([])).toEqual({ kind: "hidden" });
  });

  it("com um número elegível: aparece, mesmo com outros recusados", () => {
    expect(transferEntry([option("Oficial", "window_closed"), option("Vendas")])).toEqual({
      kind: "enabled",
    });
  });

  it("só número oficial com a janela fechada: desabilitada, apontando o modelo", () => {
    const entry = transferEntry([option("Caído", "disconnected"), option("Oficial", "window_closed")]);

    expect(entry.kind).toBe("disabled");
    expect(entry).toMatchObject({ reason: expect.stringContaining("Oficial") });
    expect(entry).toMatchObject({ reason: expect.stringContaining("modelo aprovado") });
  });

  it("só número desconectado ou de outro atendente: não aparece", () => {
    expect(transferEntry([option("Caído", "disconnected"), option("Ocupado", "assigned_to_other")])).toEqual({
      kind: "hidden",
    });
  });
});
