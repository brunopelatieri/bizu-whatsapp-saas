import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api } from "@/api/app";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { setWebhookQueueForTests } from "@/lib/billing/inbox";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { setProvidersForTests } from "@/lib/payments/registry";
import {
  createStubProvider,
  makePlatformUser,
  STUB_ID,
} from "./billing-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal } from "./portal-helpers";
import {
  addMember,
  cleanUp,
  connectOwner,
  createRole,
  createTenant,
  createUser,
  DOMAIN,
  type TestUser,
} from "./tenant-helpers";

/**
 * Rotas de equipe sobre HTTP de verdade. `fetch` manda DELETE sem `Content-Length`, e o
 * `bodyLimit` do Hono então remonta a `Request`: isso só funciona com o `Request` global
 * do @hono/node-server, ligado em `src/server.ts`. `api.request()` não passa por aí.
 */

const ORIGIN = "http://localhost:5173";

describe("rotas de equipe sobre o servidor Node", () => {
  let server: ServerType;
  let base: string;
  let owner: postgres.Sql;
  let tenantOwner: TestUser;
  let tenantId: string;
  let ipCounter = 0;

  function request(method: string, path: string, init: RequestInit = {}, origin = base) {
    ipCounter += 1;

    return fetch(`${origin}${path}`, {
      method,
      ...init,
      headers: {
        Cookie: tenantOwner.cookie,
        Origin: ORIGIN,
        "X-Forwarded-For": `10.41.0.${ipCounter}`,
        ...init.headers,
      },
    });
  }

  /**
   * Servidor descartável para corpo acima do limite: o 413 sai com o corpo ainda em trânsito e o
   * servidor fecha o socket em seguida, mas o `fetch` já o devolveu ao pool. Num origin próprio
   * (outra porta) esse socket morto nunca é reaproveitado pelos testes seguintes, que no CI
   * falhavam com "other side closed" ao reusá-lo.
   */
  async function withThrowawayServer<T>(run: (origin: string) => Promise<T>) {
    const throwaway = await new Promise<Server>((resolve) => {
      const instance = serve({ fetch: api.fetch, port: 0 }, () => resolve(instance as Server));
    });
    try {
      return await run(`http://127.0.0.1:${(throwaway.address() as AddressInfo).port}`);
    } finally {
      throwaway.closeAllConnections();
      await new Promise((resolve) => throwaway.close(resolve));
    }
  }

  beforeAll(async () => {
    setEmailProviderForTests(createMemoryProvider());
    owner = connectOwner();

    tenantOwner = await createUser(owner);
    tenantId = (await createTenant(tenantOwner)).id;

    await new Promise<void>((resolve) => {
      server = serve({ fetch: api.fetch, port: 0 }, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    setEmailProviderForTests(undefined);
    await owner.begin(async (tx) => {
      await tx`select set_config('app.bypass_tenant', 'on', true)`;
      await tx`delete from payment_event where provider = ${STUB_ID}`;
    });
    await cleanUp(owner);
    await cleanUpPortal(owner);
    await owner.end();
  });

  describe("rotas de clientes", () => {
    async function createCustomerOverHttp() {
      const response = await request("POST", "/api/customers", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Cliente",
          email: `${randomUUID()}@${DOMAIN}`,
          phone: uniquePhone(),
        }),
      });
      expect(response.status).toBe(201);

      const { customer } = (await response.json()) as { customer: { id: string } };
      return customer.id;
    }

    it("POST /api/customers/:id/invite sem corpo envia o acesso", async () => {
      const id = await createCustomerOverHttp();

      const response = await request("POST", `/api/customers/${id}/invite`);

      expect(response.status).toBe(200);
    });

    it("DELETE /api/customers/:id sem corpo remove", async () => {
      const id = await createCustomerOverHttp();

      const response = await request("DELETE", `/api/customers/${id}`);

      expect(response.status).toBe(200);
    });

    it("rotas do Better Auth no portal passam pelo servidor Node", async () => {
      const anonymous = await request("GET", "/api/portal/auth/get-session");
      expect(anonymous.status).toBe(200);

      const verify = await request("POST", "/api/portal/auth/magic-link/verify", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "inexistente" }),
      });
      expect(verify.status).toBe(400);

      const signOut = await request("POST", "/api/portal/auth/sign-out", {
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(signOut.status).toBe(200);
    });
  });

  describe("rotas da fase 9", () => {
    const anyId = randomUUID();
    const json = { "Content-Type": "application/json" };

    it("DELETE /api/tenant/support-grant/:id sem corpo revoga", async () => {
      const created = await request("POST", "/api/tenant/support-grant", {
        headers: json,
        body: JSON.stringify({ hours: 1 }),
      });
      const { grant } = (await created.json()) as { grant: { id: string } };

      const response = await request("DELETE", `/api/tenant/support-grant/${grant.id}`);

      expect(response.status).toBe(200);
    });

    it("DELETE /api/me/sessions/:id sem corpo chega à regra de negócio", async () => {
      expect((await request("DELETE", `/api/me/sessions/${anyId}`)).status).toBe(404);
    });

    it("POST /api/me/sessions/revoke-others sem corpo responde", async () => {
      expect((await request("POST", "/api/me/sessions/revoke-others")).status).toBe(200);
    });

    it("POST /api/admin/stop-impersonating sem corpo chega à regra de negócio", async () => {
      expect((await request("POST", "/api/admin/stop-impersonating")).status).toBe(400);
    });

    it("DELETE /api/tenant e /api/me exigem o corpo JSON (400 sem ele) e conferem a senha", async () => {
      // O `bodyLimit` remonta a `Request` do DELETE sem `Content-Length`: sem o ajuste do
      // servidor isto seria 500. Aqui a validação do corpo é que responde.
      expect((await request("DELETE", "/api/tenant")).status).toBe(400);
      expect((await request("DELETE", "/api/me")).status).toBe(400);

      for (const path of ["/api/tenant", "/api/me"]) {
        const wrong = await request("DELETE", path, {
          headers: json,
          body: JSON.stringify({ password: "errada-errada-1" }),
        });
        expect(wrong.status, path).toBe(403);
        expect(await wrong.json()).toMatchObject({ code: "INVALID_CREDENTIALS" });
      }
    });

    it("DELETE /api/files/:id e /api/portal/me respondem sobre o servidor Node", async () => {
      expect((await request("DELETE", `/api/files/${anyId}`)).status).toBe(404);
      // Cookie da equipe no portal: sessão inexistente.
      expect(
        (
          await request("DELETE", "/api/portal/me", {
            headers: json,
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(401);
    });

    it("POST /api/me/deletion/cancel sem corpo chega à regra de negócio (404, nada agendado)", async () => {
      expect((await request("POST", "/api/me/deletion/cancel")).status).toBe(404);
    });

    it("CSRF sobre HTTP de verdade: POST de outro site responde 403", async () => {
      const response = await request("POST", "/api/tenant/support-grant", {
        headers: { ...json, Origin: "https://atacante.exemplo" },
        body: JSON.stringify({ hours: 1 }),
      });

      expect(response.status).toBe(403);
    });

    it("CSRF: DELETE de outro site responde 403", async () => {
      const response = await request("DELETE", `/api/customers/${anyId}`, {
        headers: { Origin: "https://atacante.exemplo" },
      });

      expect(response.status).toBe(403);
    });

    it("webhook não passa pelo CSRF: quem autentica é a assinatura", async () => {
      setProvidersForTests([createStubProvider()]);
      setWebhookQueueForTests(async () => {});

      const signed = await fetch(`${base}/api/webhooks/payments/${STUB_ID}`, {
        method: "POST",
        headers: {
          ...json,
          Origin: "https://provedor.exemplo",
          "X-Stub-Signature": "ok",
          "X-Forwarded-For": "10.41.2.1",
        },
        body: JSON.stringify({ id: randomUUID(), type: "evento" }),
      });
      const email = await fetch(`${base}/api/webhooks/email/inexistente`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://provedor.exemplo",
          "X-Forwarded-For": "10.41.2.2",
        },
        body: "{}",
      });

      setProvidersForTests(undefined);
      setWebhookQueueForTests(undefined);

      expect(signed.status).not.toBe(403);
      expect(email.status).not.toBe(403);
    });

    it("POST /api/csp-report com o tipo do navegador responde 204", async () => {
      const response = await fetch(`${base}/api/csp-report`, {
        method: "POST",
        headers: {
          "Content-Type": "application/csp-report",
          "X-Forwarded-For": "10.41.2.3",
        },
        body: "{}",
      });

      expect(response.status).toBe(204);
    });
  });

  describe("rotas de cobrança", () => {
    const anyId = randomUUID();
    let platformCookie: string;

    beforeAll(async () => {
      setProvidersForTests([createStubProvider()]);
      platformCookie = (await makePlatformUser(owner, "platform_owner")).cookie;
    });

    afterAll(() => setProvidersForTests(undefined));

    it.each(["reactivate", "pause", "portal"])(
      "POST /api/billing/%s sem corpo chega à regra de negócio",
      async (route) => {
        const response = await request("POST", `/api/billing/${route}`);

        expect(response.status).toBe(409);
      },
    );

    it.each([
      `/api/admin/portal-users/${anyId}/revoke-sessions`,
      `/api/admin/webhooks/${anyId}/reprocess`,
      `/api/admin/subscriptions/${anyId}/cancel`,
      `/api/admin/subscriptions/${anyId}/sync`,
    ])("POST %s sem corpo chega à regra de negócio", async (path) => {
      const response = await request("POST", path, {
        headers: { Cookie: platformCookie },
      });

      expect(response.status).toBe(404);
    });

    // admin-crud A: excluir plano e preço (DELETE sem corpo, como o botão da tela).
    it.each([
      `/api/admin/plans/${anyId}`,
      `/api/admin/plans/${anyId}/prices/${anyId}`,
    ])("DELETE %s sem corpo chega à regra de negócio", async (path) => {
      const response = await request("DELETE", path, {
        headers: { Cookie: platformCookie },
      });

      expect(response.status).toBe(404);
    });

    // admin-crud C: exclusões e sessões pelo /admin, sem corpo, sobre o servidor Node.
    it.each([
      [`/api/admin/users/${anyId}/revoke-sessions`, 404],
      [`/api/admin/users/${anyId}/deletion/cancel`, 409],
      [`/api/admin/portal-users/${anyId}/deletion/cancel`, 409],
      [`/api/admin/tenants/${anyId}/deletion/cancel`, 409],
    ] as const)("POST %s sem corpo chega à regra de negócio", async (path, status) => {
      const response = await request("POST", path, { headers: { Cookie: platformCookie } });

      expect(response.status).toBe(status);
    });

    it.each(["tenants", "users", "portal-users"])(
      "DELETE /api/admin/%s/:id exige o corpo JSON (400 sem ele)",
      async (kind) => {
        const response = await request("DELETE", `/api/admin/${kind}/${anyId}`, {
          headers: { Cookie: platformCookie },
        });

        expect(response.status).toBe(400);
      },
    );

    /** Sem `Content-Length`, como um cliente que manda o corpo em pedaços. */
    function streamed(size: number) {
      const chunk = "x".repeat(64 * 1024);
      const pieces = Math.ceil(size / chunk.length);
      let sent = 0;

      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= pieces) return controller.close();
          sent += 1;
          controller.enqueue(new TextEncoder().encode(chunk));
        },
      });
    }

    it("webhook em pedaços acima de 1 MB é recusado", async () => {
      const response = await withThrowawayServer((origin) =>
        fetch(`${origin}/api/webhooks/payments/${STUB_ID}`, {
          method: "POST",
          headers: { "X-Stub-Signature": "ok", "X-Forwarded-For": "10.41.1.1" },
          body: streamed(2 * 1024 * 1024),
          duplex: "half",
        } as RequestInit),
      );

      expect(response.status).toBe(413);
    });

    it("webhook sobre HTTP de verdade é recebido", async () => {
      const queued: string[] = [];
      setWebhookQueueForTests(async (id) => {
        queued.push(id);
      });

      const response = await fetch(`${base}/api/webhooks/payments/${STUB_ID}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stub-Signature": "ok",
          "X-Forwarded-For": "10.41.1.2",
        },
        body: JSON.stringify({ id: `evt_${randomUUID()}`, events: [] }),
      });
      setWebhookQueueForTests(undefined);

      expect(response.status).toBe(200);
      expect(queued).toHaveLength(1);
    });
  });

  it("o servidor de produção usa o mesmo Request destes testes", async () => {
    const entry = await readFile("src/server.ts", "utf8");

    expect(entry).toMatch(/overrideGlobalObjects:\s*true/);
  });

  it("DELETE sem corpo remove membro", async () => {
    const colleague = await createUser(owner);
    const memberId = await addMember(owner, tenantId, colleague, "member");

    const response = await request("DELETE", `/api/team/members/${memberId}`);

    expect(response.status).toBe(200);
  });

  it("DELETE sem corpo exclui papel", async () => {
    const role = await createRole(tenantOwner, "http-apagar", ["customer:read"]);

    const response = await request("DELETE", `/api/roles/${role.id}`);

    expect(response.status).toBe(200);
  });

  it("POST sem corpo reenvia e DELETE revoga o convite", async () => {
    const invited = await request("POST", "/api/team/invitations", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "http@tenant-test.bizu.local", role: "member" }),
    });
    expect(invited.status).toBe(201);
    await waitForBackgroundTasks();

    const { invitation } = (await invited.json()) as {
      invitation: { id: string };
    };

    const resent = await request(
      "POST",
      `/api/team/invitations/${invitation.id}/resend`,
    );
    const revoked = await request(
      "DELETE",
      `/api/team/invitations/${invitation.id}`,
    );

    expect(resent.status).toBe(200);
    expect(revoked.status).toBe(200);
  });

  it("corpo chunked acima do limite responde 413", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(20 * 1024)));
        controller.close();
      },
    });

    const response = await withThrowawayServer((origin) =>
      request(
        "POST",
        "/api/tenant",
        {
          headers: { "Content-Type": "application/json" },
          body: stream,
          duplex: "half",
        } as RequestInit,
        origin,
      ),
    );

    expect(response.status).toBe(413);
  });
});
