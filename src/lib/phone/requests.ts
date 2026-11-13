import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { type Scope, scopeTenantId, type Tx, withPlatformScope, withScope } from "@/db/rls";
import { customer, member, phoneTenantVouch, phoneVerification, user } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { getEnv } from "@/lib/env";
import { linkUnlinkedContactToCustomer } from "@/lib/inbox/contacts";
import { userPhoneConfirmed } from "@/lib/phone/confirmed";
import {
  accountPhoneConflicts,
  accountPhoneInUse,
  isOwnerOrPlatformStaff,
  lockPhoneKey,
} from "@/lib/phone/uniqueness";
import {
  type PhoneVerificationSubject,
  UNVERIFIED_PHONE,
  verifiedPhone,
} from "@/lib/phone/verification";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";
import { linkExistingCustomer, matchingTeamMember } from "@/lib/tenant/team-customer";

/**
 * Pedidos de confirmação de telefone (`phone_verification`; SPEC `pre-producao`, bloco T).
 *
 * O pedido confirma o número que o cadastro tem agora, perante um responsável: a organização
 * (para os clientes dela e para quem é da equipe dela) ou a plataforma (para quem se cadastrou
 * sem convite, os owners e a equipe da plataforma). A conta de quem é da equipe de duas
 * organizações pode ter um pedido aberto em cada uma, além do da plataforma.
 *
 * **O alcance da confirmação é o do responsável do pedido, nunca maior.**
 *
 * - **Pedido da plataforma**, confirmado pelo link (na sessão da própria conta) ou à mão pelo
 *   proprietário: vale no sistema inteiro e encerra os outros pedidos do cadastro. Pelo link é
 *   prova de posse: se outra conta do mesmo grupo tinha o número confirmado, quem provou fica
 *   com ele e a outra volta a pendente. À mão não prova posse: é recusada se outra conta do
 *   grupo já tem o número confirmado.
 * - **Pedido de uma organização**, confirmado pelo link ou à mão pelo owner dela: na conta de um
 *   membro, é uma linha em `phone_tenant_vouch` e vale **só dentro daquela organização**; na
 *   ficha de cliente, é a confirmação da ficha, que já é da organização.
 *
 * O link de um pedido de organização NÃO é prova para o resto do sistema, mesmo confirmado na
 * sessão certa: o link sai pelo canal dela, e o canal por QR Code é o WhatsApp do próprio owner,
 * que lê o que enviou. Quem controla a organização conhece o link de qualquer número que mandar
 * verificar. Qualquer pessoa cria uma organização, então o que ela atesta, por qualquer meio,
 * não pode sair dela. Só o canal da plataforma é de confiança para todos.
 *
 * O link sozinho não confirma nada: quem recebe o link de outra pessoa e clica não está na
 * sessão da conta, e a confirmação é recusada. Sem isso, bastaria cadastrar-se com o número da
 * vítima e esperar ela clicar.
 *
 * Quase tudo aqui roda com `withPlatformScope`: o pedido de uma conta cruza escopos, e confirmar
 * mexe em `user`, `customer`, `portal_user` e no contato do atendimento. Quem limita o alcance é
 * o filtro de escopo de cada função, nunca o corpo da requisição.
 */

export type VerificationSubject = { type: PhoneVerificationSubject; id: string };

type Request = typeof phoneVerification.$inferSelect;

const OPEN = ["sent", "awaiting_manual"] as const;
const PAGE_SIZE = 50;
const PLATFORM: Scope = { kind: "platform" };

const INVALID_LINK = () =>
  new TenantRuleError(400, "INVALID_OR_EXPIRED", "Link inválido ou expirado.");

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const ofSubject = ({ type, id }: VerificationSubject) =>
  and(eq(phoneVerification.subjectType, type), eq(phoneVerification.subjectId, id));

const isOpen = inArray(phoneVerification.status, [...OPEN]);

/** O pedido é do escopo de quem pergunta: a organização, ou a plataforma (`tenant_id` nulo). */
const inScope = (scope: Scope) =>
  scope.kind === "tenant"
    ? eq(phoneVerification.tenantId, scope.tenantId)
    : isNull(phoneVerification.tenantId);

const CLOSED = { status: "canceled", tokenHash: null, expiresAt: null } as const;

/**
 * Abre o pedido do cadastro para um número, perante um responsável. Substitui o que ele tinha
 * aberto com ESSE responsável; os pedidos com outros responsáveis não são tocados. Sem canal para
 * enviar o link (o envio é a fase T2b), nasce esperando a liberação.
 */
async function open(
  tx: Tx,
  scope: Scope,
  subject: VerificationSubject,
  phone: { phoneNormalized: string; phoneKey: string },
) {
  await tx
    .update(phoneVerification)
    .set(CLOSED)
    .where(and(ofSubject(subject), isOpen, inScope(scope)));

  const [row] = await tx
    .insert(phoneVerification)
    .values({
      tenantId: scopeTenantId(scope),
      subjectType: subject.type,
      subjectId: subject.id,
      phoneNormalized: phone.phoneNormalized,
      phoneKey: phone.phoneKey,
      status: "awaiting_manual",
    })
    .returning({ id: phoneVerification.id });
  if (!row) throw new Error("pedido de verificação não criado");

  return row.id;
}

/**
 * Trava a conta. **Ordem de travas deste arquivo: o número (`lockPhoneKey`), a conta, o pedido.**
 * Quem vai mexer nos pedidos ou nas liberações de uma conta trava a conta ANTES: a confirmação
 * faz assim (`lockForConfirmation`), e a ordem contrária fecharia um ciclo com ela (o Postgres
 * abortaria uma das duas, e o pedido ficaria encalhado na fila de quem perdeu).
 */
async function lockUser(tx: Tx, userId: string) {
  await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
}

/** Garante o pedido da conta dentro de uma transação com bypass. Ver `ensureUserVerification`. */
async function ensureUser(tx: Tx, userId: string, wanted: Scope) {
  // Quem responde por confirmar. A organização só responde por quem é da equipe dela e não é
  // owner de nenhuma nem da equipe da plataforma: esses respondem à plataforma (P16), e uma
  // organização de fachada não pode puxar para si o pedido deles.
  let scope = PLATFORM;
  if (wanted.kind === "tenant") {
    const [membership] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, wanted.tenantId)));
    if (membership && !(await isOwnerOrPlatformStaff(tx, userId))) scope = wanted;
  }

  // Trava a conta: duas chamadas ao mesmo tempo leriam "não há pedido" e a segunda bateria no
  // índice único, abortando a transação de quem chamou (a confirmação de quem provou o número,
  // ou a exclusão de uma organização).
  await lockUser(tx, userId);
  const [person] = await tx
    .select({
      phoneNormalized: user.phoneNormalized,
      phoneKey: user.phoneKey,
      confirmed: sql<boolean>`coalesce(${userPhoneConfirmed(scope)}, false)`,
    })
    .from(user)
    .where(eq(user.id, userId));
  if (!person?.phoneNormalized || !person.phoneKey || person.confirmed) return null;

  const subject = { type: "user", id: userId } as const;
  const [current] = await tx
    .select({ id: phoneVerification.id, phoneKey: phoneVerification.phoneKey })
    .from(phoneVerification)
    .where(and(ofSubject(subject), isOpen, inScope(scope)));
  // Mesmo número, mesmo responsável: o pedido que existe continua valendo.
  if (current?.phoneKey === person.phoneKey) return current.id;

  return open(tx, scope, subject, {
    phoneNormalized: person.phoneNormalized,
    phoneKey: person.phoneKey,
  });
}

/**
 * Garante o pedido aberto da conta perante um responsável, se o telefone dela não está confirmado
 * para ele. `scope` é quem se quer como responsável: a plataforma para quem se cadastrou sem
 * convite, a organização para quem entrou na equipe dela. O pedido só vai para a organização se a
 * pessoa é mesmo da equipe e não é owner de nenhuma organização nem da equipe da plataforma.
 * Não mexe nos pedidos que a conta tem com outros responsáveis.
 */
export function ensureUserVerification(userId: string, scope: Scope = PLATFORM) {
  return withPlatformScope("telefone: abre o pedido da conta", (tx) =>
    ensureUser(tx, userId, scope),
  );
}

/**
 * O mesmo para a ficha de cliente, na transação de quem chama (`withTenant` da organização): o
 * pedido de cliente é sempre do próprio tenant.
 */
export async function ensureCustomerVerification(tx: Tx, tenantId: string, customerId: string) {
  const [record] = await tx
    .select({
      phoneNormalized: customer.phoneNormalized,
      phoneKey: customer.phoneKey,
      verifiedAt: customer.phoneVerifiedAt,
    })
    .from(customer)
    .where(and(eq(customer.id, customerId), eq(customer.tenantId, tenantId)));
  if (!record?.phoneNormalized || !record.phoneKey || record.verifiedAt) return null;

  const subject = { type: "customer", id: customerId } as const;
  const [current] = await tx
    .select({ id: phoneVerification.id, phoneKey: phoneVerification.phoneKey })
    .from(phoneVerification)
    .where(and(ofSubject(subject), isOpen));
  if (current?.phoneKey === record.phoneKey) return current.id;

  return open(tx, { kind: "tenant", tenantId }, subject, {
    phoneNormalized: record.phoneNormalized,
    phoneKey: record.phoneKey,
  });
}

/**
 * O cadastro foi confirmado por outro caminho (a equipe informou o número, o /admin editou), ou
 * trocou de número: os pedidos abertos perdem o sentido. Roda na transação de quem chama, que
 * precisa enxergar os pedidos (o tenant do cliente, ou bypass para a conta).
 */
export async function closeVerificationsOf(tx: Tx, subject: VerificationSubject) {
  await tx.update(phoneVerification).set(CLOSED).where(and(ofSubject(subject), isOpen));
}

/** Cadastro apagado ou anonimizado: os pedidos dele saem junto (`subject_id` não tem FK). */
export async function deleteVerificationsOf(
  tx: Tx,
  type: PhoneVerificationSubject,
  ids: string[],
) {
  if (ids.length === 0) return;

  await tx
    .delete(phoneVerification)
    .where(
      and(eq(phoneVerification.subjectType, type), inArray(phoneVerification.subjectId, ids)),
    );
}

/** `deleteVerificationsOf` para quem apagou as contas fora de uma transação com bypass. */
export function deleteUserVerifications(userIds: string[]) {
  if (userIds.length === 0) return Promise.resolve();

  return withPlatformScope("telefone: apaga pedidos de contas removidas", (tx) =>
    deleteVerificationsOf(tx, "user", userIds),
  );
}

/**
 * A pessoa saiu da equipe de uma organização. O que ESSA organização tinha com o telefone dela
 * termina: a liberação que o owner dela fez e o pedido que estava na fila dela. Os pedidos e as
 * liberações de outras organizações ficam como estão. A conta que não tem o número confirmado
 * para o sistema ganha (ou mantém) o pedido da plataforma.
 */
export function phoneAfterMemberLeft(userId: string, tenantId: string) {
  return withPlatformScope("telefone: membro saiu da organização", async (tx) => {
    await lockUser(tx, userId);
    const vouches = await tx
      .delete(phoneTenantVouch)
      .where(and(eq(phoneTenantVouch.userId, userId), eq(phoneTenantVouch.tenantId, tenantId)))
      .returning({ userId: phoneTenantVouch.userId });
    await tx
      .update(phoneVerification)
      .set(CLOSED)
      .where(
        and(
          ofSubject({ type: "user", id: userId }),
          isOpen,
          eq(phoneVerification.tenantId, tenantId),
        ),
      );

    if (vouches.length > 0) {
      await auditInTransaction(tx, "phone.unverified", {
        actor: { id: null, type: "system" },
        tenantId,
        target: { type: "user", id: userId },
        metadata: { reason: "left_tenant" },
      });
    }

    await ensureUser(tx, userId, PLATFORM);
  });
}

/**
 * A conta passou a responder à plataforma: virou owner de alguma organização ou entrou na equipe
 * da plataforma. Os pedidos que ela tinha na fila de organizações saem de lá (o owner delas não
 * a libera mais) e ela ganha o da plataforma. As liberações que organizações já fizeram
 * continuam valendo dentro de cada uma.
 */
export function routeVerificationToPlatform(userId: string) {
  return withPlatformScope("telefone: conta passa a responder à plataforma", async (tx) => {
    if (!(await isOwnerOrPlatformStaff(tx, userId))) return;

    await lockUser(tx, userId);
    await tx
      .update(phoneVerification)
      .set(CLOSED)
      .where(
        and(
          ofSubject({ type: "user", id: userId }),
          isOpen,
          isNotNull(phoneVerification.tenantId),
        ),
      );
    await ensureUser(tx, userId, PLATFORM);
  });
}

/**
 * A organização foi excluída: deixa de responder pelo telefone de quem era da equipe. As
 * liberações dela caem, os pedidos dela saem, e cada conta afetada ganha o pedido da plataforma
 * se ainda não tem o número confirmado para o sistema. Roda na transação (com bypass) da exclusão.
 */
export async function releaseTenantPhoneResponsibility(tx: Tx, tenantId: string) {
  const requested = await tx
    .select({ id: phoneVerification.subjectId })
    .from(phoneVerification)
    .where(
      and(
        eq(phoneVerification.tenantId, tenantId),
        eq(phoneVerification.subjectType, "user"),
        isOpen,
      ),
    );
  const vouched = await tx
    .select({ id: phoneTenantVouch.userId })
    .from(phoneTenantVouch)
    .where(eq(phoneTenantVouch.tenantId, tenantId));

  // As contas primeiro, em ordem de id (duas exclusões ao mesmo tempo não se cruzam).
  const affected = [...new Set([...requested, ...vouched].map((row) => row.id))].sort();
  for (const id of affected) await lockUser(tx, id);

  await tx.delete(phoneTenantVouch).where(eq(phoneTenantVouch.tenantId, tenantId));
  await tx.delete(phoneVerification).where(eq(phoneVerification.tenantId, tenantId));

  for (const id of affected) await ensureUser(tx, id, PLATFORM);
}

/**
 * Gera o link do pedido: o token novo substitui o anterior e só o hash fica no banco. Quem envia
 * o link (T2b) chama isto a cada tentativa. Devolve `null` se o pedido já não está aberto.
 */
export function issueVerificationToken(requestId: string, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  const ttlMs = getEnv().PHONE_VERIFICATION_TTL_MINUTES * 60_000;

  return withPlatformScope("telefone: emite o link", async (tx) => {
    const [row] = await tx
      .update(phoneVerification)
      .set({
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + ttlMs),
        status: "sent",
      })
      .where(and(eq(phoneVerification.id, requestId), isOpen))
      .returning({ id: phoneVerification.id });

    return row ? token : null;
  });
}

/** Só os 4 últimos dígitos: a tela não repete o número inteiro. */
export const phoneHint = (phoneNormalized: string) => phoneNormalized.slice(-4);

/**
 * Os pedidos abertos do próprio cadastro, para a tela "Confirme seu WhatsApp": a situação e os 4
 * últimos dígitos. Com link a caminho em qualquer um, a situação é `sent`. `null` quando não há
 * nada pendente.
 */
export function ownPhoneVerification(subject: VerificationSubject) {
  return withPlatformScope("telefone: situação do próprio pedido", async (tx) => {
    const rows = await tx
      .select({
        status: phoneVerification.status,
        phoneNormalized: phoneVerification.phoneNormalized,
      })
      .from(phoneVerification)
      .where(and(ofSubject(subject), isOpen))
      .orderBy(asc(phoneVerification.createdAt));

    const [first] = rows;
    if (!first) return null;

    return {
      status: rows.some(({ status }) => status === "sent") ? ("sent" as const) : first.status,
      phoneHint: phoneHint(first.phoneNormalized),
    };
  });
}

type Confirmation =
  /** A pessoa, na sessão da própria conta, com o link que chegou ao número. */
  | { via: "whatsapp" }
  /** O proprietário da plataforma. Vale no sistema inteiro. */
  | { via: "manual"; actorId: string }
  /** O owner de uma organização. Na conta, vale só nela; na ficha, é a confirmação da ficha. */
  | { via: "tenant"; actorId: string; tenantId: string };

const actorOf = (confirmation: Confirmation) =>
  confirmation.via === "whatsapp" ? null : confirmation.actorId;

/** Ninguém atesta o próprio número: a liberação à mão existe para um terceiro responder. */
const SELF_CONFIRMATION = () =>
  new TenantRuleError(
    403,
    "SELF_CONFIRMATION",
    "Você não pode liberar o seu próprio telefone. Use o link de verificação.",
  );

const PLATFORM_ONLY = () =>
  new TenantRuleError(
    409,
    "PLATFORM_ONLY",
    "O telefone desta conta só pode ser liberado pela plataforma.",
  );

/**
 * As contas que perderam o número para quem provou a posse: perdem a confirmação do sistema e as
 * liberações de organização para esse número, deixam de ser "a pessoa da equipe" das fichas com
 * ele, ganham um pedido novo na plataforma e ficam registradas na auditoria.
 */
async function demote(tx: Tx, holderIds: string[], phoneKey: string) {
  if (holderIds.length === 0) return;

  await tx
    .update(user)
    .set(UNVERIFIED_PHONE)
    .where(and(inArray(user.id, holderIds), eq(user.phoneKey, phoneKey)));
  await tx
    .delete(phoneTenantVouch)
    .where(
      and(inArray(phoneTenantVouch.userId, holderIds), eq(phoneTenantVouch.phoneKey, phoneKey)),
    );
  await tx
    .update(customer)
    .set({ userId: null })
    .where(and(eq(customer.phoneKey, phoneKey), inArray(customer.userId, holderIds)));

  for (const id of holderIds) {
    await ensureUser(tx, id, PLATFORM);
    await auditInTransaction(tx, "phone.unverified", {
      actor: { id: null, type: "system" },
      target: { type: "user", id },
      metadata: { reason: "claimed" },
    });
  }
}

/** Confirma o número na conta. O pedido só vale para o número que a conta ainda tem. */
async function confirmUser(tx: Tx, request: Request, confirmation: Confirmation) {
  const [person] = await tx
    .select({ id: user.id, phoneKey: user.phoneKey })
    .from(user)
    .where(eq(user.id, request.subjectId));
  if (!person || person.phoneKey !== request.phoneKey) throw INVALID_LINK();
  if (actorOf(confirmation) === person.id) throw SELF_CONFIRMATION();

  const memberships = await tx
    .select({ tenantId: member.organizationId })
    .from(member)
    .where(eq(member.userId, person.id));
  // Pedido de uma organização: só vale enquanto a pessoa é da equipe dela.
  if (request.tenantId && !memberships.some(({ tenantId }) => tenantId === request.tenantId)) {
    throw INVALID_LINK();
  }

  await lockPhoneKey(tx, request.phoneKey);

  if (request.tenantId) {
    // Pedido de uma organização: o que quer que o feche (o link que saiu pelo canal dela, ou o
    // owner à mão) vale só nela. A plataforma não fecha pedido de organização, e a organização
    // nunca responde por quem é owner de alguma ou da equipe da plataforma (P16).
    if (confirmation.via === "manual") throw INVALID_LINK();
    if (confirmation.via === "tenant" && confirmation.tenantId !== request.tenantId) {
      throw INVALID_LINK();
    }
    if (await isOwnerOrPlatformStaff(tx, person.id)) throw PLATFORM_ONLY();

    // Sem "quem provou fica com o número": aqui não há prova que valha contra um colega.
    const holders = await accountPhoneConflicts(tx, person.id, request.phoneKey, {
      onlyTenantId: request.tenantId,
    });
    if (holders.length > 0) throw accountPhoneInUse();

    // Uma linha por (conta, organização): não toca a conta nem o que outras organizações
    // atestaram. Não liga ficha de cliente: isso exige confirmação que valha no sistema inteiro
    // (`team-customer.ts`).
    const values = { phoneKey: request.phoneKey, vouchedBy: actorOf(confirmation) };
    await tx
      .insert(phoneTenantVouch)
      .values({ userId: person.id, tenantId: request.tenantId, ...values })
      .onConflictDoUpdate({
        target: [phoneTenantVouch.userId, phoneTenantVouch.tenantId],
        set: { ...values, createdAt: sql`now()` },
      });

    return { demoted: 0, global: false };
  }

  // Pedido da plataforma: só ela o fecha, pelo link do canal dela ou pelo proprietário.
  if (confirmation.via === "tenant") throw INVALID_LINK();

  const holders = await accountPhoneConflicts(tx, person.id, request.phoneKey);
  // Liberação à mão não prova a posse do número: não o tira de quem o confirmou.
  if (holders.length > 0 && confirmation.via === "manual") throw accountPhoneInUse();
  // Quem confirmou pelo link provou que o número é dele agora (celular troca de dono).
  await demote(tx, holders, request.phoneKey);

  await tx.update(user).set(verifiedPhone(confirmation.via)).where(eq(user.id, person.id));

  // Quem já era cliente de uma organização em que é da equipe passa a ter a ficha ligada.
  for (const { tenantId } of memberships) {
    await linkExistingCustomer(tx, tenantId, person.id);
  }

  return { demoted: holders.length, global: true };
}

/** Confirma o número na ficha de cliente. Os efeitos que dependem de prova só vêm com o link. */
async function confirmCustomer(tx: Tx, request: Request, confirmation: Confirmation) {
  const [record] = await tx
    .select({
      id: customer.id,
      tenantId: customer.tenantId,
      phoneKey: customer.phoneKey,
      userId: customer.userId,
    })
    .from(customer)
    .where(eq(customer.id, request.subjectId));
  if (
    !record ||
    record.phoneKey !== request.phoneKey ||
    record.tenantId !== request.tenantId
  ) {
    throw INVALID_LINK();
  }
  // A ficha é da organização: só o owner dela (ou a própria pessoa, pelo link) a confirma.
  if (confirmation.via === "manual") throw INVALID_LINK();
  if (confirmation.via === "tenant" && confirmation.tenantId !== record.tenantId) {
    throw INVALID_LINK();
  }

  const proven = confirmation.via === "whatsapp";

  // O índice único do tenant já garante que nenhum outro cliente tem o número.
  await tx
    .update(customer)
    .set(verifiedPhone(proven ? "whatsapp" : "manual"))
    .where(eq(customer.id, record.id));

  // O que vem a seguir entrega a esta ficha coisas de quem tem o número, DENTRO da organização
  // (a ligação com a pessoa da equipe, o histórico de quem já escreveu). Só com o link: na
  // liberação à mão, quem declarou o número pode não ser o dono dele, e a equipe decide esses
  // vínculos no painel. Pelo mesmo motivo, a ficha liberada à mão também não atrai sozinha as
  // próximas conversas do número (`autoLinkContact`).
  //
  // A conta global do portal (`portal_user`) nunca é confirmada aqui: o pedido da ficha é da
  // organização, e o que ela atesta não sai dela.
  if (!proven) return { demoted: 0, global: false };

  if (!record.userId) {
    const teamUserId = await matchingTeamMember(tx, record.tenantId, request.phoneKey);
    if (teamUserId) {
      await tx.update(customer).set({ userId: teamUserId }).where(eq(customer.id, record.id));
      await auditInTransaction(tx, "customer.team_linked", {
        actor: { id: null, type: "system" },
        tenantId: record.tenantId,
        target: { type: "customer", id: record.id },
        metadata: { userId: teamUserId, via: "verified" },
      });
    }
  }

  await linkUnlinkedContactToCustomer(tx, record.tenantId, request.phoneKey, record.id);

  return { demoted: 0, global: false };
}

/**
 * Trava o cadastro e depois o pedido, nesta ordem: é a mesma de quem edita o cadastro
 * (`updateCustomer`, `updatePortalProfile`), que trava a ficha e depois fecha o pedido.
 */
async function lockForConfirmation(tx: Tx, found: Request) {
  if (found.subjectType === "user") {
    // O número antes da conta: quem prova um número mexe na conta de quem o tinha (`demote`)
    // segurando a trava do número, e duas provas cruzadas se travariam na ordem contrária.
    await lockPhoneKey(tx, found.phoneKey);
    await lockUser(tx, found.subjectId);
  } else {
    await tx
      .select({ id: customer.id })
      .from(customer)
      .where(eq(customer.id, found.subjectId))
      .for("update");
  }

  const [locked] = await tx
    .select()
    .from(phoneVerification)
    .where(and(eq(phoneVerification.id, found.id), isOpen))
    .for("update");

  return locked ?? null;
}

async function confirm(tx: Tx, request: Request, confirmation: Confirmation, now: Date) {
  const outcome =
    request.subjectType === "user"
      ? await confirmUser(tx, request, confirmation)
      : await confirmCustomer(tx, request, confirmation);

  await tx
    .update(phoneVerification)
    .set({
      status: "confirmed",
      tokenHash: null,
      expiresAt: null,
      confirmedAt: now,
      confirmedBy: actorOf(confirmation),
    })
    .where(eq(phoneVerification.id, request.id));

  // Confirmada para o sistema inteiro, a conta não deve mais nada a nenhum responsável.
  if (outcome.global) {
    await tx
      .update(phoneVerification)
      .set(CLOSED)
      .where(
        and(
          ofSubject({ type: request.subjectType, id: request.subjectId }),
          isOpen,
          ne(phoneVerification.id, request.id),
        ),
      );
  }

  const actorId = actorOf(confirmation);
  await auditInTransaction(tx, "phone.verified", {
    actor: actorId ? { id: actorId } : { id: null, type: "system" },
    tenantId: request.tenantId,
    target: { type: request.subjectType, id: request.subjectId },
    // Só ids e enums: o número nunca vai para a auditoria.
    metadata: { via: confirmation.via, demoted: outcome.demoted },
  });
}

/**
 * Consome o link, **na sessão do próprio cadastro**: `subject` vem da sessão de quem chama, nunca
 * do corpo. Uso único, numa transação só. Token inválido, usado, vencido, de outro cadastro, ou
 * de um cadastro que já trocou de número respondem o mesmo 400 `INVALID_OR_EXPIRED`.
 */
export async function confirmPhoneVerificationByToken(
  token: string,
  subject: VerificationSubject,
  now = new Date(),
) {
  try {
    await consumeToken(token, subject, now);
  } catch (error) {
    await rerouteIfPlatformOnly(error, subject.id);
    throw error;
  }
}

/**
 * A conta passou a responder à plataforma depois de entrar na fila de uma organização (virou
 * owner): o pedido sai de lá e vai para a plataforma, senão ficaria encalhado onde ninguém pode
 * fechá-lo.
 */
async function rerouteIfPlatformOnly(error: unknown, subjectId: string | null) {
  if (!(error instanceof TenantRuleError) || error.code !== "PLATFORM_ONLY" || !subjectId) return;

  await routeVerificationToPlatform(subjectId).catch((failure: unknown) =>
    logError("Falha ao encaminhar o pedido de verificação à plataforma", failure),
  );
}

function consumeToken(token: string, subject: VerificationSubject, now: Date) {
  return withPlatformScope("telefone: confirma pelo link", async (tx) => {
    const valid = and(
      eq(phoneVerification.tokenHash, hashToken(token)),
      eq(phoneVerification.status, "sent"),
      gt(phoneVerification.expiresAt, now),
      ofSubject(subject),
    );

    const [found] = await tx.select().from(phoneVerification).where(valid);
    if (!found) throw INVALID_LINK();

    const locked = await lockForConfirmation(tx, found);
    // Reemitido ou usado enquanto esperávamos a trava: o token que temos já não é o do pedido.
    if (!locked || locked.tokenHash !== found.tokenHash || locked.status !== "sent") {
      throw INVALID_LINK();
    }

    await confirm(tx, locked, { via: "whatsapp" }, now);
  });
}

/**
 * Liberação à mão pelo responsável do escopo: o owner da organização (com `phone:confirm`) ou o
 * proprietário da plataforma. Pedido de outro escopo é 404. Ninguém libera o próprio telefone.
 * Com outra conta do grupo já confirmada no número, 409 `PHONE_IN_USE`.
 */
export async function confirmPhoneVerificationManually(
  scope: Scope,
  requestId: string,
  actorId: string,
  now = new Date(),
) {
  let subjectId: string | null = null;

  try {
    await withPlatformScope("telefone: liberação manual", async (tx) => {
      const [found] = await tx
        .select()
        .from(phoneVerification)
        .where(and(eq(phoneVerification.id, requestId), inScope(scope), isOpen));
      if (!found) throw notFound("Pedido de verificação não encontrado.");
      subjectId = found.subjectId;

      const locked = await lockForConfirmation(tx, found);
      if (!locked) throw notFound("Pedido de verificação não encontrado.");

      const confirmation: Confirmation =
        scope.kind === "tenant"
          ? { via: "tenant", actorId, tenantId: scope.tenantId }
          : { via: "manual", actorId };

      await confirm(tx, locked, confirmation, now);
    });
  } catch (error) {
    if (!(error instanceof TenantRuleError)) throw error;

    await rerouteIfPlatformOnly(error, subjectId);
    // Para quem libera, o pedido existe: se o cadastro mudou, dizer isso, não "link inválido".
    if (error.code === "INVALID_OR_EXPIRED") {
      throw new TenantRuleError(
        409,
        "VERIFICATION_STALE",
        "Este pedido não vale mais: o telefone ou a equipe mudou. Atualize a lista.",
      );
    }
    throw error;
  }
}

/**
 * Os pedidos abertos do escopo, para a fila de liberação, **os mais antigos primeiro** e em
 * páginas: uma enxurrada de cadastros não empurra para fora da lista quem espera há mais tempo.
 * A organização vê só os dela, e só de quem ainda é da equipe; a plataforma, só os sem
 * organização. Pedido cujo cadastro sumiu não aparece (a manutenção o apaga).
 */
export function listPhoneVerifications(scope: Scope, page = 1) {
  // Na plataforma, só quem responde a ela: owners, a equipe da plataforma e quem não é de
  // organização nenhuma. O membro comum tem o pedido da plataforma aberto (é o caminho dele para
  // a confirmação que vale em todo lugar, pelo link), mas quem o libera à mão é a organização:
  // listá-lo aqui só encheria a fila do proprietário.
  const stillThere =
    scope.kind === "tenant"
      ? sql`(${customer.id} is not null or exists (select 1 from member where member.user_id = ${user.id} and member.organization_id = ${scope.tenantId}))`
      : sql`(${user.id} is not null and (
          ${user.role} in ('platform_owner', 'platform_support')
          or not exists (select 1 from member where member.user_id = ${user.id})
          or exists (select 1 from member where member.user_id = ${user.id} and 'owner' = any(string_to_array(member.role, ',')))
        ))`;
  const where = and(inScope(scope), isOpen, stillThere);

  return withScope(scope, async (tx) => {
    const items = await tx
      .select({
        id: phoneVerification.id,
        status: phoneVerification.status,
        subjectType: phoneVerification.subjectType,
        subjectId: phoneVerification.subjectId,
        phone: phoneVerification.phoneNormalized,
        name: sql<string>`coalesce(${user.name}, ${customer.name})`,
        createdAt: phoneVerification.createdAt,
      })
      .from(phoneVerification)
      .leftJoin(
        user,
        and(eq(phoneVerification.subjectType, "user"), eq(user.id, phoneVerification.subjectId)),
      )
      .leftJoin(
        customer,
        and(
          eq(phoneVerification.subjectType, "customer"),
          eq(customer.id, phoneVerification.subjectId),
        ),
      )
      .where(where)
      .orderBy(asc(phoneVerification.createdAt), asc(phoneVerification.id))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    const [total] = await tx
      .select({ total: count() })
      .from(phoneVerification)
      .leftJoin(
        user,
        and(eq(phoneVerification.subjectType, "user"), eq(user.id, phoneVerification.subjectId)),
      )
      .leftJoin(
        customer,
        and(
          eq(phoneVerification.subjectType, "customer"),
          eq(customer.id, phoneVerification.subjectId),
        ),
      )
      .where(where);

    return { items, total: total?.total ?? 0, pageSize: PAGE_SIZE };
  });
}

/**
 * `maintenance.prune`: sai o pedido encerrado há mais de 30 dias e o que ficou sem cadastro
 * (`subject_id` não tem FK); o link vencido que ninguém usou volta a esperar a liberação, e o
 * token sai do banco.
 */
export async function prunePhoneVerifications(now = new Date()) {
  return withPlatformScope("telefone: limpa pedidos antigos", async (tx) => {
    await tx
      .update(phoneVerification)
      .set({ status: "awaiting_manual", tokenHash: null, expiresAt: null })
      .where(
        and(
          eq(phoneVerification.status, "sent"),
          sql`${phoneVerification.expiresAt} <= ${now.toISOString()}::timestamptz`,
        ),
      );

    const closed = await tx
      .delete(phoneVerification)
      .where(
        and(
          inArray(phoneVerification.status, ["confirmed", "canceled"]),
          sql`${phoneVerification.updatedAt} < ${new Date(now.getTime() - 30 * 86_400_000).toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: phoneVerification.id });

    const orphans = await tx
      .delete(phoneVerification)
      .where(
        sql`(${phoneVerification.subjectType} = 'user' and not exists (select 1 from "user" where "user"."id" = ${phoneVerification.subjectId}))
          or (${phoneVerification.subjectType} = 'customer' and not exists (select 1 from customer where customer.id = ${phoneVerification.subjectId}))`,
      )
      .returning({ id: phoneVerification.id });

    // Pedido na fila de uma organização de quem não é mais da equipe dela (o gancho da saída
    // falhou): ninguém o veria nem o fecharia.
    await tx
      .update(phoneVerification)
      .set(CLOSED)
      .where(
        and(
          eq(phoneVerification.subjectType, "user"),
          isOpen,
          sql`${phoneVerification.tenantId} is not null and not exists (select 1 from member where member.user_id = ${phoneVerification.subjectId} and member.organization_id = ${phoneVerification.tenantId})`,
        ),
      );

    // Liberação de organização que não vale mais e não pode reviver: a pessoa saiu da equipe
    // (por um caminho que não a limpou) ou trocou de número.
    await tx.delete(phoneTenantVouch).where(
      sql`not exists (select 1 from member where member.user_id = ${phoneTenantVouch.userId} and member.organization_id = ${phoneTenantVouch.tenantId})
        or not exists (select 1 from "user" where "user"."id" = ${phoneTenantVouch.userId} and "user"."phone_key" = ${phoneTenantVouch.phoneKey})`,
    );

    return closed.length + orphans.length;
  });
}

/**
 * A conta trocou de número: o que as organizações atestaram era sobre o número antigo. Sem isto
 * a linha voltaria a valer se a conta retomasse o número depois (quando outro membro já pode
 * tê-lo confirmado). Roda na transação de quem troca o número, com bypass.
 */
export async function dropTenantVouchesOf(tx: Tx, userId: string) {
  await tx.delete(phoneTenantVouch).where(eq(phoneTenantVouch.userId, userId));
}
