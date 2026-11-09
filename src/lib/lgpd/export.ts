import { and, desc, eq, lt, sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { getBoss } from "@/jobs/boss";
import { QUEUE, type LgpdExportJob } from "@/jobs/queues";
import { type Tx, withPlatformScope, withTenant } from "@/db/rls";
import {
  auditLog,
  consentLog,
  customer,
  dataExport,
  member,
  organization,
  portalUser,
  user,
} from "@/db/schema";
import type { ConsentSubjectType } from "@/db/schema/lgpd";
import { audit } from "@/lib/audit";
import { appLink } from "@/lib/auth/links";
import { isOwner } from "@/lib/auth/permissions";
import { sendEmail } from "@/lib/email/send";
import { dataExportReadyTemplate } from "@/lib/email/templates/data-export-ready";
import { createZip, type ZipEntry } from "@/lib/lgpd/zip";
import { EXPORT_LINK_TTL_MS, signExportLink } from "@/lib/lgpd/link";
import { getStorage, newStorageKey } from "@/lib/storage";
import { TenantRuleError } from "@/lib/tenant/errors";
import { tagsOfCustomers } from "@/lib/crm/tags";

export type ExportSubject = { type: ConsentSubjectType; id: string };

/** Pedido `pending` há mais que isto é de um job que morreu: libera um pedido novo. */
const STALE_PENDING_MS = 60 * 60 * 1000;
const AUDIT_EXPORT_LIMIT = 5000;

const DOWNLOAD_PATH: Record<ConsentSubjectType, string> = {
  user: "/api/me/export",
  portal_user: "/api/portal/me/export",
};

/** Link absoluto do download, com a assinatura de 7 dias. */
export function downloadUrl(
  subjectType: ConsentSubjectType,
  exportId: string,
  expiresAt: Date,
) {
  return appLink(`${DOWNLOAD_PATH[subjectType]}/${exportId}/download`, {
    sig: signExportLink(exportId, expiresAt),
  });
}

/**
 * Cria o pedido e enfileira `lgpd.export`. Um pendente por pessoa; o índice único é quem
 * decide na corrida entre dois cliques.
 */
export async function requestExport(
  subject: ExportSubject,
  ip?: string | null,
  now = new Date(),
) {
  const stale = new Date(now.getTime() - STALE_PENDING_MS);

  const created = await withPlatformScope("lgpd: pedido de exportação", async (tx) => {
    await tx
      .update(dataExport)
      .set({ status: "failed" })
      .where(
        and(
          eq(dataExport.subjectType, subject.type),
          eq(dataExport.subjectId, subject.id),
          eq(dataExport.status, "pending"),
          lt(dataExport.createdAt, stale),
        ),
      );

    const [row] = await tx
      .insert(dataExport)
      .values({ subjectType: subject.type, subjectId: subject.id })
      .onConflictDoNothing()
      .returning({ id: dataExport.id });

    return row;
  });

  if (!created) {
    throw new TenantRuleError(
      409,
      "EXPORT_PENDING",
      "Você já tem uma exportação em andamento. Aguarde o e-mail com o link.",
    );
  }

  try {
    const boss = await getBoss();
    const job: LgpdExportJob = { exportId: created.id };
    await boss.send(QUEUE.lgpdExport, job, { singletonKey: created.id });
  } catch (error) {
    await markExport(created.id, "failed");
    throw error;
  }

  await audit("lgpd.export_requested", {
    actor: { type: subject.type, id: subject.id },
    target: { type: "data_export", id: created.id },
    ip,
  });

  return { exportId: created.id };
}

function markExport(id: string, status: "failed" | "expired") {
  return withPlatformScope("lgpd: marca exportação", (tx) =>
    tx.update(dataExport).set({ status }).where(eq(dataExport.id, id)),
  );
}

/** Últimos pedidos da pessoa, com o link assinado dos prontos e ainda válidos. */
export async function listExports(subject: ExportSubject, now = new Date()) {
  const rows = await withPlatformScope("lgpd: lista exportações", (tx) =>
    tx
      .select()
      .from(dataExport)
      .where(
        and(
          eq(dataExport.subjectType, subject.type),
          eq(dataExport.subjectId, subject.id),
        ),
      )
      .orderBy(desc(dataExport.createdAt))
      .limit(5),
  );

  return rows.map((row) => {
    const live =
      row.status === "ready" && row.expiresAt !== null && row.expiresAt > now;

    return {
      id: row.id,
      status: live || row.status !== "ready" ? row.status : ("expired" as const),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      downloadUrl: live && row.expiresAt ? downloadUrl(subject.type, row.id, row.expiresAt) : null,
    };
  });
}

/** O pedido pronto e vigente que é desta pessoa. Qualquer outro caso é "não existe". */
export async function findReadyExport(
  subject: ExportSubject,
  exportId: string,
  now = new Date(),
) {
  const [row] = await withPlatformScope("lgpd: busca exportação", (tx) =>
    tx
      .select({ fileKey: dataExport.fileKey, expiresAt: dataExport.expiresAt })
      .from(dataExport)
      .where(
        and(
          eq(dataExport.id, exportId),
          eq(dataExport.subjectType, subject.type),
          eq(dataExport.subjectId, subject.id),
          eq(dataExport.status, "ready"),
        ),
      ),
  );

  return row?.fileKey && row.expiresAt && row.expiresAt > now ? row.fileKey : null;
}

const json = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value, null, 2), "utf8");

async function consentsOf(tx: Tx, subject: ExportSubject) {
  return tx
    .select({
      kind: consentLog.kind,
      version: consentLog.version,
      accepted: consentLog.accepted,
      createdAt: consentLog.createdAt,
    })
    .from(consentLog)
    .where(
      and(
        eq(consentLog.subjectType, subject.type),
        eq(consentLog.subjectId, subject.id),
      ),
    )
    .orderBy(consentLog.createdAt);
}

/** Sem `ip_hash`: é identificador derivado do IP, e a pessoa não precisa dele. */
async function auditOf(tx: Tx, actorId: string) {
  return tx
    .select({
      action: auditLog.action,
      tenantId: auditLog.tenantId,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.actorId, actorId))
    .orderBy(desc(auditLog.createdAt))
    .limit(AUDIT_EXPORT_LIMIT);
}

const customerColumns = {
  id: customer.id,
  name: customer.name,
  email: customer.email,
  phone: customer.phone,
  document: customer.document,
  status: customer.status,
  notes: customer.notes,
  createdAt: customer.createdAt,
};

async function userFiles(userId: string): Promise<ZipEntry[]> {
  const subject: ExportSubject = { type: "user", id: userId };

  const base = await withPlatformScope("lgpd: exportação de usuário", async (tx) => {
    const [profile] = await tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        phone: user.phone,
        locale: user.locale,
        twoFactorEnabled: user.twoFactorEnabled,
        platformRole: user.role,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(eq(user.id, userId));

    const memberships = await tx
      .select({
        tenantId: organization.id,
        tenantName: organization.name,
        tenantSlug: organization.slug,
        roles: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .where(eq(member.userId, userId));

    return {
      profile,
      memberships,
      consents: await consentsOf(tx, subject),
      audit: await auditOf(tx, userId),
    };
  });

  const entries: ZipEntry[] = [
    { name: "perfil.json", data: json(base.profile ?? null) },
    { name: "organizacoes-e-papeis.json", data: json(base.memberships) },
    { name: "consentimentos.json", data: json(base.consents) },
    { name: "auditoria.json", data: json(base.audit) },
  ];

  // Quem é owner é também controlador dos dados dos clientes da organização.
  for (const owned of base.memberships.filter(({ roles }) => isOwner(roles))) {
    const customers = await withTenant(owned.tenantId, async (tx) => {
      const rows = await tx.select(customerColumns).from(customer).orderBy(customer.createdAt);
      const tags = await tagsOfCustomers(tx, rows.map(({ id }) => id));

      // Rótulo (nome) das etiquetas: o id não diz nada a quem lê o arquivo.
      return rows.map((row) => ({ ...row, etiquetas: (tags.get(row.id) ?? []).map(({ name }) => name) }));
    });

    entries.push({
      name: `clientes-${owned.tenantSlug}.json`,
      data: json(customers),
    });
  }

  return entries;
}

async function portalFiles(portalUserId: string): Promise<ZipEntry[]> {
  const subject: ExportSubject = { type: "portal_user", id: portalUserId };

  const base = await withPlatformScope("lgpd: exportação do portal", async (tx) => {
    const [profile] = await tx
      .select({
        id: portalUser.id,
        name: portalUser.name,
        email: portalUser.email,
        emailVerified: portalUser.emailVerified,
        phone: portalUser.phone,
        locale: portalUser.locale,
        createdAt: portalUser.createdAt,
      })
      .from(portalUser)
      .where(eq(portalUser.id, portalUserId));

    const records = await tx
      .select({ tenantName: organization.name, ...customerColumns })
      .from(customer)
      .innerJoin(organization, eq(customer.tenantId, organization.id))
      .where(eq(customer.portalUserId, portalUserId));

    return {
      profile,
      records,
      consents: await consentsOf(tx, subject),
      audit: await auditOf(tx, portalUserId),
    };
  });

  return [
    { name: "perfil.json", data: json(base.profile ?? null) },
    { name: "cadastros-nas-organizacoes.json", data: json(base.records) },
    { name: "consentimentos.json", data: json(base.consents) },
    { name: "auditoria.json", data: json(base.audit) },
  ];
}

/** Arquivos do zip de uma pessoa: o que está no `README.txt` descreve cada um. */
export async function buildExportFiles(
  subject: ExportSubject,
  now = new Date(),
): Promise<ZipEntry[]> {
  const files =
    subject.type === "user"
      ? await userFiles(subject.id)
      : await portalFiles(subject.id);

  const readme = [
    "Exportação de dados pessoais (LGPD)",
    `Gerada em ${now.toISOString()}.`,
    "",
    "Cada arquivo é JSON:",
    "- perfil.json: seus dados de cadastro.",
    "- organizacoes-e-papeis.json / cadastros-nas-organizacoes.json: onde você aparece e com qual papel ou status.",
    "- consentimentos.json: aceites e recusas dos textos legais, com a versão.",
    "- auditoria.json: ações registradas em seu nome.",
    "- clientes-<organizacao>.json: clientes das organizações de que você é proprietário.",
  ].join("\n");

  return [...files, { name: "LEIA-ME.txt", data: Buffer.from(readme, "utf8") }];
}

async function loadPending(exportId: string) {
  const [row] = await withPlatformScope("lgpd: carrega exportação", (tx) =>
    tx
      .select()
      .from(dataExport)
      .where(and(eq(dataExport.id, exportId), eq(dataExport.status, "pending"))),
  );

  return row ?? null;
}

async function recipientOf(subject: ExportSubject) {
  const [row] = await withPlatformScope("lgpd: destinatário da exportação", (tx) =>
    subject.type === "user"
      ? tx
          .select({ name: user.name, email: user.email })
          .from(user)
          .where(eq(user.id, subject.id))
      : tx
          .select({ name: portalUser.name, email: portalUser.email })
          .from(portalUser)
          .where(eq(portalUser.id, subject.id)),
  );

  return row ?? null;
}

/**
 * `lgpd.export`: monta o zip, guarda no `StorageProvider` sob chave aleatória e avisa por
 * e-mail com o link assinado. Idempotente: pedido que não está `pending` não faz nada. O
 * e-mail é cortesia (a tela lista o link também): se falhar, o pedido já está pronto.
 */
export async function processExport(
  exportId: string,
  attempt: { retryCount: number; retryLimit: number } = { retryCount: 0, retryLimit: 0 },
  now = new Date(),
) {
  const request = await loadPending(exportId);
  if (!request) return "skipped" as const;

  const subject: ExportSubject = { type: request.subjectType, id: request.subjectId };

  try {
    const zip = createZip(await buildExportFiles(subject, now), now);
    const key = newStorageKey("exports");
    await getStorage().put(key, zip, { contentType: "application/zip" });

    const expiresAt = new Date(now.getTime() + EXPORT_LINK_TTL_MS);
    const [updated] = await withPlatformScope("lgpd: conclui exportação", (tx) =>
      tx
        .update(dataExport)
        .set({ status: "ready", fileKey: key, readyAt: now, expiresAt })
        .where(and(eq(dataExport.id, exportId), eq(dataExport.status, "pending")))
        .returning({ id: dataExport.id }),
    );

    // Outro job concluiu antes: o objeto que acabamos de gravar não tem dono.
    if (!updated) {
      await getStorage().delete(key);
      return "skipped" as const;
    }

    const recipient = await recipientOf(subject);
    if (recipient) {
      await sendEmail({
        to: recipient.email,
        ...dataExportReadyTemplate({
          name: recipient.name,
          url: downloadUrl(subject.type, exportId, expiresAt),
          expiresAt,
        }),
        tags: { template: "data-export-ready" },
      }).catch((error) => logError("Falha ao enviar o e-mail da exportação", error));
    }

    return "ready" as const;
  } catch (error) {
    if (attempt.retryCount >= attempt.retryLimit) await markExport(exportId, "failed");
    throw error;
  }
}

/** Apaga o arquivo e marca como expirada a exportação vencida. */
export async function pruneExports(now = new Date()) {
  const due = await withPlatformScope("lgpd: exportações vencidas", (tx) =>
    tx
      .select({ id: dataExport.id, fileKey: dataExport.fileKey })
      .from(dataExport)
      .where(and(eq(dataExport.status, "ready"), lt(dataExport.expiresAt, now))),
  );

  for (const { id, fileKey } of due) {
    if (fileKey) {
      await getStorage()
        .delete(fileKey)
        .catch((error) => logError("Falha ao apagar exportação vencida", error));
    }
    await withPlatformScope("lgpd: expira exportação", (tx) =>
      tx
        .update(dataExport)
        .set({ status: "expired", fileKey: null })
        .where(eq(dataExport.id, id)),
    );
  }

  return due.length;
}

/** Registros de exportação antigos (7 dias depois de vencerem) saem do banco. */
export async function deleteOldExportRecords(now = new Date()) {
  const cutoff = new Date(now.getTime() - EXPORT_LINK_TTL_MS);

  const deleted = await withPlatformScope("lgpd: apaga registros de exportação", (tx) =>
    tx
      .delete(dataExport)
      .where(
        and(
          sql`${dataExport.status} in ('expired', 'failed')`,
          lt(dataExport.createdAt, cutoff),
        ),
      )
      .returning({ id: dataExport.id }),
  );

  return deleted.length;
}
