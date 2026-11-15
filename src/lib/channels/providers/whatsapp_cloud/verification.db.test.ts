import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudProvider } from "@/lib/channels/providers/whatsapp_cloud";
import { setProvidersForTests } from "@/lib/channels/registry";
import { asPlatform, makePlatformUser } from "../../../../../tests/db/billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedCloudChannel,
  tenantScope,
} from "../../../../../tests/db/channels-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "../../../../../tests/db/tenant-helpers";

/**
 * `PUT /api/channels/:id/verification-template` e a de `/api/admin/channels` (SPEC
 * `pre-producao`, T2b): o modelo que leva o link de verificação de telefone. Só modelo aprovado
 * do WABA do canal, com o botão de URL no `APP_URL` deste servidor (`http://localhost:5173` nos
 * testes). Mora na pasta do módulo para sumir com ela.
 */

const WABA = "100000000000001";
const GOOD_URL = "http://localhost:5173/verificar-telefone?token={{1}}";

let owner: postgres.Sql;
let boss: TestUser;
let memberUser: TestUser;
let platformOwner: TestUser;
let tenantId: string;
let channelId: string;
let platformChannelId: string;
const tenants: string[] = [];

async function template(scopeTenant: string | null, url: string, status = "APPROVED") {
  const name = `verif_${randomUUID().slice(0, 8)}`;
  await asPlatform(
    owner,
    (tx) => tx`
      insert into message_template (tenant_id, waba_id, name, language, status, components)
      values (${scopeTenant}, ${WABA}, ${name}, 'pt_BR', ${status}, ${tx.json([
        { type: "BODY", text: "Confirme seu WhatsApp." },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Confirmar", url }] },
      ])})
    `,
  );
  return name;
}

const choice = async (id: string) =>
  (
    await asPlatform(
      owner,
      (tx) => tx<{ name: string | null; language: string | null }[]>`
        select verification_template_name as name, verification_template_language as language
        from channel_whatsapp_cloud where channel_id = ${id}
      `,
    )
  )[0];

const put = (cookie: string, path: string, body: unknown) =>
  call("PUT", path, { cookie, body });

beforeAll(async () => {
  // O módulo é ligado aqui, como nos testes vizinhos: sem isto a rota só existe quando o
  // `.env.local` traz `CHANNEL_PROVIDERS=whatsapp_cloud`, e o CI (sem a variável) responde 404.
  setProvidersForTests([createCloudProvider()]);
  owner = connectOwner();
  boss = await createUser(owner);
  tenantId = (await createTenant(boss)).id;
  tenants.push(tenantId);
  memberUser = await createUser(owner);
  await addMember(owner, tenantId, memberUser, "member");
  platformOwner = await makePlatformUser(owner, "platform_owner");
  channelId = (await seedCloudChannel(tenantScope(tenantId), { wabaId: WABA })).id;
  platformChannelId = (
    await seedCloudChannel(platformScope, { wabaId: WABA, name: "Cloud plataforma-chtest" })
  ).id;
});

afterAll(async () => {
  setProvidersForTests(undefined);
  // Os modelos da plataforma não saem com organização nenhuma.
  await asPlatform(owner, (tx) => tx`delete from message_template where name like ${"verif\\_%"}`);
  await cleanUpChannels(owner, tenants);
  await cleanUp(owner);
  await owner.end();
});

describe("modelo de verificação do canal Cloud", () => {
  it("aceita o modelo aprovado com o botão no APP_URL e tira com null", async () => {
    const name = await template(tenantId, GOOD_URL);
    const path = `/api/channels/${channelId}/verification-template`;

    const shown = async (base: string, id: string) => {
      const list = (await (await call("GET", base, { cookie: boss.cookie })).json()) as {
        channels: Array<{ id: string; verificationTemplate?: unknown }>;
      };
      return list.channels.find((item) => item.id === id)?.verificationTemplate;
    };

    // A leitura do canal traz o modelo escolhido (nulo sem modelo), sem nada a mais.
    expect(await shown("/api/channels", channelId)).toBeNull();

    const chosen = await put(boss.cookie, path, { template: { name, language: "pt_BR" } });
    expect(chosen.status).toBe(200);
    expect(await choice(channelId)).toEqual({ name, language: "pt_BR" });
    expect(await shown("/api/channels", channelId)).toEqual({ name, language: "pt_BR" });
    // O canal da plataforma, lido pela organização, não existe: nada vaza entre escopos.
    expect(
      ((await (await call("GET", "/api/channels", { cookie: boss.cookie })).json()) as {
        channels: Array<{ id: string }>;
      }).channels.some((item) => item.id === platformChannelId),
    ).toBe(false);

    const cleared = await put(boss.cookie, path, { template: null });
    expect(cleared.status).toBe(200);
    expect(await choice(channelId)).toEqual({ name: null, language: null });
    expect(await shown("/api/channels", channelId)).toBeNull();
  });

  it("recusa o modelo cujo botão manda o token para fora do APP_URL", async () => {
    const name = await template(tenantId, "https://atacante.example/verificar-telefone?token={{1}}");

    const response = await put(boss.cookie, `/api/channels/${channelId}/verification-template`, {
      template: { name, language: "pt_BR" },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "INVALID_VERIFICATION_TEMPLATE" });
    expect((await choice(channelId))?.name).toBeNull();
  });

  it("recusa modelo não aprovado e modelo que não existe no escopo", async () => {
    const paused = await template(tenantId, GOOD_URL, "PAUSED");
    const platformOnly = await template(null, GOOD_URL);
    const path = `/api/channels/${channelId}/verification-template`;

    expect(
      (await put(boss.cookie, path, { template: { name: paused, language: "pt_BR" } })).status,
    ).toBe(422);
    // O modelo da plataforma não é desta organização.
    expect(
      (await put(boss.cookie, path, { template: { name: platformOnly, language: "pt_BR" } }))
        .status,
    ).toBe(404);
  });

  it("pede `channel:manage` e não alcança canal de outro escopo", async () => {
    const name = await template(tenantId, GOOD_URL);
    const body = { template: { name, language: "pt_BR" } };

    expect(
      (await put(memberUser.cookie, `/api/channels/${channelId}/verification-template`, body))
        .status,
    ).toBe(403);
    // O canal da plataforma pela rota da organização: não existe para ela.
    expect(
      (await put(boss.cookie, `/api/channels/${platformChannelId}/verification-template`, body))
        .status,
    ).toBe(404);
  });

  it("a plataforma escolhe o modelo do canal dela em /api/admin/channels", async () => {
    const name = await template(null, GOOD_URL);

    const response = await put(
      platformOwner.cookie,
      `/api/admin/channels/${platformChannelId}/verification-template`,
      { template: { name, language: "pt_BR" } },
    );
    expect(response.status).toBe(200);
    expect(await choice(platformChannelId)).toEqual({ name, language: "pt_BR" });
  });
});
