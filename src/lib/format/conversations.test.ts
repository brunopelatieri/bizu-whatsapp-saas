import { describe, expect, it } from "vitest";
import { accountRecordsWarning, conversationsLabel } from "@/lib/format/conversations";

describe("avisos de exclusão com conversas", () => {
  it("conta no singular e no plural", () => {
    expect(conversationsLabel(1)).toBe("1 conversa");
    expect(conversationsLabel(0)).toBe("0 conversas");
    expect(conversationsLabel(3)).toBe("3 conversas");
  });

  it("não avisa quando não há ficha ligada", () => {
    expect(accountRecordsWarning(undefined)).toBeNull();
    expect(accountRecordsWarning({ customers: 0, conversationCount: 0 })).toBeNull();
  });

  it("avisa a ficha, a contagem e que a equipe pode desfazer a ligação", () => {
    expect(accountRecordsWarning({ customers: 1, conversationCount: 2 })).toMatch(
      /uma organização: a ficha de cliente ligada a você e 2 conversas de WhatsApp do seu número serão apagadas, sem volta/,
    );
    expect(accountRecordsWarning({ customers: 1, conversationCount: 0 })).toMatch(/ligada a você será apagada, sem volta/);
    const many = accountRecordsWarning({ customers: 3, conversationCount: 0 });
    expect(many).toMatch(/3 organizações: as fichas de cliente ligadas a você serão apagadas/);
    expect(many).not.toMatch(/conversa/);
    expect(many).toMatch(/desfazer a ligação/);
  });
});
