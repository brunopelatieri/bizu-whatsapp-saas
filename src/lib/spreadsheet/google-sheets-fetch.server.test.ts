import { describe, expect, it } from "vitest";
import {
  fetchGoogleSheetCsv,
  httpsTransport,
  MAX_REDIRECTS,
  type ResolvedAddress,
  type SheetFetchDeps,
  SheetFetchError,
  type SheetFetchErrorCode,
  type TransportRequest,
  type UpstreamResponse,
} from "@/lib/spreadsheet/google-sheets-fetch.server";
import type { GoogleSheetRef } from "@/lib/spreadsheet/google-sheets-link";

/**
 * A guarda de SSRF da I3 sem rede: o resolvedor de nomes e o transporte são falsos, e cada teste
 * diz o que o "Google" responde em cada salto.
 */

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const REF: GoogleSheetRef = { spreadsheetId: ID, gid: "0" };
const CONTENT_HOST = "doc-08-4o-sheets.googleusercontent.com";
const CONTENT_URL = `https://${CONTENT_HOST}/export/abc/def/1794685880000/100630705629414352418/*/${ID}?format=csv&gid=0`;
const CSV = "telefone;nome\n11987654321;Maria\n";

type Reply = {
  status: number;
  headers?: Record<string, string>;
  /** Pedaços do corpo; `hang` nunca termina (para o tempo limite). */
  body?: (string | Uint8Array)[] | "hang";
};

const encoder = new TextEncoder();

function response(reply: Reply, closed: { count: number }): UpstreamResponse {
  const headers = Object.fromEntries(
    Object.entries(reply.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const body = reply.body ?? [];

  return {
    status: reply.status,
    header: (name) => headers[name.toLowerCase()],
    body: {
      async *[Symbol.asyncIterator]() {
        if (body === "hang") {
          yield encoder.encode("telefone\n");
          await new Promise(() => undefined);
          return;
        }
        for (const chunk of body) yield typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      },
    },
    close: () => {
      closed.count += 1;
    },
  };
}

const redirect = (location: string, status = 307): Reply => ({ status, headers: { Location: location } });
const csv = (text = CSV, extra: Record<string, string> = {}): Reply => ({
  status: 200,
  headers: { "Content-Type": "text/csv; charset=utf-8", ...extra },
  body: [text],
});

/**
 * Monta as dependências: `replies` responde por salto (na ordem), `dns` resolve por host (o padrão é
 * um IP público do Google). Guarda o que foi pedido para o teste conferir.
 */
function fake(
  replies: (Reply | "hang")[],
  options: { dns?: Record<string, string[]>; totalTimeoutMs?: number; maxBytes?: number } = {},
) {
  const requests: TransportRequest[] = [];
  const resolved: string[] = [];
  const closed = { count: 0 };

  const deps: SheetFetchDeps = {
    resolve: async (hostname) => {
      resolved.push(hostname);
      const addresses = options.dns?.[hostname] ?? ["142.250.219.225"];
      return addresses.map((address): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    transport: async (request) => {
      requests.push(request);
      const reply = replies[requests.length - 1];
      if (!reply) throw new Error("salto não esperado pelo teste");
      if (reply === "hang") return new Promise<UpstreamResponse>(() => undefined);
      return response(reply, closed);
    },
    totalTimeoutMs: options.totalTimeoutMs ?? 5_000,
    connectTimeoutMs: 1_000,
    maxBytes: options.maxBytes ?? 1_000,
  };

  return { deps, requests, resolved, closed };
}

async function codeOf(promise: Promise<unknown>): Promise<SheetFetchErrorCode | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof SheetFetchError) return error.code;
    throw error;
  }
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("o caminho real (observado em 2026-11-14)", () => {
  it("docs.google.com responde 307 para o googleusercontent, que entrega o CSV sem Content-Length", async () => {
    const { deps, requests, resolved } = fake([redirect(CONTENT_URL), csv()]);

    expect(text(await fetchGoogleSheetCsv(REF, deps))).toBe(CSV);
    expect(requests.map(({ url }) => url.href)).toEqual([
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=0`,
      CONTENT_URL,
    ]);
    expect(resolved).toEqual(["docs.google.com", CONTENT_HOST]);
  });

  it("só manda os cabeçalhos fixos: sem cookie, sem autorização, sem nada do usuário, sem compressão", async () => {
    const { deps, requests } = fake([redirect(CONTENT_URL), csv()]);
    await fetchGoogleSheetCsv(REF, deps);

    for (const request of requests) {
      expect(Object.keys(request.headers).sort()).toEqual(["Accept", "Accept-Encoding", "User-Agent"]);
      expect(request.headers["Accept-Encoding"]).toBe("identity");
      expect(request.headers["User-Agent"]).not.toMatch(/bizu|@/i);
    }
  });

  it("a conexão recebe os IPs já conferidos, do host daquele salto", async () => {
    const { deps, requests } = fake([redirect(CONTENT_URL), csv()], {
      dns: { [CONTENT_HOST]: ["142.250.219.225", "2800:3f0:4001:817::2001"] },
    });
    await fetchGoogleSheetCsv(REF, deps);

    expect(requests[1]?.addresses).toEqual([
      { address: "142.250.219.225", family: 4 },
      { address: "2800:3f0:4001:817::2001", family: 6 },
    ]);
  });

  it("sem gid, o endereço montado não leva gid (o Google exporta a primeira aba)", async () => {
    const { deps, requests } = fake([redirect(CONTENT_URL), csv()]);
    await fetchGoogleSheetCsv({ spreadsheetId: ID }, deps);
    expect(requests[0]?.url.href).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv`);
  });

  it("redirecionamento relativo dentro de docs.google.com é seguido pela mesma lista", async () => {
    const { deps, requests } = fake([redirect(`/spreadsheets/d/${ID}/export?format=csv&id=1`), redirect(CONTENT_URL), csv()]);
    expect(text(await fetchGoogleSheetCsv(REF, deps))).toBe(CSV);
    expect(requests[1]?.url.href).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&id=1`);
  });
});

describe("redirecionamentos", () => {
  it.each<[string, string, SheetFetchErrorCode]>([
    ["host fora da lista", "https://evil.com/export/x", "unexpected_redirect"],
    ["googleusercontent genérico (conteúdo de qualquer usuário)", `https://lh3.googleusercontent.com/export/x`, "unexpected_redirect"],
    ["parecido com o host da exportação", `https://doc-08-4o-sheets.googleusercontent.com.evil.com/export/x`, "unexpected_redirect"],
    ["grupo a mais no host", `https://doc-08-4o-xx-sheets.googleusercontent.com/export/x`, "unexpected_redirect"],
    ["caminho fora da exportação", `https://${CONTENT_HOST}/outra/coisa`, "unexpected_redirect"],
    ["docs.google.com fora de /spreadsheets/", "https://docs.google.com/document/d/x/export", "unexpected_redirect"],
    ["http", `http://${CONTENT_HOST}/export/x`, "unexpected_redirect"],
    ["http em docs.google.com", `http://docs.google.com/spreadsheets/d/${ID}/export`, "unexpected_redirect"],
    ["porta", `https://${CONTENT_HOST}:8443/export/x`, "unexpected_redirect"],
    ["credenciais", `https://user:pass@${CONTENT_HOST}/export/x`, "unexpected_redirect"],
    ["IP privado literal", "https://10.0.0.1/export/x", "unexpected_redirect"],
    ["metadados da nuvem", "http://169.254.169.254/latest/meta-data/", "unexpected_redirect"],
    ["localhost", "https://localhost/export/x", "unexpected_redirect"],
    ["outro esquema", "file:///etc/passwd", "unexpected_redirect"],
    ["javascript:", "javascript:alert(1)", "unexpected_redirect"],
    ["login do Google (planilha privada)", "https://accounts.google.com/ServiceLogin?service=wise&continue=x", "not_shared"],
    ["login do Google em docs.google.com", "https://docs.google.com/accounts/ServiceLogin?continue=x", "not_shared"],
  ])("para %s", async (_label, location, code) => {
    const { deps, requests, closed } = fake([redirect(location), csv()]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe(code);
    // O segundo salto nunca acontece, e a resposta do redirecionamento é fechada.
    expect(requests).toHaveLength(1);
    expect(closed.count).toBe(1);
  });

  it("sem Location, encerra", async () => {
    const { deps } = fake([{ status: 302 }]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("unexpected_redirect");
  });

  it.each([301, 302, 303, 308])("segue %i como o 307", async (status) => {
    const { deps } = fake([redirect(CONTENT_URL, status), csv()]);
    expect(text(await fetchGoogleSheetCsv(REF, deps))).toBe(CSV);
  });

  it(`em cadeia: aceita ${MAX_REDIRECTS} saltos e recusa o seguinte`, async () => {
    const hop = redirect(`/spreadsheets/d/${ID}/export?format=csv`);
    const within = fake([...Array<Reply>(MAX_REDIRECTS).fill(hop), csv()]);
    expect(text(await fetchGoogleSheetCsv(REF, within.deps))).toBe(CSV);

    const beyond = fake([...Array<Reply>(MAX_REDIRECTS + 1).fill(hop), csv()]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, beyond.deps))).toBe("unexpected_redirect");
    expect(beyond.requests).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("um ciclo de redirecionamentos termina no teto", async () => {
    const { deps, requests } = fake(Array<Reply>(20).fill(redirect(CONTENT_URL.replace("/export/", "/export/loop/"))));
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("unexpected_redirect");
    expect(requests.length).toBeLessThanOrEqual(MAX_REDIRECTS + 1);
  });
});

describe("resolução de nome (o host está na lista, o IP não)", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["privada", "10.1.2.3"],
    ["metadados da nuvem", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
    ["IPv4 mapeado", "::ffff:192.168.0.1"],
    ["ULA", "fd00:ec2::254"],
  ])("docs.google.com resolvendo para %s: nem conecta", async (_label, address) => {
    const { deps, requests } = fake([csv()], { dns: { "docs.google.com": [address] } });
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("blocked_address");
    expect(requests).toHaveLength(0);
  });

  it("o host do redirecionamento resolvendo para faixa privada: nem conecta", async () => {
    const { deps, requests } = fake([redirect(CONTENT_URL), csv()], { dns: { [CONTENT_HOST]: ["192.168.0.10"] } });
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("blocked_address");
    expect(requests).toHaveLength(1);
  });

  it("um IP privado no meio de públicos recusa o host inteiro", async () => {
    const { deps, requests } = fake([csv()], { dns: { "docs.google.com": ["142.250.219.225", "127.0.0.1"] } });
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("blocked_address");
    expect(requests).toHaveLength(0);
  });

  it("nenhum IP, ou falha do DNS, encerra sem conectar", async () => {
    const empty = fake([csv()], { dns: { "docs.google.com": [] } });
    expect(await codeOf(fetchGoogleSheetCsv(REF, empty.deps))).toBe("blocked_address");

    const broken = fake([csv()]);
    broken.deps.resolve = async () => {
      throw new Error("ENOTFOUND docs.google.com");
    };
    expect(await codeOf(fetchGoogleSheetCsv(REF, broken.deps))).toBe("upstream");
    expect(broken.requests).toHaveLength(0);
  });
});

describe("tamanho, tipo e tempo", () => {
  it("acima do teto sem Content-Length: corta enquanto lê e fecha a conexão", async () => {
    const chunks = Array.from({ length: 50 }, () => "x".repeat(100));
    const { deps, closed } = fake([{ status: 200, headers: { "Content-Type": "text/csv" }, body: chunks }]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("too_large");
    expect(closed.count).toBe(1);
  });

  it("acima do teto com Content-Length verdadeiro: recusa antes de ler", async () => {
    const { deps, closed } = fake([csv("x".repeat(10), { "Content-Length": "5000" })]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("too_large");
    expect(closed.count).toBe(1);
  });

  it("Content-Length mentiroso (pequeno) não engana: o teto vale para os bytes lidos", async () => {
    const { deps } = fake([csv("x".repeat(5000), { "Content-Length": "10" })]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("too_large");
  });

  it("exatamente no teto passa", async () => {
    const { deps } = fake([csv("x".repeat(1000))]);
    expect((await fetchGoogleSheetCsv(REF, deps)).byteLength).toBe(1000);
  });

  it.each([
    ["HTML (página de login com 200)", "text/html; charset=utf-8"],
    ["binário", "application/octet-stream"],
    ["o tipo do redirecionamento do Google", "application/binary"],
    ["XLSX", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["JSON", "application/json"],
    ["sem tipo", ""],
  ])("resposta que não é texto: %s", async (_label, type) => {
    const { deps } = fake([{ status: 200, headers: type ? { "Content-Type": type } : {}, body: [CSV] }]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("not_csv");
  });

  it("text/plain é aceito", async () => {
    const { deps } = fake([{ status: 200, headers: { "Content-Type": "text/plain" }, body: [CSV] }]);
    expect(text(await fetchGoogleSheetCsv(REF, deps))).toBe(CSV);
  });

  it("corpo de zip ou com byte nulo, mesmo com tipo de CSV, não passa", async () => {
    const zip = fake([{ status: 200, headers: { "Content-Type": "text/csv" }, body: [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2])] }]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, zip.deps))).toBe("not_csv");
    const nul = fake([{ status: 200, headers: { "Content-Type": "text/csv" }, body: [new Uint8Array([0x61, 0x00, 0x62])] }]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, nul.deps))).toBe("not_csv");
  });

  it("resposta comprimida, mesmo sem ter pedido, é recusada (nada é descomprimido)", async () => {
    const { deps } = fake([csv(CSV, { "Content-Encoding": "gzip" })]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("upstream");
  });

  it("corpo vazio", async () => {
    const { deps } = fake([csv("")]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("empty");
  });

  it("tempo limite: o Google não responde", async () => {
    const { deps } = fake(["hang"], { totalTimeoutMs: 50 });
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("timeout");
  });

  it("tempo limite: o corpo para no meio (o total vale também para a leitura)", async () => {
    const { deps, closed } = fake([{ status: 200, headers: { "Content-Type": "text/csv" }, body: "hang" }], {
      totalTimeoutMs: 50,
    });
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("timeout");
    expect(closed.count).toBe(1);
  });

  it("o tempo limite é do total, somando os saltos", async () => {
    const { deps } = fake([redirect(CONTENT_URL), "hang"], { totalTimeoutMs: 50 });
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("timeout");
  });

  it("falha de rede vira upstream, sem a mensagem original (que traz o endereço)", async () => {
    const { deps } = fake([]);
    deps.transport = async () => {
      throw new Error(`connect ECONNREFUSED https://docs.google.com/spreadsheets/d/${ID}`);
    };
    let message = "";
    try {
      await fetchGoogleSheetCsv(REF, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(SheetFetchError);
      message = (error as Error).message;
    }
    expect(message).not.toContain(ID);
  });
});

describe("respostas de erro do Google viram mensagens do que fazer", () => {
  it.each<[number, SheetFetchErrorCode]>([
    [401, "not_shared"],
    [403, "not_shared"],
    [404, "not_found"],
    [400, "upstream"],
    [429, "google_rate_limited"],
    [500, "upstream"],
    [503, "upstream"],
  ])("HTTP %i → %s, sem repassar o corpo", async (status, code) => {
    const { deps, closed } = fake([
      { status, headers: { "Content-Type": "text/html" }, body: ["<html>segredo do Google</html>"] },
    ]);
    let message = "";
    try {
      await fetchGoogleSheetCsv(REF, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(SheetFetchError);
      expect((error as SheetFetchError).code).toBe(code);
      message = (error as Error).message;
    }
    expect(message).not.toContain("segredo");
    expect(closed.count).toBe(1);
  });

  it("400 só é 'aba não encontrada' no host do conteúdo (onde o Google responde assim ao gid que não existe)", async () => {
    const { deps } = fake([redirect(CONTENT_URL), { status: 400, headers: { "Content-Type": "text/html" } }]);
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("tab_not_found");
  });

  it("resposta que chega depois do tempo limite é fechada", async () => {
    const { deps, closed } = fake([]);
    let deliver: (value: UpstreamResponse) => void = () => undefined;
    deps.totalTimeoutMs = 30;
    deps.transport = () =>
      new Promise<UpstreamResponse>((resolve) => {
        deliver = resolve;
      });
    expect(await codeOf(fetchGoogleSheetCsv(REF, deps))).toBe("timeout");
    deliver(response(csv(), closed));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed.count).toBe(1);
  });

  it("a mensagem da planilha privada diz o que fazer", () => {
    expect(new SheetFetchError("not_shared").message).toContain("Qualquer pessoa com o link");
  });
});

describe("httpsTransport: a conexão real usa só os IPs conferidos", () => {
  it("sem IP conferido, nem tenta conectar", async () => {
    const attempt = httpsTransport({
      url: new URL("https://docs.google.com/spreadsheets/d/x/export"),
      addresses: [],
      headers: {},
      signal: AbortSignal.timeout(2_000),
      connectTimeoutMs: 1_000,
    });
    await expect(attempt).rejects.toThrow("Host inesperado");
  });

  it("conecta no IP fixado, não no que o DNS daria, e respeita o tempo para conectar", async () => {
    // 192.0.2.1 é de documentação (nunca roteado): se o DNS real fosse usado, chegaria ao Google
    // e haveria resposta; fixado, a conexão não abre e o tempo para conectar encerra.
    const started = Date.now();
    const attempt = httpsTransport({
      url: new URL("https://docs.google.com/spreadsheets/d/x/export"),
      addresses: [{ address: "192.0.2.1", family: 4 }],
      headers: {},
      signal: AbortSignal.timeout(5_000),
      connectTimeoutMs: 300,
    });
    await expect(attempt).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
