import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  chronological,
  errorText,
  inboxKeys,
  invalidateInbox,
  type MessageView,
} from "@/components/inbox/inbox-api";
import { ApiError } from "@/lib/api/client";

const message = (id: string, createdAt: string): MessageView => ({
  id,
  conversationId: "c1",
  direction: "in",
  senderType: "contact",
  sender: null,
  type: "text",
  text: id,
  template: null,
  isFavorite: false,
  status: null,
  error: null,
  media: null,
  replyTo: null,
  createdAt,
});

describe("chronological", () => {
  it("junta as páginas (da mais nova para a mais antiga) em ordem de leitura, sem repetir", () => {
    const data = {
      pageParams: [undefined, "cursor"],
      pages: [
        { items: [message("c", "3"), message("b", "2")], nextCursor: "x" },
        // "b" volta na página seguinte quando uma mensagem entra entre as leituras.
        { items: [message("b", "2"), message("a", "1")], nextCursor: null },
      ],
    };

    expect(chronological(data).map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(chronological(undefined)).toEqual([]);
  });
});

describe("errorText", () => {
  it("usa a mensagem da API e traduz o limite do plano", () => {
    expect(errorText(new ApiError("Já tem dono.", 409, "ALREADY_ASSIGNED"))).toBe("Já tem dono.");
    expect(errorText(new ApiError("x", 403, "PLAN_LIMIT_REACHED"))).toContain("limite");
    expect(errorText(new Error("rede"))).toBe("Não foi possível concluir. Tente novamente.");
  });
});

describe("invalidateInbox", () => {
  const keysOf = (calls: { queryKey?: readonly unknown[] }[]) => calls.map(({ queryKey }) => queryKey);

  it("com conversa, relê lista, contador, detalhe e mensagens; sem mensagens quando pedido", async () => {
    const invalidate = vi.fn(async (_filters: { queryKey?: readonly unknown[] }) => undefined);
    const client = { invalidateQueries: invalidate } as unknown as QueryClient;

    await invalidateInbox(client, "t1", { conversationId: "c1" });
    expect(keysOf(invalidate.mock.calls.map(([filters]) => filters))).toEqual([
      ["inbox", "t1", "conversations"],
      ["inbox", "t1", "unread"],
      ["inbox", "t1", "conversation", "c1"],
      ["inbox", "t1", "messages", "c1"],
    ]);

    invalidate.mockClear();
    await invalidateInbox(client, "t1", { conversationId: "c1", messages: false });
    expect(invalidate).toHaveBeenCalledTimes(3);

    invalidate.mockClear();
    await invalidateInbox(client, "t1");
    expect(keysOf(invalidate.mock.calls.map(([filters]) => filters))).toContainEqual([
      "inbox",
      "t1",
      "conversation",
    ]);
    expect(keysOf(invalidate.mock.calls.map(([filters]) => filters))).not.toContainEqual([
      "inbox",
      "t1",
      "messages",
    ]);
  });
});

describe("inboxKeys", () => {
  it("todas as chaves ficam sob a raiz do tenant, para a C4 invalidar por ela", () => {
    const tenant = "t1";
    for (const key of [
      inboxKeys.conversations(tenant),
      inboxKeys.conversation(tenant, "c1"),
      inboxKeys.messages(tenant, "c1"),
      inboxKeys.unread(tenant),
      inboxKeys.assignees(tenant),
    ]) {
      expect(key.slice(0, 2)).toEqual(["inbox", tenant]);
    }
  });
});
