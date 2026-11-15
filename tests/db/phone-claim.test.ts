import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PhoneVerifyJob } from "@/jobs/queues";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { setProvidersForTests } from "@/lib/channels/registry";
import type { ChannelContext, ChannelProvider, SendTemplate, SendText } from "@/lib/channels/types";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { stopRealtime } from "@/lib/inbox/realtime";
import { resetEnvForTests } from "@/lib/env";
import { phoneValues } from "@/lib/phone/columns";
import { deliverPhoneVerification } from "@/lib/phone/delivery";
import { setPhoneVerifyQueueForTests } from "@/lib/phone/dispatch";
import { portalPhoneGatePasses } from "@/lib/phone/gate";
import { prunePhoneVerifications } from "@/lib/phone/requests";
import { setStorageForTests } from "@/lib/storage";
import { asPlatform } from "./billing-helpers";
import { cleanUpChannels, seedCloudChannel, seedQrChannel, tenantScope } from "./channels-helpers";
import { attachMedia, memoryStorage, seedConversation, seedMessage } from "./inbox-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, createCustomer, customerEmail, sessionCookies } from "./portal-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  type TestUser,
} from "./tenant-helpers";

/**
 * O telefone que já existe (P3, D-1, `purpose = claim`; SPEC `pre-producao`). Só o autocadastro do
 * portal abre `claim` (decisão do proprietário de 2026-11-14): a resposta é a de sempre, a ficha nova
 * só nasce quando o link do número é confirmado **na sessão do portal de quem se cadastrou**, e aí a
 * ficha antiga sai com contatos, conversas, mensagens e arquivos. A liberação à mão não fecha
 * `claim`. A equipe com número repetido continua recebendo 409, sem pedido e sem exclusão.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);
const PASSWORD = "Senha-do-portal-1";
const VERIFY_URL = "http://localhost:5173/verificar-telefone?token={{1}}";

const mail = createMemoryProvider();
const memory = memoryStorage();
let owner: postgres.Sql;
const jobs: PhoneVerifyJob[] = [];
type Sent = { channelId: string; kind: "text" | "template"; to: string; payload: string };
const sent: Sent[] = [];
const tenants: string[] = [];

function fake(type: "whatsapp_cloud" | "whatsapp_qr"): ChannelProvider {
  const send = (kind: Sent["kind"]) => async (ctx: ChannelContext, input: SendText | SendTemplate) => {
    sent.push({ channelId: ctx.channelId, kind, to: input.to, payload: JSON.stringify(input) });
    return { providerMessageId: `wamid.${randomUUID()}` };
  };
  return {
    type,
    capabilities: {
      templates: type === "whatsapp_cloud",
      sessionWindow24h: type === "whatsapp_cloud",
      deliveryFailure: true,
      deviceEcho: type === "whatsapp_qr",
      pairing: type === "whatsapp_qr",
    },
    sendText: send("text"),
    sendTemplate: send("template"),
    normalizeEvents: () => [],
  } as unknown as ChannelProvider;
}

async function drain() {
  await waitForBackgroundTasks();
  const outcomes: string[] = [];
  while (jobs.length > 0) {
    const next = jobs.shift();
    if (next) outcomes.push(await deliverPhoneVerification(next));
  }
  return outcomes;
}

/** O token: parâmetro do botão do modelo (Cloud) ou dentro do link em texto (QR Code). */
const tokenIn = (payload: string) => payload.match(/(c\.[A-Za-z0-9_-]{43})/)?.[1];

async function giveTemplate(channelId: string, tenantId: string) {
  const name = `verificacao_${randomUUID().slice(0, 8)}`;
  await asPlatform(owner, async (tx) => {
    const [cloud] = await tx<{ waba_id: string }[]>`
      select waba_id from channel_whatsapp_cloud where channel_id = ${channelId}
    `;
    await tx`
      insert into message_template (tenant_id, waba_id, name, language, category, status, components)
      values (${tenantId}, ${cloud?.waba_id ?? ""}, ${name}, 'pt_BR', 'UTILITY', 'APPROVED',
        ${tx.json([
          { type: "BODY", text: "Confirme seu WhatsApp." },
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Confirmar", url: VERIFY_URL }] },
        ])})
    `;
    await tx`
      update channel_whatsapp_cloud
      set verification_template_name = ${name}, verification_template_language = 'pt_BR'
      where channel_id = ${channelId}
    `;
  });
}

/** Organização com autocadastro no portal e um canal (Cloud com modelo, ou só QR Code). */
async function portalTenant(kind: "cloud" | "qr" = "cloud") {
  const boss = await createUser(owner);
  const tenant = await createTenant(boss, `Claim ${randomUUID().slice(0, 6)}`);
  tenants.push(tenant.id);
  await asPlatform(
    owner,
    (tx) => tx`update organization set settings = ${tx.json({ portal_self_signup: true })} where id = ${tenant.id}`,
  );
  const channel =
    kind === "cloud"
      ? await seedCloudChannel(tenantScope(tenant.id))
      : await seedQrChannel(tenantScope(tenant.id));
  if (kind === "cloud") await giveTemplate(channel.id, tenant.id);
  await waitForBackgroundTasks();
  jobs.length = 0;
  return { boss, tenant, channelId: channel.id };
}

/** Autocadastro no portal até o e-mail confirmado (o que chama `confirmPortalSignup`). */
async function portalSignup(org: string, phone: string, name = "Pessoa do portal") {
  const email = customerEmail();
  const signup = await call("POST", "/api/portal/auth-ext/sign-up", {
    body: { name, email, password: PASSWORD, org, phone, acceptTerms: true, termsVersion: "2026-11" },
  });
  expect(signup.status).toBe(200);
  await waitForBackgroundTasks();
  const token = decodeURIComponent(
    mail.sent.filter((m) => m.to === email).at(-1)?.text.match(/token=([^&\s"]+)/)?.[1] as string,
  );
  const verified = await call("POST", "/api/portal/auth/verify-email", { body: { token, org } });
  await waitForBackgroundTasks();
  return { email, verified };
}

async function portalSignIn(email: string) {
  const response = await call("POST", "/api/portal/auth/sign-in/email", { body: { email, password: PASSWORD } });
  expect(response.status).toBe(200);
  return sessionCookies(response);
}

const confirm = (cookie: string, token: string) =>
  call("POST", "/api/portal/me/phone-verification/confirm", { cookie, body: { token } });

const count = async (sqlText: string, value: string) => {
  const [row] = await asPlatform(
    owner,
    (tx) => tx.unsafe(`select count(*)::int as total from ${sqlText}`, [value]) as Promise<{ total: number }[]>,
  );
  return row?.total ?? 0;
};

type ClaimRow = {
  id: string;
  subject_id: string;
  tenant_id: string;
  status: string;
  payload: unknown;
  requested_by_id: string;
};

const claimsOf = (tenantId: string) =>
  asPlatform(
    owner,
    (tx) => tx<ClaimRow[]>`
      select id, subject_id, tenant_id, status, payload, requested_by_id from phone_verification
      where tenant_id = ${tenantId} and purpose = 'claim' order by created_at
    `,
  );

const portalUserId = async (email: string) => {
  const [row] = await owner<{ id: string }[]>`select id from portal_user where email = ${email}`;
  return row?.id as string;
};

/** A ficha que tem o número, com uma conversa (texto e imagem) ligada a ela. */
async function holderWithConversation(boss: TestUser, tenantId: string, channelId: string, phone: string) {
  const holder = await createCustomer(boss, { name: "Dono anterior", phone });
  const scope = tenantScope(tenantId);
  const seeded = await seedConversation(scope, channelId, {
    customerId: holder.id,
    phone: phoneValues(phone).phoneNormalized,
  });
  const target = { conversationId: seeded.id, channelId };
  await seedMessage(scope, target, { text: "conversa do dono anterior" });
  const image = await seedMessage(scope, target, { type: "image", text: null });
  const fileId = await attachMedia(scope, memory, image.id, PNG, "image/png", "foto.png");
  return { holder, conversation: seeded, fileId, mediaKey: `inbox/test/${image.id}` };
}

beforeAll(async () => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
});

beforeEach(() => {
  process.env.PHONE_VERIFICATION_CHANNELS = "whatsapp_cloud,whatsapp_qr";
  resetEnvForTests();
  setProvidersForTests([fake("whatsapp_cloud"), fake("whatsapp_qr")]);
  setPhoneVerifyQueueForTests(async (job) => {
    jobs.push(job);
  });
  setStorageForTests(memory.storage);
  jobs.length = 0;
  sent.length = 0;
  mail.reset();
});

afterEach(async () => {
  await waitForBackgroundTasks();
  setPhoneVerifyQueueForTests(async () => {});
  setProvidersForTests(undefined);
  setStorageForTests(undefined);
  // O `test:db` roda com o bloqueio desligado (`vitest.db.config.ts`); apagar a variável o ligaria.
  process.env.PHONE_VERIFICATION_REQUIRED = "false";
  resetEnvForTests();
});

afterAll(async () => {
  delete process.env.PHONE_VERIFICATION_CHANNELS;
  resetEnvForTests();
  setEmailProviderForTests(undefined);
  await stopRealtime();
  await asPlatform(owner, (tx) => tx`delete from message_template where name like ${"verificacao\\_%"}`);
  await cleanUpChannels(owner, tenants);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("autocadastro do portal com o número de outra ficha", () => {
  it("responde como sempre e não cria ficha: abre o claim com os dados no payload", async () => {
    const { boss, tenant } = await portalTenant();
    const phone = uniquePhone();
    const holder = await createCustomer(boss, { name: "Dono anterior", phone });

    // Um autocadastro comum na mesma organização, para comparar.
    const normal = await portalSignup(tenant.slug, uniquePhone());
    const claimed = await portalSignup(tenant.slug, phone, "Quem diz ter o número");

    expect(claimed.verified.status).toBe(normal.verified.status);
    expect(await claimed.verified.json()).toEqual(await normal.verified.json());

    // Nenhuma ficha com o e-mail novo; a ficha anterior segue intacta.
    expect(await count("customer where email = $1", claimed.email)).toBe(0);
    expect(await count("customer where id = $1", holder.id)).toBe(1);

    const [claim] = await claimsOf(tenant.id);
    expect(claim).toMatchObject({
      status: "awaiting_manual",
      payload: { name: "Quem diz ter o número", email: claimed.email },
      requested_by_id: await portalUserId(claimed.email),
    });
    expect(await count("customer where id = $1", claim?.subject_id as string)).toBe(0);

    // A tela do portal é a mesma do autocadastro comum: uma linha "pendente" na organização.
    const normalCookie = await portalSignIn(normal.email);
    const claimCookie = await portalSignIn(claimed.email);
    const overview = async (cookie: string) =>
      (await (await call("GET", "/api/portal/me/phone-verification", { cookie })).json()) as {
        responsibles: Array<Record<string, unknown>>;
      };
    const normalRows = (await overview(normalCookie)).responsibles;
    const claimRows = (await overview(claimCookie)).responsibles;
    expect(claimRows).toHaveLength(1);
    expect(Object.keys(claimRows[0] ?? {}).sort()).toEqual(Object.keys(normalRows[0] ?? {}).sort());
    expect(claimRows[0]).toMatchObject({ tenantId: tenant.id, status: normalRows[0]?.status });
    expect(await portalPhoneGatePasses(await portalUserId(claimed.email), null)).toBe(false);

    // Com o bloqueio desligado, `/api/portal/me` também lista a organização como a de um lead.
    const tenantsOf = async (cookie: string) =>
      ((await (await call("GET", "/api/portal/me", { cookie })).json()) as { tenants: unknown[] }).tenants;
    expect(await tenantsOf(claimCookie)).toEqual(await tenantsOf(normalCookie));
  });

  it("a conta com claim aberto não é apagada como órfã quando perde a ficha de outra organização", async () => {
    const a = await portalTenant();
    const b = await portalTenant();
    const phone = uniquePhone();
    await createCustomer(a.boss, { phone });
    // A pessoa já é lead em B (autocadastro com outro número) e abre um claim em A.
    const { email } = await portalSignup(b.tenant.slug, uniquePhone());
    const [inB] = await asPlatform(
      owner,
      (tx) => tx<{ id: string }[]>`select id from customer where tenant_id = ${b.tenant.id} and email = ${email}`,
    );
    const person = await portalUserId(email);
    await asPlatform(owner, async (tx) => {
      await tx`
        insert into phone_verification (tenant_id, subject_type, subject_id, purpose, phone, phone_normalized, phone_key,
          status, requested_by_type, requested_by_id, payload)
        values (${a.tenant.id}, 'customer', ${randomUUID()}, 'claim', ${phone}, ${phoneValues(phone).phoneNormalized},
          ${phoneValues(phone).phoneKey}, 'awaiting_manual', 'portal_user', ${person}, ${tx.json({ name: "X", email })})
      `;
    });

    // B exclui a ficha: a conta ficaria sem ficha, mas espera o claim de A.
    expect((await call("DELETE", `/api/customers/${inB?.id}`, { cookie: b.boss.cookie })).status).toBe(200);
    await waitForBackgroundTasks();
    expect(await count("portal_user where id = $1", person)).toBe(1);
    expect((await claimsOf(a.tenant.id))[0]).toMatchObject({ status: "awaiting_manual" });
  });

  it("a ficha nova só nasce na confirmação; a antiga sai com conversas e arquivos, e só ela", async () => {
    const { boss, tenant, channelId } = await portalTenant();
    const phone = uniquePhone();
    const old = await holderWithConversation(boss, tenant.id, channelId, phone);
    const other = await holderWithConversation(boss, tenant.id, channelId, uniquePhone());
    const stranger = await seedConversation(tenantScope(tenant.id), channelId);

    const { email } = await portalSignup(tenant.slug, phone, "Novo dono");
    expect(await drain()).toEqual(["sent"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "template", to: phoneValues(phone).phoneNormalized });
    const token = tokenIn(sent[0]?.payload ?? "") as string;
    const [claim] = await claimsOf(tenant.id);
    expect(claim?.status).toBe("sent");
    expect(await count("customer where id = $1", claim?.subject_id as string)).toBe(0);

    const cookie = await portalSignIn(email);
    const response = await confirm(cookie, token);
    expect(response.status).toBe(200);
    await waitForBackgroundTasks();

    // A ficha nova: o id do pedido, o número confirmado pelo link, a conta do portal ligada.
    const [created] = await asPlatform(
      owner,
      (tx) => tx<Record<string, unknown>[]>`
        select id, name, email, status, phone_key, phone_verified_via, portal_user_id from customer
        where id = ${claim?.subject_id as string}
      `,
    );
    expect(created).toMatchObject({
      name: "Novo dono",
      email,
      status: "lead",
      phone_key: phoneValues(phone).phoneKey,
      phone_verified_via: "whatsapp",
      portal_user_id: await portalUserId(email),
    });

    // A antiga e tudo o que estava ligado a ela.
    expect(await count("customer where id = $1", old.holder.id)).toBe(0);
    expect(await count("chat_contact where id = $1", old.conversation.contactId)).toBe(0);
    expect(await count("conversation where id = $1", old.conversation.id)).toBe(0);
    expect(await count("message where conversation_id = $1", old.conversation.id)).toBe(0);
    expect(await count("file where id = $1", old.fileId)).toBe(0);
    expect(memory.objects.has(old.mediaKey)).toBe(false);

    // Nada mais.
    expect(await count("customer where id = $1", other.holder.id)).toBe(1);
    expect(await count("conversation where id = $1", other.conversation.id)).toBe(1);
    expect(await count("file where id = $1", other.fileId)).toBe(1);
    expect(memory.objects.has(other.mediaKey)).toBe(true);
    expect(await count("conversation where id = $1", stranger.id)).toBe(1);

    // O pedido fechou sem os dados da ficha.
    const [closed] = await claimsOf(tenant.id);
    expect(closed).toMatchObject({ status: "confirmed", payload: null });

    // Auditoria: ids e os 4 últimos dígitos, nunca o número inteiro.
    const audits = await asPlatform(
      owner,
      (tx) => tx<{ action: string; target_id: string; metadata: Record<string, unknown> }[]>`
        select action, target_id, metadata from audit_log where tenant_id = ${tenant.id}
        and action = 'customer.deleted_by_phone_claim'
      `,
    );
    expect(audits).toEqual([
      {
        action: "customer.deleted_by_phone_claim",
        target_id: old.holder.id,
        metadata: { newCustomerId: claim?.subject_id, phoneHint: phoneValues(phone).phoneNormalized.slice(-4) },
      },
    ]);
    const leaked = await asPlatform(
      owner,
      (tx) => tx<{ total: number }[]>`
        select count(*)::int as total from audit_log
        where tenant_id = ${tenant.id} and metadata::text like ${`%${phoneValues(phone).phoneNormalized}%`}
      `,
    );
    expect(leaked[0]?.total).toBe(0);

    // E-mail ao owner, só com o final do número.
    const notices = mail.sent.filter((m) => m.tags?.template === "customer-deleted-by-phone-claim");
    expect(notices.map(({ to }) => to)).toEqual([boss.email]);
    expect(notices[0]?.text).toContain(phoneValues(phone).phoneNormalized.slice(-4));
    expect(notices[0]?.text).not.toContain(phoneValues(phone).phoneNormalized);
  });

  it("o token não serve a outro cadastro do portal, nem depois de usado", async () => {
    const { boss, tenant } = await portalTenant();
    const phone = uniquePhone();
    const holder = await createCustomer(boss, { phone });
    const { email } = await portalSignup(tenant.slug, phone);
    const intruder = await portalSignup(tenant.slug, uniquePhone());
    await drain();
    const token = tokenIn(sent.find(({ to }) => to === phoneValues(phone).phoneNormalized)?.payload ?? "") as string;
    expect(token).toBeTruthy();

    // Outra pessoa do portal, com o link na mão: o mesmo 400 de sempre, e nada muda.
    const wrong = await confirm(await portalSignIn(intruder.email), token);
    expect(wrong.status).toBe(400);
    expect(await count("customer where id = $1", holder.id)).toBe(1);

    const cookie = await portalSignIn(email);
    expect((await confirm(cookie, token)).status).toBe(200);
    expect((await confirm(cookie, token)).status).toBe(400);
  });

  it("vencido, o claim é encerrado pela manutenção e o payload some; o link não confirma mais", async () => {
    const { boss, tenant } = await portalTenant();
    const phone = uniquePhone();
    const holder = await createCustomer(boss, { phone });
    const { email } = await portalSignup(tenant.slug, phone);
    await drain();
    const token = tokenIn(sent[0]?.payload ?? "") as string;

    await prunePhoneVerifications(new Date(Date.now() + 2 * 60 * 60_000));

    const [claim] = await claimsOf(tenant.id);
    expect(claim).toMatchObject({ status: "canceled", payload: null });
    expect((await confirm(await portalSignIn(email), token)).status).toBe(400);
    expect(await count("customer where id = $1", holder.id)).toBe(1);
    expect(await count("customer where email = $1", email)).toBe(0);
  });

  it("a liberação à mão não fecha o claim nem apaga a ficha de ninguém", async () => {
    const { boss, tenant } = await portalTenant("qr");
    const phone = uniquePhone();
    const holder = await createCustomer(boss, { phone });
    const { email } = await portalSignup(tenant.slug, phone);
    await drain();
    const [claim] = await claimsOf(tenant.id);

    const queue = await call("GET", "/api/phone-verifications", { cookie: boss.cookie });
    const { items } = (await queue.json()) as { items: Array<{ id: string; purpose: string; name: string }> };
    expect(items.find(({ id }) => id === claim?.id)).toMatchObject({ purpose: "claim" });

    const released = await call("POST", `/api/phone-verifications/${claim?.id}/confirm`, { cookie: boss.cookie });
    expect(released.status).toBe(409);
    expect(((await released.json()) as { code: string }).code).toBe("CLAIM_LINK_ONLY");
    expect(await count("customer where id = $1", holder.id)).toBe(1);
    expect(await count("customer where email = $1", email)).toBe(0);
    expect((await claimsOf(tenant.id))[0]?.status).toBe("sent");
  });

  it("sem Cloud, o QR Code leva o link do claim (CL-3 revista), e a confirmação funciona", async () => {
    const { boss, tenant, channelId } = await portalTenant("qr");
    const phone = uniquePhone();
    const holder = await createCustomer(boss, { phone });
    const { email } = await portalSignup(tenant.slug, phone);

    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId: id, kind, to }) => [id, kind, to])).toEqual([
      [channelId, "text", phoneValues(phone).phoneNormalized],
    ]);
    expect(await count("customer where id = $1", holder.id)).toBe(1);
    expect(mail.sent.filter((m) => m.tags?.template === "phone-verification-manual")).toHaveLength(0);

    expect((await confirm(await portalSignIn(email), tokenIn(sent[0]?.payload ?? "") as string)).status).toBe(200);
    expect(await count("customer where id = $1", holder.id)).toBe(0);
    expect(await count("customer where email = $1", email)).toBe(1);
  });

  it("a falha da Cloud (aviso failed do webhook) passa o claim ao QR Code, e o reenvio recomeça a ordem", async () => {
    const { boss, tenant, channelId } = await portalTenant();
    const qr = await seedQrChannel(tenantScope(tenant.id));
    const phone = uniquePhone();
    await createCustomer(boss, { phone });
    await portalSignup(tenant.slug, phone);
    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId: id, kind }) => [id, kind])).toEqual([[channelId, "template"]]);

    const [request] = await asPlatform(
      owner,
      (tx) => tx<{ id: string; channel_id: string; provider_message_id: string }[]>`
        select id, channel_id, provider_message_id from phone_verification
        where tenant_id = ${tenant.id} and purpose = 'claim'
      `,
    );
    expect(
      await deliverPhoneVerification({
        requestId: request?.id as string,
        reason: "failed",
        afterChannelId: request?.channel_id,
        failedMessageId: request?.provider_message_id,
      }),
    ).toBe("sent");
    expect(sent.map(({ channelId: id, kind }) => [id, kind])).toEqual([
      [channelId, "template"],
      [qr.id, "text"],
    ]);
  });

  it("isolamento: só a ficha desta organização sai; a outra organização não vê nem libera o claim", async () => {
    const a = await portalTenant();
    const b = await portalTenant();
    const phone = uniquePhone();
    const inA = await createCustomer(a.boss, { phone });
    const inB = await createCustomer(b.boss, { phone });
    const { email } = await portalSignup(a.tenant.slug, phone);
    await drain();
    const token = tokenIn(sent[0]?.payload ?? "") as string;
    const [claim] = await claimsOf(a.tenant.id);

    const foreign = await call("POST", `/api/phone-verifications/${claim?.id}/confirm`, { cookie: b.boss.cookie });
    expect(foreign.status).toBe(404);
    const queueB = (await (await call("GET", "/api/phone-verifications", { cookie: b.boss.cookie })).json()) as {
      items: Array<{ id: string }>;
    };
    expect(queueB.items.some(({ id }) => id === claim?.id)).toBe(false);

    expect((await confirm(await portalSignIn(email), token)).status).toBe(200);
    expect(await count("customer where id = $1", inA.id)).toBe(0);
    expect(await count("customer where id = $1", inB.id)).toBe(1);
  });

  /** As três fichas que o `claim` nunca apaga (CL-7, CL-13): com conta no portal, ligada à equipe, bloqueada. */
  const protections: Array<[string, (tenantId: string, holderId: string) => Promise<void>]> = [
    [
      "com conta no portal",
      async (_tenantId, holderId) => {
        const id = randomUUID();
        const values = phoneValues(uniquePhone());
        await owner`
          insert into portal_user (id, name, email, phone, phone_normalized, phone_key)
          values (${id}, 'Conta antiga', ${customerEmail()}, ${values.phone}, ${values.phoneNormalized}, ${values.phoneKey})
        `;
        await asPlatform(owner, (tx) => tx`update customer set portal_user_id = ${id} where id = ${holderId}`);
      },
    ],
    [
      "ligada a uma pessoa da equipe",
      async (tenantId, holderId) => {
        const colleague = await createUser(owner);
        await addMember(owner, tenantId, colleague, "member");
        await asPlatform(owner, (tx) => tx`update customer set user_id = ${colleague.id} where id = ${holderId}`);
      },
    ],
    [
      "bloqueada",
      async (_tenantId, holderId) => {
        await asPlatform(owner, (tx) => tx`update customer set status = 'blocked' where id = ${holderId}`);
      },
    ],
  ];

  it.each(protections)("ficha %s: o claim nem abre, e a resposta é a de sempre", async (_label, protect) => {
    const { boss, tenant } = await portalTenant();
    const phone = uniquePhone();
    const holder = await createCustomer(boss, { phone });
    await protect(tenant.id, holder.id);

    const normal = await portalSignup(tenant.slug, uniquePhone());
    const { email, verified } = await portalSignup(tenant.slug, phone);
    expect(verified.status).toBe(normal.verified.status);
    expect(await verified.json()).toEqual(await normal.verified.json());

    expect(await claimsOf(tenant.id)).toEqual([]);
    expect(await count("customer where id = $1", holder.id)).toBe(1);
    expect(await count("customer where email = $1", email)).toBe(0);
  });

  it.each(protections)(
    "ficha que passou a estar %s com o link a caminho: a confirmação responde 400 e nada é apagado",
    async (_label, protect) => {
      const { boss, tenant } = await portalTenant();
      const phone = uniquePhone();
      const holder = await createCustomer(boss, { phone });
      const { email } = await portalSignup(tenant.slug, phone);
      await drain();
      const token = tokenIn(sent[0]?.payload ?? "") as string;
      expect(token).toBeTruthy();

      await protect(tenant.id, holder.id);

      expect((await confirm(await portalSignIn(email), token)).status).toBe(400);
      expect(await count("customer where id = $1", holder.id)).toBe(1);
      expect(await count("customer where email = $1", email)).toBe(0);
      expect((await claimsOf(tenant.id))[0]?.status).toBe("sent");
    },
  );

  it("a pessoa que some do portal leva o claim junto (manutenção)", async () => {
    const { boss, tenant } = await portalTenant();
    const phone = uniquePhone();
    await createCustomer(boss, { phone });
    const { email } = await portalSignup(tenant.slug, phone);
    await owner`delete from portal_user where email = ${email}`;

    await prunePhoneVerifications();
    expect((await claimsOf(tenant.id))[0]).toMatchObject({ status: "canceled", payload: null });
  });

  it("com o bloqueio de telefone ligado, o claim aberto prende a pessoa na tela de confirmação, que confirma", async () => {
    const { boss, tenant } = await portalTenant();
    const phone = uniquePhone();
    await createCustomer(boss, { phone });
    const { email } = await portalSignup(tenant.slug, phone);
    await drain();
    const token = tokenIn(sent[0]?.payload ?? "") as string;
    const cookie = await portalSignIn(email);

    process.env.PHONE_VERIFICATION_REQUIRED = "true";
    resetEnvForTests();

    const me = await call("GET", "/api/portal/me", { cookie });
    expect(me.status).toBe(403);
    expect(((await me.json()) as { code: string }).code).toBe("PHONE_UNVERIFIED");
    const overview = await call("GET", "/api/portal/me/phone-verification", { cookie });
    expect(overview.status).toBe(200);
    const resend = await call("POST", "/api/portal/me/phone-verification/resend", {
      cookie,
      body: { tenantId: tenant.id },
    });
    expect([202, 429]).toContain(resend.status);

    expect((await confirm(cookie, token)).status).toBe(200);
    // Ficha nova confirmada pelo link: a pessoa passa.
    expect(await portalPhoneGatePasses(await portalUserId(email), null)).toBe(true);
  });
});

describe("equipe com número repetido", () => {
  it("continua 409 PHONE_IN_USE, sem pedido de claim e sem apagar nada", async () => {
    const { boss, tenant } = await portalTenant();
    const phone = uniquePhone();
    const holder = await createCustomer(boss, { phone });

    const response = await call("POST", "/api/customers", {
      cookie: boss.cookie,
      body: { name: "Outro cadastro", phone, email: customerEmail() },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "PHONE_IN_USE", customerId: holder.id });

    expect(await count("customer where id = $1", holder.id)).toBe(1);
    expect(await claimsOf(tenant.id)).toEqual([]);
    expect(await count("phone_verification where tenant_id = $1", tenant.id)).toBe(0);
    await waitForBackgroundTasks();
    expect(jobs).toHaveLength(0);
  });
});
