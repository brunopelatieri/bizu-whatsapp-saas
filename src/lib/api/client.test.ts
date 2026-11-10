import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "@/lib/api/client";

function mockFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof mockFetch>) {
  return new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
}

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retorna o corpo da resposta", async () => {
    mockFetch(Response.json({ ok: true }));

    await expect(apiFetch("/api/publica")).resolves.toEqual({ ok: true });
  });

  it("leva os campos extras do corpo do erro em `details`", async () => {
    mockFetch(
      Response.json(
        { error: "Já tem dono.", code: "ALREADY_ASSIGNED", assignedTo: { id: "u1", name: "Ana" } },
        { status: 409 },
      ),
    );

    const error = await apiFetch("/api/x").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ALREADY_ASSIGNED");
    expect((error as ApiError).details).toEqual({ assignedTo: { id: "u1", name: "Ana" } });
  });

  it("marca corpo em texto como JSON", async () => {
    const fetchMock = mockFetch(Response.json({ ok: true }));

    await apiFetch("/api/x", { method: "POST", body: JSON.stringify({ a: 1 }) });

    expect(sentHeaders(fetchMock).get("Content-Type")).toBe("application/json");
  });

  it("não troca o Content-Type informado nem o de FormData", async () => {
    const custom = mockFetch(Response.json({ ok: true }));
    await apiFetch("/api/x", {
      method: "POST",
      body: "a=1",
      headers: { "Content-Type": "text/plain" },
    });
    expect(sentHeaders(custom).get("Content-Type")).toBe("text/plain");

    const form = mockFetch(Response.json({ ok: true }));
    await apiFetch("/api/x", { method: "POST", body: new FormData() });
    expect(sentHeaders(form).has("Content-Type")).toBe(false);
  });

  it("lança ApiError com a mensagem e o status da API", async () => {
    mockFetch(Response.json({ error: "Sem acesso." }, { status: 403 }));

    const error = await apiFetch("/api/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: "Sem acesso.", status: 403 });
  });
});
