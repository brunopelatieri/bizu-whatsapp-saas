import { eq, ne } from "drizzle-orm";
import { logError } from "@/api/log";
import { withPlatformScope, withScope } from "@/db/rls";
import { channel, organization } from "@/db/schema";
import { getDb } from "@/db";
import { appLink } from "@/lib/auth/links";
import { listTenantOwners } from "@/lib/billing/notify";
import { requeueStuckChannelEvents, scopeOf } from "@/lib/channels/events";
import { logChannelError } from "@/lib/channels/log";
import { findProvider } from "@/lib/channels/registry";
import { applyChannelStatus, contextFor } from "@/lib/channels/service";
import type { ChannelStatus } from "@/lib/channels/types";
import { sendEmail } from "@/lib/email/send";
import { channelDisconnectedTemplate } from "@/lib/email/templates/channel-disconnected";

/**
 * `channel.health` (cron de 15 em 15 minutos): pergunta ao provedor o estado real de cada canal
 * não desativado e grava `status`, `status_detail` e `last_seen_at`. Avisa os owners por e-mail
 * quando o canal sai de `connected` para `error` ou `disconnected`, uma vez por queda (só a
 * passagem avisa, não o estado). Devolve à fila os avisos `pending` parados há mais de 10 min.
 *
 * Falha transitória do provedor (5xx, 429, timeout) **não** muda o estado: o `probe` lança e o
 * canal fica como estava até a próxima passada.
 */

const DOWN: ReadonlySet<ChannelStatus> = new Set(["error", "disconnected"]);

export type HealthSummary = { checked: number; changed: number; skipped: number; requeued: number };

async function notifyDown(tenantId: string, channelName: string, reason: string | null) {
  const [tenant] = await getDb()
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, tenantId));
  if (!tenant) return;

  for (const owner of await listTenantOwners(tenantId)) {
    await sendEmail({
      to: owner.email,
      ...channelDisconnectedTemplate({
        name: owner.name,
        tenantName: tenant.name,
        channelName,
        reason,
        url: appLink("/app/configuracoes/canais"),
      }),
      tags: { template: "channel-disconnected" },
    });
  }
}

export async function checkChannelsHealth(now = new Date()): Promise<HealthSummary> {
  const rows = await withPlatformScope("channel.health: lista canais", (tx) =>
    tx.select().from(channel).where(ne(channel.status, "disabled")),
  );
  const summary: HealthSummary = { checked: 0, changed: 0, skipped: 0, requeued: 0 };

  for (const row of rows) {
    const provider = findProvider(row.type);
    if (!provider) {
      summary.skipped += 1;
      continue;
    }

    try {
      const ctx = await withPlatformScope("channel.health: contexto", (tx) => contextFor(tx, row));
      const probe = await provider.probe(ctx);
      summary.checked += 1;

      await withScope(scopeOf(row.tenantId), (tx) =>
        applyChannelStatus(
          tx,
          row.id,
          { status: probe.status, detail: probe.detail, identifier: probe.identifier },
          now,
        ),
      );

      if (probe.status !== row.status) summary.changed += 1;

      // Uma vez por queda: só a passagem de `connected` para fora do ar avisa.
      if (row.status === "connected" && DOWN.has(probe.status) && row.tenantId) {
        await notifyDown(row.tenantId, row.name, probe.detail).catch((error) =>
          logError("Falha ao avisar queda de canal", error),
        );
      }
    } catch (error) {
      // Transitório ou segredo ilegível: o estado fica, o motivo vai ao log sem dado pessoal.
      summary.skipped += 1;
      logChannelError(`Falha ao conferir o canal (${row.type})`, error);
    }
  }

  summary.requeued = await requeueStuckChannelEvents(now).catch((error) => {
    logError("Falha ao devolver avisos parados à fila", error);
    return 0;
  });

  return summary;
}
