import { describe, expect, it } from "vitest";
import {
  GoogleSheetLinkError,
  type GoogleSheetLinkErrorCode,
  googleSheetExportUrl,
  parseGoogleSheetLink,
} from "@/lib/spreadsheet/google-sheets-link";

/** Identificador no formato real (44 caracteres). Fictício. */
const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde".slice(0, 44);

/** Caractere pelo código: o fonte fica sem caractere invisível ou de controle literal. */
const ch = (code: number) => String.fromCodePoint(code);

function codeOf(input: string): GoogleSheetLinkErrorCode | "ok" {
  try {
    parseGoogleSheetLink(input);
    return "ok";
  } catch (error) {
    if (error instanceof GoogleSheetLinkError) return error.code;
    throw error;
  }
}

describe("parseGoogleSheetLink: links válidos", () => {
  it.each([
    [`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`, undefined],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, "0"],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit?gid=123456789#gid=123456789`, "123456789"],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42&range=A1:C3`, "42"],
    [`https://docs.google.com/spreadsheets/d/${ID}`, undefined],
    [`https://docs.google.com/spreadsheets/d/${ID}/`, undefined],
    [`https://docs.google.com/spreadsheets/d/${ID}/view`, undefined],
    [`https://docs.google.com/spreadsheets/d/${ID}/htmlview`, undefined],
    [`https://docs.google.com/spreadsheets/u/0/d/${ID}/edit`, undefined],
    [`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit#gid=7`, "7"],
    [`https://DOCS.GOOGLE.COM/spreadsheets/d/${ID}/edit`, undefined],
    [`  https://docs.google.com/spreadsheets/d/${ID}/edit  `, undefined],
    [`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=5`, "5"],
    [`https://docs.google.com/a/empresa.com.br/spreadsheets/d/${ID}/edit#gid=3`, "3"],
  ])("%s", (link, gid) => {
    expect(parseGoogleSheetLink(link)).toEqual(
      gid === undefined ? { spreadsheetId: ID } : { spreadsheetId: ID, gid },
    );
  });

  it("caminho com `..` antes da planilha é normalizado pelo URL, e só o id é usado", () => {
    expect(parseGoogleSheetLink(`https://docs.google.com/x/../spreadsheets/d/${ID}/edit`)).toEqual({
      spreadsheetId: ID,
    });
  });

  it("letras de largura total viram ASCII pelo URL (é o mesmo host) e o id segue estrito", () => {
    expect(codeOf(`https://${ch(0xff44)}ocs.google.com/spreadsheets/d/${ID}/edit`)).toBe("ok");
  });
});

describe("parseGoogleSheetLink: links hostis", () => {
  it.each<[string, string, GoogleSheetLinkErrorCode]>([
    ["vazio", "   ", "empty"],
    ["texto qualquer", "minha planilha", "invalid_url"],
    ["sem esquema", `docs.google.com/spreadsheets/d/${ID}/edit`, "not_https"],
    ["http", `http://docs.google.com/spreadsheets/d/${ID}/edit`, "not_https"],
    ["javascript:", "javascript:alert(1)", "invalid_url"],
    ["data:", "data:text/csv,phone%0A1", "invalid_url"],
    ["file:", "file:///etc/passwd", "invalid_url"],
    ["ftp", `ftp://docs.google.com/spreadsheets/d/${ID}`, "invalid_url"],
    ["host como sufixo", `https://docs.google.com.evil.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["host como prefixo", `https://evildocs.google.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["outro subdomínio do Google", `https://sheets.google.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["host no caminho", `https://evil.com/docs.google.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["host na consulta", `https://evil.com/?u=https://docs.google.com/spreadsheets/d/${ID}`, "not_google_sheets"],
    ["credenciais (o host real é evil.com)", `https://docs.google.com@evil.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["credenciais no host certo", `https://user:pass@docs.google.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["só usuário no host certo", `https://user@docs.google.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["porta", `https://docs.google.com:8443/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["IPv4 literal", `https://142.250.219.225/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["IPv4 em decimal", `https://2398796769/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["IPv4 em hexadecimal", `https://0x8efadbe1/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["IPv6 literal", `https://[::1]/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["metadados da nuvem", "https://169.254.169.254/latest/meta-data/", "not_google_sheets"],
    ["localhost", `https://localhost/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["ponto final no host", `https://docs.google.com./spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["homógrafo cirílico", `https://docs.g${ch(0x43e)}${ch(0x43e)}gle.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["IDN em punycode", `https://xn--dcs-qma.google.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["ponto ideográfico no host", `https://docs${ch(0x3002)}google${ch(0x3002)}com.evil.com/spreadsheets/d/${ID}/edit`, "not_google_sheets"],
    ["documento", `https://docs.google.com/document/d/${ID}/edit`, "other_google_product"],
    ["apresentação", `https://docs.google.com/presentation/d/${ID}/edit`, "other_google_product"],
    ["formulário", `https://docs.google.com/forms/d/${ID}/edit`, "other_google_product"],
    ["documento do Workspace", `https://docs.google.com/a/empresa.com/document/d/${ID}/edit`, "other_google_product"],
    ["domínio do Workspace com barra codificada", `https://docs.google.com/a/x%2fy/spreadsheets/d/${ID}/edit`, "other_google_product"],
    ["desenho", `https://docs.google.com/drawings/d/${ID}/edit`, "other_google_product"],
    ["arquivo do Drive", `https://drive.google.com/file/d/${ID}/view`, "not_google_sheets"],
    ["Drive open", `https://drive.google.com/open?id=${ID}`, "not_google_sheets"],
    ["raiz do docs", "https://docs.google.com/", "other_google_product"],
    ["lista de planilhas", "https://docs.google.com/spreadsheets/u/0/", "other_google_product"],
    ["publicada na Web", "https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pubhtml", "published_link"],
    ["id com ..", "https://docs.google.com/spreadsheets/d/abcdefghij..klmnopqrstuvwxyz/edit", "invalid_id"],
    ["id com %2f", "https://docs.google.com/spreadsheets/d/abcdefghij%2fklmnopqrstuvwxyz/edit", "invalid_id"],
    ["id com %2F maiúsculo", "https://docs.google.com/spreadsheets/d/abcdefghij%2Fklmnopqrstuvwxyz/edit", "invalid_id"],
    ["id só com %2e%2e", "https://docs.google.com/spreadsheets/d/%2e%2e/edit", "other_google_product"],
    ["id com %00", "https://docs.google.com/spreadsheets/d/abcdefghij%00klmnopqrstuvwxyz/edit", "invalid_id"],
    ["id curto", "https://docs.google.com/spreadsheets/d/abc/edit", "invalid_id"],
    ["id absurdo", `https://docs.google.com/spreadsheets/d/${"a".repeat(500)}/edit`, "invalid_id"],
    ["id com letra acentuada", `https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwx${ch(0xe9)}/edit`, "invalid_id"],
    ["link gigante", `https://docs.google.com/spreadsheets/d/${ID}/edit?x=${"a".repeat(3000)}`, "too_long"],
    ["caractere nulo", `https://docs.google.com/spreadsheets/d/${ID}${ch(0)}/edit`, "invalid_url"],
    ["quebra de linha no meio", `https://docs.google.com/spreadsheets/d/${ID}${ch(10)}/edit`, "invalid_url"],
    ["retorno de carro no meio", `https://docs.google.com${ch(13)}/spreadsheets/d/${ID}/edit`, "invalid_url"],
    ["tab no meio", `https://docs.google.com/spreadsheets/d/${ID}${ch(9)}/edit`, "invalid_url"],
    ["DEL", `https://docs.google.com/spreadsheets/d/${ID}${ch(0x7f)}/edit`, "invalid_url"],
    ["espaço de largura zero", `https://docs.google.com${ch(0x200b)}/spreadsheets/d/${ID}/edit`, "invalid_url"],
    ["inversão de direção", `https://docs.google.com/spreadsheets/d/${ID}${ch(0x202e)}/edit`, "invalid_url"],
    ["espaço sem quebra", `https://docs.google.com/spreadsheets/d/${ID}${ch(0xa0)}/edit`, "invalid_url"],
    ["espaço no meio", `https://docs.google.com/spreadsheets/d/${ID} /edit`, "invalid_url"],
    ["gid com letras", `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=abc`, "invalid_gid"],
    ["gid negativo", `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=-1`, "invalid_gid"],
    ["gid absurdo", `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=${"9".repeat(30)}`, "invalid_gid"],
    ["gid com barra codificada", `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1%2f..`, "invalid_gid"],
    ["gid que injeta parâmetro", `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1%26format%3Dhtml`, "invalid_gid"],
    ["dois gids diferentes", `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=1#gid=2`, "invalid_gid"],
  ])("%s", (_label, link, code) => {
    expect(codeOf(link)).toBe(code);
  });

  it("a mensagem do erro nunca repete o que foi colado", () => {
    const link = `https://docs.google.com.evil.com/spreadsheets/d/${ID}/edit`;
    let message = "";
    try {
      parseGoogleSheetLink(link);
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleSheetLinkError);
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("evil");
    expect(message).not.toContain(ID);
  });
});

describe("googleSheetExportUrl", () => {
  it("monta o endereço só com os identificadores, sempre em https://docs.google.com", () => {
    expect(googleSheetExportUrl({ spreadsheetId: ID, gid: "7" }).href).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=7`,
    );
    expect(googleSheetExportUrl({ spreadsheetId: ID }).href).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`,
    );
  });

  it("nada do link colado chega ao endereço montado (conta, consulta, chave, fragmento)", () => {
    const ref = parseGoogleSheetLink(
      `https://docs.google.com/spreadsheets/u/3/d/${ID}/edit?usp=sharing&resourcekey=abc&ouid=1#gid=9&range=A1`,
    );
    expect(googleSheetExportUrl(ref).href).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=9`,
    );
  });

  it("recusa referência montada à mão com id ou gid fora do formato", () => {
    expect(() => googleSheetExportUrl({ spreadsheetId: "../../evil" })).toThrow(GoogleSheetLinkError);
    expect(() => googleSheetExportUrl({ spreadsheetId: `${ID}/../x` })).toThrow(GoogleSheetLinkError);
    expect(() => googleSheetExportUrl({ spreadsheetId: ID, gid: "1&format=html" })).toThrow(
      GoogleSheetLinkError,
    );
  });
});
