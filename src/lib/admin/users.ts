import { portalOrganizations, teamOrganizations } from "@/lib/admin/org-links";
import { escapeLike } from "@/lib/admin/tenants";
import { and, count, desc, eq, ilike, notLike, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { withPlatformScope } from "@/db/rls";
import {
  portalSession,
  portalUser,
  user,
} from "@/db/schema";
import { normalizePhone } from "@/lib/phone/br";
import { PAGE_SIZE } from "@/lib/schemas/admin";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Conta anonimizada pela exclusão (`deleted+<id>@invalid`, `src/lib/lgpd/deletion.ts`) não é
 * mais uma pessoa: fica fora das listas, como o detalhe já responde 404 (`isGhost`).
 */
const ANONYMIZED_EMAIL = "deleted+%@invalid";

/**
 * Usuários de equipe e da plataforma. `user` não tem RLS: quem chega aqui já passou por
 * `requirePlatform`. Não devolve nada além do que a tela mostra.
 */
export async function listUsers(input: { q?: string; page: number }) {
  const term = input.q ? `%${escapeLike(input.q)}%` : null;
  const where = and(
    notLike(user.email, ANONYMIZED_EMAIL),
    term ? or(ilike(user.email, term), ilike(user.name, term)) : undefined,
  );

  return withPlatformScope("admin: lista usuários", async (tx) => {
    const [totalRow] = await tx.select({ total: count() }).from(user).where(where);
    const rows = await tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        platformRole: user.role,
        emailVerified: user.emailVerified,
        banned: user.banned,
        banReason: user.banReason,
        createdAt: user.createdAt,
        phoneNormalized: user.phoneNormalized,
      })
      .from(user)
      .where(where)
      .orderBy(desc(user.createdAt))
      .limit(PAGE_SIZE)
      .offset((input.page - 1) * PAGE_SIZE);

    // admin-crud A: nome das organizações, no lugar da contagem.
    const links = await teamOrganizations(
      tx,
      rows.map(({ id }) => id),
    );
    // `phoneKind` diz se há telefone e de que tipo (a tela decide se oferece "Conversar"); o número não sai.
    const items = rows.map(({ phoneNormalized, ...row }) => {
      const parsed = phoneNormalized ? normalizePhone(`+${phoneNormalized}`) : null;
      return {
        ...row,
        phoneKind: parsed?.ok ? parsed.kind : null,
        organizations: links.get(row.id)?.organizations ?? [],
        more: links.get(row.id)?.more ?? 0,
      };
    });

    return { items, total: totalRow?.total ?? 0, pageSize: PAGE_SIZE };
  });
}

/**
 * Clientes e leads. Os vínculos leem `customer`, com RLS, e por isso rodam em
 * `withPlatformScope`. A lista atravessa tenants, e só a plataforma a vê.
 */
export function listPortalUsers(input: { q?: string; page: number }) {
  const term = input.q ? `%${escapeLike(input.q)}%` : null;
  const where = and(
    notLike(portalUser.email, ANONYMIZED_EMAIL),
    term ? or(ilike(portalUser.email, term), ilike(portalUser.name, term)) : undefined,
  );

  return withPlatformScope("admin: lista usuários do portal", async (tx) => {
    const [totalRow] = await tx
      .select({ total: count() })
      .from(portalUser)
      .where(where);
    const rows = await tx
      .select({
        id: portalUser.id,
        name: portalUser.name,
        email: portalUser.email,
        emailVerified: portalUser.emailVerified,
        sessions: sql<number>`(select count(*)::int from ${portalSession} where ${portalSession.userId} = "portal_user"."id" and ${portalSession.expiresAt} > now())`,
        createdAt: portalUser.createdAt,
      })
      .from(portalUser)
      .where(where)
      .orderBy(desc(portalUser.createdAt))
      .limit(PAGE_SIZE)
      .offset((input.page - 1) * PAGE_SIZE);

    // admin-crud A: nome das organizações, com o status do vínculo.
    const links = await portalOrganizations(
      tx,
      rows.map(({ id }) => id),
    );
    const items = rows.map((row) => ({
      ...row,
      organizations: links.get(row.id)?.organizations ?? [],
      more: links.get(row.id)?.more ?? 0,
    }));

    return { items, total: totalRow?.total ?? 0, pageSize: PAGE_SIZE };
  });
}

/** Derruba todas as sessões do cliente. Ele entra de novo por um magic link. */
export async function revokePortalSessions(portalUserId: string) {
  const [target] = await getDb()
    .select({ id: portalUser.id })
    .from(portalUser)
    .where(eq(portalUser.id, portalUserId));

  if (!target) throw notFound("Usuário não encontrado.");

  await getDb()
    .delete(portalSession)
    .where(eq(portalSession.userId, portalUserId));
}

/**
 * Só se bane quem é usuário comum. O plugin não compara o papel do alvo: sem esta
 * checagem, um proprietário baniria outro, ou a si mesmo, e perderia o acesso ao admin.
 */
export async function assertBannable(targetId: string, actorId: string) {
  if (targetId === actorId) {
    throw new TenantRuleError(409, "SELF_BAN", "Você não pode banir a si mesmo.");
  }

  const [target] = await getDb()
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, targetId));

  if (!target) throw notFound("Usuário não encontrado.");

  if (target.role !== "user") {
    throw new TenantRuleError(
      403,
      "PLATFORM_USER_PROTECTED",
      "Usuários da plataforma não podem ser banidos por aqui.",
    );
  }
}
