import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { type Tx, withTenant } from "@/db/rls";
import { customer, portalAccount, portalSession, portalUser } from "@/db/schema";
import { audit, auditInTransaction } from "@/lib/audit";
import { runInBackground } from "@/lib/auth/background";
import {
  evaluatePassword,
  isPasswordValid,
  normalizePassword,
  PASSWORD_POLICY_CODE,
  PASSWORD_POLICY_MESSAGE,
} from "@/lib/auth/password-policy";
import { clearLoginThrottleForEmail } from "@/lib/auth/login-throttle-store";
import { getPortalAuth } from "@/lib/auth/portal";
import { requestPhoneVerificationSend } from "@/lib/phone/dispatch";
import {
  cancelCustomerPhoneChange,
  type NewPhone,
  openCustomerPhoneChange,
} from "@/lib/phone/requests";
import { UNVERIFIED_PHONE } from "@/lib/phone/verification";
import { sendPortalPasswordChanged } from "@/lib/auth/portal-emails";
import type { PortalCustomer } from "@/lib/portal/access";
import type {
  PortalProfileInput,
  SetPasswordInput,
} from "@/lib/schemas/portal";
import { phoneValues } from "@/lib/phone/columns";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/** Sessão aberta há menos que isto acabou de provar o e-mail ou a senha. */
const FRESH_SESSION_MS = 10 * 60 * 1000;

const CREDENTIAL = "credential";

export async function hasPortalPassword(portalUserId: string) {
  const [row] = await getDb()
    .select({ id: portalAccount.id })
    .from(portalAccount)
    .where(
      and(
        eq(portalAccount.userId, portalUserId),
        eq(portalAccount.providerId, CREDENTIAL),
      ),
    );

  return row !== undefined;
}

/** Trava a ficha da pessoa no tenant ativo: é a ordem de quem confirma o telefone (`requests.ts`). */
async function lockRecord(tx: Tx, tenantId: string, customerId: string) {
  const [record] = await tx
    .select({ phoneKey: customer.phoneKey })
    .from(customer)
    .where(and(eq(customer.id, customerId), eq(customer.tenantId, tenantId)))
    .for("update");
  if (!record) throw notFound("Cliente não encontrado.");

  return record;
}

const requesterOf = (portalUserId: string) => ({ type: "portal_user", id: portalUserId }) as const;

/**
 * Atualiza a pessoa e o cadastro dela no tenant ativo, sem tocar nos outros tenants. O nome muda na
 * hora. **O telefone não**: outro número abre a troca pelo pedido (`openCustomerPhoneChange`), e a
 * ficha fica com o número antigo, e a confirmação dele, até o link do número novo ser confirmado na
 * sessão desta pessoa ou o owner liberar (bloco T, P1). Sem isso, a pessoa trocaria o número da
 * ficha pelo de um terceiro, e a conversa dele viria para ela. A resposta não diz se o número novo já
 * é de outro cliente da organização: isso só aparece para quem prova a posse dele.
 *
 * O mesmo número escrito de outro jeito (com ou sem o 9º dígito: a mesma `phone_key`) é gravado
 * direto, sem mexer na confirmação.
 */
export async function updatePortalProfile(
  portalUserId: string,
  current: PortalCustomer,
  input: PortalProfileInput,
  ip?: string,
) {
  const tenantId = current.tenant.id;
  const phone = phoneValues(input.phone);

  const updated = await withTenant(tenantId, async (tx) => {
    const record = await lockRecord(tx, tenantId, current.id);
    const [account] = await tx
      .select({ phoneKey: portalUser.phoneKey })
      .from(portalUser)
      .where(eq(portalUser.id, portalUserId))
      .for("update");
    const samePhone = record.phoneKey === phone.phoneKey;

    // A conta global acompanha a ficha só quando a ficha não muda de número; o número novo chega
    // à conta na confirmação da troca. A confirmação de uma linha nunca serve à outra.
    const accountPhone = !samePhone
      ? {}
      : account?.phoneKey === phone.phoneKey
        ? phone
        : { ...phone, ...UNVERIFIED_PHONE };

    const [person] = await tx
      .update(portalUser)
      .set({ name: input.name, ...accountPhone })
      .where(eq(portalUser.id, portalUserId))
      .returning({
        id: portalUser.id,
        name: portalUser.name,
        email: portalUser.email,
        phone: portalUser.phone,
        phoneNormalized: portalUser.phoneNormalized,
      });

    await tx
      .update(customer)
      .set({ name: input.name, ...(samePhone ? phone : {}) })
      .where(and(eq(customer.id, current.id), eq(customer.tenantId, tenantId)));

    const opened = samePhone
      ? null
      : await openCustomerPhoneChange(tx, tenantId, current.id, phone, requesterOf(portalUserId));

    await auditInTransaction(tx, "portal.profile_updated", {
      actor: { type: "portal_user", id: portalUserId },
      tenantId,
      target: { type: "customer", id: current.id },
      metadata: { phoneChange: opened !== null },
      ip,
    });

    return { person, opened };
  });

  if (updated.opened) {
    await requestPhoneVerificationSend(
      updated.opened.requestId,
      { type: "customer", id: current.id },
      updated.opened.reason,
    );
  }

  return { user: updated.person, phoneChangePending: updated.opened !== null };
}

/**
 * `POST /api/portal/me/phone-change`: a troca do número da ficha da organização ativa, pedida pela
 * própria pessoa. A ficha não muda até a confirmação. Devolve o pedido para o envio, depois do commit.
 */
export function requestPortalPhoneChange(
  portalUserId: string,
  current: PortalCustomer,
  phone: NewPhone,
) {
  const tenantId = current.tenant.id;

  return withTenant(tenantId, async (tx) => {
    await lockRecord(tx, tenantId, current.id);
    return openCustomerPhoneChange(tx, tenantId, current.id, phone, requesterOf(portalUserId));
  });
}

/** `DELETE /api/portal/me/phone-change`: desiste da troca aberta da ficha da organização ativa. */
export function cancelPortalPhoneChange(portalUserId: string, current: PortalCustomer) {
  const tenantId = current.tenant.id;

  return withTenant(tenantId, async (tx) => {
    await lockRecord(tx, tenantId, current.id);
    return cancelCustomerPhoneChange(tx, tenantId, current.id, requesterOf(portalUserId));
  });
}

type PasswordActor = {
  user: { id: string; email: string; name: string };
  session: { id: string; createdAt: Date };
  ip?: string;
};

/**
 * Define ou troca a senha pela sessão. Quem tem senha confirma a atual, salvo com sessão
 * recém-aberta: é assim que se recupera a senha, entrando por um magic link. As outras
 * sessões caem, porque trocar a senha costuma ser reação a um acesso indevido.
 *
 * Grava o hash direto, sem o endpoint do Better Auth (e sem o hook dele): a política e a
 * normalização são repetidas aqui, para não depender de quem chama ter passado pelo Zod.
 */
export async function setPortalPassword(
  { user, session, ip }: PasswordActor,
  input: SetPasswordInput,
) {
  const newPassword = normalizePassword(input.newPassword);
  const currentPassword =
    input.currentPassword === undefined
      ? undefined
      : normalizePassword(input.currentPassword);

  if (!isPasswordValid(evaluatePassword(newPassword))) {
    throw new TenantRuleError(400, PASSWORD_POLICY_CODE, PASSWORD_POLICY_MESSAGE);
  }

  const { internalAdapter, password } = await getPortalAuth().$context;
  const accounts = await internalAdapter.findAccounts(user.id);
  const stored = accounts.find(({ providerId }) => providerId === CREDENTIAL);

  if (stored?.password) {
    const fresh = Date.now() - session.createdAt.getTime() < FRESH_SESSION_MS;
    const confirmed =
      fresh ||
      (currentPassword !== undefined &&
        (await password.verify({
          hash: stored.password,
          password: currentPassword,
        })));

    if (!confirmed) {
      throw new TenantRuleError(
        403,
        "CURRENT_PASSWORD_REQUIRED",
        "Confirme sua senha atual.",
      );
    }
  }

  const hash = await password.hash(newPassword);

  if (stored) {
    await internalAdapter.updatePassword(user.id, hash);
  } else {
    await internalAdapter.linkAccount({
      userId: user.id,
      providerId: CREDENTIAL,
      accountId: user.id,
      password: hash,
    });
  }

  await getDb()
    .delete(portalSession)
    .where(
      and(eq(portalSession.userId, user.id), ne(portalSession.id, session.id)),
    );

  // A senha foi definida por quem tem sessão: o bloqueio de login daquele e-mail cai.
  runInBackground(clearLoginThrottleForEmail("portal", user.email));
  runInBackground(sendPortalPasswordChanged(user));
  await audit("portal.password_set", {
    actor: { type: "portal_user", id: user.id },
    ip,
  });
}
