import { describe, expect, it } from "vitest";
import { mapColumns, normalizeHeader } from "@/lib/spreadsheet/columns";
import { parseCsv, readCsvRecords, sniffDelimiter } from "@/lib/spreadsheet/parse-csv";
import { parseTagCell } from "@/lib/spreadsheet/rows";
import { MAX_CELL_CHARS, MAX_IMPORT_ROWS, SpreadsheetParseError } from "@/lib/spreadsheet/types";

const PHONE = "5511988887777";

function codeOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error instanceof SpreadsheetParseError ? error.code : "outro";
  }
  return "nenhum";
}

describe("colunas", () => {
  it("reconhece o cabeçalho em inglês e em português, sem depender de acento ou caixa", () => {
    expect(mapColumns(["phone", "name", "email", "document", "tags", "notes"])).toEqual({
      phone: 0,
      name: 1,
      email: 2,
      document: 3,
      tags: 4,
      notes: 5,
    });
    expect(mapColumns(["Nome", "Número", "E-mail", "CPF", "Etiquetas", "Observações"])).toEqual({
      phone: 1,
      name: 0,
      email: 2,
      document: 3,
      tags: 4,
      notes: 5,
    });
    expect(mapColumns(["WhatsApp", "CNPJ"])).toMatchObject({ phone: 0, document: 1 });
    expect(normalizeHeader("﻿  Observações ")).toBe("observacoes");
  });

  it("coluna ausente é -1, e cabeçalho repetido vale pelo primeiro", () => {
    expect(mapColumns(["phone"]).email).toBe(-1);
    expect(mapColumns(["telefone", "phone"]).phone).toBe(1);
    expect(mapColumns(["celular", "celular"]).phone).toBe(0);
  });
});

describe("parseCsv: o básico", () => {
  it("numera sourceRow pela linha da planilha (o cabeçalho é a 1)", () => {
    const { rows } = parseCsv(`phone,name\n${PHONE},Maria\n5511977776666,João`);
    expect(rows.map((row) => row.sourceRow)).toEqual([2, 3]);
  });

  it("linha em branco não conta, mas a numeração segue a do arquivo", () => {
    const { rows } = parseCsv(`phone\n${PHONE}\n\n5511977776666`);
    expect(rows.map((row) => row.sourceRow)).toEqual([2, 4]);
  });

  it("linha só de delimitadores é em branco", () => {
    const { rows } = parseCsv(`phone,name\n${PHONE},Maria\n,\n,,`);
    expect(rows).toHaveLength(1);
  });

  it("a linha sem telefone não some: sai com telefone vazio para ser relatada", () => {
    const { rows } = parseCsv(`phone,name\n,Maria\n${PHONE},João`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ phone: "", name: "Maria", sourceRow: 2 });
  });

  it("lê as seis colunas, ignora as desconhecidas e diz quais ignorou", () => {
    const table = parseCsv(
      `phone,empresa,name,email,document,tags,notes\n${PHONE},Acme,Maria,m@x.com,123,vip;lead,Obs`,
    );
    expect(table.rows[0]).toEqual({
      sourceRow: 2,
      phone: PHONE,
      name: "Maria",
      email: "m@x.com",
      document: "123",
      tags: ["vip", "lead"],
      notes: "Obs",
    });
    expect(table.columns).toEqual(["phone", "name", "email", "document", "tags", "notes"]);
    expect(table.ignoredColumns).toEqual(["empresa"]);
  });

  it("sem coluna de telefone, o erro diz o que fazer", () => {
    expect(codeOf(() => parseCsv("name,email\nMaria,m@x.com"))).toBe("missing_phone_column");
  });

  it("só cabeçalho e arquivo vazio são recusados", () => {
    expect(codeOf(() => parseCsv("phone,name"))).toBe("empty_file");
    expect(codeOf(() => parseCsv(""))).toBe("empty_file");
    expect(codeOf(() => parseCsv("\n\n  \n"))).toBe("empty_file");
  });
});

// Casos A a K da SPEC 052 da origem (§2.2 e §9.1): cada um foi colhido executando o leitor da origem.
describe("parseCsv: casos A a K da SPEC 052", () => {
  it("A: `,` com tags `vip,lead` sem aspas na última coluna perde a segunda (documenta a perda)", () => {
    const { rows } = parseCsv(`phone,name,tags\n${PHONE},Maria,vip,lead`);
    expect(rows[0]?.tags).toEqual(["vip"]);
  });

  it('B: `,` com tags `"vip, lead"` entre aspas guarda as duas', () => {
    const { rows } = parseCsv(`phone,name,tags\n${PHONE},Maria,"vip, lead"`);
    expect(rows[0]?.tags).toEqual(["vip", "lead"]);
  });

  it("C: `,` com tags `vip;lead` guarda as duas sem aspas", () => {
    const { rows } = parseCsv(`phone,name,tags\n${PHONE},Maria,vip;lead`);
    expect(rows[0]?.tags).toEqual(["vip", "lead"]);
  });

  it("D: `,` com tags no meio e sem aspas desloca as colunas seguintes (documenta)", () => {
    const { rows } = parseCsv(`phone,tags,name\n${PHONE},vip,lead,Maria`);
    expect(rows[0]?.tags).toEqual(["vip"]);
    expect(rows[0]?.name).toBe("lead");
  });

  it("E: CSV com `;` (o do Excel em português) reconhece as colunas", () => {
    const { rows, columns } = parseCsv(`phone;name;email\n${PHONE};Maria;maria@exemplo.com`);
    expect(columns).toEqual(["phone", "name", "email"]);
    expect(rows[0]).toMatchObject({ phone: PHONE, name: "Maria", email: "maria@exemplo.com" });
  });

  it('E2: `;` com tags `"vip, lead"` entre aspas guarda as duas', () => {
    const { rows } = parseCsv(`phone;name;tags\n${PHONE};Maria;"vip, lead"`);
    expect(rows[0]?.tags).toEqual(["vip", "lead"]);
  });

  it("E3: `,` com vírgula dentro de campo entre aspas não muda o delimitador", () => {
    const { rows } = parseCsv(`phone,name,tags\n${PHONE},"Silva, Maria","vip, sp"`);
    expect(rows[0]?.name).toBe("Silva, Maria");
    expect(rows[0]?.tags).toEqual(["vip", "sp"]);
    expect(sniffDelimiter(`phone;"empresa,filial"`)).toBe(";");
  });

  it("E4: tab como delimitador (o 'Texto' do Excel)", () => {
    const { rows } = parseCsv(`phone\tname\n${PHONE}\tMaria`);
    expect(rows[0]).toMatchObject({ phone: PHONE, name: "Maria" });
  });

  it("F: preserva o apóstrofo (Maria D'Ávila, O'Brien & Co), inclusive o que envolve a célula", () => {
    const { rows } = parseCsv(`phone,name,notes\n${PHONE},Maria D'Ávila,O'Brien & Co\n5511977776666,'Zé',x`);
    expect(rows[0]?.name).toBe("Maria D'Ávila");
    expect(rows[0]?.notes).toBe("O'Brien & Co");
    expect(rows[1]?.name).toBe("'Zé'");
  });

  it('G: `""` dentro de aspas vira uma aspa (RFC 4180)', () => {
    const { rows } = parseCsv(`phone,name\n${PHONE},"Maria ""Bibi"" Souza"`);
    expect(rows[0]?.name).toBe('Maria "Bibi" Souza');
  });

  it("K: só `;` e `,` separam etiquetas (`|` e `/` não), sem repetir e sem diferenciar a caixa", () => {
    expect(parseTagCell("vip|lead")).toEqual(["vip|lead"]);
    expect(parseTagCell("vip / lead")).toEqual(["vip / lead"]);
    expect(parseTagCell("VIP; vip ;Lead;;  ;lead")).toEqual(["VIP", "Lead"]);
    expect(parseTagCell("  ")).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe("parseCsv: arquivo hostil ou fora do comum", () => {
  it("BOM, CRLF e CR sozinho", () => {
    const bom = parseCsv(`﻿phone,name\r\n${PHONE},Maria\r\n5511977776666,João\r`);
    expect(bom.rows.map((row) => row.name)).toEqual(["Maria", "João"]);
    expect(parseCsv(`phone,name\r${PHONE},Maria`).rows).toHaveLength(1);
  });

  it("quebra de linha dentro de aspas fica na célula, e o número da linha é o da linha física", () => {
    const { rows } = parseCsv(`phone,notes\n${PHONE},"linha 1\nlinha 2\r\nlinha 3"\n5511977776666,fim`);
    expect(rows[0]?.notes).toBe("linha 1\nlinha 2\nlinha 3");
    expect(rows[0]?.sourceRow).toBe(2);
    expect(rows[1]?.sourceRow).toBe(5);
  });

  it("a dica `sep=;` do Excel dá o delimitador e não é dado", () => {
    const { rows } = parseCsv(`sep=;\nphone;name\n${PHONE};Maria`);
    expect(rows[0]).toMatchObject({ phone: PHONE, name: "Maria", sourceRow: 3 });
  });

  it("fórmula é só texto: nada é interpretado nem alterado", () => {
    const evil = ['=HYPERLINK("http://x","y")', "+SUM(1+1)", "-2+3", "@SUM(A1)", "=cmd|' /C calc'!A0"];
    const csv = `phone,name,notes\n${evil.map((value, i) => `5511977776${i}00,"${value.replaceAll('"', '""')}",${value.includes(",") ? '"x"' : value}`).join("\n")}`;
    const { rows } = parseCsv(csv);
    expect(rows.map((row) => row.name)).toEqual(evil);
  });

  it("aspas que não fecham são um erro com a linha, não um arquivo engolido", () => {
    const error = (() => {
      try {
        parseCsv(`phone,name\n${PHONE},"Maria\n5511977776666,João`);
      } catch (e) {
        return e as SpreadsheetParseError;
      }
    })();
    expect(error?.code).toBe("unclosed_quote");
    expect(error?.message).toContain("linha 2");
  });

  it("aspas no meio de uma célula sem aspas são caractere comum", () => {
    const { rows } = parseCsv(`phone,name\n${PHONE},5" de altura`);
    expect(rows[0]?.name).toBe('5" de altura');
  });

  it("célula gigante: guarda só o necessário e recusa a linha com motivo", () => {
    const { rows } = parseCsv(`phone,name,notes\n${PHONE},Maria,${"x".repeat(5_000_000)}\n5511977776666,João,ok`);
    expect(rows[0]?.problem).toContain("mais de");
    expect(rows[0]?.notes?.length).toBe(MAX_CELL_CHARS);
    expect(rows[1]?.problem).toBeUndefined();
  });

  it("célula de exatamente o teto passa", () => {
    const { rows } = parseCsv(`phone,notes\n${PHONE},${"x".repeat(MAX_CELL_CHARS)}`);
    expect(rows[0]?.problem).toBeUndefined();
  });

  it("linha só de delimitadores, aos milhões, termina depressa e fica em branco", () => {
    const started = Date.now();
    const { rows } = parseCsv(`phone,name\n${PHONE},Maria\n${",".repeat(2_000_000)}`);
    expect(rows).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("muitas aspas depois de uma célula já grande não custam tempo quadrático", () => {
    const started = Date.now();
    parseCsv(`phone,name\n${PHONE},${" ".repeat(1_500)}x${'"'.repeat(3_000_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("colunas além do teto são descartadas", () => {
    const header = `phone,${Array.from({ length: 300 }, (_, i) => `c${i}`).join(",")}`;
    const row = `${PHONE},${Array.from({ length: 300 }, (_, i) => i).join(",")}`;
    expect(parseCsv(`${header}\n${row}`).rows[0]?.phone).toBe(PHONE);
  });

  it("teto de linhas: o último que cabe passa, o seguinte é recusado sem ler o resto", () => {
    const body = (count: number) => Array.from({ length: count }, () => PHONE).join("\n");
    expect(parseCsv(`phone\n${body(MAX_IMPORT_ROWS)}`).rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(codeOf(() => parseCsv(`phone\n${body(MAX_IMPORT_ROWS + 1)}`))).toBe("too_many_rows");
  });

  it("linhas em branco não contam para o teto", () => {
    const rows = `${PHONE}\n\n`.repeat(MAX_IMPORT_ROWS);
    expect(parseCsv(`phone\n${rows}`).rows).toHaveLength(MAX_IMPORT_ROWS);
  });

  it("readCsvRecords devolve o delimitador detectado", () => {
    expect(readCsvRecords("a;b\n1;2").delimiter).toBe(";");
    expect(readCsvRecords("a\n1").delimiter).toBe(",");
  });
});
