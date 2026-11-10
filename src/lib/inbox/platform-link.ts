import { and, asc, eq, notInArray } from "drizzle-orm";
import type { Tx } from "@/db/rls";
import { type chatContact, member, organization, user } from "@/db/schema";
import { annotationsOfOrganizations, type OrgTagView } from "@/lib/crm/organization-profile";

/**
 * O que o painel do atendimento da plataforma mostra do contato (SPEC, "Plataforma"): o `user`
 * vinculado e as organizações dele, com a anotação da plataforma (`organization_tag` e
 * `organization_profile`, de `crm-cadastro`). **Nunca** lê `customer` de tenant: o cliente é do owner
 * (decisão do proprietário). Roda em `withPlatformData`, que não enxerga linha de tenant.
 */

export type PlatformOrganizationView = {
  id: string;
  name: string;
  /** Papel do usuário na organização (`owner`, `admin`, `member` ou o de um papel personalizado). */
  role: string;
  tags: OrgTagView[];
  /** Valores por **id** do campo (as definições vêm de `/api/admin/crm/custom-fields`). */
  customFields: Record<string, unknown>;
};

export type PlatformContactLink =
  | { kind: "user"; user: { id: string; name: string }; organizations: PlatformOrganizationView[] }
  | { kind: "none" };

/** Organizações em exclusão ou já apagadas não entram no painel (como o 404 da anotação). */
const LIVE = notInArray(organization.status, ["deleting", "deleted"]);

export async function platformLinkOf(
  tx: Tx,
  contact: typeof chatContact.$inferSelect,
): Promise<PlatformContactLink> {
  if (!contact.userId) return { kind: "none" };

  const [linked] = await tx
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, contact.userId));
  if (!linked) return { kind: "none" };

  const memberships = await tx
    .select({ id: organization.id, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, linked.id), LIVE))
    .orderBy(asc(organization.name))
    .limit(50);

  const annotations = await annotationsOfOrganizations(
    tx,
    memberships.map(({ id }) => id),
  );

  return {
    kind: "user",
    user: linked,
    organizations: memberships.map((row) => ({
      ...row,
      tags: annotations.get(row.id)?.tags ?? [],
      customFields: annotations.get(row.id)?.customFields ?? {},
    })),
  };
}
