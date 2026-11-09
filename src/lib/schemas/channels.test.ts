import { describe, expect, it } from "vitest";
import {
  createCloudChannelSchema,
  createQrChannelSchema,
  deleteChannelSchema,
  listChannelEventsQuerySchema,
  pairChannelSchema,
  updateChannelSchema,
} from "@/lib/schemas/channels";

const cloud = {
  name: "  Vendas  ",
  phoneNumberId: "200000000000001",
  wabaId: "100000000000001",
  accessToken: "EAAB-token-de-teste",
  appSecret: "segredo-do-aplicativo",
};

describe("createCloudChannelSchema", () => {
  it("aceita o mínimo, apara o nome e deixa appId e PIN ausentes", () => {
    const result = createCloudChannelSchema.parse(cloud);

    expect(result.name).toBe("Vendas");
    expect(result.appId).toBeUndefined();
    expect(result.pin).toBeUndefined();
  });

  it("appId e PIN vazios viram ausentes", () => {
    const result = createCloudChannelSchema.parse({ ...cloud, appId: "", pin: "  " });

    expect(result.appId).toBeUndefined();
    expect(result.pin).toBeUndefined();
  });

  it.each([
    ["nome vazio", { name: "   " }],
    ["nome longo", { name: "x".repeat(61) }],
    ["id do número com letras", { phoneNumberId: "../me" }],
    ["id do número com barra", { phoneNumberId: "123/messages" }],
    ["WABA curto", { wabaId: "12" }],
    ["token curto", { accessToken: "abc" }],
    ["segredo ausente", { appSecret: "" }],
    ["PIN de 4 dígitos", { pin: "1234" }],
    ["PIN com letras", { pin: "12345a" }],
  ])("recusa %s", (_, patch) => {
    expect(createCloudChannelSchema.safeParse({ ...cloud, ...patch }).success).toBe(false);
  });

  it("recusa campo que não existe (tenant_id do corpo nunca vale)", () => {
    expect(createCloudChannelSchema.safeParse({ ...cloud, tenantId: "x" }).success).toBe(false);
    expect(createCloudChannelSchema.safeParse({ ...cloud, status: "connected" }).success).toBe(false);
  });
});

describe("updateChannelSchema", () => {
  it("campos vazios mantêm o gravado (viram undefined)", () => {
    const result = updateChannelSchema.parse({ name: "Novo", accessToken: "", appSecret: "", pin: "" });

    expect(result).toEqual({ name: "Novo" });
  });

  it("aceita troca de token e segredo", () => {
    expect(updateChannelSchema.parse({ accessToken: "novo-token-valido", appSecret: "novo-segredo-valido" })).toEqual({
      accessToken: "novo-token-valido",
      appSecret: "novo-segredo-valido",
    });
  });

  it("recusa campo desconhecido e type", () => {
    expect(updateChannelSchema.safeParse({ type: "whatsapp_qr" }).success).toBe(false);
    expect(updateChannelSchema.safeParse({ phoneNumberId: "300000000000001" }).success).toBe(false);
  });
});

describe("demais contratos", () => {
  it("QR: só o nome", () => {
    expect(createQrChannelSchema.safeParse({ name: "Suporte" }).success).toBe(true);
    expect(createQrChannelSchema.safeParse({ name: "Suporte", url: "http://x" }).success).toBe(false);
  });

  it("pareamento: só dígitos com DDI", () => {
    expect(pairChannelSchema.safeParse({ phone: "5511999990001" }).success).toBe(true);
    for (const phone of ["+5511999990001", "11 99999-0001", "123", "abc", ""]) {
      expect(pairChannelSchema.safeParse({ phone }).success, phone).toBe(false);
    }
  });

  it("remoção exige o texto de confirmação", () => {
    expect(deleteChannelSchema.safeParse({ confirm: "Vendas" }).success).toBe(true);
    expect(deleteChannelSchema.safeParse({}).success).toBe(false);
  });

  it("lista de eventos: página padrão 1 e status conhecido", () => {
    expect(listChannelEventsQuerySchema.parse({})).toEqual({ page: 1 });
    expect(listChannelEventsQuerySchema.parse({ status: "failed", page: "3" })).toEqual({
      status: "failed",
      page: 3,
    });
    expect(listChannelEventsQuerySchema.safeParse({ status: "x" }).success).toBe(false);
    expect(listChannelEventsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
  });
});
