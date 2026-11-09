import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { getDb } from "@/db";
import { type Tx, withPlatformScope } from "@/db/rls";
import {
  account,
  billingProfile,
  customer,
  dataExport,
  deletionRequest,
  emailMessages,
  emailVerificationIssue,
  file,
  impersonationGrant,
  invitation,
  member,
  organization,
  organizationRole,
  portalAccount,
  portalSession,
  portalTwoFactor,
  portalUser,
  portalVerification,
  session,
  subscription,
  tenantPaymentCredential,
  twoFactor,
  user,
} from "@/db/schema";
import type {
  DeletionMetadata,
  DeletionOrigin,
  DeletionSubjectType,
} from "@/db/schema/lgpd";
import { type AuditAction, auditInTransaction } from "@/lib/audit";
import { appLink } from "@/lib/auth/links";
import { getPortalAuth } from "@/lib/auth/portal";
import { cancelSubscriptionForDeletion } from "@/lib/billing/checkout";
import { listTenantOwners } from "@/lib/billing/notify";
import { hashEmail, normalizeEmail } from "@/lib/email/address";
import { sendEmail } from "@/lib/email/send";
import { deletionConfirmTemplate } from "@/lib/email/templates/deletion-confirm";
import { deletionScheduledTemplate } from "@/lib/email/templates/deletion-scheduled";
import { getStorage } from "@/lib/storage";
import { TenantRuleError, notFound } from "@/lib/tenant/errors";
import { soleOwnerTenants } from "@/lib/tenant/ownership";

/**
 * Exclusão de dados pessoais com carência (`deletion_request`). Pedir agenda; cancelar desfaz;
 * o job `lgpd.delete` executa o que venceu. Executar **anonimiza**, não apaga a linha: o
 * histórico de auditoria, as faturas e os vínculos continuam íntegros, sem apontar para
 * ninguém. Tudo roda em uma transação com `withPlatformScope("lgpd")` e é idempotente.
 *
 * Quem pede é a própria pessoa (ou o owner, para a organização), com `origin = self`, ou a
 * plataforma pelo `/admin`, com `origin = platform`. Cada lado só cancela o próprio pedido.
 * O núcleo (`schedule*Deletion`: checagens, pedido e aviso) é o mesmo para os dois.
 */

export const DELETION_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const PORTAL_CONFIRM_TTL_MS = 60 * 60 * 1000;
const REMOVED_USER = "Usuário removido";
export const PLATFORM_BAN_REASON = "Exclusão agendada pela plataforma";

const ghostEmail = (id: string) => `deleted+${id}@invalid`;

/** Fim da carência de um pedido feito agora. */
export const graceEnd = (now: Date) => new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);

export const deletionPending = (message = "Já existe uma exclusão agendada.") =>
  new TenantRuleError(409, "DELETION_PENDING", message);

export type ScheduledRequest = { id: string | null; created: boolean; scheduledFor: Date };

export type ScheduleOptions = {
  origin: DeletionOrigin;
  /** Quem pede: a própria pessoa, o owner ou o proprietário da plataforma. */
  actorId: string;
  scheduledFor: Date;
  metadata?: DeletionMetadata;
  /**
   * Roda na mesma transação do pedido novo: o que precisa valer junto com ele (derrubar
   * sessões, banir, auditar). Pedido já existente (`self`, idempotente) não chama.
   */
  onCreated?: (tx: Tx, request: ScheduledRequest) => Promise<void>;
  /** `false` na exclusão imediata: o aviso é o `deletion-executed`, depois de executar. */
  notify?: boolean;
};

/**
 * Um pedido em aberto por assunto. A própria pessoa que pede de novo recebe o que já está
 * agendado; a plataforma não reaproveita pedido nenhum (409 `DELETION_PENDING`).
 */
async function createRequest(
  tx: Tx,
  input: {
    subjectType: DeletionSubjectType;
    subjectId: string;
    tenantId?: string;
  },
  options: ScheduleOptions,
): Promise<ScheduledRequest> {
  const { scheduledFor } = options;

  const [row] = await tx
    .insert(deletionRequest)
    .values({
      ...input,
      tenantId: input.tenantId ?? null,
      requestedBy: options.actorId,
      scheduledFor,
      origin: options.origin,
      metadata: options.metadata ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: deletionRequest.id });

  if (row) return { id: row.id, created: true, scheduledFor };

  if (options.origin === "platform") throw deletionPending();

  const [existing] = await tx
    .select({ id: deletionRequest.id, scheduledFor: deletionRequest.scheduledFor })
    .from(deletionRequest)
    .where(
      and(
        eq(deletionRequest.subjectType, input.subjectType),
        eq(deletionRequest.subjectId, input.subjectId),
        eq(deletionRequest.status, "pending"),
      ),
    );

  return {
    id: existing?.id ?? null,
    created: false,
    scheduledFor: existing?.scheduledFor ?? scheduledFor,
  };
}

/** No pedido da plataforma, quem é avisado não cancela: o link leva ao contato. */
function notifyScheduled(
  to: string,
  input: { name: string; subjectLabel: string; scheduledFor: Date; url: string },
  origin: DeletionOrigin,
) {
  const byPlatform = origin === "platform";

  return sendEmail({
    to,
    ...deletionScheduledTemplate({
      ...input,
      url: byPlatform ? appLink("/contato") : input.url,
      byPlatform,
    }),
    tags: { template: "deletion-scheduled" },
  }).catch((error) => logError("Falha ao avisar a exclusão agendada", error));
}

type TeamUser = {
  id: string;
  name: string;
  email: string;
  platformRole: string;
};

/**
 * Núcleo da exclusão da conta de equipe: checagens, pedido e aviso. A própria pessoa não
 * exclui conta da plataforma; a plataforma não exclui o `platform_owner`. Ninguém deixa uma
 * organização sem proprietário (409 `LAST_OWNER`).
 */
export async function scheduleUserDeletion(target: TeamUser, options: ScheduleOptions) {
  if (options.origin === "self" && target.platformRole !== "user") {
    throw new TenantRuleError(
      403,
      "PLATFORM_ACCOUNT",
      "Contas da plataforma não são excluídas por aqui.",
    );
  }

  if (target.platformRole === "platform_owner") {
    throw new TenantRuleError(
      403,
      "PLATFORM_OWNER_PROTECTED",
      "O proprietário da plataforma não é excluído por aqui.",
    );
  }

  const sole = await soleOwnerTenants(target.id);

  if (sole.length > 0) {
    const names = sole.map(({ name }) => name).join(", ");

    throw options.origin === "self"
      ? new TenantRuleError(
          409,
          "LAST_OWNER",
          `Você é o único proprietário de ${names}. Transfira a propriedade ou exclua a organização antes.`,
        )
      : new TenantRuleError(
          409,
          "LAST_OWNER",
          `Esta pessoa é a única proprietária de ${names}.`,
          { tenants: sole },
        );
  }

  const result = await withPlatformScope("lgpd: pedido de exclusão", async (tx) => {
    const created = await createRequest(
      tx,
      { subjectType: "user", subjectId: target.id },
      options,
    );
    if (created.created) await options.onCreated?.(tx, created);
    return created;
  });

  if (result.created && options.notify !== false) {
    await notifyScheduled(
      target.email,
      {
        name: target.name,
        subjectLabel: "sua conta",
        scheduledFor: result.scheduledFor,
        url: appLink("/app/configuracoes/privacidade"),
      },
      options.origin,
    );
  }

  return result;
}

/**
 * Exclusão da conta de equipe, pela própria pessoa. A identidade já foi provada pela rota.
 * Encerra as outras sessões.
 */
export async function requestUserDeletion(
  current: TeamUser,
  currentSessionId: string,
  ip?: string | null,
  now = new Date(),
) {
  const result = await scheduleUserDeletion(current, {
    origin: "self",
    actorId: current.id,
    scheduledFor: graceEnd(now),
    onCreated: async (tx) => {
      await tx
        .delete(session)
        .where(and(eq(session.userId, current.id), ne(session.id, currentSessionId)));

      await auditInTransaction(tx, "lgpd.deletion_requested", {
        actor: { id: current.id },
        target: { type: "user", id: current.id },
        ip,
      });
    },
  });

  return { scheduledFor: result.scheduledFor };
}

type PortalPerson = { id: string; name: string; email: string };

async function portalHasPassword(personId: string) {
  const { internalAdapter } = await getPortalAuth().$context;
  const accounts = await internalAdapter.findAccounts(personId);

  return accounts.some(({ providerId, password }) => providerId === "credential" && password);
}

async function portalPasswordOk(personId: string, password: string) {
  const { internalAdapter, password: hasher } = await getPortalAuth().$context;
  const stored = (await internalAdapter.findAccounts(personId)).find(
    ({ providerId }) => providerId === "credential",
  );

  return Boolean(stored?.password) && hasher.verify({ hash: stored?.password ?? "", password });
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Só o hash do token fica no banco, no mesmo formato de identificador do portal. */
const confirmIdentifier = (token: string) => `lgpd-delete:${sha256(token)}`;

/** Núcleo da exclusão da conta do portal: pedido e aviso. */
export async function schedulePortalDeletion(person: PortalPerson, options: ScheduleOptions) {
  const result = await withPlatformScope("lgpd: pedido de exclusão do portal", async (tx) => {
    const created = await createRequest(
      tx,
      { subjectType: "portal_user", subjectId: person.id },
      options,
    );
    if (created.created) await options.onCreated?.(tx, created);
    return created;
  });

  if (result.created && options.notify !== false) {
    await notifyScheduled(
      person.email,
      {
        name: person.name,
        subjectLabel: "sua conta no portal",
        scheduledFor: result.scheduledFor,
        url: appLink("/portal/conta"),
      },
      options.origin,
    );
  }

  return result;
}

async function scheduleForPortal(
  person: PortalPerson,
  currentSessionId: string,
  ip: string | null | undefined,
  now: Date,
) {
  const result = await schedulePortalDeletion(person, {
    origin: "self",
    actorId: person.id,
    scheduledFor: graceEnd(now),
    onCreated: async (tx) => {
      await tx
        .delete(portalSession)
        .where(
          and(eq(portalSession.userId, person.id), ne(portalSession.id, currentSessionId)),
        );

      await auditInTransaction(tx, "lgpd.deletion_requested", {
        actor: { type: "portal_user", id: person.id },
        target: { type: "portal_user", id: person.id },
        ip,
      });
    },
  });

  return { scheduledFor: result.scheduledFor };
}

export type PortalDeletionResult =
  | { status: "scheduled"; scheduledFor: Date }
  | { status: "confirmation_sent" };

/**
 * Exclusão do cliente do portal. Quem tem senha a confirma e agenda na hora; quem entrou só
 * por link mágico recebe um link de confirmação, consumido só pelo clique (`confirmPortalDeletion`).
 */
export async function requestPortalDeletion(
  person: PortalPerson,
  currentSessionId: string,
  password: string | undefined,
  ip?: string | null,
  now = new Date(),
): Promise<PortalDeletionResult> {
  if (await portalHasPassword(person.id)) {
    if (!password || !(await portalPasswordOk(person.id, password))) {
      throw new TenantRuleError(403, "INVALID_CREDENTIALS", "Senha incorreta.");
    }

    return { status: "scheduled", ...(await scheduleForPortal(person, currentSessionId, ip, now)) };
  }

  const token = randomBytes(32).toString("base64url");
  await getDb().insert(portalVerification).values({
    identifier: confirmIdentifier(token),
    value: person.id,
    expiresAt: new Date(now.getTime() + PORTAL_CONFIRM_TTL_MS),
  });

  await sendEmail({
    to: person.email,
    ...deletionConfirmTemplate({
      name: person.name,
      url: appLink("/portal/conta", { "confirmar-exclusao": token }),
      expiresInMinutes: PORTAL_CONFIRM_TTL_MS / 60_000,
    }),
    tags: { template: "deletion-confirm" },
  });

  return { status: "confirmation_sent" };
}

/**
 * O clique do botão. O token é de uso único (apagado ao ser lido, de forma atômica) e só vale
 * para a pessoa da sessão: o link vazado, sozinho, não exclui nada.
 */
export async function confirmPortalDeletion(
  person: PortalPerson,
  currentSessionId: string,
  token: string,
  ip?: string | null,
  now = new Date(),
) {
  const [consumed] = await getDb()
    .delete(portalVerification)
    .where(eq(portalVerification.identifier, confirmIdentifier(token)))
    .returning({ value: portalVerification.value, expiresAt: portalVerification.expiresAt });

  if (!consumed || consumed.expiresAt <= now || consumed.value !== person.id) {
    throw new TenantRuleError(400, "INVALID_LINK", "Link inválido ou expirado.");
  }

  return scheduleForPortal(person, currentSessionId, ip, now);
}

/**
 * Núcleo da exclusão da organização. Primeiro encerra a cobrança no provedor (se o provedor
 * falhar, nada é agendado); depois trava a organização (`deleting`/`locked`), agenda e avisa
 * os owners. O owner só exclui organização ativa; a plataforma também a suspensa, e o estado
 * anterior fica em `metadata.previousStatus` para o cancelamento devolver.
 */
export async function scheduleTenantDeletion(
  tenant: { id: string; name: string },
  options: ScheduleOptions & {
    ip?: string | null;
    now?: Date;
    /** Quem chama já encerrou no provedor (várias organizações de uma vez, antes de agendar). */
    providerCanceled?: boolean;
  },
) {
  const now = options.now ?? new Date();
  const allowed = options.origin === "platform" ? ["active", "suspended"] : ["active"];

  if (!options.providerCanceled) {
    await cancelSubscriptionForDeletion(
      tenant.id,
      { userId: options.actorId, ip: options.ip, platform: options.origin === "platform" },
      now,
    );
  }

  const result = await withPlatformScope("lgpd: pedido de exclusão da organização", async (tx) => {
    const [current] = await tx
      .select({ status: organization.status })
      .from(organization)
      .where(eq(organization.id, tenant.id))
      .for("update");

    if (!current || current.status === "deleted") {
      throw notFound("Organização não encontrada.");
    }

    if (!allowed.includes(current.status)) {
      throw deletionPending("Esta organização já tem a exclusão agendada.");
    }

    await tx
      .update(organization)
      .set({ status: "deleting", accessMode: "locked" })
      .where(eq(organization.id, tenant.id));

    const created = await createRequest(
      tx,
      { subjectType: "tenant", subjectId: tenant.id, tenantId: tenant.id },
      {
        ...options,
        metadata: {
          ...options.metadata,
          previousStatus: current.status as "active" | "suspended",
        },
      },
    );
    if (created.created) await options.onCreated?.(tx, created);
    return created;
  });

  if (options.notify !== false) {
    for (const owner of await listTenantOwners(tenant.id)) {
      await notifyScheduled(
        owner.email,
        {
          name: owner.name,
          subjectLabel: `a organização ${tenant.name}`,
          scheduledFor: result.scheduledFor,
          url: appLink("/app/configuracoes/privacidade"),
        },
        options.origin,
      );
    }
  }

  return result;
}

/** Exclusão da organização, pelo proprietário (`DELETE /api/tenant`). */
export async function requestTenantDeletion(
  tenant: { id: string; name: string },
  actor: { userId: string; ip?: string | null },
  now = new Date(),
) {
  const result = await scheduleTenantDeletion(tenant, {
    origin: "self",
    actorId: actor.userId,
    scheduledFor: graceEnd(now),
    ip: actor.ip,
    now,
    onCreated: (tx) =>
      auditInTransaction(tx, "lgpd.deletion_requested", {
        actor: { id: actor.userId },
        tenantId: tenant.id,
        target: { type: "tenant", id: tenant.id },
        ip: actor.ip,
      }),
  });

  return { scheduledFor: result.scheduledFor };
}

/** O pedido em aberto do assunto, de qualquer origem. */
export async function findPendingDeletion(subject: { type: DeletionSubjectType; id: string }) {
  const [row] = await withPlatformScope("lgpd: pedido em aberto", (tx) =>
    tx
      .select({
        id: deletionRequest.id,
        origin: deletionRequest.origin,
        scheduledFor: deletionRequest.scheduledFor,
        createdAt: deletionRequest.createdAt,
      })
      .from(deletionRequest)
      .where(
        and(
          eq(deletionRequest.subjectType, subject.type),
          eq(deletionRequest.subjectId, subject.id),
          eq(deletionRequest.status, "pending"),
        ),
      ),
  );

  return row ?? null;
}

/**
 * Barreira do portal na carência: a plataforma agendou a exclusão desta pessoa. Pedido da
 * própria pessoa não barra (ela ainda entra para cancelar).
 */
export async function portalAccessBarred(personId: string) {
  return (await findPendingDeletion({ type: "portal_user", id: personId }))?.origin === "platform";
}

/** A mesma barreira pelo e-mail, para quem ainda não tem sessão (login e magic link). */
export async function portalEmailBarred(email: string) {
  const [person] = await getDb()
    .select({ id: portalUser.id })
    .from(portalUser)
    .where(eq(portalUser.email, normalizeEmail(email)));

  return person ? portalAccessBarred(person.id) : false;
}

const CANCELED_BY: Record<DeletionSubjectType, AuditAction> = {
  user: "admin.user_deletion_canceled",
  portal_user: "admin.portal_user_deletion_canceled",
  tenant: "admin.tenant_deletion_canceled",
};

/**
 * Desfaz o pedido dentro da carência. Cada lado só desfaz o próprio: a pessoa (ou o owner)
 * recebe 409 `DELETION_BY_PLATFORM` no pedido da plataforma, e a plataforma, 409
 * `DELETION_NOT_PLATFORM` no da pessoa. Para uma organização, devolve o acesso (a assinatura
 * encerrada no provedor não volta: o proprietário contrata de novo) ou a suspensão anterior;
 * para a conta banida pela plataforma, tira o banimento se ela não estava banida antes.
 */
export async function cancelDeletion(
  subject: { type: DeletionSubjectType; id: string },
  actor: { type: "user" | "portal_user" | "platform"; id: string },
  ip?: string | null,
  now = new Date(),
) {
  const origin: DeletionOrigin = actor.type === "platform" ? "platform" : "self";

  const outcome = await withPlatformScope("lgpd: cancela exclusão", async (tx) => {
    const [row] = await tx
      .update(deletionRequest)
      .set({ status: "canceled", canceledAt: now })
      .where(
        and(
          eq(deletionRequest.subjectType, subject.type),
          eq(deletionRequest.subjectId, subject.id),
          eq(deletionRequest.origin, origin),
          // Vale até o job executar: `pending` com data vencida ainda não foi anonimizado, e
          // o `FOR UPDATE` do executor decide a corrida com o cancelamento.
          eq(deletionRequest.status, "pending"),
        ),
      )
      .returning({ tenantId: deletionRequest.tenantId, metadata: deletionRequest.metadata });

    if (!row) {
      const [other] = await tx
        .select({ origin: deletionRequest.origin })
        .from(deletionRequest)
        .where(
          and(
            eq(deletionRequest.subjectType, subject.type),
            eq(deletionRequest.subjectId, subject.id),
            eq(deletionRequest.status, "pending"),
          ),
        );

      return { canceled: false as const, otherOrigin: other?.origin ?? null };
    }

    if (subject.type === "tenant") {
      const [sub] = await tx
        .select({ status: subscription.status })
        .from(subscription)
        .where(eq(subscription.tenantId, subject.id));

      await tx
        .update(organization)
        .set(
          row.metadata.previousStatus === "suspended"
            ? { status: "suspended", accessMode: "locked" }
            : {
                status: "active",
                accessMode:
                  sub && ["expired", "unpaid", "canceled", "paused"].includes(sub.status)
                    ? "read_only"
                    : "full",
              },
        )
        .where(and(eq(organization.id, subject.id), eq(organization.status, "deleting")));
    }

    if (subject.type === "user" && origin === "platform" && row.metadata.wasBanned === false) {
      await tx
        .update(user)
        .set({ banned: false, banReason: null, banExpires: null })
        .where(eq(user.id, subject.id));
    }

    await auditInTransaction(
      tx,
      origin === "platform" ? CANCELED_BY[subject.type] : "lgpd.deletion_canceled",
      {
        actor: { type: actor.type, id: actor.id },
        tenantId: row.tenantId,
        target: { type: subject.type, id: subject.id },
        ip,
      },
    );

    return { canceled: true as const };
  });

  if (outcome.canceled) return;

  if (outcome.otherOrigin === "platform") {
    throw new TenantRuleError(
      409,
      "DELETION_BY_PLATFORM",
      "Esta exclusão foi agendada pela administração da plataforma. Fale com ela para desistir.",
    );
  }

  if (outcome.otherOrigin === "self") {
    throw new TenantRuleError(
      409,
      "DELETION_NOT_PLATFORM",
      "Esta exclusão foi pedida pela própria pessoa: só ela pode desistir.",
    );
  }

  if (origin === "platform") {
    throw new TenantRuleError(409, "NO_PENDING_DELETION", "Nenhuma exclusão agendada.");
  }

  throw notFound("Nenhuma exclusão agendada.");
}

/** Na exclusão imediata, o pedido em aberto (de qualquer origem) vence agora. */
export async function anticipateDeletion(requestId: string, now: Date) {
  await withPlatformScope("lgpd: antecipa exclusão", (tx) =>
    tx
      .update(deletionRequest)
      .set({ scheduledFor: now })
      .where(and(eq(deletionRequest.id, requestId), eq(deletionRequest.status, "pending"))),
  );
}

/** O que a tela de privacidade mostra: a conta e as organizações que a pessoa possui. */
export async function listPendingDeletions(
  subject: { type: "user" | "portal_user"; id: string },
  ownedTenantIds: string[] = [],
) {
  const rows = await withPlatformScope("lgpd: lista exclusões", (tx) =>
    tx
      .select({
        subjectType: deletionRequest.subjectType,
        subjectId: deletionRequest.subjectId,
        scheduledFor: deletionRequest.scheduledFor,
        origin: deletionRequest.origin,
      })
      .from(deletionRequest)
      .where(
        and(
          eq(deletionRequest.status, "pending"),
          sql`(
            (${deletionRequest.subjectType} = ${subject.type} and ${deletionRequest.subjectId} = ${subject.id})
            ${
              ownedTenantIds.length > 0
                ? sql`or (${deletionRequest.subjectType} = 'tenant' and ${inArray(deletionRequest.subjectId, ownedTenantIds)})`
                : sql``
            }
          )`,
        ),
      ),
  );

  return {
    account: rows.find(({ subjectType }) => subjectType !== "tenant")?.scheduledFor ?? null,
    tenants: rows
      .filter(({ subjectType }) => subjectType === "tenant")
      // `origin = platform`: só a administração desiste; a tela não oferece o botão.
      .map(({ subjectId, scheduledFor, origin }) => ({ tenantId: subjectId, scheduledFor, origin })),
  };
}

type Anonymized = { storageKeys: string[] };

async function exportKeysOf(tx: Tx, type: "user" | "portal_user", id: string) {
  const rows = await tx
    .delete(dataExport)
    .where(and(eq(dataExport.subjectType, type), eq(dataExport.subjectId, id)))
    .returning({ fileKey: dataExport.fileKey });

  return rows.flatMap(({ fileKey }) => (fileKey ? [fileKey] : []));
}

/** A pessoa deixa de existir para o sistema, e o que ela fez continua sem apontar para ela. */
async function anonymizeUser(tx: Tx, id: string): Promise<Anonymized> {
  const [person] = await tx.select({ email: user.email }).from(user).where(eq(user.id, id));
  if (!person) return { storageKeys: [] };

  await tx
    .update(user)
    .set({
      email: ghostEmail(id),
      name: REMOVED_USER,
      image: null,
      phone: null,
      phoneNormalized: null,
      phoneKey: null,
      locale: null,
      emailVerified: false,
      twoFactorEnabled: false,
      lastTenantId: null,
      // Conta de suporte excluída não sobra com acesso de plataforma.
      role: "user",
    })
    .where(eq(user.id, id));

  await tx.delete(account).where(eq(account.userId, id));
  await tx.delete(twoFactor).where(eq(twoFactor.userId, id));
  // Também as personificações abertas por esta conta (suporte excluído).
  await tx.delete(session).where(or(eq(session.userId, id), eq(session.impersonatedBy, id)));
  await tx.delete(emailVerificationIssue).where(eq(emailVerificationIssue.userId, id));
  await tx.delete(member).where(eq(member.userId, id));
  await tx.delete(invitation).where(eq(invitation.email, person.email));
  await tx.delete(emailMessages).where(eq(emailMessages.toHash, hashEmail(person.email)));

  return { storageKeys: await exportKeysOf(tx, "user", id) };
}

const anonymizedCustomer = {
  name: "Cliente removido",
  email: sql`'deleted+' || ${customer.id} || '@invalid'`,
  phone: null,
  // Libera o número para outro cadastro; o `CHECK` aceita porque o e-mail vira `deleted+...`.
  phoneNormalized: null,
  phoneKey: null,
  document: null,
  notes: null,
  // Valor de campo adicional é dado pessoal em potencial.
  customFields: {},
  status: "blocked" as const,
  portalUserId: null,
};

async function anonymizePortalUser(tx: Tx, id: string): Promise<Anonymized> {
  const [person] = await tx
    .select({ email: portalUser.email })
    .from(portalUser)
    .where(eq(portalUser.id, id));
  if (!person) return { storageKeys: [] };

  // O cadastro do cliente em cada organização, ligado pela conta ou só pelo e-mail.
  await tx
    .update(customer)
    .set(anonymizedCustomer)
    .where(sql`${customer.portalUserId} = ${id} or ${customer.email} = ${person.email}`);

  await tx
    .update(portalUser)
    .set({
      email: ghostEmail(id),
      name: REMOVED_USER,
      image: null,
      phone: null,
      phoneNormalized: null,
      phoneKey: null,
      locale: null,
      emailVerified: false,
      twoFactorEnabled: false,
    })
    .where(eq(portalUser.id, id));

  await tx.delete(portalAccount).where(eq(portalAccount.userId, id));
  await tx.delete(portalTwoFactor).where(eq(portalTwoFactor.userId, id));
  await tx.delete(portalSession).where(eq(portalSession.userId, id));
  await tx.delete(emailMessages).where(eq(emailMessages.toHash, hashEmail(person.email)));

  return { storageKeys: await exportKeysOf(tx, "portal_user", id) };
}

/**
 * A organização vira "Organização removida", sem equipe, clientes identificáveis, dados de
 * cobrança nem arquivos. Faturas e auditoria ficam: obrigação fiscal e histórico, sem nomes.
 */
async function anonymizeTenant(tx: Tx, id: string, now: Date): Promise<Anonymized> {
  await tx
    .update(organization)
    .set({
      name: "Organização removida",
      slug: `removida-${id}`,
      logo: null,
      metadata: null,
      settings: {},
      status: "deleted",
      accessMode: "locked",
      deletedAt: now,
    })
    .where(eq(organization.id, id));

  await tx.delete(member).where(eq(member.organizationId, id));
  await tx.delete(invitation).where(eq(invitation.organizationId, id));
  await tx.delete(organizationRole).where(eq(organizationRole.organizationId, id));
  await tx.delete(tenantPaymentCredential).where(eq(tenantPaymentCredential.tenantId, id));
  await tx.delete(impersonationGrant).where(eq(impersonationGrant.tenantId, id));
  await tx.update(customer).set(anonymizedCustomer).where(eq(customer.tenantId, id));

  await tx
    .update(billingProfile)
    .set({ legalName: "Organização removida", document: "", email: "removido@invalid", address: {} })
    .where(eq(billingProfile.tenantId, id));

  await tx.update(user).set({ lastTenantId: null }).where(eq(user.lastTenantId, id));
  await tx.update(session).set({ activeOrganizationId: null }).where(eq(session.activeOrganizationId, id));
  await tx.update(portalSession).set({ activeTenantId: null }).where(eq(portalSession.activeTenantId, id));

  const files = await tx
    .delete(file)
    .where(eq(file.tenantId, id))
    .returning({ key: file.key });

  return { storageKeys: files.map(({ key }) => key) };
}

export type DeletionOutcome = "executed" | "skipped" | "failed";

/**
 * Executa um pedido vencido. Idempotente: com o pedido travado, quem chega depois encontra
 * `executed` e não faz nada. Os objetos do armazenamento saem depois do commit: se a remoção
 * falhar, sobra um arquivo órfão no log, nunca uma pessoa que continua nos dados.
 */
export async function executeDeletion(
  requestId: string,
  now = new Date(),
): Promise<DeletionOutcome> {
  const { outcome, storageKeys } = await withPlatformScope("lgpd", async (tx) => {
    const [request] = await tx
      .select()
      .from(deletionRequest)
      .where(eq(deletionRequest.id, requestId))
      .for("update");

    if (request?.status !== "pending" || request.scheduledFor > now) {
      return { outcome: "skipped" as const, storageKeys: [] as string[] };
    }

    // Dono único de organização ativa que surgiu durante a carência: não deixa órfã.
    if (request.subjectType === "user") {
      const sole = await soleOwnerTenants(request.subjectId);

      if (sole.length > 0) {
        await tx
          .update(deletionRequest)
          .set({ status: "failed" })
          .where(eq(deletionRequest.id, request.id));
        return { outcome: "failed" as const, storageKeys: [] as string[] };
      }
    }

    const result =
      request.subjectType === "user"
        ? await anonymizeUser(tx, request.subjectId)
        : request.subjectType === "portal_user"
          ? await anonymizePortalUser(tx, request.subjectId)
          : await anonymizeTenant(tx, request.subjectId, now);

    await tx
      .update(deletionRequest)
      .set({ status: "executed", executedAt: now })
      .where(eq(deletionRequest.id, request.id));

    await auditInTransaction(tx, "lgpd.deletion_executed", {
      actor: { type: "system", id: null },
      tenantId: request.tenantId,
      target: { type: request.subjectType, id: request.subjectId },
    });

    return { outcome: "executed" as const, storageKeys: result.storageKeys };
  });

  for (const key of storageKeys) {
    await getStorage()
      .delete(key)
      .catch((error) => logError("Falha ao apagar arquivo na exclusão", error));
  }

  return outcome;
}

/** `lgpd.delete` (cron diário): executa cada pedido vencido; uma falha não trava os demais. */
export async function executeDueDeletions(now = new Date()) {
  const due = await withPlatformScope("lgpd: pedidos vencidos", (tx) =>
    tx
      .select({ id: deletionRequest.id })
      .from(deletionRequest)
      .where(and(eq(deletionRequest.status, "pending"), lte(deletionRequest.scheduledFor, now))),
  );

  const result = { executed: 0, skipped: 0, failed: 0, errors: 0 };

  for (const { id } of due) {
    try {
      const outcome = await executeDeletion(id, now);
      result[outcome] += 1;
    } catch (error) {
      result.errors += 1;
      logError("Falha ao executar exclusão", error);
    }
  }

  // Quem falhou volta na próxima rodada; o erro faz o pg-boss tentar de novo agora.
  if (result.errors > 0) {
    throw new Error(`${result.errors} exclusão(ões) falharam; veja o log.`);
  }

  return result;
}
