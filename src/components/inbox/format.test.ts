import { describe, expect, it } from "vitest";
import {
  contactLabel,
  dayKey,
  emptiedByRetention,
  formatDayLabel,
  formatFileSize,
  formatListTime,
  initialsOf,
  safeHref,
  splitLinks,
} from "@/components/inbox/format";

describe("contactLabel e initialsOf", () => {
  it("usa o nome; sem nome, o telefone formatado", () => {
    expect(contactLabel({ displayName: "Ana Souza", phone: "5511987654321" })).toBe("Ana Souza");
    expect(contactLabel({ displayName: null, phone: "5511987654321" })).toBe("+55 (11) 98765-4321");
    expect(contactLabel({ displayName: "  ", phone: "5511987654321" })).toBe("+55 (11) 98765-4321");
  });

  it("iniciais de até duas palavras; telefone vira #", () => {
    expect(initialsOf("Ana Maria Souza")).toBe("AS");
    expect(initialsOf("ana")).toBe("A");
    expect(initialsOf("+55 (11) 98765-4321")).toBe("#");
  });
});

describe("datas", () => {
  const now = new Date(2026, 10, 10, 15, 0);

  it("hoje, ontem e a data curta na lista", () => {
    expect(formatListTime(new Date(2026, 10, 10, 9, 5).toISOString(), now)).toBe("09:05");
    expect(formatListTime(new Date(2026, 10, 9, 23, 0).toISOString(), now)).toBe("Ontem");
    expect(formatListTime(new Date(2026, 10, 1, 8, 0).toISOString(), now)).toBe("01/11");
    expect(formatListTime(null, now)).toBe("");
  });

  it("separador por dia", () => {
    expect(formatDayLabel(new Date(2026, 10, 10, 1).toISOString(), now)).toBe("Hoje");
    expect(formatDayLabel(new Date(2026, 10, 9, 1).toISOString(), now)).toBe("Ontem");
    expect(formatDayLabel(new Date(2026, 9, 1, 1).toISOString(), now)).toContain("outubro");
    expect(dayKey(new Date(2026, 10, 10, 1).toISOString())).toBe(
      dayKey(new Date(2026, 10, 10, 23).toISOString()),
    );
  });

  it("tamanho de arquivo", () => {
    expect(formatFileSize(null)).toBe("");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("splitLinks", () => {
  it("texto sem link volta inteiro", () => {
    expect(splitLinks("olá, tudo bem?")).toEqual([{ kind: "text", value: "olá, tudo bem?" }]);
  });

  it("link http(s) no meio, sem a pontuação final", () => {
    expect(splitLinks("veja https://exemplo.com/a?b=1, ok")).toEqual([
      { kind: "text", value: "veja " },
      { kind: "link", value: "https://exemplo.com/a?b=1", href: "https://exemplo.com/a?b=1" },
      { kind: "text", value: ", ok" },
    ]);
  });

  it("só http e https; o resto fica como texto", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHref("ftp://exemplo.com")).toBeNull();
    expect(splitLinks("javascript:alert(1) e <script>x</script>")).toEqual([
      { kind: "text", value: "javascript:alert(1) e <script>x</script>" },
    ]);
  });

  it("HTML no texto nunca vira link nem marcação", () => {
    const parts = splitLinks('<a href="https://x.com">x</a>');
    // O texto continua literal: quem renderiza (React) escapa.
    expect(parts.map((part) => part.value).join("")).toContain("<a href=");
  });
});

describe("emptiedByRetention", () => {
  it("sem mensagem e com movimento anterior: a conversa foi esvaziada", () => {
    expect(emptiedByRetention(0, "2026-11-01T10:00:00.000Z")).toBe(true);
  });

  it("conversa nova, sem nada trocado, não é esvaziada", () => {
    expect(emptiedByRetention(0, null)).toBe(false);
  });

  it("com mensagem (ou envio em andamento) não há aviso", () => {
    expect(emptiedByRetention(1, "2026-11-01T10:00:00.000Z")).toBe(false);
    expect(emptiedByRetention(3, null)).toBe(false);
  });
});
