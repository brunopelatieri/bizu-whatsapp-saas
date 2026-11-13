import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { withTenant } from "@/db/rls";
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
import { UNVERIFIED_PHONE } from "@/lib/phone/verification";
import { sendPortalPasswordChanged } from "@/lib/auth/portal-emails";
import type { PortalCustomer } from "@/lib/portal/access";
import type {
  PortalProfileInput,
  SetPasswordInput,
} from "@/lib/schemas/portal";
import { phoneValues } from "@/lib/phone/columns";
import { phoneInUse, TenantRuleError } from "@/lib/tenant/errors";

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

/** Atualiza a pessoa e o cadastro dela no tenant ativo, sem tocar nos outros tenants. */
export function updatePortalProfile(
  portalUserId: string,
  current: PortalCustomer,
  input: PortalProfileInput,
  ip?: string,
) {
  const tenantId = current.tenant.id;
  // Duas formas do mesmo número casam em `phone_key`; o índice único do tenant barra a repetida.
  const phone = phoneValues(input.phone);
  const base = { name: input.name, ...phone };

  /**
   * Número novo declarado pela própria pessoa deixa de valer como confirmado: é o que impede a
   * conversa de outro dono do número de ser vinculada a este cadastro (`autoLinkContact` só usa
   * telefone confirmado). A decisão é **por linha**. A conta é global e a ficha é do tenant
   * ativo: as duas podem ter números diferentes (a pessoa já trocou o número em outra
   * organização, ou o /admin editou a conta), e a confirmação de uma nunca serve à outra. A
   * troca com link de verificação é a T2.
   */
  const valuesFor = (currentKey: string | null | undefined) =>
    currentKey === phone.phoneKey ? base : { ...base, ...UNVERIFIED_PHONE };

  return withTenant(tenantId, async (tx) => {
    const [account] = await tx
      .select({ phoneKey: portalUser.phoneKey })
      .from(portalUser)
      .where(eq(portalUser.id, portalUserId))
      .for("update");
    const [record] = await tx
      .select({ phoneKey: customer.phoneKey })
      .from(customer)
      .where(and(eq(customer.id, current.id), eq(customer.tenantId, tenantId)))
      .for("update");

    const [person] = await tx
      .update(portalUser)
      .set(valuesFor(account?.phoneKey))
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
      .set(valuesFor(record?.phoneKey))
      .where(and(eq(customer.id, current.id), eq(customer.tenantId, tenantId)));
    await auditInTransaction(tx, "portal.profile_updated", {
      actor: { type: "portal_user", id: portalUserId },
      tenantId,
      target: { type: "customer", id: current.id },
      ip,
    });

    return person;
  }).catch((error: unknown) => {
    // Outro cliente do tenant já tem o número: sem dizer quem (o autor é o próprio cliente).
    if (isUniqueViolation(error)) throw phoneInUse();
    throw error;
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
