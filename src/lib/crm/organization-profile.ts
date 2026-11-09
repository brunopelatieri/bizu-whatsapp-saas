import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type Tx, withPlatformData } from "@/db/rls";
import { organization, organizationProfile, organizationTag, tag } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import {
  assertRequiredFilled,
  customFieldsMergeSql,
  resolveCustomFieldsIn,
  valuesOf,
} from "@/lib/crm/custom-fields";
import { type CustomFieldValues, mergeCustomFields } from "@/lib/crm/values";
import type { OrganizationProfileInput } from "@/lib/schemas/crm";
import { notFound } from "@/lib/tenant/errors";

/**
 * Anotação da plataforma sobre uma organização: etiquetas (`organization_tag`) e valores de
 * campos (`organization_profile`). É dado da **plataforma**: tudo roda em `withPlatformData`
 * (a `platformOnlyPolicy()` recusa qualquer outro contexto) e nenhuma rota de tenant importa
 * este arquivo. Nunca use `withPlatformScope` aqui: ele atravessa tenants e leria tudo.
 * Nome de etiqueta e valor de campo não vão para a auditoria (só ids).
 */

const NOT_FOUND = "Organização não encontrada.";

export type OrgTagView = { id: string; name: string; color: string };
export type OrganizationAnnotation = {
  tags: OrgTagView[];
  customFields: Record<string, unknown>;
};

export type ProfileActor = { userId: string | null; ip?: string };

/** As etiquetas da plataforma de um conjunto de organizações, por organização (uma consulta). */
async function tagsOfOrganizations(tx: Tx, organizationIds: string[]) {
  const result = new Map<string, OrgTagView[]>();
  if (organizationIds.length === 0) return result;

  const rows = await tx
    .select({
      organizationId: organizationTag.organizationId,
      id: tag.id,
      name: tag.name,
      color: tag.color,
    })
    .from(organizationTag)
    .innerJoin(tag, eq(organizationTag.tagId, tag.id))
    .where(inArray(organizationTag.organizationId, organizationIds))
    .orderBy(asc(sql`lower(${tag.name})`));

  for (const { organizationId, ...view } of rows) {
    const list = result.get(organizationId) ?? [];
    list.push(view);
    result.set(organizationId, list);
  }

  return result;
}

/** Organizações que têm qualquer uma das etiquetas (filtro `tags=` de `/api/admin/tenants`). */
export function organizationIdsWithTags(tagIds: string[]): Promise<string[]> {
  if (tagIds.length === 0) return Promise.resolve([]);

  return withPlatformData(async (tx) => {
    const rows = await tx
      .selectDistinct({ id: organizationTag.organizationId })
      .from(organizationTag)
      .where(inArray(organizationTag.tagId, tagIds));

    return rows.map(({ id }) => id);
  });
}

/** Etiquetas das organizações de uma página da lista, por id da organização. */
export function tagsOfOrganizationPage(organizationIds: string[]) {
  return withPlatformData((tx) => tagsOfOrganizations(tx, organizationIds));
}

async function annotationOf(tx: Tx, organizationId: string): Promise<OrganizationAnnotation> {
  const tags = (await tagsOfOrganizations(tx, [organizationId])).get(organizationId) ?? [];
  const [profile] = await tx
    .select({ customFields: organizationProfile.customFields })
    .from(organizationProfile)
    .where(eq(organizationProfile.organizationId, organizationId));

  return { tags, customFields: profile?.customFields ?? {} };
}

/**
 * A organização existe e não está em exclusão; senão 404, sem dizer qual dos dois (quem nunca
 * existiu e quem está sendo apagada respondem igual).
 */
async function assertAnnotatable(tx: Tx, organizationId: string) {
  const [row] = await tx
    .select({ id: organization.id, status: organization.status })
    .from(organization)
    .where(eq(organization.id, organizationId));

  if (!row || row.status === "deleting" || row.status === "deleted") throw notFound(NOT_FOUND);
}

/**
 * Etiquetas e valores da organização, para o detalhe em `/admin/tenants/:id` (a rota já
 * confirmou que a organização existe; a leitura vale também em exclusão).
 */
export function getOrganizationAnnotation(organizationId: string) {
  return withPlatformData((tx) => annotationOf(tx, organizationId));
}

/** Todas as etiquetas pedidas são da plataforma; senão 404 (sem dizer qual). */
async function assertPlatformTags(tx: Tx, tagIds: string[]) {
  if (tagIds.length === 0) return;

  const found = await tx
    .select({ id: tag.id })
    .from(tag)
    .where(and(isNull(tag.tenantId), inArray(tag.id, tagIds)));

  if (found.length !== tagIds.length) throw notFound("Etiqueta não encontrada.");
}

/**
 * `PUT /api/admin/tenants/:id/profile`. Etiquetas substituem o conjunto; campos fazem merge por
 * chave (`null` remove) e `required` vale sobre o estado final, só quando o corpo traz
 * `customFields`. A auditoria (`admin.tenant_profile_updated`) vai **sem `tenant_id`**: com ele,
 * o owner a leria em `/app/auditoria`, e a regra é que ele nunca vê a anotação.
 */
export function setOrganizationProfile(
  organizationId: string,
  input: OrganizationProfileInput,
  actor: ProfileActor,
) {
  return withPlatformData(async (tx) => {
    await assertAnnotatable(tx, organizationId);

    // Um por organização: serializa o merge dos valores e a troca das etiquetas.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`org_profile:${organizationId}`}))`,
    );

    if (input.customFields) {
      // Antes de gravar o valor: a exclusão do campo trava o campo e depois os perfis.
      const resolved = await resolveCustomFieldsIn(tx, { kind: "platform" }, input.customFields);

      const [current] = await tx
        .select({ customFields: organizationProfile.customFields })
        .from(organizationProfile)
        .where(eq(organizationProfile.organizationId, organizationId))
        .for("update");

      const merged = mergeCustomFields(
        (current?.customFields ?? {}) as CustomFieldValues,
        resolved.patch,
      );
      assertRequiredFilled(resolved.defs, merged);

      if (current) {
        await tx
          .update(organizationProfile)
          .set({
            customFields: customFieldsMergeSql(resolved.patch, organizationProfile.customFields),
            updatedBy: actor.userId,
          })
          .where(eq(organizationProfile.organizationId, organizationId));
      } else {
        await tx.insert(organizationProfile).values({
          organizationId,
          customFields: valuesOf(resolved.patch),
          updatedBy: actor.userId,
        });
      }
    }

    if (input.tagIds) {
      await assertPlatformTags(tx, input.tagIds);

      await tx.delete(organizationTag).where(eq(organizationTag.organizationId, organizationId));
      if (input.tagIds.length > 0) {
        await tx
          .insert(organizationTag)
          .values(input.tagIds.map((tagId) => ({ organizationId, tagId })));
      }
    }

    await auditInTransaction(tx, "admin.tenant_profile_updated", {
      actor: { type: "platform", id: actor.userId },
      target: { type: "tenant", id: organizationId },
      metadata: {
        tags: input.tagIds ? input.tagIds.length : null,
        fields: input.customFields ? Object.keys(input.customFields).join(",") : null,
      },
      ip: actor.ip,
    });

    return annotationOf(tx, organizationId);
  });
}
