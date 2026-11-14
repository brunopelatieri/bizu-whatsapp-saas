import { describe, expect, it } from "vitest";
import {
  CHANNEL_PARAM,
  inboxPath,
  parseChannelParam,
  resolveChannelFilter,
} from "@/components/inbox/channel-filter";

const A = "3f2b8c1e-7a4d-4e8b-9c11-5d6e7f8a9b0c";
const B = "0b9e1d2c-4a3f-4c5d-8e7f-1a2b3c4d5e6f";

describe("parseChannelParam", () => {
  it("aceita um id de canal, com espaços e em maiúsculas", () => {
    expect(parseChannelParam(A)).toBe(A);
    expect(parseChannelParam(`  ${A.toUpperCase()} `)).toBe(A);
  });

  it("recusa o que não é um id: vazio, ausente, texto, script e id com sobra", () => {
    expect(parseChannelParam(undefined)).toBeUndefined();
    expect(parseChannelParam(null)).toBeUndefined();
    expect(parseChannelParam("")).toBeUndefined();
    expect(parseChannelParam("todos")).toBeUndefined();
    expect(parseChannelParam("<script>alert(1)</script>")).toBeUndefined();
    expect(parseChannelParam(`${A}&q=maria`)).toBeUndefined();
    expect(parseChannelParam(`${A},${B}`)).toBeUndefined();
  });
});

describe("resolveChannelFilter", () => {
  it("vale só o canal que está na lista do escopo", () => {
    expect(resolveChannelFilter(A, [A, B])).toBe(A);
  });

  it("canal que não existe ou é de outro escopo cai em todos", () => {
    expect(resolveChannelFilter(A, [B])).toBeUndefined();
    expect(resolveChannelFilter(A, [])).toBeUndefined();
  });

  it("sem parâmetro, ou com a lista de números ainda não lida, é todos", () => {
    expect(resolveChannelFilter(undefined, [A])).toBeUndefined();
    expect(resolveChannelFilter(A, undefined)).toBeUndefined();
  });
});

describe("inboxPath", () => {
  it("monta a rota da lista e da conversa, com o filtro só quando existe", () => {
    expect(inboxPath("/app/atendimento")).toBe("/app/atendimento");
    expect(inboxPath("/app/atendimento", "c1")).toBe("/app/atendimento/c1");
    expect(inboxPath("/admin/atendimento", undefined, A)).toBe(`/admin/atendimento?${CHANNEL_PARAM}=${A}`);
    expect(inboxPath("/app/atendimento", "c1", A)).toBe(`/app/atendimento/c1?${CHANNEL_PARAM}=${A}`);
  });
});
