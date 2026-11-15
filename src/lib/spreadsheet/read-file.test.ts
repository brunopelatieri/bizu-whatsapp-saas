import { describe, expect, it } from "vitest";
import { decodeSpreadsheetText, readSpreadsheetFile } from "@/lib/spreadsheet/read-file";
import { buildXlsx, buildZip } from "@/lib/spreadsheet/testing/xlsx-builder";
import { MAX_SPREADSHEET_BYTES, SpreadsheetParseError } from "@/lib/spreadsheet/types";
import { assertXlsxIsNotABomb } from "@/lib/spreadsheet/zip-guard";

const PHONE = "5511988887777";
const file = (name: string, content: string | Uint8Array) => new File([content as BlobPart], name);

async function failure(run: () => Promise<unknown> | unknown) {
  try {
    await run();
  } catch (error) {
    if (error instanceof SpreadsheetParseError) return error;
    throw error;
  }
  return null;
}

describe("decodeSpreadsheetText", () => {
  it("UTF-8, com e sem BOM (o decodificador já tira o BOM; o leitor de CSV tira o que sobrar)", () => {
    const text = "phone,name\n1,Á";
    expect(decodeSpreadsheetText(new TextEncoder().encode(text))).toBe(text);
    expect(decodeSpreadsheetText(new TextEncoder().encode(`﻿${text}`))).toBe(text);
  });

  it("Windows-1252, o CSV do Excel em português: acento não vira lixo", () => {
    // "José" com é = 0xE9 (inválido em UTF-8).
    expect(decodeSpreadsheetText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]))).toBe("José");
  });

  it("UTF-16 com marca de ordem (o 'Texto Unicode' do Excel)", () => {
    const text = "phone\tname\n1\tMaria";
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) le[2 + i * 2] = text.charCodeAt(i);
    expect(decodeSpreadsheetText(le)).toBe(text);
  });

  it("byte nulo em qualquer ponto (também depois dos primeiros 4096 bytes): não é texto", () => {
    const late = new Uint8Array(10_000).fill(0x61);
    late[9_000] = 0;
    expect(() => decodeSpreadsheetText(late)).toThrowError(
      expect.objectContaining({ code: "unsupported_format" }),
    );
  });

  it("byte nulo no começo: não é texto", () => {
    expect(() => decodeSpreadsheetText(new Uint8Array([0x50, 0x00, 0x01, 0x02]))).toThrowError(
      expect.objectContaining({ code: "unsupported_format" }),
    );
  });
});

describe("readSpreadsheetFile", () => {
  it("lê um CSV de Excel em português: Windows-1252, `;` e CRLF", async () => {
    const bytes = Uint8Array.from([..."phone;nome\r\n"].map((c) => c.charCodeAt(0)));
    const row = Uint8Array.from([..."5511988887777;Jos"].map((c) => c.charCodeAt(0)).concat([0xe9]));
    const all = new Uint8Array([...bytes, ...row]);

    const result = await readSpreadsheetFile(file("clientes.csv", all));
    expect(result.format).toBe("csv");
    expect(result.rows[0]).toMatchObject({ phone: PHONE, name: "José" });
  });

  it("lê um .xlsx", async () => {
    const xlsx = buildXlsx([{ name: "A", rows: [["phone", "name"], [PHONE, "Maria"]] }]);
    const result = await readSpreadsheetFile(file("clientes.xlsx", xlsx));
    expect(result.format).toBe("xlsx");
    expect(result.sheetName).toBe("A");
    expect(result.rows[0]).toMatchObject({ phone: PHONE, name: "Maria" });
  });

  it("o conteúdo manda: .xlsx renomeado para .csv abre, e CSV com nome .xlsx é recusado", async () => {
    const xlsx = buildXlsx([{ name: "A", rows: [["phone"], [PHONE]] }]);
    expect((await readSpreadsheetFile(file("x.csv", xlsx))).format).toBe("xlsx");
    expect((await failure(() => readSpreadsheetFile(file("x.xlsx", `phone\n${PHONE}`))))?.code).toBe("unreadable");
  });

  it("arquivo grande demais é recusado pelo tamanho declarado, sem ler", async () => {
    let read = false;
    const big = {
      name: "x.csv",
      size: MAX_SPREADSHEET_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    };
    expect((await failure(() => readSpreadsheetFile(big)))?.code).toBe("file_too_large");
    expect(read).toBe(false);
  });

  it("o teto vale também para os bytes lidos, se o tamanho declarado mentir", async () => {
    const liar = {
      name: "x.csv",
      size: 10,
      arrayBuffer: async () => new ArrayBuffer(MAX_SPREADSHEET_BYTES + 1),
    };
    expect((await failure(() => readSpreadsheetFile(liar)))?.code).toBe("file_too_large");
  });

  it("formato que não é planilha: extensão estranha, binário com nome .csv, .xls antigo, vazio", async () => {
    expect((await failure(() => readSpreadsheetFile(file("x.pdf", "%PDF"))))?.code).toBe("unsupported_format");
    expect((await failure(() => readSpreadsheetFile(file("x", "a"))))?.code).toBe("unsupported_format");
    expect((await failure(() => readSpreadsheetFile(file("x.csv", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1])))))?.code).toBe(
      "unsupported_format",
    );
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect((await failure(() => readSpreadsheetFile(file("x.xls", ole))))?.message).toContain(".xls");
    expect((await failure(() => readSpreadsheetFile(file("x.xlsx", ole))))?.message).toContain(".xls");
    expect((await failure(() => readSpreadsheetFile(file("x.csv", ""))))?.code).toBe("empty_file");
  });

  it("a mensagem de erro nunca carrega conteúdo do arquivo", async () => {
    const secret = "SEGREDO-DA-CELULA";
    const error = await failure(() => readSpreadsheetFile(file("x.csv", `name\n${secret}`)));
    expect(error?.code).toBe("missing_phone_column");
    expect(error?.message).not.toContain(secret);
  });
});

describe("assertXlsxIsNotABomb", () => {
  const entry = (declaredSize: number) => buildZip([{ name: "a.xml", content: "x", declaredSize }]);

  it("aceita um zip comum e o que não é zip", () => {
    expect(() => assertXlsxIsNotABomb(entry(1_000))).not.toThrow();
    expect(() => assertXlsxIsNotABomb(new TextEncoder().encode("não é zip"))).not.toThrow();
    expect(() => assertXlsxIsNotABomb(new Uint8Array(3))).not.toThrow();
  });

  it("recusa pelo tamanho que as entradas declaram descompactado, sem descomprimir", () => {
    expect(() => assertXlsxIsNotABomb(entry(70 * 1024 * 1024))).toThrowError(
      expect.objectContaining({ code: "file_too_large" }),
    );
    const two = buildZip([
      { name: "a.xml", content: "x", declaredSize: 40 * 1024 * 1024 },
      { name: "b.xml", content: "x", declaredSize: 40 * 1024 * 1024 },
    ]);
    expect(() => assertXlsxIsNotABomb(two)).toThrowError(expect.objectContaining({ code: "file_too_large" }));
  });

  it("recusa zip com entradas demais e o sinal de ZIP64", () => {
    const many = buildZip(Array.from({ length: 2_001 }, (_, i) => ({ name: `f${i}.xml`, content: "x" })));
    expect(() => assertXlsxIsNotABomb(many)).toThrowError(expect.objectContaining({ code: "unreadable" }));
    expect(() => assertXlsxIsNotABomb(entry(0xffffffff))).toThrowError(
      expect.objectContaining({ code: "file_too_large" }),
    );
  });

  it("a leitura do arquivo passa pela guarda antes de descomprimir", async () => {
    const bomb = buildXlsx([{ name: "A", rows: [["phone"], [PHONE]] }], [
      { name: "xl/big.xml", content: "x", declaredSize: 200 * 1024 * 1024 },
    ]);
    expect((await failure(() => readSpreadsheetFile(file("x.xlsx", bomb))))?.code).toBe("file_too_large");
  });
});
