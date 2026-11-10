/**
 * Modelos de mensagem da Meta (`message_template.components`): quais variáveis pedem, se esta tela
 * sabe enviá-los, a prévia e os `components` do envio. **Código puro, sem servidor**: o `template-dialog`
 * (prévia) e o serviço de envio (validação e texto gravado) usam a mesma função, então a prévia nunca
 * diverge do que sai.
 *
 * Suportado nesta fase: cabeçalho de texto, corpo, rodapé e botões sem parâmetro (resposta rápida,
 * telefone e URL fixa). Cabeçalho de mídia, botão com variável, código de cópia, fluxo, carrossel e os
 * demais ficam listados, mas desabilitados, com o motivo (criar e enviar mídia em modelo é de outra fase).
 */

export type TemplateSlot = {
  /** Onde a variável aparece: o cabeçalho ou o corpo. */
  component: "header" | "body";
  /** `1`, `2`... (posicional) ou o nome (`nome_cliente`). */
  name: string;
};

export type TemplateAnalysis =
  | {
      supported: true;
      slots: TemplateSlot[];
      /** `true`: variáveis posicionais; `false`: nomeadas (`parameter_name` no envio). */
      positional: boolean;
      header: string | null;
      body: string;
      footer: string | null;
    }
  | { supported: false; reason: string };

export const TEMPLATE_VARIABLE_MAX = 1024;

const TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

type Raw = {
  type?: unknown;
  format?: unknown;
  text?: unknown;
  buttons?: unknown;
};

const upper = (value: unknown) => (typeof value === "string" ? value.toUpperCase() : "");
const textOf = (value: unknown) => (typeof value === "string" ? value : "");

/** Nomes das variáveis do texto, na ordem em que aparecem, sem repetir. */
function tokensOf(text: string) {
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) if (match[1]) seen.add(match[1]);
  return [...seen];
}

const unsupported = (reason: string): TemplateAnalysis => ({ supported: false, reason });

/** Botões que a Meta envia sem parâmetro: não pedem nada na hora do envio. */
const STATIC_BUTTONS = new Set(["QUICK_REPLY", "PHONE_NUMBER", "URL"]);

export function analyzeTemplate(components: unknown): TemplateAnalysis {
  if (!Array.isArray(components)) return unsupported("Modelo sem componentes.");

  let header: string | null = null;
  let body: string | null = null;
  let footer: string | null = null;
  const headerTokens: string[] = [];
  let bodyTokens: string[] = [];

  for (const item of components as Raw[]) {
    const type = upper(item?.type);

    if (type === "HEADER") {
      if (upper(item.format) !== "TEXT") {
        return unsupported("Este modelo tem cabeçalho com mídia, ainda não suportado aqui.");
      }
      header = textOf(item.text);
      headerTokens.push(...tokensOf(header));
    } else if (type === "BODY") {
      body = textOf(item.text);
      bodyTokens = tokensOf(body);
    } else if (type === "FOOTER") {
      footer = textOf(item.text) || null;
    } else if (type === "BUTTONS") {
      const buttons = Array.isArray(item.buttons) ? (item.buttons as Raw[]) : [];
      for (const button of buttons) {
        if (!STATIC_BUTTONS.has(upper(button?.type))) {
          return unsupported("Este modelo tem um botão que ainda não é suportado aqui.");
        }
        // URL com variável pede parâmetro no botão.
        if (upper(button.type) === "URL" && tokensOf(textOf((button as { url?: unknown }).url)).length > 0) {
          return unsupported("Este modelo tem um botão com link variável, ainda não suportado aqui.");
        }
      }
    } else {
      return unsupported("Este modelo usa um recurso que ainda não é suportado aqui.");
    }
  }

  if (!body) return unsupported("Modelo sem corpo.");

  const all = [...headerTokens, ...bodyTokens];
  const numeric = all.filter((name) => /^\d+$/.test(name));
  if (numeric.length > 0 && numeric.length !== all.length) {
    return unsupported("Modelo mistura variáveis numeradas e nomeadas.");
  }
  const positional = numeric.length === all.length;

  if (positional) {
    for (const tokens of [headerTokens, bodyTokens]) {
      const sorted = tokens.map(Number).sort((a, b) => a - b);
      if (sorted.some((value, index) => value !== index + 1)) {
        return unsupported("Modelo com variáveis numeradas fora de sequência.");
      }
    }
  }

  const order = (tokens: string[]) =>
    positional ? [...tokens].sort((a, b) => Number(a) - Number(b)) : tokens;

  return {
    supported: true,
    positional,
    header,
    body,
    footer,
    slots: [
      ...order(headerTokens).map((name) => ({ component: "header" as const, name })),
      ...order(bodyTokens).map((name) => ({ component: "body" as const, name })),
    ],
  };
}

/** Valor da variável no texto: `{{1}}` sem valor aparece como está, para a prévia mostrar o que falta. */
function fill(text: string, values: Map<string, string>) {
  return text.replace(TOKEN, (whole, name: string) => values.get(name) ?? whole);
}

function valuesOf(slots: TemplateSlot[], variables: string[]) {
  const header = new Map<string, string>();
  const body = new Map<string, string>();
  slots.forEach((slot, index) => {
    const value = variables[index];
    if (value !== undefined && value !== "") (slot.component === "header" ? header : body).set(slot.name, value);
  });
  return { header, body };
}

/** O texto que o contato recebe (cabeçalho, corpo e rodapé), com as variáveis preenchidas. */
export function renderTemplate(
  analysis: Extract<TemplateAnalysis, { supported: true }>,
  variables: string[],
) {
  const values = valuesOf(analysis.slots, variables);
  return [
    analysis.header ? fill(analysis.header, values.header) : null,
    fill(analysis.body, values.body),
    analysis.footer,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

/** Erro de uma variável, em português, ou `null`. A Meta recusa quebra de linha, tabulação e 5 espaços. */
export function variableProblem(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!text) return "Preencha todas as variáveis.";
  if (text.length > TEMPLATE_VARIABLE_MAX) return "Uma variável está muito longa.";
  if (/[\r\n\t]| {5}/.test(text)) {
    return "As variáveis não podem ter quebra de linha, tabulação nem cinco espaços seguidos.";
  }
  return null;
}

type SendParameter = { type: "text"; text: string; parameter_name?: string };

/** `components` do envio da Meta: só os que levam parâmetro. */
export function buildSendComponents(
  analysis: Extract<TemplateAnalysis, { supported: true }>,
  variables: string[],
) {
  const parameters: Record<"header" | "body", SendParameter[]> = { header: [], body: [] };

  analysis.slots.forEach((slot, index) => {
    parameters[slot.component].push({
      type: "text",
      text: (variables[index] ?? "").trim(),
      ...(analysis.positional ? {} : { parameter_name: slot.name }),
    });
  });

  return (["header", "body"] as const)
    .filter((component) => parameters[component].length > 0)
    .map((component) => ({ type: component, parameters: parameters[component] }));
}

/** `aprovado` na Meta é `APPROVED`; a comparação ignora a caixa. */
export const isApprovedTemplate = (status: string) => status.toUpperCase() === "APPROVED";
