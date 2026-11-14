import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { isUniqueViolation } from "@/db/errors";
import { withTenant } from "@/db/rls";
import {
  customer,
  organization,
  portalAccount,
  portalUser,
} from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { PENDING_SIGNUP_TTL_MS } from "@/lib/auth/pending-signup";
import { getPortalAuth } from "@/lib/auth/portal";
import type { PortalLinkContext } from "@/lib/auth/portal-emails";
import { type ConsentMeta, withSignupConsent } from "@/lib/lgpd/consent";
import { checkLimit } from "@/lib/billing/limits";
import { portalEmailBarred } from "@/lib/lgpd/deletion";
import { ensurePortalUser } from "@/lib/portal/access";
import { requestPhoneVerificationSend } from "@/lib/phone/dispatch";
import { isProtectedFromClaim } from "@/lib/phone/claim";
import { ensureCustomerVerification, openPortalClaim } from "@/lib/phone/requests";
import type { PortalSignupInput } from "@/lib/schemas/portal";

/**
 * Pedidos anônimos do portal. Tudo aqui roda em segundo plano, depois da resposta
 * uniforme: nada do que acontece ou deixa de acontecer chega a quem pediu.
 */

type TenantSettings = { portal_self_signup?: unknown };

/** Tenant que aceita entrada agora, pelo `org` do login. Suspenso é como inexistente. */
async function findOpenTenant(slug: string) {
  const [row] = await getDb()
    .select({
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      settings: organization.settings,
    })
    .from(organization)
    .where(
      and(
        eq(organization.slug, slug),
        eq(organization.status, "active"),
        sql`${organization.accessMode} <> 'locked'`,
      ),
    );

  if (!row) return null;

  const { settings, ...tenant } = row;

  return {
    ...tenant,
    selfSignup: (settings as TenantSettings).portal_self_signup === true,
  };
}

/** Só o que a tela de login mostra. Nenhum dado de cliente. */
export async function publicTenantInfo(slug: string) {
  const tenant = await findOpenTenant(slug);

  return tenant && { name: tenant.name, selfSignup: tenant.selfSignup };
}

/**
 * Só `active` recebe link: lead e bloqueado não entram, e e-mail desconhecido não gera
 * nada. A checagem vem antes do plugin, que gravaria a verificação para qualquer endereço.
 * Na carência de uma exclusão pedida pela plataforma, também não sai link.
 */
export async function requestPortalLogin(email: string, org: string) {
  if (await portalEmailBarred(email)) return;

  const tenant = await findOpenTenant(org);
  if (!tenant) return;

  const [current] = await withTenant(tenant.id, (tx) =>
    tx
      .select({
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        status: customer.status,
        portalUserId: customer.portalUserId,
      })
      .from(customer)
      .where(and(eq(customer.tenantId, tenant.id), eq(customer.email, email))),
  );

  if (current?.status !== "active") return;

  // Ativado por `status`, sem convite: ainda não tem identidade no portal.
  if (!current.portalUserId) {
    if (!current.phone) return;
    const portalUserId = await ensurePortalUser(email, current.name, current.phone);

    await withTenant(tenant.id, (tx) =>
      tx
        .update(customer)
        .set({ portalUserId })
        .where(and(eq(customer.id, current.id), eq(customer.tenantId, tenant.id))),
    );
  }

  await getPortalAuth().api.signInMagicLink({
    headers: new Headers(),
    body: {
      email,
      metadata: {
        kind: "login",
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        customerName: current.name,
      } satisfies PortalLinkContext,
    },
  });
}

/**
 * Como em `purgeExpiredPendingSignup`, a senha nasce antes de o e-mail ser provado. Conta
 * sem senha veio de convite: fica, à espera do clique.
 */
async function purgeExpiredPortalSignup(email: string) {
  await getDb()
    .delete(portalUser)
    .where(
      and(
        eq(portalUser.email, email),
        eq(portalUser.emailVerified, false),
        lt(portalUser.createdAt, new Date(Date.now() - PENDING_SIGNUP_TTL_MS)),
        sql`exists (select 1 from ${portalAccount} where ${portalAccount.userId} = ${portalUser.id})`,
      ),
    );
}

/** Autocadastro, só se o tenant permitir. O `customer` nasce depois da confirmação. */
export async function requestPortalSignup(
  { name, email, password, phone, org, termsVersion, marketing }: PortalSignupInput,
  meta: ConsentMeta = {},
) {
  const tenant = await findOpenTenant(org);
  if (!tenant?.selfSignup) return;

  await purgeExpiredPortalSignup(email);
  await withSignupConsent(
    { subjectType: "portal_user", termsVersion, marketing, phone, ...meta },
    () =>
      getPortalAuth().api.signUpEmail({
        headers: new Headers(),
        body: {
          name,
          email,
          password,
          callbackURL: `/portal?org=${encodeURIComponent(tenant.slug)}`,
        },
      }),
  );
}

/**
 * E-mail provado: vira `lead` do tenant, ou liga o lead que o owner já tinha cadastrado.
 * Só o owner promove a `active`, e uma linha ativa nunca é ligada aqui: a senha desta conta
 * nasceu antes da prova do e-mail. Plano sem vaga não ganha linha: autocadastro não derruba
 * o limite de quem paga.
 */
export async function confirmPortalSignup(email: string, org: string) {
  const tenant = await findOpenTenant(org);
  if (!tenant?.selfSignup) return;

  const [person] = await getDb()
    .select()
    .from(portalUser)
    .where(eq(portalUser.email, email));
  if (!person?.emailVerified) return;

  const { allowed } = await checkLimit(tenant.id, "customers");
  if (!allowed) return;

  const opened = await withTenant(tenant.id, async (tx) => {
    // O número do autocadastro já é de uma ficha desta organização, e nenhuma ficha tem o e-mail
    // (o e-mail decide antes: a ficha `lead` com ele é ligada abaixo, como sempre). Quem verifica
    // fica com o número (D-1): abre o `claim`, e a ficha nova só nasce quando o link do número for
    // confirmado na sessão do portal desta pessoa. A resposta não muda (neutra).
    const [byEmail] = await tx
      .select({ id: customer.id })
      .from(customer)
      .where(and(eq(customer.tenantId, tenant.id), eq(customer.email, person.email)));
    if (!byEmail && person.phone && person.phoneNormalized && person.phoneKey) {
      const [holder] = await tx
        .select({
          id: customer.id,
          portalUserId: customer.portalUserId,
          userId: customer.userId,
          status: customer.status,
        })
        .from(customer)
        .where(and(eq(customer.tenantId, tenant.id), eq(customer.phoneKey, person.phoneKey)));
      // A ficha com conta no portal, ligada à equipe ou bloqueada nunca é apagada por `claim`
      // (CL-7, CL-13): o pedido nem abre, e a resposta é a mesma do número que não ganha ficha.
      if (holder && !isProtectedFromClaim(holder)) {
        const claim = await openPortalClaim(
          tx,
          tenant.id,
          person.id,
          { phone: person.phone, phoneNormalized: person.phoneNormalized, phoneKey: person.phoneKey },
          { name: person.name, email: person.email },
        );
        return { requestId: claim.requestId, customerId: claim.subject.id };
      }
    }

    const [row] = await tx
      .insert(customer)
      .values({
        tenantId: tenant.id,
        portalUserId: person.id,
        name: person.name,
        email: person.email,
        // O telefone do autocadastro, o mesmo da conta (`CHECK`: toda pessoa tem telefone).
        phone: person.phone,
        phoneNormalized: person.phoneNormalized,
        phoneKey: person.phoneKey,
        // O número do autocadastro é só declarado até a pessoa confirmá-lo. A ficha só herda a
        // confirmação da conta quando ela vale no sistema inteiro (prova de posse, ou liberação
        // da plataforma): o que OUTRA organização atestou sobre esta pessoa não vale nesta.
        ...(person.phoneVerifiedAt &&
        (person.phoneVerifiedVia === "whatsapp" || person.phoneVerifiedVia === "manual")
          ? { phoneVerifiedAt: person.phoneVerifiedAt, phoneVerifiedVia: person.phoneVerifiedVia }
          : {}),
      })
      .onConflictDoUpdate({
        target: [customer.tenantId, customer.email],
        set: { portalUserId: person.id },
        where: sql`${customer.portalUserId} is null and ${customer.status} = 'lead'`,
      })
      .returning({ id: customer.id });

    if (!row) return null;

    // Telefone do autocadastro, só declarado: entra na fila de verificação da organização, e o
    // link sai pelos canais dela depois do commit.
    const requestId = await ensureCustomerVerification(tx, tenant.id, row.id);

    await auditInTransaction(tx, "portal.signed_up", {
      actor: { type: "portal_user", id: person.id },
      tenantId: tenant.id,
      target: { type: "customer", id: row.id },
    });

    return { requestId, customerId: row.id };
  }).catch((error: unknown) => {
    // Corrida: outra ficha ganhou o número (ou o e-mail) entre a conferência e a gravação (índice
    // único). Responder diferente (500) viraria um oráculo de quem é cliente do tenant: sem linha
    // de cliente, a resposta é a mesma de sempre.
    if (isUniqueViolation(error)) return null;
    throw error;
  });

  if (opened) {
    await requestPhoneVerificationSend(opened.requestId, { type: "customer", id: opened.customerId });
  }
}
