import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { getDb } from "@/db";
import { consentLog } from "@/db/schema";
import type { ConsentKind, ConsentSubjectType } from "@/db/schema/lgpd";
import { hashIp } from "@/lib/audit";
import { phoneErrorMessage } from "@/lib/phone/br";
import { InvalidPhoneError, phoneValues } from "@/lib/phone/columns";
import {
  LEGAL_VERSIONS,
  REQUIRED_CONSENTS,
  type RequiredConsent,
} from "@/lib/legal/versions";

/**
 * Registro de consentimento (`consent_log`). Não tem tenant: o aceite é da pessoa. Cada linha
 * guarda o hash do IP (como `audit_log`) e o user agent, para provar o quê e quando.
 */

export type ConsentMeta = { ip?: string | null; userAgent?: string | null };

type Entry = { kind: ConsentKind; version: string; accepted: boolean };

const MAX_USER_AGENT = 255;

export async function recordConsent(
  subject: { type: ConsentSubjectType; id: string },
  entries: Entry[],
  { ip, userAgent }: ConsentMeta = {},
) {
  if (entries.length === 0) return;

  const ipHash = ip && ip !== "unknown" ? hashIp(ip) : null;

  await getDb()
    .insert(consentLog)
    .values(
      entries.map((entry) => ({
        subjectType: subject.type,
        subjectId: subject.id,
        ...entry,
        ipHash,
        userAgent: userAgent?.slice(0, MAX_USER_AGENT) ?? null,
      })),
    );
}

/** Estado atual de cada tipo: a linha mais recente. */
export async function currentConsents(
  subject: { type: ConsentSubjectType; id: string },
) {
  // Uma linha por tipo (a mais recente): o histórico cresce e `/api/me` chama isto sempre.
  const rows = await getDb()
    .selectDistinctOn([consentLog.kind], {
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
    .orderBy(consentLog.kind, desc(consentLog.createdAt), desc(consentLog.id));

  return new Map<ConsentKind, (typeof rows)[number]>(rows.map((row) => [row.kind, row]));
}

/** Documentos cuja versão vigente a pessoa ainda não aceitou (nunca aceitou, ou versão antiga). */
export async function pendingConsents(
  subject: { type: ConsentSubjectType; id: string },
): Promise<RequiredConsent[]> {
  const latest = await currentConsents(subject);

  return REQUIRED_CONSENTS.filter((kind) => {
    const row = latest.get(kind);
    return !row?.accepted || row.version !== LEGAL_VERSIONS[kind];
  });
}

/** Aceita as versões vigentes dos documentos obrigatórios (modal de re-aceite). */
export function acceptCurrentVersions(
  subject: { type: ConsentSubjectType; id: string },
  meta: ConsentMeta,
) {
  return recordConsent(
    subject,
    REQUIRED_CONSENTS.map((kind) => ({
      kind,
      version: LEGAL_VERSIONS[kind],
      accepted: true,
    })),
    meta,
  );
}

export function setMarketingConsent(
  subject: { type: ConsentSubjectType; id: string },
  accepted: boolean,
  meta: ConsentMeta,
) {
  return recordConsent(
    subject,
    [{ kind: "marketing", version: LEGAL_VERSIONS.terms, accepted }],
    meta,
  );
}

/** Dados do aceite do cadastro, levados da rota até o hook que cria o usuário. */
export type SignupConsent = ConsentMeta & {
  subjectType: ConsentSubjectType;
  termsVersion: string;
  marketing?: boolean;
  /**
   * Telefone digitado no cadastro, já validado pelo `signupSchema`. Viaja no mesmo contexto e
   * é gravado pelo hook `user.create.before` (`signupPhoneValues`); nunca vem do corpo do
   * Better Auth (`additionalFields.phone` tem `input: false`).
   */
  phone?: string;
};

const signupContext = new AsyncLocalStorage<SignupConsent>();

/**
 * O aceite só é gravado quando o usuário é de fato criado: o hook `user.create.after` lê este
 * contexto. Cadastro de e-mail que já existe não cria usuário, e portanto não grava aceite em
 * nome de quem é dono daquele e-mail.
 */
export function withSignupConsent<T>(context: SignupConsent, fn: () => Promise<T>) {
  return signupContext.run(context, fn);
}

/** Chamado pelos hooks de criação de usuário das duas instâncias. */
export async function recordSignupConsent(
  subject: { type: ConsentSubjectType; id: string },
) {
  const context = signupContext.getStore();
  if (!context || context.subjectType !== subject.type) return;

  const { termsVersion, marketing, ip, userAgent } = context;
  const entries: Entry[] = [
    { kind: "terms", version: termsVersion, accepted: true },
    { kind: "privacy", version: termsVersion, accepted: true },
  ];

  if (marketing !== undefined) {
    entries.push({ kind: "marketing", version: termsVersion, accepted: marketing });
  }

  await recordConsent(subject, entries, { ip, userAgent });
}

/**
 * As colunas de telefone da conta que está nascendo, lidas do contexto do cadastro. Sem
 * contexto ou sem telefone válido, lança: chamar o Better Auth direto, fora da rota de
 * cadastro, falha fechada em vez de criar conta sem telefone.
 */
export function signupPhoneValues(subjectType: ConsentSubjectType) {
  const context = signupContext.getStore();
  if (!context || context.subjectType !== subjectType || !context.phone) {
    throw new APIError("BAD_REQUEST", { message: "Informe o telefone." });
  }

  try {
    return phoneValues(context.phone);
  } catch (error) {
    if (error instanceof InvalidPhoneError) {
      throw new APIError("BAD_REQUEST", { message: phoneErrorMessage(error.reason) });
    }
    throw error;
  }
}
