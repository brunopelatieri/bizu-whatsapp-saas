import type { Readable } from "node:stream";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { type Tx, withPlatformScope } from "@/db/rls";
import { file, user } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { getEnv } from "@/lib/env";
import { matchesSignature } from "@/lib/files/types";
import { getStorage, newStorageKey } from "@/lib/storage";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Foto de perfil da conta da equipe (`docs/specs/pre-producao/spec.md`, bloco F).
 *
 * A pessoa é global: a foto é um `file` com `owner_type = 'user_avatar'`, `owner_id` = a conta e
 * **`tenant_id` nulo**, e não conta no `storage_mb` de organização nenhuma. Só esta combinação vale
 * como foto: `POST /api/files` grava sempre com o `tenant_id` da organização, então um arquivo
 * enviado por lá com `owner_type = 'user_avatar'` nunca é servido como a foto de alguém.
 * `user.image` guarda o id do arquivo só para a interface saber que há foto; quem decide é a
 * consulta pelo dono, nunca o valor da coluna (o Better Auth deixa a coluna ser escrita no cadastro).
 *
 * Tipos aceitos: PNG, JPEG e WebP, **conferidos pela assinatura do conteúdo**. O tipo declarado e a
 * extensão não contam. SVG nunca (é um documento que executa script).
 */

export const AVATAR_OWNER = "user_avatar";

const AVATAR_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

export type AvatarMime = keyof typeof AVATAR_TYPES;

export const isAvatarMime = (mime: string): mime is AvatarMime => Object.hasOwn(AVATAR_TYPES, mime);

const AVATAR_MIMES = Object.keys(AVATAR_TYPES) as AvatarMime[];

/**
 * O tipo da imagem pelos primeiros bytes, com as assinaturas do módulo de arquivos
 * (`matchesSignature`). `null`: não é PNG, JPEG nem WebP.
 */
export function detectAvatarType(bytes: Buffer): AvatarMime | null {
  return AVATAR_MIMES.find((mime) => matchesSignature(mime, bytes)) ?? null;
}

/** Teto da foto, em bytes (`AVATAR_MAX_KB`). */
export const avatarMaxBytes = () => getEnv().AVATAR_MAX_KB * 1024;

/** As fotos da conta: só as da plataforma (`tenant_id` nulo) e do dono certo. */
const ofUser = (userId: string) =>
  and(eq(file.ownerType, AVATAR_OWNER), eq(file.ownerId, userId), isNull(file.tenantId));

/** Trava a conta: duas trocas ao mesmo tempo não deixam duas fotos. */
async function lockAccount(tx: Tx, userId: string) {
  await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
}

async function deleteObjects(keys: string[]) {
  for (const key of keys) {
    await getStorage()
      .delete(key)
      .catch((error) => logError("Falha ao apagar a foto de perfil do armazenamento", error));
  }
}

type AvatarActor = { userId: string; ip?: string | null };

/**
 * `POST /api/me/avatar`: guarda a foto nova e apaga a anterior. Recusa conteúdo vazio (400), maior
 * que `AVATAR_MAX_KB` (413) e o que não é PNG, JPEG nem WebP pela assinatura (415). O objeto é
 * gravado antes da transação; se o banco falhar, ele é apagado.
 */
export async function uploadAvatar(content: Buffer, actor: AvatarActor) {
  if (content.length === 0) throw new TenantRuleError(400, "EMPTY_FILE", "O arquivo está vazio.");
  if (content.length > avatarMaxBytes()) {
    throw new TenantRuleError(413, "FILE_TOO_LARGE", "Imagem grande demais.");
  }

  const mime = detectAvatarType(content);
  if (!mime) {
    throw new TenantRuleError(
      415,
      "UNSUPPORTED_FILE_TYPE",
      "Envie uma imagem PNG, JPEG ou WebP.",
    );
  }

  const storage = getStorage();
  const key = newStorageKey(`avatars/${actor.userId}`);
  await storage.put(key, content, { contentType: mime });

  try {
    const { created, removedKeys } = await withPlatformScope("perfil: troca a foto", async (tx) => {
      await lockAccount(tx, actor.userId);
      const [row] = await tx
        .insert(file)
        .values({
          tenantId: null,
          ownerType: AVATAR_OWNER,
          ownerId: actor.userId,
          key,
          name: `foto-de-perfil.${AVATAR_TYPES[mime]}`,
          size: content.length,
          mime,
          provider: storage.id,
          createdBy: actor.userId,
        })
        .returning();
      if (!row) throw new Error("foto de perfil não gravada");

      // A anterior sai junto: a pessoa tem uma foto só.
      const removed = await tx
        .delete(file)
        .where(and(ofUser(actor.userId), ne(file.id, row.id)))
        .returning({ key: file.key });
      await tx.update(user).set({ image: row.id }).where(eq(user.id, actor.userId));
      await auditInTransaction(tx, "user.avatar_updated", {
        actor: { id: actor.userId },
        target: { type: "user", id: actor.userId },
        metadata: { size: content.length, mime, replaced: removed.length },
        ip: actor.ip,
      });

      return { created: row, removedKeys: removed.map((item) => item.key) };
    });

    await deleteObjects(removedKeys);
    return { id: created.id, mime: created.mime, size: created.size };
  } catch (error) {
    await storage
      .delete(key)
      .catch((cleanup) => logError("Falha ao limpar a foto de perfil órfã", cleanup));
    throw error;
  }
}

/** `DELETE /api/me/avatar`: tira a foto. Sem foto, nada muda (e a rota responde o mesmo 204). */
export async function removeAvatar(actor: AvatarActor) {
  const removedKeys = await withPlatformScope("perfil: tira a foto", async (tx) => {
    await lockAccount(tx, actor.userId);
    const removed = await tx.delete(file).where(ofUser(actor.userId)).returning({ key: file.key });
    await tx.update(user).set({ image: null }).where(eq(user.id, actor.userId));
    if (removed.length > 0) {
      await auditInTransaction(tx, "user.avatar_removed", {
        actor: { id: actor.userId },
        target: { type: "user", id: actor.userId },
        ip: actor.ip,
      });
    }
    return removed.map((item) => item.key);
  });

  await deleteObjects(removedKeys);
}

/**
 * Quem vê a foto de uma conta: a própria pessoa, a equipe da plataforma e quem é da equipe de uma
 * organização em comum (`member`, que não tem RLS, nas duas pontas). Ninguém mais.
 */
async function canSeeAvatar(tx: Tx, viewer: { id: string; platformStaff: boolean }, targetId: string) {
  if (viewer.id === targetId || viewer.platformStaff) return true;

  const [shared] = await tx.execute<{ ok: number }>(sql`
    select 1 as ok
    from member mine
    join member theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = ${viewer.id} and theirs.user_id = ${targetId}
    limit 1
  `);
  return shared !== undefined;
}

/**
 * `GET /api/avatars/:userId`: o registro e o conteúdo da foto, se quem pede pode vê-la. Sem foto, ou
 * sem permissão, o mesmo 404: a resposta não diz se a conta existe nem se tem foto.
 */
export async function openAvatar(
  viewer: { id: string; platformStaff: boolean },
  targetId: string,
): Promise<{ record: typeof file.$inferSelect & { mime: AvatarMime }; stream: Readable }> {
  const record = await withPlatformScope("perfil: lê a foto", async (tx) => {
    if (!(await canSeeAvatar(tx, viewer, targetId))) return null;

    const [row] = await tx
      .select()
      .from(file)
      .where(ofUser(targetId))
      .orderBy(desc(file.createdAt))
      .limit(1);
    return row ?? null;
  });
  if (!record || !isAvatarMime(record.mime)) throw notFound("Foto não encontrada.");

  const stream = await getStorage().get(record.key);
  if (!stream) throw notFound("Foto não encontrada.");

  return { record: { ...record, mime: record.mime }, stream };
}

/** O id da foto da conta, para a interface montar a URL (`null` sem foto). */
export async function avatarIdOf(userId: string) {
  const [row] = await withPlatformScope("perfil: id da foto", (tx) =>
    tx.select({ id: file.id }).from(file).where(ofUser(userId)).orderBy(desc(file.createdAt)).limit(1),
  );
  return row?.id ?? null;
}

/** A URL da foto na API, com o id do arquivo para o cache trocar junto com ela. */
export const avatarUrl = (userId: string, fileId: string | null) =>
  fileId ? `/api/avatars/${userId}?v=${fileId}` : null;

/**
 * LGPD, na transação (com bypass) da anonimização da conta: as fotos saem do banco e as chaves
 * voltam para quem chama apagar os objetos depois do commit.
 */
export async function deleteAvatarsOf(tx: Tx, userIds: string[]) {
  if (userIds.length === 0) return [];

  const removed = await tx
    .delete(file)
    .where(
      and(eq(file.ownerType, AVATAR_OWNER), inArray(file.ownerId, userIds), isNull(file.tenantId)),
    )
    .returning({ key: file.key });
  return removed.map((item) => item.key);
}

/**
 * Contas apagadas de verdade (o expurgo do cadastro pendente, `pending-signup.ts`): `file.owner_id`
 * não tem FK, então as fotos delas saem aqui, com os objetos.
 */
export async function removeAvatarsOfDeleted(userIds: string[]) {
  if (userIds.length === 0) return;

  const keys = await withPlatformScope("perfil: fotos de contas apagadas", (tx) =>
    deleteAvatarsOf(tx, userIds),
  );
  await deleteObjects(keys);
}

/** LGPD, exportação da conta: a foto como arquivo do zip (`null` sem foto). */
export async function avatarForExport(userId: string) {
  const [record] = await withPlatformScope("lgpd: foto de perfil", (tx) =>
    tx.select().from(file).where(ofUser(userId)).orderBy(desc(file.createdAt)).limit(1),
  );
  if (!record || !isAvatarMime(record.mime)) return null;

  const stream = await getStorage().get(record.key);
  if (!stream) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }

  return { name: `foto-de-perfil.${AVATAR_TYPES[record.mime]}`, data: Buffer.concat(chunks) };
}
