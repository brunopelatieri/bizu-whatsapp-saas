import { describe, expect, it } from "vitest";
import { verificationTemplateProblem as problemFor } from "@/lib/channels/providers/whatsapp_cloud/verification";

/**
 * Regra do modelo de verificação de telefone (SPEC `pre-producao`, T2b, restrição (b)): o botão
 * de URL precisa apontar para o `APP_URL` deste servidor, senão o token iria para outro endereço.
 */

const APP_URL = "https://app.exemplo.com.br";
const verificationTemplateProblem = (template: { status: string; components: unknown[] }) =>
  problemFor(template, APP_URL);
const URL_OK = "https://app.exemplo.com.br/verificar-telefone?token={{1}}";

const template = (url: string, extra: unknown[] = []) => ({
  status: "APPROVED",
  components: [
    { type: "BODY", text: "Confirme seu WhatsApp." },
    ...extra,
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Confirmar", url }] },
  ],
});

describe("verificationTemplateProblem", () => {
  it("aceita o modelo aprovado com o botão no APP_URL", () => {
    expect(verificationTemplateProblem(template(URL_OK))).toBeNull();
  });

  it.each([
    ["outro domínio", "https://atacante.example/verificar-telefone?token={{1}}"],
    ["subdomínio parecido", "https://app.exemplo.com.br.atacante.example/verificar-telefone?token={{1}}"],
    ["http em vez de https", "http://app.exemplo.com.br/verificar-telefone?token={{1}}"],
    ["outro caminho", "https://app.exemplo.com.br/login?token={{1}}"],
    ["token no meio", "https://app.exemplo.com.br/verificar-telefone?token={{1}}&x=1"],
    ["sem variável", "https://app.exemplo.com.br/verificar-telefone"],
  ])("recusa o botão com %s", (_label, url) => {
    expect(verificationTemplateProblem(template(url))).toMatch(/botão de URL precisa apontar/);
  });

  it("recusa modelo não aprovado, sem botão, com dois botões de URL ou com variável no texto", () => {
    expect(verificationTemplateProblem({ ...template(URL_OK), status: "PAUSED" })).toMatch(
      /aprovado/,
    );
    expect(
      verificationTemplateProblem({ status: "APPROVED", components: [{ type: "BODY", text: "Oi" }] }),
    ).toMatch(/exatamente um botão/);
    expect(
      verificationTemplateProblem({
        status: "APPROVED",
        components: [
          {
            type: "BUTTONS",
            buttons: [
              { type: "URL", url: URL_OK },
              { type: "URL", url: "https://atacante.example/{{1}}" },
            ],
          },
        ],
      }),
    ).toMatch(/exatamente um botão/);
    expect(
      verificationTemplateProblem(template(URL_OK, [{ type: "HEADER", format: "TEXT", text: "Oi {{1}}" }])),
    ).toMatch(/variáveis/);
    expect(
      verificationTemplateProblem(template(URL_OK, [{ type: "HEADER", format: "IMAGE" }])),
    ).toMatch(/cabeçalho/);
  });
});
