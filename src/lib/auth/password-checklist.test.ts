import { describe, expect, it } from "vitest";
import { passwordChecklist } from "@/lib/auth/password-checklist";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password-policy";

function metRules(password: string) {
  return passwordChecklist(password)
    .items.filter((item) => item.met)
    .map((item) => item.rule);
}

describe("passwordChecklist", () => {
  it("não mostra nada com o campo vazio", () => {
    const checklist = passwordChecklist("");

    expect(checklist.empty).toBe(true);
    expect(checklist.valid).toBe(false);
  });

  it("lista as cinco regras fixas, na ordem, e só a minúscula cumprida em 'abc'", () => {
    const checklist = passwordChecklist("abc");

    expect(checklist.empty).toBe(false);
    expect(checklist.items.map((item) => item.rule)).toEqual([
      "minLength",
      "uppercase",
      "lowercase",
      "number",
      "special",
    ]);
    expect(metRules("abc")).toEqual(["lowercase"]);
    expect(checklist.met).toBe(1);
    expect(checklist.total).toBe(5);
    expect(checklist.valid).toBe(false);
  });

  it("cumpre tudo com 'Cafe Quente 123!'", () => {
    const checklist = passwordChecklist("Cafe Quente 123!");

    expect(checklist.met).toBe(5);
    expect(checklist.valid).toBe(true);
    expect(checklist.items.every((item) => item.met)).toBe(true);
  });

  it("mostra o tamanho mínimo e os caracteres especiais aceitos nos rótulos", () => {
    const labels = passwordChecklist("a").items.map((item) => item.label);

    expect(labels[0]).toContain("10");
    expect(labels[4]).toContain("!@#$%^&*()_+-=[]{}:;,.?/~");
  });

  it("espaços nas pontas não contam, como na gravação", () => {
    expect(passwordChecklist("   Ab1!   ").items[0]).toMatchObject({
      rule: "minLength",
      met: false,
    });
  });

  it("mostra 'máximo' só quando ultrapassa o limite", () => {
    const ok = passwordChecklist(`Aa1!${"x".repeat(PASSWORD_MAX_LENGTH - 4)}`);
    const long = passwordChecklist(`Aa1!${"x".repeat(PASSWORD_MAX_LENGTH)}`);

    expect(ok.items.some((item) => item.rule === "maxLength")).toBe(false);
    expect(ok.valid).toBe(true);
    expect(long.items.find((item) => item.rule === "maxLength")?.met).toBe(false);
    expect(long.valid).toBe(false);
    // As regras fixas continuam cumpridas: a barra não conta a violação.
    expect(long.met).toBe(5);
  });

  it("mostra 'sem controle' só quando há caractere de controle", () => {
    const clean = passwordChecklist("Cafe Quente 123!");
    const dirty = passwordChecklist("Cafe\u0007Quente 123!");

    expect(clean.items.some((item) => item.rule === "noControl")).toBe(false);
    expect(dirty.items.find((item) => item.rule === "noControl")?.met).toBe(false);
    expect(dirty.valid).toBe(false);
  });
});
