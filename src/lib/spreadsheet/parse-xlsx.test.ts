import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone/br";
import { cellToString, parseXlsxSheets, pickSheet, readXlsxBytes } from "@/lib/spreadsheet/parse-xlsx";
import { buildXlsx } from "@/lib/spreadsheet/testing/xlsx-builder";
import { MAX_IMPORT_ROWS, SpreadsheetParseError } from "@/lib/spreadsheet/types";

const sheet = (name: string, data: (string | number | null)[][]) => ({ sheet: name, data });

async function codeOf(run: () => Promise<unknown> | unknown) {
  try {
    await run();
  } catch (error) {
    return error instanceof SpreadsheetParseError ? error.code : "outro";
  }
  return "nenhum";
}

describe("cellToString", () => {
  it("número grande sai com todos os dígitos, sem notação científica", () => {
    expect(cellToString(5511988887777)).toBe("5511988887777");
    expect(cellToString(5.5e21)).toBe("5500000000000000000000");
    expect(cellToString(1.5)).toBe("1.5");
  });

  it("texto numérico em notação científica é expandido", () => {
    expect(cellToString("5.511988887777E12")).toBe("5511988887777");
    expect(cellToString("5511988887777")).toBe("5511988887777");
  });

  it("texto com a letra e (phone, e-mail, nome) não é confundido com notação científica", () => {
    expect(cellToString("phone")).toBe("phone");
    expect(cellToString("e-mail")).toBe("e-mail");
    expect(cellToString("1e5")).toBe("100000");
    expect(cellToString("12e")).toBe("12e");
  });

  it("vazio, data, booleano e infinito", () => {
    expect(cellToString(null)).toBe("");
    expect(cellToString(undefined)).toBe("");
    expect(cellToString(new Date("2026-03-04T00:00:00Z"))).toBe("2026-03-04");
    expect(cellToString(new Date("x"))).toBe("");
    expect(cellToString(true)).toBe("true");
    expect(cellToString(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("texto de célula é cortado no teto + 1", () => {
    expect(cellToString("a".repeat(10_000)).length).toBe(2_001);
  });
});

describe("parseXlsxSheets", () => {
  it("H: célula `vip, lead` sem aspas vira duas etiquetas (a planilha não tem o problema do CSV)", () => {
    const { rows } = parseXlsxSheets([
      sheet("Clientes", [
        ["phone", "name", "tags"],
        ["5511988887777", "Maria", "vip, lead"],
      ]),
    ]);
    expect(rows[0]?.tags).toEqual(["vip", "lead"]);
  });

  it("I: telefone como número e como texto com apóstrofo chegam ao normalizador", () => {
    const { rows } = parseXlsxSheets([
      sheet("Clientes", [
        ["phone"],
        [5519992496598],
        ["'0 19 99249-6598'"],
        ["+55 (19) 99249-6598"],
      ]),
    ]);
    // O apóstrofo que marca "texto" no Excel não chega ao telefone (o cadastro só aceita dígitos e + ( ) - .).
    expect(rows[1]?.phone).toBe("0 19 99249-6598");
    const normalized = rows.map((row) => {
      const result = normalizePhone(row.phone);
      return result.ok ? result.phone : result.reason;
    });
    expect(normalized).toEqual(["5519992496598", "5519992496598", "5519992496598"]);
  });

  it("a linha é a da planilha: cabeçalho depois de linhas em branco, e linhas em branco no meio", () => {
    const { rows } = parseXlsxSheets([
      sheet("Clientes", [
        [null, null],
        ["phone", "name"],
        ["5511988887777", "Maria"],
        [null, null],
        ["5511977776666", "João"],
      ]),
    ]);
    expect(rows.map((row) => row.sourceRow)).toEqual([3, 5]);
  });

  it("cabeçalho em português numa aba secundária: escolhe a aba com telefone e lista as abas", () => {
    const result = parseXlsxSheets([
      sheet("Capa", [["Instruções"], ["Preencha a aba seguinte"]]),
      sheet("Clientes", [["Nome", "Celular"], ["Maria", "5511988887777"]]),
    ]);
    expect(result.sheetName).toBe("Clientes");
    expect(result.sheetNames).toEqual(["Capa", "Clientes"]);
    expect(result.rows[0]).toMatchObject({ name: "Maria", phone: "5511988887777" });
  });

  it("respeita a aba pedida; aba que não existe cai na escolha automática", () => {
    const sheets = [
      sheet("A", [["phone"], ["5511988887777"]]),
      sheet("B", [["phone"], ["5511977776666"]]),
    ];
    expect(parseXlsxSheets(sheets, { sheetName: "B" }).rows[0]?.phone).toBe("5511977776666");
    expect(parseXlsxSheets(sheets, { sheetName: "Z" }).sheetName).toBe("A");
    expect(pickSheet([], "A")).toBeNull();
  });

  it("nenhuma aba com telefone: o erro leva as abas para a tela trocar", () => {
    const run = () => parseXlsxSheets([sheet("A", [["nome"], ["Maria"]]), sheet("B", [["x"], ["y"]])]);
    expect(run).toThrowError(expect.objectContaining({ code: "missing_phone_column", sheetNames: ["A", "B"] }));
  });

  it("pasta sem abas, aba vazia e aba só com cabeçalho", async () => {
    expect(await codeOf(() => parseXlsxSheets([]))).toBe("empty_file");
    expect(await codeOf(() => parseXlsxSheets([sheet("A", [[null]])]))).toBe("empty_file");
    expect(await codeOf(() => parseXlsxSheets([sheet("A", [["phone"]])]))).toBe("empty_file");
  });

  it("fórmula: chega o valor que a planilha guardou, como texto", () => {
    const { rows } = parseXlsxSheets([sheet("A", [["phone", "name"], ["5511988887777", "=1+1"]])]);
    expect(rows[0]?.name).toBe("=1+1");
  });

  it("teto de linhas", async () => {
    const body = (count: number) => Array.from({ length: count }, () => ["5511988887777"]);
    expect(parseXlsxSheets([sheet("A", [["phone"], ...body(MAX_IMPORT_ROWS)])]).rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(await codeOf(() => parseXlsxSheets([sheet("A", [["phone"], ...body(MAX_IMPORT_ROWS + 1)])]))).toBe(
      "too_many_rows",
    );
  });
});

// Com `read-excel-file` de verdade, sobre um `.xlsx` montado byte a byte no teste.
describe("readXlsxBytes (read-excel-file)", () => {
  it("lê as abas, escolhe a que tem telefone e entende número e texto", async () => {
    const bytes = buildXlsx([
      { name: "Capa", rows: [["Leia-me"]] },
      {
        name: "Clientes",
        rows: [
          ["Telefone", "Nome", "Etiquetas", "Observações"],
          [5511988887777, "Maria D'Ávila", "vip, lead", "ok"],
          ["(21) 98888-7777", "João", null, null],
        ],
      },
    ]);

    const result = await readXlsxBytes(bytes);
    expect(result.sheetNames).toEqual(["Capa", "Clientes"]);
    expect(result.sheetName).toBe("Clientes");
    expect(result.rows).toEqual([
      { sourceRow: 2, phone: "5511988887777", name: "Maria D'Ávila", tags: ["vip", "lead"], notes: "ok" },
      { sourceRow: 3, phone: "(21) 98888-7777", name: "João", tags: [] },
    ]);
  });

  it("outra aba pelo nome", async () => {
    const bytes = buildXlsx([
      { name: "A", rows: [["phone"], ["5511988887777"]] },
      { name: "B", rows: [["phone"], ["5511977776666"]] },
    ]);
    expect((await readXlsxBytes(bytes, { sheetName: "B" })).rows[0]?.phone).toBe("5511977776666");
  });

  it("arquivo zip que não é Excel é um erro legível, não uma exceção solta", async () => {
    const notExcel = buildXlsx([], []);
    expect(await codeOf(() => readXlsxBytes(notExcel))).toBe("unreadable");
    expect(await codeOf(() => readXlsxBytes(new TextEncoder().encode("não é um zip")))).toBe("unreadable");
  });
});
