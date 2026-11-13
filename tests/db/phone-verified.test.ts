import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPlatformScope, withTenant } from "@/db/rls";
import { waitForBackgroundTasks } from "@/lib/auth/background";
import { createMemoryProvider } from "@/lib/email/providers/memory";
import { setEmailProviderForTests } from "@/lib/email/send";
import { phoneValues } from "@/lib/phone/columns";
import {
  accountPhoneConflicts,
  assertOwnerPhoneFree,
  assertPhoneFreeInTenant,
  ownerPhoneHolder,
  platformStaffPhoneHolder,
  teamPhoneHolder,
} from "@/lib/phone/uniqueness";
import { linkMemberCustomer } from "@/lib/tenant/team-customer";
import { asPlatform, makePlatformUser } from "./billing-helpers";
import { uniquePhone } from "./phone-helpers";
import { cleanUpPortal, createCustomer, inviteAndEnter } from "./portal-helpers";
import {
  addMember,
  call,
  cleanUp,
  connectOwner,
  createTenant,
  createUser,
  newEmail,
  type TestUser,
} from "./tenant-helpers";

/**
 * Telefone verificado e único por grupo (`docs/specs/pre-producao/spec.md`, bloco T, fase T1):
 * o estado de verificação nos cadastros, a unicidade entre contas confirmadas e a pessoa da
 * equipe que também é cliente. O vínculo automático da conversa está em `inbox-ingest.test.ts`.
 */

const mail = createMemoryProvider();
let owner: postgres.Sql;

type Verification = { at: Date | null; via: string | null };

/** Grava o telefone da conta direto: `createUser` usa o mesmo número para todas. */
async function setUserPhone(user: TestUser, phone: string, verified = true) {
  const values = phoneValues(phone);

  await owner`
    update "user" set
      phone = ${values.phone},
      phone_normalized = ${values.phoneNormalized},
      phone_key = ${values.phoneKey},
      phone_verified_at = ${verified ? new Date() : null},
      phone_verified_via = ${verified ? "manual" : null}
    where id = ${user.id}
  `;

  return values.phoneKey;
}

const customerRow = (id: string) =>
  asPlatform(owner, async (tx) => {
    const [row] = await tx<
      ({ user_id: string | null; phone_key: string } & Verification)[]
    >`
      select user_id, phone_key, phone_verified_at as at, phone_verified_via as via
      from customer where id = ${id}
    `;
    return row;
  });

async function createCustomerAs(user: TestUser, body: Record<string, unknown>) {
  const response = await call("POST", "/api/customers", {
    cookie: user.cookie,
    body: { name: "Cliente Teste", phone: uniquePhone(), ...body },
  });
  const json = (await response.json()) as {
    customer?: {
      id: string;
      phoneVerified: boolean;
      team: { userId: string; role: string } | null;
    };
    code?: string;
  };

  return { status: response.status, ...json };
}

beforeAll(() => {
  setEmailProviderForTests(mail);
  owner = connectOwner();
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await cleanUpPortal(owner);
  await cleanUp(owner);
  await owner.end();
});

describe("unicidade do telefone entre contas", () => {
  it("owners: o número confirmado de um owner não fica livre para outro, em nenhuma organização", async () => {
    const first = await createUser(owner);
    const second = await createUser(owner);
    await createTenant(first, "Primeira");
    await createTenant(second, "Segunda");
    const key = await setUserPhone(first, uniquePhone());

    const result = await withPlatformScope("teste: unicidade", async (tx) => ({
      holder: await ownerPhoneHolder(tx, key, second.id),
      self: await ownerPhoneHolder(tx, key, first.id),
      refused: await assertOwnerPhoneFree(tx, key, second.id).then(
        () => null,
        (error: { code?: string; status?: number }) => ({
          code: error.code,
          status: error.status,
        }),
      ),
    }));

    expect(result.holder).toBe(first.id);
    expect(result.self).toBeNull();
    expect(result.refused).toEqual({ code: "PHONE_IN_USE", status: 409 });
  });

  it("número só declarado não reserva nada: não tranca o número de outra pessoa", async () => {
    const squatter = await createUser(owner);
    const realOwner = await createUser(owner);
    await createTenant(squatter, "Quem declarou");
    await createTenant(realOwner, "Quem tem o número");
    const key = await setUserPhone(squatter, uniquePhone(), false);

    const conflicts = await withPlatformScope("teste: unicidade", (tx) =>
      accountPhoneConflicts(tx, realOwner.id, key),
    );

    expect(conflicts).toEqual([]);
  });

  it("equipe: não se repete na organização, mas pode repetir em outra", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss, "Com equipe");
    const colleague = await createUser(owner);
    const newcomer = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "member");
    await addMember(owner, tenant.id, newcomer, "member");

    const outsider = await createUser(owner);
    const other = await createTenant(outsider, "Outra organização");
    const key = await setUserPhone(colleague, uniquePhone());

    const result = await withPlatformScope("teste: unicidade", async (tx) => ({
      same: await teamPhoneHolder(tx, tenant.id, key, newcomer.id),
      elsewhere: await teamPhoneHolder(tx, other.id, key, outsider.id),
      // O colega não é owner de nada: para o grupo dos owners, o número está livre.
      owners: await ownerPhoneHolder(tx, key, outsider.id),
      conflicts: await accountPhoneConflicts(tx, newcomer.id, key),
    }));

    expect(result.same).toBe(colleague.id);
    expect(result.elsewhere).toBeNull();
    expect(result.owners).toBeNull();
    expect(result.conflicts).toEqual([colleague.id]);
  });

  it("cliente e equipe da mesma organização podem ter o mesmo número", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss, "Dois cadastros");
    const phone = uniquePhone();
    const key = await setUserPhone(boss, phone);
    const created = await createCustomerAs(boss, { phone });
    expect(created.status).toBe(201);

    await withTenant(tenant.id, async (tx) => {
      // Para a equipe, só o próprio owner tem o número; o cliente não entra na conta.
      await expect(
        assertPhoneFreeInTenant(tx, tenant.id, "team", key, boss.id),
      ).resolves.toBeUndefined();
      // Entre clientes, o número já tem dono.
      await expect(
        assertPhoneFreeInTenant(tx, tenant.id, "customer", key),
      ).rejects.toMatchObject({ code: "PHONE_IN_USE" });
      await expect(
        assertPhoneFreeInTenant(tx, tenant.id, "customer", key, created.customer?.id),
      ).resolves.toBeUndefined();
    });
  });

  it("equipe da plataforma: não se repete entre proprietário e suporte", async () => {
    const platformOwner = await makePlatformUser(owner, "platform_owner");
    const support = await makePlatformUser(owner, "platform_support");
    const key = await setUserPhone(platformOwner, uniquePhone());

    const result = await withPlatformScope("teste: unicidade", async (tx) => ({
      holder: await platformStaffPhoneHolder(tx, key, support.id),
      conflicts: await accountPhoneConflicts(tx, support.id, key),
    }));

    expect(result.holder).toBe(platformOwner.id);
    expect(result.conflicts).toEqual([platformOwner.id]);
  });

  it("/admin: liberar à mão um número que outro owner já confirmou é recusado", async () => {
    const platformOwner = await makePlatformUser(owner, "platform_owner");
    const holder = await createUser(owner);
    const target = await createUser(owner);
    await createTenant(holder, "Dona do número");
    await createTenant(target, "Quer o número");
    const phone = uniquePhone();
    await setUserPhone(holder, phone);

    const refused = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: platformOwner.cookie,
      body: { phone },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "PHONE_IN_USE" });

    // Número livre: a edição do proprietário da plataforma vale como liberação manual.
    const free = uniquePhone();
    const accepted = await call("PATCH", `/api/admin/users/${target.id}`, {
      cookie: platformOwner.cookie,
      body: { phone: free },
    });
    expect(accepted.status).toBe(200);

    const [row] = await owner<({ phone_key: string } & Verification)[]>`
      select phone_key, phone_verified_at as at, phone_verified_via as via
      from "user" where id = ${target.id}
    `;
    expect(row).toMatchObject({ phone_key: phoneValues(free).phoneKey, via: "manual" });
    expect(row?.at).toBeInstanceOf(Date);
  });
});

describe("estado de verificação nos cadastros", () => {
  it("cliente cadastrado pela equipe nasce com o telefone confirmado como `team`", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);

    const created = await createCustomerAs(boss, {});

    expect(created.customer?.phoneVerified).toBe(true);
    expect(await customerRow(created.customer?.id ?? "")).toMatchObject({ via: "team" });
  });

  it("o cliente que troca o próprio telefone no portal volta a pendente, na conta e na ficha", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const customer = await createCustomer(boss);
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);

    // A conta do portal nasceu do número que a equipe cadastrou.
    const before = await owner<Verification[]>`
      select phone_verified_at as at, phone_verified_via as via
      from portal_user where email = ${customer.email}
    `;
    expect(before[0]?.via).toBe("team");

    const stolen = uniquePhone();
    const response = await call("PATCH", "/api/portal/me", {
      cookie,
      body: { name: "Cliente Teste", phone: stolen },
    });
    expect(response.status).toBe(200);

    const after = await owner<Verification[]>`
      select phone_verified_at as at, phone_verified_via as via
      from portal_user where email = ${customer.email}
    `;
    expect(after[0]).toEqual({ at: null, via: null });
    expect(await customerRow(customer.id)).toMatchObject({
      phone_key: phoneValues(stolen).phoneKey,
      at: null,
      via: null,
    });
  });

  it("conta e ficha com números diferentes: a ficha não herda a confirmação ao receber o número da conta", async () => {
    // A conta do portal é global. Aqui ela já tem o número da vítima, só declarado (a pessoa o
    // trocou em outra organização); a ficha desta organização segue com o número real, `team`.
    const boss = await createUser(owner);
    await createTenant(boss);
    const customer = await createCustomer(boss);
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);
    const victim = uniquePhone();
    const values = phoneValues(victim);
    await owner`
      update portal_user set phone = ${values.phone}, phone_normalized = ${values.phoneNormalized},
        phone_key = ${values.phoneKey}, phone_verified_at = null, phone_verified_via = null
      where email = ${customer.email}
    `;

    const response = await call("PATCH", "/api/portal/me", {
      cookie,
      body: { name: "Cliente Teste", phone: victim },
    });
    expect(response.status).toBe(200);

    // Para a conta nada mudou; para a ficha o número é novo, e novo número é pendente.
    expect(await customerRow(customer.id)).toMatchObject({
      phone_key: values.phoneKey,
      at: null,
      via: null,
    });
  });

  it("a conta do portal criada pelo convite herda o estado da ficha, nunca nasce confirmada sozinha", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const pending = await createCustomer(boss);
    await asPlatform(
      owner,
      (tx) => tx`
        update customer set phone_verified_at = null, phone_verified_via = null
        where id = ${pending.id}
      `,
    );

    await inviteAndEnter(boss, mail, pending.id, pending.email);

    const [account] = await owner<Verification[]>`
      select phone_verified_at as at, phone_verified_via as via
      from portal_user where email = ${pending.email}
    `;
    expect(account).toEqual({ at: null, via: null });
  });

  it("gravar o mesmo número de novo no portal não derruba a confirmação", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const phone = uniquePhone();
    const customer = await createCustomer(boss, { phone });
    const cookie = await inviteAndEnter(boss, mail, customer.id, customer.email);

    const response = await call("PATCH", "/api/portal/me", {
      cookie,
      // Outra forma do mesmo número, e o nome trocado.
      body: { name: "Outro Nome", phone: `+55 ${phone}` },
    });
    expect(response.status).toBe(200);

    expect(await customerRow(customer.id)).toMatchObject({ via: "team" });
  });

  it("o banco recusa confirmação sem número e forma desconhecida", async () => {
    const user = await createUser(owner);

    await expect(
      owner`update "user" set phone_verified_via = 'sms', phone_verified_at = now() where id = ${user.id}`,
    ).rejects.toThrow(/user_phone_verified_consistent/);
    await expect(
      owner`update "user" set phone_verified_at = now() where id = ${user.id}`,
    ).rejects.toThrow(/user_phone_verified_consistent/);
    // Confirmado sem número: só a linha anonimizada fica sem telefone, e ela não é confirmada.
    await expect(
      owner`
        update "user" set email = ${`deleted+${user.id}@invalid`}, phone = null,
          phone_normalized = null, phone_key = null,
          phone_verified_at = now(), phone_verified_via = 'manual'
        where id = ${user.id}
      `,
    ).rejects.toThrow(/user_phone_verified_consistent/);
  });
});

describe("quem é da equipe e também é cliente da organização", () => {
  it("a ficha nasce ligada ao membro pelo telefone confirmado, com o papel atual", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "admin");
    const phone = uniquePhone();
    await setUserPhone(colleague, phone);

    const created = await createCustomerAs(boss, { phone, email: newEmail() });

    expect(created.status).toBe(201);
    expect(created.customer?.team).toEqual({ userId: colleague.id, role: "admin" });

    // O papel é lido na hora: mudou na equipe, muda no selo.
    await owner`update member set role = 'member' where user_id = ${colleague.id}`;
    const detail = await call("GET", `/api/customers/${created.customer?.id}`, {
      cookie: boss.cookie,
    });
    expect((await detail.json()).customer.team).toEqual({
      userId: colleague.id,
      role: "member",
    });

    // E a lista filtra só quem é da equipe.
    await createCustomerAs(boss, {});
    const list = await call("GET", "/api/customers?team=true", { cookie: boss.cookie });
    const { items } = (await list.json()) as { items: { id: string }[] };
    expect(items.map(({ id }) => id)).toEqual([created.customer?.id]);
  });

  it("o próprio owner pode ser cliente da organização dele, com o mesmo telefone e e-mail", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const phone = uniquePhone();
    await setUserPhone(boss, phone);

    const created = await createCustomerAs(boss, { phone, email: boss.email });

    expect(created.status).toBe(201);
    expect(created.customer?.team).toEqual({ userId: boss.id, role: "owner" });

    // A ligação fica na auditoria da organização.
    const audits = await asPlatform(
      owner,
      (tx) => tx<{ metadata: Record<string, unknown> }[]>`
        select metadata from audit_log
        where action = 'customer.team_linked' and target_id = ${created.customer?.id ?? ""}
      `,
    );
    expect(audits.map(({ metadata }) => metadata)).toEqual([{ userId: boss.id, via: "created" }]);
  });

  it("telefone só declarado não puxa a ficha de ninguém", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const colleague = await createUser(owner);
    await addMember(owner, tenant.id, colleague, "member");
    const phone = uniquePhone();
    await setUserPhone(colleague, phone, false);

    const created = await createCustomerAs(boss, { phone });

    expect(created.customer?.team).toBeNull();
    expect((await customerRow(created.customer?.id ?? ""))?.user_id).toBeNull();
  });

  it("o e-mail da ficha nunca liga sozinho: colaborador não vira dono da ficha de outra pessoa", async () => {
    // O ataque: um colaborador cadastra o número de um cliente com o PRÓPRIO e-mail (verificado).
    // Se o e-mail bastasse, a ficha e as conversas do cliente passariam a ser "dele" e sumiriam
    // quando ele saísse da equipe (D-11).
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const insider = await createUser(owner);
    await addMember(owner, tenant.id, insider, "member");
    await setUserPhone(insider, uniquePhone());

    const created = await createCustomerAs(insider, {
      phone: uniquePhone(),
      email: insider.email,
    });

    expect(created.status).toBe(201);
    expect(created.customer?.team).toBeNull();
    expect((await customerRow(created.customer?.id ?? ""))?.user_id).toBeNull();
  });

  it("uma ficha por pessoa: quem já tem ficha e troca de número não ganha a segunda", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const oldPhone = uniquePhone();
    await setUserPhone(boss, oldPhone);
    const first = await createCustomerAs(boss, { phone: oldPhone });
    expect(first.customer?.team?.userId).toBe(boss.id);

    const newPhone = uniquePhone();
    await setUserPhone(boss, newPhone);
    const second = await createCustomerAs(boss, { phone: newPhone });

    expect(second.status).toBe(201);
    expect(second.customer?.team).toBeNull();
  });

  it("membro de outra organização com o mesmo número não é ligado", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const outsider = await createUser(owner);
    await createTenant(outsider, "Outra");
    const phone = uniquePhone();
    await setUserPhone(outsider, phone);

    const created = await createCustomerAs(boss, { phone });

    expect(created.customer?.team).toBeNull();
  });

  it("quem entra na equipe e já era cliente segue com a ficha, agora ligada", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);
    const phone = uniquePhone();
    const existing = await createCustomerAs(boss, { phone });
    expect(existing.customer?.team).toBeNull();

    const newcomer = await createUser(owner);
    await setUserPhone(newcomer, phone);
    await addMember(owner, tenant.id, newcomer, "member");

    expect(await linkMemberCustomer(tenant.id, newcomer.id)).toBe(existing.customer?.id);
    expect((await customerRow(existing.customer?.id ?? ""))?.user_id).toBe(newcomer.id);
    // De novo, não muda nada.
    expect(await linkMemberCustomer(tenant.id, newcomer.id)).toBe(existing.customer?.id);
  });

  it("quem entra na equipe: ficha ou conta com o telefone pendente não é ligada, nem pelo e-mail", async () => {
    const boss = await createUser(owner);
    const tenant = await createTenant(boss);

    // Conta com o telefone só declarado, igual ao da ficha (confirmada pela equipe).
    const declared = await createUser(owner);
    const phone = uniquePhone();
    await setUserPhone(declared, phone, false);
    const record = await createCustomerAs(boss, { phone, email: declared.email });
    await addMember(owner, tenant.id, declared, "member");
    expect(await linkMemberCustomer(tenant.id, declared.id)).toBeNull();

    // Conta confirmada, mas a ficha com esse número está pendente (declarado no portal).
    const confirmed = await createUser(owner);
    const other = uniquePhone();
    await setUserPhone(confirmed, other);
    const pending = await createCustomerAs(boss, { phone: other });
    await asPlatform(
      owner,
      (tx) => tx`
        update customer set phone_verified_at = null, phone_verified_via = null
        where id = ${pending.customer?.id ?? ""}
      `,
    );
    await addMember(owner, tenant.id, confirmed, "member");
    expect(await linkMemberCustomer(tenant.id, confirmed.id)).toBeNull();

    expect((await customerRow(record.customer?.id ?? ""))?.user_id).toBeNull();
    expect((await customerRow(pending.customer?.id ?? ""))?.user_id).toBeNull();
  });

  it("o aceite do convite liga a ficha de quem já era cliente", async () => {
    const boss = await createUser(owner);
    await createTenant(boss);
    const guest = await createUser(owner);
    const phone = uniquePhone();
    await setUserPhone(guest, phone);
    const existing = await createCustomerAs(boss, { phone });
    // No cadastro da ficha a pessoa ainda não era da equipe.
    expect(existing.customer?.team).toBeNull();

    const invited = await call("POST", "/api/team/invitations", {
      cookie: boss.cookie,
      body: { email: guest.email, role: "member" },
    });
    expect(invited.status).toBe(201);
    await waitForBackgroundTasks();
    const id = mail.sent
      .filter((m) => m.to === guest.email && m.tags?.template === "invite-member")
      .at(-1)
      ?.text.match(/\/convite\/([0-9a-f-]{36})/)?.[1];

    const accepted = await call("POST", `/api/invitations/${id}/accept`, {
      cookie: guest.cookie,
    });
    expect(accepted.status).toBe(200);

    expect((await customerRow(existing.customer?.id ?? ""))?.user_id).toBe(guest.id);
  });
});
