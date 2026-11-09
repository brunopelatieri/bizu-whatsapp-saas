import { and, inArray, lt, sql } from "drizzle-orm";
import { pruneRateLimitBuckets } from "@/api/rate-limit-postgres";
import { getDb } from "@/db";
import { withPlatformScope } from "@/db/rls";
import {
  auditLog,
  channelEvent,
  emailMessages,
  paymentEvent,
  portalSession,
  portalVerification,
  session,
  verification,
} from "@/db/schema";
import { loadSettings } from "@/lib/billing/settings";
import { deleteOldExportRecords, pruneExports } from "@/lib/lgpd/export";

/** Prazos de retenção. A tabela com a base legal de cada um está em `docs/context/lgpd.md`. */
export const EMAIL_MESSAGE_RETENTION_DAYS = 180;
export const PAYMENT_EVENT_RETENTION_DAYS = 90;
export const CHANNEL_EVENT_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/**
 * `maintenance.prune` (cron diário): apaga o que passou do prazo de retenção.
 *
 * - `payment_event` já tratado (processado, ignorado ou duplicado) há mais de 90 dias;
 * - `channel_event` já tratado (processado, ignorado ou falho) há mais de 30 dias;
 * - `email_message` com mais de 180 dias;
 * - sessões vencidas da equipe e do portal, e `verification`/`portal_verification` vencidos;
 * - exportações de dados (arquivo e registro) vencidas;
 * - `audit_log` mais antigo que `platform_setting.audit_retention_days` (padrão 365);
 * - buckets vencidos de rate limit.
 *
 * Faturas (5 anos) e `consent_log` (prova de consentimento) nunca passam por aqui.
 * Idempotente: rodar duas vezes seguidas não apaga nada a mais.
 */
export async function pruneOldData(now = new Date()) {
  const { auditRetentionDays } = await loadSettings();

  const emailRows = await getDb()
    .delete(emailMessages)
    .where(
      lt(
        emailMessages.createdAt,
        sql`${daysAgo(now, EMAIL_MESSAGE_RETENTION_DAYS).toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: emailMessages.id });

  // `payment_event` e `audit_log` têm RLS e linhas sem tenant: só o escopo de plataforma alcança.
  const platform = await withPlatformScope("maintenance: retenção", async (tx) => {
    const events = await tx
      .delete(paymentEvent)
      .where(
        and(
          inArray(paymentEvent.status, ["processed", "ignored", "duplicate"]),
          lt(
            paymentEvent.receivedAt,
            sql`${daysAgo(now, PAYMENT_EVENT_RETENTION_DAYS).toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({ id: paymentEvent.id });

    const channelEvents = await tx
      .delete(channelEvent)
      .where(
        and(
          inArray(channelEvent.status, ["processed", "ignored", "failed"]),
          lt(
            channelEvent.receivedAt,
            sql`${daysAgo(now, CHANNEL_EVENT_RETENTION_DAYS).toISOString()}::timestamptz`,
          ),
        ),
      )
      .returning({ id: channelEvent.id });

    const audits = await tx
      .delete(auditLog)
      .where(
        lt(
          auditLog.createdAt,
          sql`${daysAgo(now, auditRetentionDays).toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: auditLog.id });

    return {
      paymentEvents: events.length,
      channelEvents: channelEvents.length,
      auditLogs: audits.length,
    };
  });

  const stamp = sql`${now.toISOString()}::timestamptz`;
  const sessions = await getDb()
    .delete(session)
    .where(lt(session.expiresAt, stamp))
    .returning({ id: session.id });
  const portalSessions = await getDb()
    .delete(portalSession)
    .where(lt(portalSession.expiresAt, stamp))
    .returning({ id: portalSession.id });
  const verifications = await getDb()
    .delete(verification)
    .where(lt(verification.expiresAt, stamp))
    .returning({ id: verification.id });
  const portalVerifications = await getDb()
    .delete(portalVerification)
    .where(lt(portalVerification.expiresAt, stamp))
    .returning({ id: portalVerification.id });

  return {
    emailMessages: emailRows.length,
    ...platform,
    sessions: sessions.length,
    portalSessions: portalSessions.length,
    verifications: verifications.length,
    portalVerifications: portalVerifications.length,
    exportFiles: await pruneExports(now),
    exportRecords: await deleteOldExportRecords(now),
    rateLimitBuckets: await pruneRateLimitBuckets(now),
  };
}

export async function handleMaintenancePrune() {
  await pruneOldData();
}
