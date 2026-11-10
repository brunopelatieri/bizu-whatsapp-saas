import { describe, expect, it } from "vitest";
import { SESSION_WINDOW_MS, sessionWindow } from "@/lib/inbox/window";

describe("sessionWindow", () => {
  const now = new Date("2026-11-10T12:00:00Z");

  it("canal sem janela (QR) está sempre aberto", () => {
    expect(sessionWindow("whatsapp_qr", null, now)).toEqual({
      applies: false,
      open: true,
      expiresAt: null,
    });
  });

  it("Cloud sem mensagem do contato nasce fechada", () => {
    expect(sessionWindow("whatsapp_cloud", null, now)).toMatchObject({ applies: true, open: false });
  });

  it("Cloud aberta até 24 h depois da última mensagem do contato", () => {
    const recent = new Date(now.getTime() - SESSION_WINDOW_MS + 60_000);
    const window = sessionWindow("whatsapp_cloud", recent, now);

    expect(window.open).toBe(true);
    expect(window.expiresAt?.getTime()).toBe(recent.getTime() + SESSION_WINDOW_MS);
  });

  it("Cloud fechada com a última mensagem há 25 horas", () => {
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    expect(sessionWindow("whatsapp_cloud", old, now).open).toBe(false);
  });
});
