import { and, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { logError } from "@/api/log";
import { type Scope, type Tx, withPlatformScope } from "@/db/rls";
import { channel, customer, phoneVerification, portalUser, user } from "@/db/schema";
import type { PhoneVerifyJob } from "@/jobs/queues";
import { appLink } from "@/lib/auth/links";
import { findModule } from "@/lib/channels/registry";
import { sendChannelTemplate, sendChannelText } from "@/lib/channels/send";
import { ProviderError } from "@/lib/channels/errors";
import type {
  ChannelType,
  NormalizedMessage,
  NormalizedStatus,
  VerificationDelivery,
} from "@/lib/channels/types";
import { getEnv } from "@/lib/env";
import {
  enqueuePhoneVerify,
  linksSentInLastHour,
  MAX_LINKS_PER_HOUR,
  requestPhoneVerificationSend,
  subjectKey,
} from "@/lib/phone/dispatch";
import { notifyManualRelease } from "@/lib/phone/notify";
import {
  answersToPlatform,
  isOpen,
  issueVerificationToken,
  lockUser,
  phoneHint,
} from "@/lib/phone/requests";
import type { PhoneDeliveryAttempt } from "@/lib/phone/verification";

/**
 * Envio do link de verificação de telefone pelos canais de WhatsApp (SPEC `pre-producao`, bloco
 * T, fase T2b, D-3). O job `phone.verify` (`src/jobs/phone.ts`) chama `deliverPhoneVerification`.
 *
 * **O canal é sempre do responsável do pedido** (`phone_verification.tenant_id`): pedido da
 * plataforma só sai por canal da plataforma, pedido de uma organização só por canal dela. O
 * canal por QR Code de uma organização é o WhatsApp do owner, que lê o que enviou: se um pedido
 * da plataforma saísse por ele, o owner teria o link que confirma a conta para o sistema inteiro.
 * Por isso a conferência fica em `sendVerificationMessage` (a função que envia), na lista de
 * candidatos, em `requireChannelRow` (o envio do canal) e num gatilho do banco (migration 0037).
 *
 * Cascata: os canais `connected` do responsável, na ordem de `PHONE_VERIFICATION_CHANNELS`
 * (padrão do tipo primeiro, depois o mais antigo). Canal sem jeito de levar o link (Cloud sem
 * modelo) é pulado; erro na chamada passa ao próximo; o aviso `failed` que chega depois pelo
 * webhook (`applyVerificationStatus`) também. Sem canal apto, ou todos falharam: o pedido espera
 * a liberação à mão e o responsável é avisado por e-mail, uma vez por pedido.
 *
 * Cada tentativa gera um token novo (`issueVerificationToken`): o token não vai para o payload
 * do job, para o log, para a auditoria nem para `attempts`. A mensagem de verificação não entra
 * na caixa de entrada (não cria contato, conversa nem mensagem).
 */

export const VERIFY_PATH = "/verificar-telefone";

export { MAX_LINKS_PER_HOUR };

type Request = typeof phoneVerification.$inferSelect;
type ChannelRow = typeof channel.$inferSelect;

export type DeliveryOutcome =
  /** Um canal aceitou a mensagem. */
  | "sent"
  /** Nenhum canal levou o link: o pedido espera a liberação à mão. */
  | "manual"
  /** Não é a vez deste pedido (D-12, ou já há um link a caminho do mesmo número). */
  | "held"
  /** O cadastro já recebeu `MAX_LINKS_PER_HOUR` links nesta hora. */
  | "limited"
  /** O link deste pedido já está a caminho (abrir de novo não reenvia). */
  | "already"
  /** O pedido foi encerrado. */
  | "closed"
  /** O aviso de falha é de uma mensagem que já não é a do pedido. */
  | "stale";

const scopeOfTenant = (tenantId: string | null): Scope =>
  tenantId ? { kind: "tenant", tenantId } : { kind: "platform" };

/** O link que vai na mensagem. O token só existe aqui e no WhatsApp da pessoa. */
export const verificationLink = (token: string) => appLink(VERIFY_PATH, { token });

/** A mensagem de texto livre (QR Code). Sem nome de quem envia nem dado do cadastro. */
export const verificationText = (link: string) =>
  `Para confirmar este número de WhatsApp, abra o link abaixo na mesma conta em que você o cadastrou:\n${link}\n\nSe não foi você, ignore esta mensagem.`;

/**
 * A mensagem que saiu do próprio número pelo envio de verificação e voltou como aviso (o QR Code
 * devolve o que a API envia), reconhecida pelo texto. Não é conversa: não entra na caixa de
 * entrada, e o `raw` do aviso, que tem o link, é apagado (`processChannelEvent`). O texto é a
 * reserva para a corrida em que o eco chega antes de o envio gravar o id da mensagem; com o id
 * gravado, `isVerificationMessage` acha a mensagem exata.
 */
export function isVerificationEcho(event: NormalizedMessage) {
  return event.fromMe && (event.text?.includes(`${VERIFY_PATH}?token=`) ?? false);
}

/**
 * A mensagem `fromMe` é o link de algum pedido enviado por este canal (pelo id no provedor). Roda
 * na transação do aviso, no escopo do canal.
 */
export async function isVerificationMessage(tx: Tx, target: ChannelRow, event: NormalizedMessage) {
  if (!event.fromMe) return false;
  if (isVerificationEcho(event)) return true;

  const [found] = await tx
    .select({ id: phoneVerification.id })
    .from(phoneVerification)
    .where(
      and(
        eq(phoneVerification.channelId, target.id),
        eq(phoneVerification.providerMessageId, event.providerMessageId),
      ),
    )
    .limit(1);

  return found !== undefined;
}

export class VerificationScopeError extends Error {
  constructor() {
    super("Canal de outro escopo para o pedido de verificação.");
    this.name = "VerificationScopeError";
  }
}

/**
 * O `claim` (D-1) apaga a ficha de quem tinha o número: o link só sai por modelo (Cloud), que só o
 * dono do número lê. Decisão do proprietário de 2026-11-14 (CL-3): em texto livre (QR Code) o link
 * fica no celular do canal, e quem opera aquele celular se cadastraria no portal com o número de um
 * cliente e confirmaria na própria sessão. Vale na escolha dos candidatos, na tentativa e na função
 * que envia (reenvio e falha assíncrona incluídos).
 */
export class ClaimDeliveryError extends Error {
  constructor() {
    super("O link de um claim só sai por modelo de mensagem.");
    this.name = "ClaimDeliveryError";
  }
}

/** Pedido da plataforma só por canal da plataforma; de organização, só por canal dela. */
function assertSameScope(request: { tenantId: string | null }, target: { tenantId: string | null }) {
  if ((target.tenantId ?? null) !== (request.tenantId ?? null)) throw new VerificationScopeError();
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

type Plan =
  | { kind: Exclude<DeliveryOutcome, "sent" | "manual"> }
  | { kind: "go"; request: Request; candidates: ChannelRow[] };

async function lockRequest(tx: Tx, requestId: string) {
  const [head] = await tx
    .select({ subjectType: phoneVerification.subjectType, subjectId: phoneVerification.subjectId })
    .from(phoneVerification)
    .where(eq(phoneVerification.id, requestId));
  if (!head) return null;

  // A ordem de travas de `requests.ts`: a conta antes do pedido.
  if (head.subjectType === "user") await lockUser(tx, head.subjectId);
  const [request] = await tx
    .select()
    .from(phoneVerification)
    .where(and(eq(phoneVerification.id, requestId), isOpen))
    .for("update");

  return request ?? null;
}


/**
 * Os canais `connected` do responsável do pedido, na ordem de `PHONE_VERIFICATION_CHANNELS`. O
 * filtro de escopo é explícito (a transação é de plataforma, com bypass).
 */
async function candidatesFor(tx: Tx, request: Request) {
  const order = getEnv().PHONE_VERIFICATION_CHANNELS;
  if (order.length === 0) return [];

  const rows = await tx
    .select()
    .from(channel)
    .where(
      and(
        eq(channel.status, "connected"),
        inArray(channel.type, order),
        request.tenantId ? eq(channel.tenantId, request.tenantId) : isNull(channel.tenantId),
      ),
    );

  return rows
    .filter((row) => (row.tenantId ?? null) === (request.tenantId ?? null))
    // `claim`: só o canal cujo módulo leva o link por modelo (`verificationDelivery`); sem ele, o
    // padrão é texto livre (CL-3).
    .filter((row) => request.purpose !== "claim" || Boolean(findModule(row.type)?.verificationDelivery))
    .sort(
      (a, b) =>
        order.indexOf(a.type) - order.indexOf(b.type) ||
        Number(b.isDefault) - Number(a.isDefault) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
}

/** Por onde começar: do início (abertura), depois do canal atual (falha), ou em roda (reenvio). */
function startingAt(candidates: ChannelRow[], current: string | null, reason: PhoneVerifyJob["reason"]) {
  const index = current ? candidates.findIndex((row) => row.id === current) : -1;
  if (reason === "open" || index < 0) return candidates;
  if (reason === "failed") return candidates.slice(index + 1);

  return [...candidates.slice(index + 1), ...candidates.slice(0, index + 1)];
}

/** Outro pedido do mesmo cadastro já tem um link válido a caminho do mesmo número. */
async function otherLinkInFlight(tx: Tx, request: Request, now: Date) {
  const [other] = await tx
    .select({ id: phoneVerification.id })
    .from(phoneVerification)
    .where(
      and(
        eq(phoneVerification.subjectType, request.subjectType),
        eq(phoneVerification.subjectId, request.subjectId),
        ne(phoneVerification.id, request.id),
        eq(phoneVerification.phoneKey, request.phoneKey),
        eq(phoneVerification.status, "sent"),
        gt(phoneVerification.expiresAt, now),
      ),
    )
    .limit(1);

  return other !== undefined;
}

async function appendAttempt(
  tx: Tx,
  requestId: string,
  attempt: PhoneDeliveryAttempt,
  extra: Partial<Pick<Request, "channelId" | "providerMessageId">> = {},
) {
  const [row] = await tx
    .select({ attempts: phoneVerification.attempts })
    .from(phoneVerification)
    .where(and(eq(phoneVerification.id, requestId), isOpen))
    .for("update");
  if (!row) return false;

  await tx
    .update(phoneVerification)
    // Os 20 mais recentes bastam para entender o que aconteceu.
    .set({ attempts: [...row.attempts, attempt].slice(-20), ...extra })
    .where(eq(phoneVerification.id, requestId));

  return true;
}

const recordAttempt = (
  requestId: string,
  attempt: PhoneDeliveryAttempt,
  extra?: Partial<Pick<Request, "channelId" | "providerMessageId">>,
) =>
  withPlatformScope("phone.verify: registra tentativa", (tx) =>
    appendAttempt(tx, requestId, attempt, extra),
  );

async function plan(job: PhoneVerifyJob, now: Date): Promise<Plan> {
  return withPlatformScope("phone.verify: decide o envio", async (tx) => {
    const request = await lockRequest(tx, job.requestId);
    if (!request) return { kind: "closed" };

    if (job.reason === "failed") {
      // Só a falha da mensagem atual passa ao próximo canal; reenvio ou confirmação no meio
      // tornam o aviso velho.
      if (
        !job.failedMessageId ||
        request.channelId !== job.afterChannelId ||
        request.providerMessageId !== job.failedMessageId
      ) {
        return { kind: "stale" };
      }
    }

    if (job.reason === "open") {
      if (request.status === "sent" && request.expiresAt && request.expiresAt > now) {
        return { kind: "already" };
      }
      if (request.subjectType === "user") {
        // D-12: a plataforma só manda o link sozinha a quem responde a ela. O membro comum
        // recebe o da organização e pede o da plataforma quando quiser ("Reenviar"). A troca de
        // número não espera: foi pedida (pela pessoa, ou pelo proprietário no /admin).
        if (
          request.purpose === "signup" &&
          !request.tenantId &&
          !(await answersToPlatform(tx, request.subjectId))
        ) {
          return { kind: "held" };
        }
        // Restrição (a): um link por número. O da plataforma sai primeiro; o da organização só
        // se não há outro a caminho (a plataforma não tem canal, ou o link dela venceu).
        if (await otherLinkInFlight(tx, request, now)) return { kind: "held" };
      }
    }

    const subject = { type: request.subjectType, id: request.subjectId };
    if ((await linksSentInLastHour(tx, subject, now)) >= MAX_LINKS_PER_HOUR) {
      await appendAttempt(tx, request.id, {
        channelId: null,
        type: null,
        at: now.toISOString(),
        outcome: "limited",
      });
      return { kind: "limited" };
    }

    // A troca de número da ficha só se confirma pelo link na sessão do portal da ficha: sem conta no
    // portal, o link não serviria a ninguém e seria só uma mensagem fria ao número novo. Vai direto
    // para a liberação do owner (que é avisado).
    if (request.subjectType === "customer" && request.purpose === "change") {
      const [record] = await tx
        .select({ portalUserId: customer.portalUserId })
        .from(customer)
        .where(eq(customer.id, request.subjectId));
      if (!record?.portalUserId) return { kind: "go", request, candidates: [] };
    }

    // O `claim` (D-1) só se confirma na sessão do portal de quem se cadastrou: se a conta sumiu, o
    // link não serviria a ninguém.
    if (request.purpose === "claim") {
      const [person] = request.requestedById
        ? await tx
            .select({ id: portalUser.id })
            .from(portalUser)
            .where(eq(portalUser.id, request.requestedById))
        : [];
      if (!person) return { kind: "go", request, candidates: [] };
    }

    const candidates = startingAt(await candidatesFor(tx, request), request.channelId, job.reason);
    return { kind: "go", request, candidates };
  });
}

async function deliveryOf(scope: Scope, target: ChannelRow): Promise<VerificationDelivery> {
  const module = findModule(target.type);
  if (!module) return { kind: "unavailable", reason: "módulo inativo" };
  if (!module.verificationDelivery) return { kind: "text" };

  return module.verificationDelivery(scope, target.id);
}

/**
 * Envia o link por um canal. **Confere aqui que o canal é do responsável do pedido**, antes de
 * qualquer chamada, e o envio do canal confere de novo pelo escopo (`requireChannelRow`).
 */
export async function sendVerificationMessage(
  request: { tenantId: string | null; phoneNormalized: string; purpose?: Request["purpose"] },
  target: { id: string; tenantId: string | null },
  delivery: Exclude<VerificationDelivery, { kind: "unavailable" }>,
  token: string,
) {
  assertSameScope(request, target);
  if (request.purpose === "claim" && delivery.kind !== "template") throw new ClaimDeliveryError();
  const scope = scopeOfTenant(request.tenantId);
  const to = request.phoneNormalized;

  if (delivery.kind === "template") {
    return sendChannelTemplate(scope, target.id, {
      to,
      name: delivery.name,
      language: delivery.language,
      components: delivery.components(token),
    });
  }

  return sendChannelText(scope, target.id, { to, text: verificationText(verificationLink(token)) });
}

/** Código curto do erro, sem a mensagem do provedor (que pode citar o número). */
function errorCode(error: unknown) {
  if (error instanceof ProviderError) return `provider:${error.status}:${error.code ?? "-"}`;
  if (error instanceof Error) return error.name.slice(0, 60);
  return "erro";
}

type TryOutcome = "sent" | "skipped" | "failed" | "closed";

async function tryChannel(request: Request, target: ChannelRow, now: Date): Promise<TryOutcome> {
  assertSameScope(request, target);
  const base = { channelId: target.id, type: target.type, at: now.toISOString() };

  let delivery: VerificationDelivery;
  try {
    delivery = await deliveryOf(scopeOfTenant(request.tenantId), target);
  } catch (error) {
    logError("Falha ao preparar o link de verificação", new Error(errorCode(error)));
    delivery = { kind: "unavailable", reason: "erro" };
  }
  if (delivery.kind === "unavailable") {
    await recordAttempt(request.id, { ...base, outcome: "skipped", error: delivery.reason });
    return "skipped";
  }
  // `claim`: só por modelo (CL-3, `ClaimDeliveryError`), conferido de novo aqui e na função que envia.
  if (request.purpose === "claim" && delivery.kind !== "template") {
    await recordAttempt(request.id, { ...base, outcome: "skipped", error: "claim só por modelo" });
    return "skipped";
  }

  // O escopo é conferido de novo na emissão: o pedido pode ter mudado de responsável depois do
  // `plan()` (a troca de quem virou owner vai para a plataforma), e o link não sai pelo canal errado.
  const token = await issueVerificationToken(request.id, now, request.tenantId);
  if (!token) return "closed";

  try {
    const result = await sendVerificationMessage(request, target, delivery, token);
    await recordAttempt(
      request.id,
      { ...base, outcome: "sent" },
      { channelId: target.id, providerMessageId: result.providerMessageId },
    );
    return "sent";
  } catch (error) {
    // Só o código: a mensagem de um erro de módulo pode repetir o corpo da chamada, que tem o
    // link. O token nunca vai a log.
    logError("Falha ao enviar o link de verificação", new Error(errorCode(error)));
    await recordAttempt(
      request.id,
      { ...base, outcome: "failed", error: errorCode(error) },
      { channelId: target.id, providerMessageId: null },
    );
    return "failed";
  }
}

/**
 * Nenhum canal levou o link: o pedido espera a liberação à mão e o token sai do banco. O
 * responsável é avisado uma vez por pedido, e só se o pedido é da fila dele (o pedido da
 * plataforma de um membro comum não aparece na fila do proprietário). O pedido da plataforma que
 * cai aqui libera o da organização do mesmo número, que esperava a vez (restrição (a)).
 */
async function fallToManual(requestId: string, now: Date): Promise<DeliveryOutcome> {
  const effects = await withPlatformScope("phone.verify: cai na liberação à mão", async (tx) => {
    const request = await lockRequest(tx, requestId);
    if (!request) return null;

    // O `claim` não se libera à mão (sem prova de posse não se apaga a ficha de ninguém): não há o
    // que avisar ao owner.
    const inQueue =
      request.purpose !== "claim" &&
      (request.tenantId !== null ||
      request.subjectType === "customer" ||
      request.purpose === "change" ||
      (await answersToPlatform(tx, request.subjectId)));
    const notify = inQueue && request.manualNotifiedAt === null;

    await tx
      .update(phoneVerification)
      .set({
        status: "awaiting_manual",
        tokenHash: null,
        expiresAt: null,
        providerMessageId: null,
        ...(notify ? { manualNotifiedAt: now } : {}),
      })
      .where(eq(phoneVerification.id, request.id));

    let personName = "";
    if (notify) {
      const [person] =
        request.subjectType === "user"
          ? await tx.select({ name: user.name }).from(user).where(eq(user.id, request.subjectId))
          : await tx
              .select({ name: customer.name })
              .from(customer)
              .where(eq(customer.id, request.subjectId));
      personName = person?.name ?? "";
    }

    const waiting =
      request.tenantId === null && request.subjectType === "user"
        ? await tx
            .select({ id: phoneVerification.id })
            .from(phoneVerification)
            .where(
              and(
                eq(phoneVerification.subjectType, "user"),
                eq(phoneVerification.subjectId, request.subjectId),
                eq(phoneVerification.phoneKey, request.phoneKey),
                eq(phoneVerification.status, "awaiting_manual"),
                ne(phoneVerification.id, request.id),
                // Só o que esperava a vez e nunca teve tentativa: o pedido que já falhou em
                // todos os canais não recebe outra mensagem sem a pessoa pedir.
                sql`jsonb_array_length(${phoneVerification.attempts}) = 0`,
              ),
            )
        : [];

    return { request, notify, personName, waiting };
  });
  if (!effects) return "closed";

  const { request, notify, personName, waiting } = effects;
  if (notify) {
    await notifyManualRelease({
      tenantId: request.tenantId,
      subjectType: request.subjectType,
      personName,
      phoneHint: phoneHint(request.phoneNormalized),
    }).catch((error: unknown) => logError("Falha ao avisar a liberação à mão", error));
  }
  for (const { id } of waiting) {
    await requestPhoneVerificationSend(id, { type: "user", id: request.subjectId });
  }

  return "manual";
}

/** `phone.verify`: uma passada da cascata para um pedido. */
export async function deliverPhoneVerification(
  job: PhoneVerifyJob,
  now = new Date(),
): Promise<DeliveryOutcome> {
  const decided = await plan(job, now);
  // A mensagem atual falhou e o limite da hora não deixa outra: o link não chegou, então o pedido
  // cai na liberação à mão (e o responsável é avisado) em vez de ficar "enviado".
  if (decided.kind === "limited" && job.reason === "failed") return fallToManual(job.requestId, now);
  if (decided.kind !== "go") return decided.kind;

  let issued = false;
  for (const target of decided.candidates) {
    const outcome = await tryChannel(decided.request, target, now);
    if (outcome === "sent") return "sent";
    if (outcome === "closed") return "closed";
    if (outcome === "failed") issued = true;
  }

  // Reenvio sem nenhum canal apto agora: o link que já saiu (e talvez chegou) continua valendo.
  // Só a falha da mensagem atual, ou um token novo que não saiu, derruba o link.
  const { request } = decided;
  if (
    !issued &&
    job.reason === "resend" &&
    request.status === "sent" &&
    request.providerMessageId &&
    request.expiresAt &&
    request.expiresAt > now
  ) {
    return "already";
  }

  return fallToManual(request.id, now);
}

// ---------------------------------------------------------------------------
// Aviso de status (webhook do canal)
// ---------------------------------------------------------------------------

/** `(#131042) Título: mensagem` → `131042`. */
const statusErrorCode = (error: string | null) => error?.match(/^\(#(\w+)\)/)?.[1] ?? null;

/**
 * Status de uma mensagem que não é da caixa de entrada: talvez seja o link de verificação.
 * `failed` da mensagem atual do pedido (sem crédito, `131042`, modelo pausado) passa ao próximo
 * canal da ordem, depois do commit. Roda na transação do aviso, no escopo do canal: o pedido
 * achado é sempre do mesmo escopo.
 */
export async function applyVerificationStatus(
  tx: Tx,
  scope: Scope,
  target: ChannelRow,
  event: NormalizedStatus,
  after?: Array<() => Promise<void>>,
): Promise<boolean> {
  if (event.status !== "failed") return false;

  const [request] = await tx
    .select({
      id: phoneVerification.id,
      attempts: phoneVerification.attempts,
      subjectType: phoneVerification.subjectType,
      subjectId: phoneVerification.subjectId,
    })
    .from(phoneVerification)
    .where(
      and(
        eq(phoneVerification.channelId, target.id),
        eq(phoneVerification.providerMessageId, event.providerMessageId),
        eq(phoneVerification.status, "sent"),
        scope.kind === "tenant"
          ? eq(phoneVerification.tenantId, scope.tenantId)
          : isNull(phoneVerification.tenantId),
      ),
    )
    .for("update");
  if (!request) return false;

  const attempt: PhoneDeliveryAttempt = {
    channelId: target.id,
    type: target.type satisfies ChannelType,
    at: event.occurredAt.toISOString(),
    outcome: "failed",
    error: statusErrorCode(event.error),
  };
  // A mensagem continua sendo a do pedido até a próxima tentativa: é o que o job confere para
  // saber que a falha não ficou velha (um reenvio no meio troca a mensagem).
  await tx
    .update(phoneVerification)
    .set({ attempts: [...request.attempts, attempt].slice(-20) })
    .where(eq(phoneVerification.id, request.id));

  const next = () =>
    enqueuePhoneVerify(
      {
        requestId: request.id,
        reason: "failed",
        afterChannelId: target.id,
        failedMessageId: event.providerMessageId,
      },
      subjectKey({ type: request.subjectType, id: request.subjectId }),
    );
  if (after) after.push(next);
  else await next();

  return true;
}
