import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type PreviewState,
  RetentionScope,
  RetentionStateNotice,
} from "@/components/admin/retention-scope";
import type { RetentionView } from "@/lib/inbox/retention";
import { emptyRunResult } from "@/lib/inbox/retention-policy";

const view = (over: Partial<RetentionView> = {}): RetentionView => ({
  channelType: "whatsapp_cloud",
  enabled: false,
  floorHours: 72,
  batchLimit: 5000,
  policy: null,
  policyUpdatedAt: null,
  defaults: { maxMessages: 5000, retentionDays: 90, maxFavorites: 200 },
  effective: { maxMessages: 5000, retentionDays: 90, maxFavorites: 200 },
  sources: { maxMessages: "default", retentionDays: "default", maxFavorites: "default" },
  lastRun: null,
  ...over,
});

const render = (
  over: Partial<RetentionView> = {},
  props: { canWrite?: boolean; platform?: boolean; preview?: PreviewState } = {},
) =>
  renderToStaticMarkup(
    createElement(RetentionScope, {
      view: view(over),
      canWrite: props.canWrite ?? true,
      platform: props.platform,
      preview: props.preview ?? { status: "idle" },
      onSave: () => {},
      onPreview: () => {},
    }),
  );

describe("RetentionStateNotice", () => {
  it("desligada diz que a política está gravada e nada é apagado", () => {
    const html = renderToStaticMarkup(
      createElement(RetentionStateNotice, { enabled: false, floorHours: 72 }),
    );
    expect(html).toContain('data-retention-state="off"');
    expect(html).toContain("desligada");
    expect(html).toContain("nenhuma mensagem é apagada");
  });

  it("ligada diz que roda uma vez por dia, apaga sem volta e poupa favorita e o piso", () => {
    const html = renderToStaticMarkup(
      createElement(RetentionStateNotice, { enabled: true, floorHours: 72 }),
    );
    expect(html).toContain('data-retention-state="on"');
    expect(html).toContain("uma vez por dia");
    expect(html).toContain("sem volta");
    expect(html).toContain("favorita");
    expect(html).toContain("72 horas (3 dias)");
  });
});

describe("RetentionScope", () => {
  it("mostra o que vale, a origem, o piso e que nunca rodou", () => {
    const html = render();
    expect(html).toContain("WhatsApp oficial");
    expect(html).toContain("5.000 mensagens");
    expect(html).toContain("padrão do sistema");
    expect(html).toContain("72 horas (3 dias)");
    expect(html).toContain("Nunca rodou.");
  });

  it("política fixada aparece como fixada, e 0 como sem limite fixado", () => {
    const html = render({
      policy: { maxMessages: 100, retentionDays: 0, maxFavorites: null },
      effective: { maxMessages: 100, retentionDays: null, maxFavorites: 200 },
      sources: { maxMessages: "policy", retentionDays: "policy", maxFavorites: "default" },
    });
    expect(html).toContain("100 mensagens");
    expect(html).toContain("fixado para esta organização");
    expect(html).toContain("sem limite");
  });

  it("o proprietário vê as três opções de cada limite e a opção de herdar mostra o padrão", () => {
    const html = render();
    expect(html.match(/type="radio"/g)).toHaveLength(9);
    expect(html).toContain("Herdar o padrão do sistema (5.000 mensagens)");
    expect(html).toContain("Herdar o padrão do sistema (90 dias)");
    expect(html).toContain("Sem limite");
    expect(html).toContain("Definir um valor");
    expect(html).toContain("Salvar política");
  });

  it("o suporte vê tudo, sem formulário", () => {
    const html = render({}, { canWrite: false });
    expect(html).toContain("5.000 mensagens");
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("Salvar política");
    expect(html).toContain("Só o proprietário da plataforma altera");
    expect(html).toContain("Ver prévia");
  });

  it("a plataforma é só leitura, mesmo para o proprietário, e não fala em política fixada", () => {
    const html = render(
      { sources: { maxMessages: "default", retentionDays: "unlimited", maxFavorites: "default" } },
      { canWrite: true, platform: true },
    );
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("Salvar política");
    expect(html).not.toContain("fixado para esta organização");
    expect(html).toContain("nenhum limite definido");
    expect(html).toContain("só os padrões do sistema");
    expect(html).toContain("Não apaga nada. Usa os padrões do sistema.");
    expect(html).not.toContain("política já gravada");
  });

  it("mostra a última execução", () => {
    const html = render({
      lastRun: {
        at: "2026-11-14T04:45:00.000Z",
        result: { ...emptyRunResult, byAge: 12, messagesTotal: 480, favoritesTotal: 20 },
      },
    });
    expect(html).toContain("Rodou em");
    expect(html).toContain("Apagadas por idade");
    expect(html).toContain("Depois dela, 480 mensagens e 20 favoritas.");
    expect(html).not.toContain("Nunca rodou.");
  });

  it("a prévia diz que não apaga e que usa a política gravada, e mostra as contagens", () => {
    const html = render(
      {},
      {
        preview: {
          status: "ready",
          result: { ...emptyRunResult, byAge: 7, truncated: true, messagesTotal: 10 },
        },
      },
    );
    expect(html).toContain("Não apaga nada");
    expect(html).toContain("política já gravada");
    expect(html).toContain("7 mensagens apagadas por idade");
    expect(html).toContain("Atualizar prévia");
    expect(html).toContain("5.000");
  });

  it("a prévia carregando e com erro", () => {
    expect(render({}, { preview: { status: "loading" } })).toContain("Calculando");
    expect(render({}, { preview: { status: "error", message: "Falhou." } })).toContain("Falhou.");
  });
});
