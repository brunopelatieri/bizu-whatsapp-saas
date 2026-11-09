import { describe, expect, it } from "vitest";
import {
  buildCustomFieldsSchema,
  type CustomFieldDef,
  displayCustomFieldValue,
  isIsoDate,
  mergeCustomFields,
  missingRequired,
  slugifyKey,
} from "@/lib/crm/values";

const options = [
  { value: "a", label: "Alfa" },
  { value: "b", label: "Beta" },
];

const def = (id: string, type: CustomFieldDef["type"], extra: Partial<CustomFieldDef> = {}) =>
  ({ id, key: id, label: id, type, options: [], required: false, ...extra }) as CustomFieldDef;

const ids = {
  text: "00000000-0000-4000-8000-000000000001",
  number: "00000000-0000-4000-8000-000000000002",
  date: "00000000-0000-4000-8000-000000000003",
  boolean: "00000000-0000-4000-8000-000000000004",
  select: "00000000-0000-4000-8000-000000000005",
  multi: "00000000-0000-4000-8000-000000000006",
};

const defs = [
  def(ids.text, "text"),
  def(ids.number, "number"),
  def(ids.date, "date"),
  def(ids.boolean, "boolean"),
  def(ids.select, "select", { options }),
  def(ids.multi, "multiselect", { options }),
];

const parse = (input: unknown, list = defs, requireAll = false) =>
  buildCustomFieldsSchema(list, { requireAll }).safeParse(input);

describe("buildCustomFieldsSchema", () => {
  it("aceita um valor válido de cada tipo", () => {
    const result = parse({
      [ids.text]: "  olá  ",
      [ids.number]: 12.5,
      [ids.date]: "2026-02-28",
      [ids.boolean]: false,
      [ids.select]: "a",
      [ids.multi]: ["a", "b", "a"],
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      [ids.text]: "olá",
      [ids.number]: 12.5,
      [ids.date]: "2026-02-28",
      [ids.boolean]: false,
      [ids.select]: "a",
      [ids.multi]: ["a", "b"],
    });
  });

  it.each([
    ["texto longo", ids.text, "x".repeat(501)],
    ["texto que não é string", ids.text, 5],
    ["número como string", ids.number, "12"],
    ["número infinito", ids.number, Number.POSITIVE_INFINITY],
    ["número acima do limite", ids.number, 1e16],
    ["data em outro formato", ids.date, "28/02/2026"],
    ["data que não existe", ids.date, "2026-02-31"],
    ["booleano como texto", ids.boolean, "sim"],
    ["opção que não existe", ids.select, "z"],
    ["lista com opção inválida", ids.multi, ["a", "z"]],
    ["lista com mais de 20", ids.multi, Array.from({ length: 21 }, () => "a")],
  ])("recusa %s", (_name, id, value) => {
    expect(parse({ [id]: value }).success).toBe(false);
  });

  it("trata vazio como remoção (null)", () => {
    const result = parse({
      [ids.text]: "   ",
      [ids.select]: null,
      [ids.multi]: [],
    });

    expect(result.data).toEqual({ [ids.text]: null, [ids.select]: null, [ids.multi]: null });
  });

  it("recusa id desconhecido (inclusive de campo arquivado, que não está nas ativas)", () => {
    expect(parse({ "00000000-0000-4000-8000-0000000000ff": "x" }).success).toBe(false);
  });

  it("obrigatório pede valor só com requireAll", () => {
    const required = [def(ids.text, "text", { required: true })];

    expect(parse({}, required, true).success).toBe(false);
    expect(parse({ [ids.text]: "" }, required, true).success).toBe(false);
    expect(parse({ [ids.text]: "ok" }, required, true).success).toBe(true);
    expect(parse({}, required, false).success).toBe(true);
  });
});

describe("missingRequired e mergeCustomFields", () => {
  const required = [def("a", "text", { required: true, label: "Alfa" }), def("b", "text")];

  it("lista o rótulo dos obrigatórios sem valor", () => {
    expect(missingRequired(required, {})).toEqual(["Alfa"]);
    expect(missingRequired(required, { a: "x" })).toEqual([]);
  });

  it("merge por chave: null remove, ausente não muda", () => {
    expect(mergeCustomFields({ a: "1", b: "2" }, { a: null, c: "3" })).toEqual({ b: "2", c: "3" });
  });
});

describe("auxiliares", () => {
  it("slugifyKey", () => {
    expect(slugifyKey("Clínica São João!")).toBe("clinica_sao_joao");
    expect(slugifyKey("???")).toBe("");
    expect(slugifyKey("a".repeat(60))).toHaveLength(40);
  });

  it("isIsoDate", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-2-9")).toBe(false);
  });

  it("displayCustomFieldValue mostra rótulo de lista, data e sim/não", () => {
    expect(displayCustomFieldValue(def("x", "multiselect", { options }), ["a", "b"])).toBe(
      "Alfa, Beta",
    );
    expect(displayCustomFieldValue(def("x", "select", { options }), "b")).toBe("Beta");
    expect(displayCustomFieldValue(def("x", "date"), "2026-03-09")).toBe("09/03/2026");
    expect(displayCustomFieldValue(def("x", "boolean"), false)).toBe("Não");
    expect(displayCustomFieldValue(def("x", "text"), "")).toBeNull();
  });
});
