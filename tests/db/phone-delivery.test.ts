import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { eq as sqlEq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withScope } from "@/db/rls";
import { channel } from "@/db/schema";
import type { PhoneVerifyJob } from "@/jobs/queues";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { applyChannelEvent } from "@/lib/channels/events";
import { setProvidersForTests } from "@/lib/channels/registry";
import type {
  ChannelContext,
  ChannelProvider,
  SendTemplate,
  SendText,
} from "@/lib/channels/types";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { resetEnvForTests } from "@/lib/env";
import { createLogger, setLoggerForTests } from "@/lib/logger";
import {
  deliverPhoneVerification,
  sendVerificationMessage,
  VerificationScopeError,
} from "@/lib/phone/delivery";
import {
  requestPhoneVerificationSend,
  setPhoneVerifyQueueForTests,
} from "@/lib/phone/dispatch";
import { phoneValues } from "@/lib/phone/columns";
import { ensureUserVerification, issueVerificationToken } from "@/lib/phone/requests";
import { asPlatform, makePlatformUser } from "./billing-helpers";
import {
  cleanUpChannels,
  platformScope,
  seedCloudChannel,
  seedQrChannel,
  tenantScope,
} from "./channels-helpers";
import { makeCustomerPhonePending, uniquePhone } from "./phone-helpers";
import { cleanUpPortal, createCustomer, inviteAndEnter } from "./portal-helpers";
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
 * Envio do link de verificação de telefone (SPEC `pre-producao`, bloco T, fase T2b): a cascata
 * Cloud → QR Code → liberação à mão, a falha que chega depois pelo webhook, o canal escolhido
 * **só** pelo responsável do pedido, um link por número, D-12, o limite do reenvio e o token
 * fora do job, do log e da auditoria. Provedores falsos: nada sai daqui.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;
let platformOwner: TestUser;

/** Os jobs enfileirados (a fila de teste), rodados à mão por `drain`. */
const jobs: Array<{ job: PhoneVerifyJob; key: string }> = [];

type Sent = { channelId: string; kind: "text" | "template"; to: string; payload: string };
const sent: Sent[] = [];
/** Canais cujo envio falha na chamada. */
const failing = new Set<string>();

function fake(type: "whatsapp_cloud" | "whatsapp_qr"): ChannelProvider {
  const send = (kind: Sent["kind"]) => async (ctx: ChannelContext, input: SendText | SendTemplate) => {
    if (failing.has(ctx.channelId)) {
      // Um módulo descuidado que repete o corpo na mensagem de erro: não pode chegar ao log.
      throw new Error(`recusado: ${JSON.stringify(input)}`);
    }
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
    if (next) outcomes.push(await deliverPhoneVerification(next.job));
  }
  return outcomes;
}

type RequestRow = {
  id: string;
  tenant_id: string | null;
  status: string;
  channel_id: string | null;
  provider_message_id: string | null;
  attempts: Array<{ channelId: string | null; outcome: string; error?: string | null }>;
  manual_notified_at: Date | null;
};

const openRequest = async (subjectId: string, tenantId: string | null) => {
  const rows = await asPlatform(
    owner,
    (tx) => tx<RequestRow[]>`
      select id, tenant_id, status, channel_id, provider_message_id, attempts, manual_notified_at
      from phone_verification
      where subject_id = ${subjectId} and status in ('sent', 'awaiting_manual')
        and tenant_id is not distinct from ${tenantId}
    `,
  );
  expect(rows).toHaveLength(1);
  return rows[0] as RequestRow;
};

const tokenIn = (payload: string) => payload.match(/token=([uc]\.[A-Za-z0-9_-]{43})/)?.[1];

const VERIFY_URL = "http://localhost:5173/verificar-telefone?token={{1}}";

/** Modelo aprovado com o botão de URL certo, sincronizado no WABA do canal. */
async function giveTemplate(channelId: string, tenantId: string | null, url = VERIFY_URL) {
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
          { type: "BUTTONS", buttons: [{ type: "URL", text: "Confirmar", url }] },
        ])})
    `;
    await tx`
      update channel_whatsapp_cloud
      set verification_template_name = ${name}, verification_template_language = 'pt_BR'
      where channel_id = ${channelId}
    `;
  });
  return name;
}

/** Cliente com conta no portal e número só declarado: ficha pendente e pedido aberto. */
async function pendingPortalCustomer(boss: TestUser, phone = uniquePhone()) {
  const customer = await createCustomer(boss);
  const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);
  await makeCustomerPhonePending(customer.id, phone);
  await waitForBackgroundTasks();
  return { customer, cookie, phone };
}

/** Organização com owner e os canais pedidos, todos `connected`. */
async function tenantWith(kinds: Array<"cloud" | "qr">) {
  const boss = await createUser(owner);
  const tenant = await createTenant(boss);
  const channels: Record<string, string> = {};
  for (const kind of kinds) {
    // O primeiro de cada tipo é o padrão; os demais, não (um padrão por tipo).
    const isDefault = !channels[kind];
    const row =
      kind === "cloud"
        ? await seedCloudChannel(tenantScope(tenant.id), { isDefault })
        : await seedQrChannel(tenantScope(tenant.id), { isDefault });
    channels[kind] ??= row.id;
  }
  await waitForBackgroundTasks();
  jobs.length = 0;
  return { boss, tenant, channels };
}

const setOrder = (value: string) => {
  process.env.PHONE_VERIFICATION_CHANNELS = value;
  resetEnvForTests();
};

const platformChannels: string[] = [];

beforeAll(async () => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
  platformOwner = await makePlatformUser(owner, "platform_owner");
});

beforeEach(() => {
  setOrder("whatsapp_cloud,whatsapp_qr");
  setProvidersForTests([fake("whatsapp_cloud"), fake("whatsapp_qr")]);
  setPhoneVerifyQueueForTests(async (job, key) => {
    jobs.push({ job, key });
  });
  jobs.length = 0;
  sent.length = 0;
  failing.clear();
  mail.reset();
});

afterEach(async () => {
  await waitForBackgroundTasks();
  // Volta ao padrão de `tests/db/setup.ts`.
  setPhoneVerifyQueueForTests(async () => {});
  setProvidersForTests(undefined);
  // Os canais da plataforma deste arquivo não ficam no ar para o próximo teste.
  if (platformChannels.length > 0) {
    await asPlatform(
      owner,
      (tx) => tx`update channel set status = 'disconnected' where id = any(${platformChannels})`,
    );
  }
});

afterAll(async () => {
  delete process.env.PHONE_VERIFICATION_CHANNELS;
  resetEnvForTests();
  setEmailProviderForTests(undefined);
  setLoggerForTests(undefined);
  await waitForBackgroundTasks();
  await asPlatform(owner, (tx) => tx`delete from channel where id = any(${platformChannels})`);
  await asPlatform(owner, (tx) => tx`delete from message_template where name like ${"verificacao\\_%"}`);
  await cleanUpChannels(owner, []);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

async function platformQr() {
  const row = await seedQrChannel(platformScope, { name: `QR plataforma-chtest` });
  platformChannels.push(row.id);
  return row.id;
}

describe("cascata Cloud → QR Code → liberação à mão", () => {
  it("Cloud sem modelo de verificação é pulado e o link sai pelo QR Code", async () => {
    const { boss, channels } = await tenantWith(["cloud", "qr"]);
    const { customer, phone } = await pendingPortalCustomer(boss);

    expect(await drain()).toEqual(["sent"]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelId: channels.qr, kind: "text" });
    expect(sent[0]?.to).toBe(phoneValues(phone).phoneNormalized);
    expect(sent[0]?.payload).toContain("/verificar-telefone?token=c.");
    const request = await openRequest(customer.id, (await tenantOf(customer.id)) ?? null);
    expect(request).toMatchObject({ status: "sent", channel_id: channels.qr });
    expect(request.attempts.map(({ outcome }) => outcome)).toEqual(["skipped", "sent"]);
  });

  it("Cloud com modelo manda o modelo, com o token no botão de URL", async () => {
    const { boss, tenant, channels } = await tenantWith(["cloud", "qr"]);
    await giveTemplate(channels.cloud as string, tenant.id);
    await pendingPortalCustomer(boss);

    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId, kind }) => [channelId, kind])).toEqual([
      [channels.cloud, "template"],
    ]);
    const payload = JSON.parse(sent[0]?.payload ?? "{}") as SendTemplate;
    expect(JSON.stringify(payload.components)).toMatch(/"sub_type":"url".*"text":"c\./);
  });

  it("modelo cuja URL não é a do APP_URL não serve: o envio pula para o QR Code", async () => {
    const { boss, tenant, channels } = await tenantWith(["cloud", "qr"]);
    await giveTemplate(
      channels.cloud as string,
      tenant.id,
      "https://outro-site.example/verificar-telefone?token={{1}}",
    );
    await pendingPortalCustomer(boss);

    await drain();
    expect(sent.map(({ channelId }) => channelId)).toEqual([channels.qr]);
  });

  it("erro na chamada passa ao próximo canal", async () => {
    const { boss, tenant, channels } = await tenantWith(["cloud", "qr"]);
    await giveTemplate(channels.cloud as string, tenant.id);
    failing.add(channels.cloud as string);
    const { customer } = await pendingPortalCustomer(boss);

    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([channels.qr]);
    const request = await openRequest(customer.id, tenant.id);
    expect(request.attempts.map(({ outcome }) => outcome)).toEqual(["failed", "sent"]);
  });

  it("`failed` que chega depois pelo webhook passa ao próximo canal", async () => {
    const { boss, tenant, channels } = await tenantWith(["cloud", "qr"]);
    await giveTemplate(channels.cloud as string, tenant.id);
    const { customer } = await pendingPortalCustomer(boss);
    await drain();
    const first = await openRequest(customer.id, tenant.id);
    expect(first.channel_id).toBe(channels.cloud);

    // O aviso da Meta: sem crédito (131042). Não é mensagem da caixa de entrada.
    const scope = tenantScope(tenant.id);
    const after: Array<() => Promise<void>> = [];
    const applied = await withScope(scope, async (tx) => {
      const [origin] = await tx.select().from(channel).where(eqId(channels.cloud as string));
      return applyChannelEvent(
        tx,
        scope,
        origin as typeof channel.$inferSelect,
        {
          type: "status",
          providerMessageId: first.provider_message_id as string,
          status: "failed",
          occurredAt: new Date(),
          error: "(#131042) Business eligibility payment issue",
          recipientPhone: null,
        },
        after,
      );
    });
    expect(applied).toBe(true);
    for (const effect of after) await effect();

    expect(jobs.map(({ job }) => [job.reason, job.failedMessageId])).toEqual([
      ["failed", first.provider_message_id],
    ]);
    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([channels.cloud, channels.qr]);
    const request = await openRequest(customer.id, tenant.id);
    expect(request).toMatchObject({ status: "sent", channel_id: channels.qr });
    expect(request.attempts.map(({ outcome, error }) => [outcome, error ?? null])).toEqual([
      ["sent", null],
      ["failed", "131042"],
      ["sent", null],
    ]);
  });

  it("falha velha (de uma mensagem que já não é a do pedido) não reenvia nada", async () => {
    const { boss, tenant, channels } = await tenantWith(["qr"]);
    const { customer } = await pendingPortalCustomer(boss);
    await drain();
    const request = await openRequest(customer.id, tenant.id);

    const failed = {
      requestId: request.id,
      reason: "failed" as const,
      afterChannelId: channels.qr,
      failedMessageId: request.provider_message_id as string,
    };
    // Outro token (um reenvio) já substituiu a mensagem que falhou.
    await issueVerificationToken(request.id);
    expect(await deliverPhoneVerification(failed)).toBe("stale");
    // Falha de mensagem que nunca foi a do pedido, idem.
    expect(
      await deliverPhoneVerification({ ...failed, failedMessageId: "wamid.outra" }),
    ).toBe("stale");
    expect(sent).toHaveLength(1);
  });

  it("sem canal apto, o pedido espera a liberação e o owner é avisado uma vez", async () => {
    const { boss, tenant } = await tenantWith([]);
    const { customer } = await pendingPortalCustomer(boss);

    expect(await drain()).toEqual(["manual"]);
    expect(sent).toEqual([]);
    const request = await openRequest(customer.id, tenant.id);
    expect(request).toMatchObject({ status: "awaiting_manual", provider_message_id: null });
    expect(request.manual_notified_at).not.toBeNull();

    const notices = mail.sent.filter((m) => m.tags?.template === "phone-verification-manual");
    expect(notices.map(({ to }) => to)).toEqual([boss.email]);
    // Só os 4 últimos dígitos.
    expect(notices[0]?.text).not.toMatch(/\d{8,}/);

    // De novo (reenvio sem canal): sem outro e-mail.
    await deliverPhoneVerification({ requestId: request.id, reason: "resend" });
    expect(mail.sent.filter((m) => m.tags?.template === "phone-verification-manual")).toHaveLength(1);
  });

  it("`PHONE_VERIFICATION_CHANNELS` vazio: sempre manual, mesmo com canal no ar", async () => {
    setOrder("");
    const { boss, tenant } = await tenantWith(["qr"]);
    const { customer } = await pendingPortalCustomer(boss);

    expect(await drain()).toEqual(["manual"]);
    expect(sent).toEqual([]);
    expect((await openRequest(customer.id, tenant.id)).status).toBe("awaiting_manual");
  });
});

describe("troca de número: o link vai ao número novo", () => {
  it("troca pedida pela equipe numa ficha com portal: o link sai ao número novo e só confirma na sessão do portal", async () => {
    const { boss, tenant, channels } = await tenantWith(["qr"]);
    const customer = await createCustomer(boss);
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);
    await drain();
    sent.length = 0;

    const next = uniquePhone();
    const asked = await call("POST", `/api/customers/${customer.id}/phone-change`, {
      cookie: boss.cookie,
      body: { phone: next },
    });
    expect(asked.status).toBe(202);
    expect(await drain()).toEqual(["sent"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channelId: channels.qr, to: phoneValues(next).phoneNormalized });
    const token = tokenIn(sent[0]?.payload ?? "") as string;
    expect(token).toMatch(/^c\./);

    // A equipe, que pediu, não confirma; a pessoa do portal, sim.
    expect(
      (await call("POST", "/api/me/phone-verification/confirm", { cookie: boss.cookie, body: { token } }))
        .status,
    ).toBe(400);
    const confirmed = await call("POST", "/api/portal/me/phone-verification/confirm", {
      cookie,
      body: { token },
    });
    expect(confirmed.status).toBe(200);
    const [row] = await asPlatform(
      owner,
      (tx) => tx<{ phone_key: string; via: string | null; tenant_id: string }[]>`
        select phone_key, phone_verified_via as via, tenant_id from customer where id = ${customer.id}
      `,
    );
    expect(row).toMatchObject({ phone_key: phoneValues(next).phoneKey, via: "whatsapp", tenant_id: tenant.id });
  });

  it("ficha sem conta no portal: nenhum link (ninguém o confirmaria), vai à liberação do owner", async () => {
    const { boss, tenant } = await tenantWith(["qr"]);
    const customer = await createCustomer(boss);
    await drain();

    const asked = await call("POST", `/api/customers/${customer.id}/phone-change`, {
      cookie: boss.cookie,
      body: { phone: uniquePhone() },
    });
    expect(asked.status).toBe(202);
    expect(await drain()).toEqual(["manual"]);
    expect(sent).toEqual([]);
    const [request] = await asPlatform(
      owner,
      (tx) => tx<{ status: string; tenant_id: string; manual_notified_at: Date | null }[]>`
        select status, tenant_id, manual_notified_at from phone_verification
        where subject_id = ${customer.id} and purpose = 'change'
      `,
    );
    expect(request).toMatchObject({ status: "awaiting_manual", tenant_id: tenant.id });
    expect(request?.manual_notified_at).not.toBeNull();
  });

  it("a troca da conta não espera a D-12: o membro comum confirmado no sistema recebe o link da plataforma no número novo", async () => {
    const platformChannel = await platformQr();
    const { tenant } = await tenantWith(["qr"]);
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    await asPlatform(
      owner,
      (tx) => tx`
        update "user" set phone_verified_at = now(), phone_verified_via = 'manual' where id = ${person.id}
      `,
    );
    await drain();
    sent.length = 0;

    const next = uniquePhone();
    const asked = await call("POST", "/api/me/phone-change", {
      cookie: person.cookie,
      body: { phone: next },
    });
    expect(asked.status).toBe(202);
    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId, to }) => ({ channelId, to }))).toEqual([
      { channelId: platformChannel, to: phoneValues(next).phoneNormalized },
    ]);
  });
});

describe("o canal é sempre do responsável do pedido", () => {
  it("pedido da plataforma nunca sai pelo canal de uma organização", async () => {
    // Uma organização com canal no ar; a plataforma sem canal.
    const { channels } = await tenantWith(["cloud", "qr"]);
    const person = await createUser(owner);
    expect(await drain()).toEqual(["manual"]);

    expect(sent).toEqual([]);
    const request = await openRequest(person.id, null);
    expect(request).toMatchObject({ status: "awaiting_manual", channel_id: null });
    // A fila da plataforma é avisada (a pessoa não é de organização nenhuma).
    expect(
      mail.sent
        .filter((m) => m.tags?.template === "phone-verification-manual")
        .map(({ to }) => to),
    ).toContain(platformOwner.email);

    // Nem chamando a função que envia direto com o canal da organização.
    await expect(
      sendVerificationMessage(
        { tenantId: null, phoneNormalized: "5511987654321" },
        { id: channels.qr as string, tenantId: (await tenantOfChannel(channels.qr as string)) ?? null },
        { kind: "text" },
        `u.${"a".repeat(43)}`,
      ),
    ).rejects.toBeInstanceOf(VerificationScopeError);
    expect(sent).toEqual([]);

    // E o banco recusa gravar o canal de outro escopo no pedido.
    await expect(
      asPlatform(
        owner,
        (tx) => tx`update phone_verification set channel_id = ${channels.qr as string} where id = ${request.id}`,
      ),
    ).rejects.toThrow(/outro escopo/);
  });

  it("pedido de organização nunca sai pelo canal da plataforma nem de outra organização", async () => {
    await platformQr();
    const other = await tenantWith(["qr"]);
    const { boss, tenant } = await tenantWith([]);
    const { customer } = await pendingPortalCustomer(boss);

    expect(await drain()).toEqual(["manual"]);
    expect(sent).toEqual([]);
    expect((await openRequest(customer.id, tenant.id)).channel_id).toBeNull();

    await expect(
      sendVerificationMessage(
        { tenantId: tenant.id, phoneNormalized: "5511987654321" },
        { id: other.channels.qr as string, tenantId: other.tenant.id },
        { kind: "text" },
        `c.${"a".repeat(43)}`,
      ),
    ).rejects.toBeInstanceOf(VerificationScopeError);
    expect(sent).toEqual([]);
  });
});

describe("quem recebe o link e quantos (D-12, restrição (a))", () => {
  it("quem não é de organização nenhuma recebe o da plataforma; o da organização em que entra depois espera", async () => {
    const platformChannel = await platformQr();
    const { tenant, channels } = await tenantWith(["qr"]);

    const person = await createUser(owner);
    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([platformChannel]);
    expect(sent[0]?.payload).toContain("token=u.");

    // Entra na equipe: o pedido da organização abre, mas o link da plataforma já está a caminho.
    await addMember(owner, tenant.id, person, "member");
    await requestPhoneVerificationSend(
      await ensureUserVerification(person.id, { kind: "tenant", tenantId: tenant.id }),
      { type: "user", id: person.id },
    );
    expect(await drain()).toEqual(["held"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([platformChannel]);
    expect(sent.some(({ channelId }) => channelId === channels.qr)).toBe(false);
  });

  it("sem canal na plataforma, o da organização sai em seguida (e só um)", async () => {
    const { tenant, channels } = await tenantWith(["qr"]);
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    // Ainda sem organização quando o job do cadastro roda? Aqui já é membro: a plataforma espera.
    await requestPhoneVerificationSend(
      await ensureUserVerification(person.id, { kind: "tenant", tenantId: tenant.id }),
      { type: "user", id: person.id },
    );

    expect(await drain()).toEqual(["held", "sent"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([channels.qr]);
  });

  it("o membro comum não recebe o link da plataforma sem pedir; pedindo, recebe", async () => {
    const platformChannel = await platformQr();
    const { tenant, channels } = await tenantWith(["qr"]);
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");

    // O job do cadastro roda depois da entrada na equipe: D-12 segura o da plataforma.
    expect(await drain()).toEqual(["held"]);
    expect(sent).toEqual([]);
    expect(mail.sent.filter((m) => m.tags?.template === "phone-verification-manual")).toEqual([]);

    await requestPhoneVerificationSend(
      await ensureUserVerification(person.id, { kind: "tenant", tenantId: tenant.id }),
      { type: "user", id: person.id },
    );
    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([channels.qr]);

    // A situação por responsável: a plataforma pendente, a organização com o link a caminho.
    const mine = await call("GET", "/api/me/phone-verification", { cookie: person.cookie });
    expect(await mine.json()).toMatchObject({
      pending: { status: "sent" },
      confirmedGlobally: false,
      answersTo: "organization",
      responsibles: [
        { responsible: "platform", status: "awaiting_manual" },
        { responsible: "organization", tenantId: tenant.id, status: "sent" },
      ],
    });

    // Ele pede o da plataforma.
    const resend = await call("POST", "/api/me/phone-verification/resend", {
      cookie: person.cookie,
      body: { responsible: "platform" },
    });
    expect(resend.status).toBe(202);
    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([channels.qr, platformChannel]);
  });

  it("o link da plataforma confirmado tira a confirmação de quem tinha o número e avisa por e-mail", async () => {
    const platformChannel = await platformQr();
    const phone = uniquePhone();
    const values = phoneValues(phone);
    // Dois owners: o número não se repete entre owners (P13).
    const holder = await createUser(owner);
    const claimer = await createUser(owner);
    await createTenant(holder);
    await createTenant(claimer);
    await drain();
    sent.length = 0;
    for (const [person, via] of [
      [holder, "whatsapp"],
      [claimer, null],
    ] as const) {
      await owner`
        update "user" set phone = ${values.phone}, phone_normalized = ${values.phoneNormalized},
          phone_key = ${values.phoneKey}, phone_verified_at = ${via ? new Date() : null},
          phone_verified_via = ${via}
        where id = ${person.id}
      `;
    }
    await requestPhoneVerificationSend(await ensureUserVerification(claimer.id), {
      type: "user",
      id: claimer.id,
    });
    expect(await drain()).toEqual(["sent"]);
    expect(sent.map(({ channelId }) => channelId)).toEqual([platformChannel]);
    const token = tokenIn(sent[0]?.payload ?? "") as string;

    const confirmed = await call("POST", "/api/me/phone-verification/confirm", {
      cookie: claimer.cookie,
      body: { token },
    });
    expect(confirmed.status).toBe(200);

    const notice = mail.sent.filter((m) => m.tags?.template === "phone-number-claimed");
    expect(notice.map(({ to }) => to)).toEqual([holder.email]);
    expect(notice[0]?.text).toContain(phone.slice(-4));
    expect(notice[0]?.text).not.toContain(values.phoneNormalized);
    // Quem perdeu o número não recebe link: o número agora é de outra pessoa.
    expect(jobs).toEqual([]);
  });
});

describe("reenvio", () => {
  it("tenta o próximo canal da ordem e volta ao primeiro no fim", async () => {
    const { boss, tenant } = await tenantWith(["qr"]);
    const extra = (await seedQrChannel(tenantScope(tenant.id))).id;
    const { customer, cookie } = await pendingPortalCustomer(boss);
    await drain();
    const first = (await openRequest(customer.id, tenant.id)).channel_id;

    const used: Array<string | null> = [first];
    for (let index = 0; index < 2; index += 1) {
      const resend = await call("POST", "/api/portal/me/phone-verification/resend", { cookie });
      expect(resend.status).toBe(202);
      await drain();
      used.push((await openRequest(customer.id, tenant.id)).channel_id);
    }
    expect(new Set(used).size).toBe(2);
    expect(used).toContain(extra);
    expect(used[2]).toBe(used[0]);
  });

  it("reenvio sem canal apto agora não derruba o link que já saiu", async () => {
    const { boss, tenant, channels } = await tenantWith(["qr"]);
    const { customer } = await pendingPortalCustomer(boss);
    await drain();
    const before = await openRequest(customer.id, tenant.id);
    await asPlatform(
      owner,
      (tx) => tx`update channel set status = 'disconnected' where id = ${channels.qr as string}`,
    );

    expect(await deliverPhoneVerification({ requestId: before.id, reason: "resend" })).toBe(
      "already",
    );
    const after = await openRequest(customer.id, tenant.id);
    expect(after).toMatchObject({
      status: "sent",
      provider_message_id: before.provider_message_id,
    });
  });

  it("3 por hora por cadastro, além do limite por IP; o job também segura o 4º link", async () => {
    const { tenant } = await tenantWith(["qr"]);
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    await drain();

    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const resend = await call("POST", "/api/me/phone-verification/resend", {
        cookie: person.cookie,
        body: { responsible: tenant.id },
      });
      statuses.push(resend.status);
    }
    expect(statuses).toEqual([202, 202, 202, 429]);
    expect(await drain()).toEqual(["sent", "sent", "sent"]);

    // Um quarto pedido de envio por outro caminho: o job conta os links da hora.
    const request = await openRequest(person.id, tenant.id);
    expect(await deliverPhoneVerification({ requestId: request.id, reason: "resend" })).toBe(
      "limited",
    );
    expect(sent).toHaveLength(3);
  });

  it("corpo inválido é 400 e responsável de outra organização não envia nada", async () => {
    const { tenant } = await tenantWith(["qr"]);
    const stranger = await tenantWith(["qr"]);
    const person = await createUser(owner);
    await addMember(owner, tenant.id, person, "member");
    await drain();

    const bad = await call("POST", "/api/me/phone-verification/resend", {
      cookie: person.cookie,
      body: { responsible: "qualquer" },
    });
    expect(bad.status).toBe(400);

    const foreign = await call("POST", "/api/me/phone-verification/resend", {
      cookie: person.cookie,
      body: { responsible: stranger.tenant.id },
    });
    expect(foreign.status).toBe(202);
    await drain();
    expect(sent.some(({ channelId }) => channelId === stranger.channels.qr)).toBe(false);
  });

  it("o link automático da abertura conta no limite: o reenvio responde 429 em vez de aceitar sem enviar", async () => {
    await platformQr();
    const person = await createUser(owner);
    expect(await drain()).toEqual(["sent"]);

    for (let index = 0; index < 2; index += 1) {
      const resend = await call("POST", "/api/me/phone-verification/resend", {
        cookie: person.cookie,
      });
      expect(resend.status).toBe(202);
      expect(await drain()).toEqual(["sent"]);
    }

    const third = await call("POST", "/api/me/phone-verification/resend", {
      cookie: person.cookie,
    });
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ code: "PHONE_VERIFICATION_LIMIT" });
    expect(jobs).toEqual([]);
    expect(sent).toHaveLength(3);
  });

  it("falha assíncrona com o limite da hora esgotado cai na liberação à mão", async () => {
    const { boss, tenant, channels } = await tenantWith(["cloud", "qr"]);
    await giveTemplate(channels.cloud as string, tenant.id);
    const { customer, cookie } = await pendingPortalCustomer(boss);
    await drain();
    for (let index = 0; index < 2; index += 1) {
      await call("POST", "/api/portal/me/phone-verification/resend", { cookie });
      await drain();
    }
    expect(sent).toHaveLength(3);
    const current = await openRequest(customer.id, tenant.id);

    const outcome = await deliverPhoneVerification({
      requestId: current.id,
      reason: "failed",
      afterChannelId: current.channel_id as string,
      failedMessageId: current.provider_message_id as string,
    });
    expect(outcome).toBe("manual");
    expect(sent).toHaveLength(3);
    expect((await openRequest(customer.id, tenant.id)).status).toBe("awaiting_manual");
  });
});

describe("portal: o lead sem ficha ativa confirma (restrição (d))", () => {
  it("confirma pela sessão do portal sem `requirePortalTenant`", async () => {
    const { boss, tenant } = await tenantWith(["qr"]);
    const { customer, cookie } = await pendingPortalCustomer(boss);
    await drain();
    const token = tokenIn(sent[0]?.payload ?? "") as string;
    expect(token).toMatch(/^c\./);
    await asPlatform(owner, (tx) => tx`update customer set status = 'lead' where id = ${customer.id}`);

    const mine = await call("GET", "/api/portal/me/phone-verification", { cookie });
    expect(await mine.json()).toMatchObject({
      pending: { status: "sent" },
      responsibles: [{ tenantId: tenant.id, status: "sent" }],
    });

    // Token de equipe na rota do portal, ou de outra pessoa: o mesmo 400.
    const wrong = await call("POST", "/api/portal/me/phone-verification/confirm", {
      cookie,
      body: { token: `c.${"a".repeat(43)}` },
    });
    expect(wrong.status).toBe(400);

    const confirmed = await call("POST", "/api/portal/me/phone-verification/confirm", {
      cookie,
      body: { token },
    });
    expect(confirmed.status).toBe(200);
    const [row] = await asPlatform(
      owner,
      (tx) => tx<{ via: string | null }[]>`
        select phone_verified_via as via from customer where id = ${customer.id}
      `,
    );
    expect(row?.via).toBe("whatsapp");
  });

  it("ficha bloqueada ou organização suspensa não confirma (o mesmo 400)", async () => {
    const { boss, tenant } = await tenantWith(["qr"]);
    const { customer, cookie } = await pendingPortalCustomer(boss);
    await drain();
    const token = tokenIn(sent[0]?.payload ?? "") as string;
    const confirm = () =>
      call("POST", "/api/portal/me/phone-verification/confirm", { cookie, body: { token } });

    await asPlatform(owner, (tx) => tx`update customer set status = 'blocked' where id = ${customer.id}`);
    expect((await confirm()).status).toBe(400);

    await asPlatform(owner, async (tx) => {
      await tx`update customer set status = 'active' where id = ${customer.id}`;
      await tx`update organization set status = 'suspended' where id = ${tenant.id}`;
    });
    expect((await confirm()).status).toBe(400);
    await asPlatform(owner, (tx) => tx`update organization set status = 'active' where id = ${tenant.id}`);

    const [row] = await asPlatform(
      owner,
      (tx) => tx<{ via: string | null }[]>`
        select phone_verified_via as via from customer where id = ${customer.id}
      `,
    );
    expect(row?.via).toBeNull();
  });
});

describe("o token não vai para o job, o log nem a auditoria", () => {
  it("só aparece na mensagem ao provedor", async () => {
    const lines: string[] = [];
    setLoggerForTests(
      createLogger({
        level: "info",
        stream: new Writable({
          write(chunk, _encoding, done) {
            lines.push(String(chunk));
            done();
          },
        }),
      }),
    );
    const { boss, tenant, channels } = await tenantWith(["cloud", "qr"]);
    await giveTemplate(channels.cloud as string, tenant.id);
    failing.add(channels.cloud as string);
    const started = new Date();
    const { customer } = await pendingPortalCustomer(boss);
    const queued = JSON.stringify(jobs);
    await drain();
    setLoggerForTests(undefined);

    const token = tokenIn(sent[0]?.payload ?? "") as string;
    expect(token).toBeTruthy();
    expect(queued).not.toMatch(/[uc]\.[A-Za-z0-9_-]{43}/);
    expect(lines.join("")).toContain("Falha ao enviar o link de verificação");
    expect(lines.join("")).not.toMatch(/[uc]\.[A-Za-z0-9_-]{43}/);
    expect(lines.join("")).not.toContain("verificar-telefone");

    const audits = await asPlatform(
      owner,
      (tx) => tx<{ metadata: unknown }[]>`
        select metadata from audit_log where created_at >= ${started}
      `,
    );
    expect(JSON.stringify(audits)).not.toContain(token);
    const request = await openRequest(customer.id, tenant.id);
    expect(JSON.stringify(request)).not.toContain(token);
  });
});

describe("o envio de verificação não entra na caixa de entrada", () => {
  it("o eco do link que o QR Code devolve não cria contato nem conversa", async () => {
    const { tenant, channels } = await tenantWith(["qr"]);
    const scope = tenantScope(tenant.id);
    const handled = await withScope(scope, async (tx) => {
      const [origin] = await tx.select().from(channel).where(eqId(channels.qr as string));
      return applyChannelEvent(tx, scope, origin as typeof channel.$inferSelect, {
        type: "message",
        fromPhone: "5511987654321",
        fromExternalId: null,
        pushName: null,
        providerMessageId: `eco-${randomUUID()}`,
        fromMe: true,
        messageType: "text",
        text: `Para confirmar...\nhttp://localhost:5173/verificar-telefone?token=c.${"b".repeat(43)}`,
        media: null,
        replyToProviderMessageId: null,
        occurredAt: new Date(),
      });
    });
    expect(handled).toBe(true);

    const [counts] = await asPlatform(
      owner,
      (tx) => tx<{ contacts: number; conversations: number }[]>`
        select
          (select count(*)::int from chat_contact where tenant_id = ${tenant.id}) as contacts,
          (select count(*)::int from conversation where tenant_id = ${tenant.id}) as conversations
      `,
    );
    expect(counts).toEqual({ contacts: 0, conversations: 0 });
  });

  it("o eco é reconhecido também pelo id da mensagem enviada", async () => {
    const { boss, tenant, channels } = await tenantWith(["qr"]);
    await pendingPortalCustomer(boss);
    await drain();
    const [request] = await asPlatform(
      owner,
      (tx) => tx<{ provider_message_id: string }[]>`
        select provider_message_id from phone_verification
        where channel_id = ${channels.qr as string} and provider_message_id is not null
      `,
    );
    const scope = tenantScope(tenant.id);
    const handled = await withScope(scope, async (tx) => {
      const [origin] = await tx.select().from(channel).where(eqId(channels.qr as string));
      return applyChannelEvent(tx, scope, origin as typeof channel.$inferSelect, {
        type: "message",
        fromPhone: "5511987654321",
        fromExternalId: null,
        pushName: null,
        providerMessageId: request?.provider_message_id as string,
        fromMe: true,
        messageType: "text",
        // Sem o texto do link (o provedor reescreveu, ou a mensagem mudou).
        text: "Mensagem sem o endereço",
        media: null,
        replyToProviderMessageId: null,
        occurredAt: new Date(),
      });
    });
    expect(handled).toBe(true);

    const [counts] = await asPlatform(
      owner,
      (tx) => tx<{ contacts: number }[]>`
        select count(*)::int as contacts from chat_contact where tenant_id = ${tenant.id}
      `,
    );
    expect(counts?.contacts).toBe(0);
  });
});

// ---------------------------------------------------------------------------

function eqId(id: string) {
  return sqlEq(channel.id, id);
}

async function tenantOf(customerId: string) {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<{ tenant_id: string }[]>`select tenant_id from customer where id = ${customerId}`,
  );
  return row?.tenant_id;
}

async function tenantOfChannel(channelId: string) {
  const [row] = await asPlatform(
    owner,
    (tx) => tx<{ tenant_id: string | null }[]>`select tenant_id from channel where id = ${channelId}`,
  );
  return row?.tenant_id;
}
