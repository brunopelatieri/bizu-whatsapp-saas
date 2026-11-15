import { describe, expect, it } from "vitest";
import { customerSchema } from "@/lib/schemas/customer";
import { IMPORT_COLUMNS } from "@/lib/spreadsheet/columns";
import { customerFieldsFromRow } from "@/lib/spreadsheet/customer-row";
import { parseCsv } from "@/lib/spreadsheet/parse-csv";
import { buildTemplateCsv } from "@/lib/spreadsheet/template-file";
import { normalizePhone } from "@/lib/phone/br";

describe("modelo de planilha", () => {
  it("é lido de volta pelo próprio leitor, com todas as colunas e as etiquetas intactas", () => {
    const table = parseCsv(buildTemplateCsv());
    expect(table.columns).toEqual(IMPORT_COLUMNS.map(({ key }) => key));
    expect(table.ignoredColumns).toEqual([]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({ name: "Maria Souza", tags: ["cliente", "vip"] });
  });

  it("os exemplos passam pelo cadastro (quem esquecer de apagar importa dados válidos)", () => {
    for (const row of parseCsv(buildTemplateCsv()).rows) {
      expect(customerSchema.safeParse(customerFieldsFromRow(row)).success).toBe(true);
    }
  });

  it("começa com BOM e usa CRLF, para o Excel em português", () => {
    const csv = buildTemplateCsv();
    expect(csv.startsWith("﻿phone;name;")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain('"cliente;vip"');
  });
});

describe("customerFieldsFromRow", () => {
  const row = (extra: object) => ({ sourceRow: 2, phone: "", tags: [], ...extra });

  it("sem nome, o telefone formatado vira o nome", () => {
    expect(customerFieldsFromRow(row({ phone: "11987654321" })).name).toBe("+55 (11) 98765-4321");
    expect(customerFieldsFromRow(row({ phone: "+351912345678" })).name).toBe("+351912345678");
  });

  it("com nome, o nome vence", () => {
    expect(customerFieldsFromRow(row({ phone: "11987654321", name: "Maria" })).name).toBe("Maria");
  });

  it("telefone que não passa fica como veio, e a linha cai pelo telefone", () => {
    const fields = customerFieldsFromRow(row({ phone: "123" }));
    expect(fields.name).toBe("123");
    expect(customerSchema.safeParse(fields).success).toBe(false);
  });

  it("sem telefone, sem nome", () => {
    expect(customerFieldsFromRow(row({})).name).toBe("");
  });
});

// Caso J da SPEC 052 (DDD inexistente, número sem DDI), conferido contra o normalizador DESTE projeto.
describe("caso J: o telefone vale pelo normalizador do projeto", () => {
  const result = (raw: string) => {
    const r = normalizePhone(raw);
    return r.ok ? r.phone : r.reason;
  };

  it("DDD 10 não existe; sem DDI ganha o 55", () => {
    expect(result("5510987654321")).toBe("invalid_ddd");
    expect(result("19992496598")).toBe("5519992496598");
  });

  it("legado de 8 dígitos e estrangeiro entram", () => {
    expect(result("551198765432")).toBe("551198765432");
    expect(result("+351912345678")).toBe("351912345678");
  });

  it("999999999999 (12 dígitos, DDI 99): aqui entra como estrangeiro; na origem era invalid_ddd", () => {
    // Divergência da origem: lá o DDI 99 caía na checagem de DDD do Brasil. Aqui só o DDI 55 usa a regra
    // do Brasil, e o resto passa pelo tamanho do E.164 (`validateForeign`). Regra do projeto, não da I1.
    expect(result("999999999999")).toBe("999999999999");
  });
});
