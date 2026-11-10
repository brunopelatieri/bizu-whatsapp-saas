import { describe, expect, it } from "vitest";
import {
  analyzeTemplate,
  buildSendComponents,
  renderTemplate,
  variableProblem,
} from "@/lib/inbox/templates";

type Supported = Extract<ReturnType<typeof analyzeTemplate>, { supported: true }>;

const supported = (components: unknown) => {
  const analysis = analyzeTemplate(components);
  if (!analysis.supported) throw new Error(`não suportado: ${analysis.reason}`);
  return analysis as Supported;
};

describe("analyzeTemplate", () => {
  it("corpo com variáveis numeradas, na ordem, sem repetir", () => {
    const analysis = supported([{ type: "BODY", text: "Olá {{1}}, seu pedido {{2}} saiu. Tchau {{1}}." }]);

    expect(analysis.positional).toBe(true);
    expect(analysis.slots).toEqual([
      { component: "body", name: "1" },
      { component: "body", name: "2" },
    ]);
  });

  it("cabeçalho de texto vem antes do corpo", () => {
    const analysis = supported([
      { type: "BODY", text: "Corpo {{1}}" },
      { type: "HEADER", format: "TEXT", text: "Oi {{1}}" },
      { type: "FOOTER", text: "Rodapé" },
    ]);

    expect(analysis.slots.map((slot) => slot.component)).toEqual(["header", "body"]);
    expect(analysis.footer).toBe("Rodapé");
  });

  it("variáveis nomeadas", () => {
    const analysis = supported([{ type: "BODY", text: "Olá {{nome}}, {{ cidade }}" }]);

    expect(analysis.positional).toBe(false);
    expect(analysis.slots.map((slot) => slot.name)).toEqual(["nome", "cidade"]);
  });

  it("botões sem parâmetro valem; com variável ou recurso novo, não", () => {
    expect(
      analyzeTemplate([
        { type: "BODY", text: "Oi" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sim" }, { type: "URL", url: "https://x.com/a" }] },
      ]).supported,
    ).toBe(true);

    expect(
      analyzeTemplate([
        { type: "BODY", text: "Oi" },
        { type: "BUTTONS", buttons: [{ type: "URL", url: "https://x.com/{{1}}" }] },
      ]),
    ).toMatchObject({ supported: false });
    expect(
      analyzeTemplate([{ type: "BODY", text: "Oi" }, { type: "BUTTONS", buttons: [{ type: "FLOW" }] }]),
    ).toMatchObject({ supported: false });
    expect(analyzeTemplate([{ type: "BODY", text: "Oi" }, { type: "CAROUSEL" }])).toMatchObject({
      supported: false,
    });
  });

  it("cabeçalho de mídia, sem corpo, misto e fora de sequência não são suportados", () => {
    expect(
      analyzeTemplate([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Oi" }]),
    ).toMatchObject({ supported: false });
    expect(analyzeTemplate([{ type: "FOOTER", text: "x" }])).toMatchObject({ supported: false });
    expect(analyzeTemplate([{ type: "BODY", text: "{{1}} e {{nome}}" }])).toMatchObject({ supported: false });
    expect(analyzeTemplate([{ type: "BODY", text: "{{1}} e {{3}}" }])).toMatchObject({ supported: false });
    expect(analyzeTemplate("lixo")).toMatchObject({ supported: false });
  });
});

describe("renderTemplate e buildSendComponents", () => {
  const analysis = supported([
    { type: "HEADER", format: "TEXT", text: "Pedido {{1}}" },
    { type: "BODY", text: "Olá {{1}}, tudo bem?" },
    { type: "FOOTER", text: "Equipe" },
  ]);

  it("preenche cabeçalho, corpo e rodapé", () => {
    expect(renderTemplate(analysis, ["123", "Maria"])).toBe("Pedido 123\n\nOlá Maria, tudo bem?\n\nEquipe");
  });

  it("variável ainda vazia aparece como está (a prévia mostra o que falta)", () => {
    expect(renderTemplate(analysis, ["123", ""])).toContain("Olá {{1}}");
  });

  it("monta os components da Meta só com o que leva parâmetro", () => {
    expect(buildSendComponents(analysis, ["123", " Maria "])).toEqual([
      { type: "header", parameters: [{ type: "text", text: "123" }] },
      { type: "body", parameters: [{ type: "text", text: "Maria" }] },
    ]);
    expect(buildSendComponents(supported([{ type: "BODY", text: "Sem variável" }]), [])).toEqual([]);
  });

  it("variáveis nomeadas levam parameter_name", () => {
    const named = supported([{ type: "BODY", text: "Olá {{nome}}" }]);

    expect(buildSendComponents(named, ["Ana"])).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Ana", parameter_name: "nome" }] },
    ]);
  });
});

describe("variableProblem", () => {
  it("recusa vazio, quebra de linha, tabulação, cinco espaços e texto longo", () => {
    expect(variableProblem("Maria")).toBeNull();
    expect(variableProblem("   ")).toMatch(/Preencha/);
    expect(variableProblem(undefined)).toMatch(/Preencha/);
    expect(variableProblem("a\nb")).toMatch(/quebra de linha/);
    expect(variableProblem("a\tb")).toMatch(/tabulação/);
    expect(variableProblem("a     b")).toMatch(/cinco espaços/);
    expect(variableProblem("x".repeat(1025))).toMatch(/longa/);
  });
});
