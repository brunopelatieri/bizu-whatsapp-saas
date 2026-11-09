import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { withTenant } from "@/db/rls";
import { customer, portalAccount, portalSession, portalUser } from "@/db/schema";
import { audit, auditInTransaction } from "@/lib/audit";
import { runInBackground } from "@/lib/auth/background";
import { getPortalAuth } from "@/lib/auth/portal";
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
  const values = { name: input.name, ...phoneValues(input.phone) };

  return withTenant(tenantId, async (tx) => {
    const [person] = await tx
      .update(portalUser)
      .set(values)
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
      .set(values)
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
 */
export async function setPortalPassword(
  { user, session, ip }: PasswordActor,
  { newPassword, currentPassword }: SetPasswordInput,
) {
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

  runInBackground(sendPortalPasswordChanged(user));
  await audit("portal.password_set", {
    actor: { type: "portal_user", id: user.id },
    ip,
  });
}
