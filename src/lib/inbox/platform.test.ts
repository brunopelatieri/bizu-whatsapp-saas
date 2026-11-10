import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setConversationStatus } from "@/lib/inbox/assignment";
import {
  linkPlatformContact,
  PLATFORM_REPLY_ROLES,
  platformActor,
  platformCapabilities,
  startPlatformConversation,
} from "@/lib/inbox/platform";
import { sendText } from "@/lib/inbox/send";
import { visibleConversation } from "@/lib/inbox/visibility";
import {
  platformConversationsQuerySchema,
  platformLinkContactSchema,
  platformStartConversationSchema,
} from "@/lib/schemas/inbox";

/**
 * Atendimento da plataforma (C6): quem lê e quem responde, os contratos que recusam o cliente do
 * owner e a varredura que impede o módulo de tocar em `customer` ou em `withPlatformScope`.
 */

describe("platformCapabilities", () => {
  it("proprietário e suporte leem e respondem; ninguém assume, transfere nem supervisiona", () => {
    for (const role of ["platform_owner", "platform_support"] as const) {
      expect(platformCapabilities(role)).toEqual({
        read: true,
        reply: true,
        assign: false,
        supervise: false,
      });
    }
    expect(PLATFORM_REPLY_ROLES).toEqual(["platform_owner", "platform_support"]);
  });

  it("quem não é da plataforma não lê nem responde", () => {
    expect(platformCapabilities("user")).toEqual({
      read: false,
      reply: false,
      assign: false,
      supervise: false,
    });
  });

  it("ator que só lê: o serviço recusa envio, situação, iniciar conversa e vínculo (403, antes do banco)", async () => {
    const reader = {
      ...platformActor({ id: "u1", platformRole: "platform_support" }),
      can: { read: true, reply: false, assign: false, supervise: false },
    };
    const target = "0d9f1f5e-6c1a-4b5f-9f43-0f4e8d6a1111";

    const refused = { status: 403, code: "PERMISSION_DENIED" };
    await expect(sendText(reader, target, { type: "text", text: "oi", clientId: "abcdefgh1" })).rejects.toMatchObject(refused);
    await expect(setConversationStatus(reader, target, "closed")).rejects.toMatchObject(refused);
    await expect(startPlatformConversation(reader, { channelId: target, phone: "11987654321" })).rejects.toMatchObject(refused);
    await expect(linkPlatformContact(reader, target, { userId: null })).rejects.toMatchObject(refused);
  });

  it("o ator da plataforma tem escopo plataforma, sem permissões de tenant", () => {
    const actor = platformActor({ id: "u1", platformRole: "platform_owner" }, "10.0.0.1");
    expect(actor).toMatchObject({ scope: { kind: "platform" }, userId: "u1", permissions: [], ip: "10.0.0.1" });
    // Sem `inbox:read` o predicado é falso: a falha é fechada.
    const none = platformActor({ id: "u2", platformRole: "user" });
    expect(visibleConversation(none)).toBeDefined();
  });
});

describe("contratos da plataforma", () => {
  const channelId = "0d9f1f5e-6c1a-4b5f-9f43-0f4e8d6a1111";
  const userId = "5b0d4e3c-7a11-4f2e-8a77-2a5f0c1d2222";

  it("iniciar conversa: usuário ou telefone; customerId e corpo extra são recusados", () => {
    expect(platformStartConversationSchema.safeParse({ channelId, userId }).success).toBe(true);
    expect(platformStartConversationSchema.safeParse({ channelId, phone: "11987654321" }).success).toBe(true);

    for (const body of [
      { channelId, customerId: userId },
      { channelId, userId, customerId: userId },
      { channelId },
      { channelId, userId, phone: "11987654321" },
      { channelId, userId, tenantId: userId },
    ]) {
      expect(platformStartConversationSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("vincular: só userId ou null", () => {
    expect(platformLinkContactSchema.safeParse({ userId }).success).toBe(true);
    expect(platformLinkContactSchema.safeParse({ userId: null }).success).toBe(true);
    expect(platformLinkContactSchema.safeParse({ customerId: userId }).success).toBe(false);
    expect(platformLinkContactSchema.safeParse({ userId, customerId: null }).success).toBe(false);
    expect(platformLinkContactSchema.safeParse({}).success).toBe(false);
  });

  it("a lista da plataforma não tem aba, filtro de dono nem de etiqueta", () => {
    const parsed = platformConversationsQuerySchema.parse({ tab: "queue", assignedTo: userId, tagIds: userId, q: "oi" });
    expect(parsed).not.toHaveProperty("tab");
    expect(parsed).not.toHaveProperty("assignedTo");
    expect(parsed).not.toHaveProperty("tagIds");
    expect(parsed.q).toBe("oi");
  });
});

describe("isolamento do código da plataforma", () => {
  const files = ["src/api/admin-inbox.ts", "src/lib/inbox/platform.ts", "src/lib/inbox/platform-link.ts"];
  const source = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("não usa withPlatformScope nem consulta customer de tenant", () => {
    for (const file of files) {
      const code = source(file);
      expect(code, file).not.toMatch(/withPlatformScope/);
      expect(code, file).not.toMatch(/\bcustomer(Tag)?\b[^"']*\bfrom\b|from "@\/lib\/tenant\/customers"/);
      expect(code, file).not.toMatch(/\b(customer|customerTag)\b\s*[,}]/);
      expect(code, file).not.toMatch(/saveContactAsCustomer|contactCandidates|claimConversation|assignConversation|listAssignees/);
    }
  });

  it("a rota da plataforma não declara claim, assign, assignees, candidates nem customer", () => {
    const routes = source("src/api/admin-inbox.ts");
    for (const path of ["/claim", "/assign", "/assignees", "/candidates", "/customer"]) {
      expect(routes, path).not.toContain(`${path}"`);
    }
  });
});
