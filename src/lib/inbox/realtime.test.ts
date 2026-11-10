import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { noticePayload } from "@/lib/inbox/notify";
import { parseInboxNotice } from "@/lib/inbox/realtime";
import { type InboxActor, inboxCapabilities, noticeVisibleTo, ownerVisible } from "@/lib/inbox/visibility";

const tenant = randomUUID();
const otherTenant = randomUUID();
const me = randomUUID();
const other = randomUUID();
const conversationId = randomUUID();

const actor = (permissions: string[], scope: InboxActor["scope"] = { kind: "tenant", tenantId: tenant }): InboxActor => ({
  scope,
  userId: me,
  can: inboxCapabilities(permissions),
  permissions,
});

const member = actor(["inbox:read", "inbox:reply"]);
const supervisor = actor(["inbox:read", "inbox:reply", "inbox:supervise"]);

describe("carga do aviso (notifyInbox)", () => {
  it("leva só as chaves de ids, sem texto, nome ou telefone, mesmo que alguém as passe", () => {
    const smuggled = {
      s: tenant,
      c: conversationId,
      k: "message",
      m: randomUUID(),
      a: null,
      text: "segredo do paciente",
      phone: "+5511999990000",
    } as never;

    const payload = JSON.parse(noticePayload(smuggled));
    expect(Object.keys(payload).sort()).toEqual(["a", "c", "k", "m", "s"]);
    expect(JSON.stringify(payload)).not.toContain("segredo");
  });

  it("omite o que não veio e mantém o null da fila", () => {
    expect(JSON.parse(noticePayload({ s: null, c: conversationId, k: "status" }))).toEqual({
      s: null,
      c: conversationId,
      k: "status",
    });
    expect(JSON.parse(noticePayload({ s: tenant, c: conversationId, k: "conversation", a: null, p: me }))).toEqual({
      s: tenant,
      c: conversationId,
      k: "conversation",
      a: null,
      p: me,
    });
  });
});

describe("parseInboxNotice", () => {
  it("aceita a carga que o notifyInbox monta", () => {
    const raw = noticePayload({ s: tenant, c: conversationId, k: "conversation", a: me, p: null, u: other });
    expect(parseInboxNotice(raw)).toEqual({ s: tenant, c: conversationId, k: "conversation", a: me, p: null, u: other });
  });

  it.each([
    ["JSON inválido", "{"],
    ["lista", "[]"],
    ["chave a mais", JSON.stringify({ s: tenant, c: conversationId, k: "message", text: "oi" })],
    ["conversa que não é id", JSON.stringify({ s: tenant, c: "x", k: "message" })],
    ["tipo desconhecido", JSON.stringify({ s: tenant, c: conversationId, k: "typing" })],
    ["dono que não é id", JSON.stringify({ s: tenant, c: conversationId, k: "message", a: "<script>" })],
    ["escopo ausente", JSON.stringify({ c: conversationId, k: "message" })],
    ["grande demais", JSON.stringify({ s: tenant, c: conversationId, k: "message", pad: "x".repeat(2000) })],
  ])("descarta %s", (_case, raw) => {
    expect(parseInboxNotice(raw)).toBeNull();
  });
});

describe("filtro do SSE por pessoa (noticeVisibleTo)", () => {
  const notice = (owners: { a?: string | null; p?: string | null }, s: string | null = tenant) => ({ s, ...owners });

  it("membro: recebe a fila e as próprias; nunca a conversa de outro membro", () => {
    expect(noticeVisibleTo(member, notice({ a: null }))).toBe(true);
    expect(noticeVisibleTo(member, notice({ a: me }))).toBe(true);
    expect(noticeVisibleTo(member, notice({ a: other }))).toBe(false);
    expect(noticeVisibleTo(member, notice({ a: other, p: other }))).toBe(false);
  });

  it("entrar e sair da fila chega a quem a via (p) e a quem passa a ver (a)", () => {
    // Outro membro assumiu da fila: a conversa sai da minha fila.
    expect(noticeVisibleTo(member, notice({ a: other, p: null }))).toBe(true);
    // Outro devolveu à fila: entra na minha.
    expect(noticeVisibleTo(member, notice({ a: null, p: other }))).toBe(true);
    // Transferida de mim para outro, e de outro para mim.
    expect(noticeVisibleTo(member, notice({ a: other, p: me }))).toBe(true);
    expect(noticeVisibleTo(member, notice({ a: me, p: other }))).toBe(true);
  });

  it("dono desconhecido só passa para quem supervisiona (falha fechada)", () => {
    expect(noticeVisibleTo(member, notice({}))).toBe(false);
    expect(noticeVisibleTo(supervisor, notice({}))).toBe(true);
    expect(ownerVisible(member, undefined)).toBe(false);
  });

  it("supervisor recebe todas do tenant; ninguém recebe de outro tenant nem da plataforma", () => {
    expect(noticeVisibleTo(supervisor, notice({ a: other }))).toBe(true);
    expect(noticeVisibleTo(supervisor, notice({ a: null }, otherTenant))).toBe(false);
    expect(noticeVisibleTo(member, notice({ a: null }, otherTenant))).toBe(false);
    expect(noticeVisibleTo(supervisor, notice({ a: null }, null))).toBe(false);
  });

  it("sem inbox:read, nada (inclusive supervise sozinho)", () => {
    expect(noticeVisibleTo(actor([]), notice({ a: null }))).toBe(false);
    expect(noticeVisibleTo(actor(["inbox:supervise"]), notice({ a: null }))).toBe(false);
  });

  it("plataforma (C6): só avisos sem tenant, todos", () => {
    const platform = actor(["inbox:read"], { kind: "platform" });
    expect(noticeVisibleTo(platform, notice({ a: null }, null))).toBe(true);
    expect(noticeVisibleTo(platform, notice({ a: null }))).toBe(false);
  });
});
