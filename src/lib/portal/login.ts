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

  await withTenant(tenant.id, async (tx) => {
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
      })
      .onConflictDoUpdate({
        target: [customer.tenantId, customer.email],
        set: { portalUserId: person.id },
        where: sql`${customer.portalUserId} is null and ${customer.status} = 'lead'`,
      })
      .returning({ id: customer.id });

    if (!row) return;

    await auditInTransaction(tx, "portal.signed_up", {
      actor: { type: "portal_user", id: person.id },
      tenantId: tenant.id,
      target: { type: "customer", id: row.id },
    });
  }).catch((error: unknown) => {
    // O telefone do autocadastro é de outro cliente do tenant (índice único por `phone_key`).
    // Quem se cadastrou escolhe o número: responder diferente (500) viraria um oráculo de quem é
    // cliente do tenant. Sem linha de cliente, a resposta é a mesma de sempre; a equipe cadastra.
    if (isUniqueViolation(error)) return;
    throw error;
  });
}
