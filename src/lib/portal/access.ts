import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { type Tx, withPlatformScope, withTenant } from "@/db/rls";
import {
  customer,
  organization,
  portalSession,
  portalUser,
} from "@/db/schema";
import type { TenantAccessMode, TenantStatus } from "@/db/schema/tenant";
import { phoneValues } from "@/lib/phone/columns";
import type { CustomerStatus } from "@/lib/tenant/customer-constants";

/**
 * Quem o cliente é em cada tenant. A identidade (`portal_user`) atravessa tenants e o
 * vínculo fica em `customer`, com RLS: toda leitura aqui parte do usuário da sessão, nunca
 * de um id vindo do cliente sem esse filtro.
 */

const tenantColumns = {
  id: organization.id,
  slug: organization.slug,
  name: organization.name,
  tenantStatus: organization.status,
  accessMode: organization.accessMode,
  status: customer.status,
};

type TenantRow = {
  status: CustomerStatus;
  tenantStatus: TenantStatus;
  accessMode: TenantAccessMode;
};

/** Pode entrar agora? Tenant suspenso fecha o portal, como fecha `/app`. */
export function isAvailable({ status, tenantStatus, accessMode }: TenantRow) {
  return (
    status === "active" && tenantStatus === "active" && accessMode !== "locked"
  );
}

export type PortalTenant = {
  id: string;
  slug: string;
  name: string;
  status: CustomerStatus;
  available: boolean;
};

export async function listPortalTenants(
  portalUserId: string,
): Promise<PortalTenant[]> {
  const rows = await withPlatformScope("portal: tenants do cliente", (tx) =>
    tx
      .select(tenantColumns)
      .from(customer)
      .innerJoin(organization, eq(customer.tenantId, organization.id))
      .where(
        and(
          eq(customer.portalUserId, portalUserId),
          notInArray(organization.status, ["deleting", "deleted"]),
        ),
      )
      .orderBy(asc(customer.createdAt)),
  );

  return rows.map(({ id, slug, name, status, ...row }) => ({
    id,
    slug,
    name,
    status,
    available: isAvailable({ status, ...row }),
  }));
}

/** Sessão nova já abre no tenant, se só houver um; com mais de um, a pessoa escolhe. */
export async function soleTenantId(portalUserId: string) {
  const available = (await listPortalTenants(portalUserId)).filter(
    (tenant) => tenant.available,
  );

  return available.length === 1 ? (available[0]?.id ?? null) : null;
}

export type PortalCustomer = {
  id: string;
  tenant: { id: string; slug: string; name: string };
  tenantStatus: TenantStatus;
  accessMode: TenantAccessMode;
  status: CustomerStatus;
  name: string;
  /** `null` se o cadastro perdeu o e-mail: o acesso é cortado junto (`updateCustomer`). */
  email: string | null;
  phone: string | null;
  document: string | null;
};

/**
 * O vínculo do cliente com um tenant, ou `null`. Só o que o próprio cliente pode ver:
 * `notes` e `tags` são da equipe e não saem daqui.
 */
export async function findPortalCustomer(
  portalUserId: string,
  tenantId: string,
): Promise<PortalCustomer | null> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select({
        ...tenantColumns,
        customerId: customer.id,
        customerName: customer.name,
        email: customer.email,
        phone: customer.phone,
        document: customer.document,
      })
      .from(customer)
      .innerJoin(organization, eq(customer.tenantId, organization.id))
      .where(
        and(
          eq(customer.tenantId, tenantId),
          eq(customer.portalUserId, portalUserId),
        ),
      ),
  );

  if (!row) return null;

  return {
    id: row.customerId,
    tenant: { id: row.id, slug: row.slug, name: row.name },
    tenantStatus: row.tenantStatus,
    accessMode: row.accessMode,
    status: row.status,
    name: row.customerName,
    email: row.email,
    phone: row.phone,
    document: row.document,
  };
}

/** `last_login_at` conta a entrada em cada tenant, não a sessão: ela atravessa tenants. */
function touchLastLogin(tx: Tx, portalUserId: string, tenantId: string) {
  return tx
    .update(customer)
    .set({ lastLoginAt: new Date() })
    .where(
      and(
        eq(customer.tenantId, tenantId),
        eq(customer.portalUserId, portalUserId),
      ),
    );
}

export function recordPortalLogin(portalUserId: string, tenantId: string) {
  return withTenant(tenantId, (tx) => touchLastLogin(tx, portalUserId, tenantId));
}

/** A sessão passa a este tenant. Quem chama já conferiu que ele está disponível. */
export function enterPortalTenant(
  sessionId: string,
  portalUserId: string,
  tenantId: string,
) {
  return withTenant(tenantId, async (tx) => {
    await tx
      .update(portalSession)
      .set({ activeTenantId: tenantId })
      .where(eq(portalSession.id, sessionId));
    await touchLastLogin(tx, portalUserId, tenantId);
  });
}

/** Tira o tenant das sessões do cliente, na transação de quem cortou o acesso. */
export function leavePortalTenant(
  tx: Tx,
  portalUserId: string,
  tenantId: string,
) {
  return tx
    .update(portalSession)
    .set({ activeTenantId: null })
    .where(
      and(
        eq(portalSession.userId, portalUserId),
        eq(portalSession.activeTenantId, tenantId),
      ),
    );
}

/**
 * Identidade do e-mail, criada sem senha e sem verificação se ainda não existir. O telefone é
 * o do cliente convidado e só entra na criação: quem já tem conta (mesmo e-mail em outro
 * tenant) mantém o dele. Este `INSERT` direto não passa pelo hook do Better Auth.
 */
export async function ensurePortalUser(email: string, name: string, phone: string) {
  await getDb()
    .insert(portalUser)
    .values({ email, name, ...phoneValues(phone) })
    .onConflictDoNothing({ target: portalUser.email });

  const [row] = await getDb()
    .select({ id: portalUser.id })
    .from(portalUser)
    .where(eq(portalUser.email, email));
  if (!row) throw new Error("portal_user não criado");

  return row.id;
}

/** Sem cliente em nenhum tenant, a identidade é só dado pessoal parado. */
export function dropOrphanPortalUser(portalUserId: string) {
  return withPlatformScope("portal: remove identidade sem cliente", (tx) =>
    tx
      .delete(portalUser)
      .where(
        and(
          eq(portalUser.id, portalUserId),
          sql`not exists (select 1 from ${customer} where ${customer.portalUserId} = ${portalUser.id})`,
        ),
      ),
  );
}

/** Depois do login: `org` só escolhe entre os tenants em que a pessoa já está ativa. */
export async function enterRequestedTenant(
  sessionId: string,
  portalUserId: string,
  org: string | undefined,
) {
  if (!org) return;

  const tenants = await listPortalTenants(portalUserId);
  const chosen = tenants.find(({ slug, available }) => available && slug === org);

  if (chosen) await enterPortalTenant(sessionId, portalUserId, chosen.id);
}
