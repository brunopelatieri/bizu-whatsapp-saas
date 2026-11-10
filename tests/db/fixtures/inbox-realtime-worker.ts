import { eq } from "drizzle-orm";
import { type Scope, withScope } from "@/db/rls";
import { channel } from "@/db/schema";
import { ingestMessage } from "@/lib/inbox/ingest";

/**
 * Processo à parte que faz o papel do `--worker` (`JOBS_MODE=worker`) em
 * `tests/db/inbox-realtime.test.ts`: grava uma mensagem recebida pela ingestão real, em outro
 * processo e outra conexão. O aviso precisa atravessar até o SSE do processo dos testes.
 */

const { REALTIME_TEST_TENANT, REALTIME_TEST_CHANNEL, REALTIME_TEST_PHONE, REALTIME_TEST_TEXT, REALTIME_TEST_ID } =
  process.env;

if (!REALTIME_TEST_TENANT || !REALTIME_TEST_CHANNEL || !REALTIME_TEST_PHONE || !REALTIME_TEST_ID) {
  console.error("variáveis do teste ausentes");
  process.exit(2);
}

const scope: Scope = { kind: "tenant", tenantId: REALTIME_TEST_TENANT };

const applied = await withScope(scope, async (tx) => {
  const [target] = await tx.select().from(channel).where(eq(channel.id, REALTIME_TEST_CHANNEL));
  if (!target) throw new Error("canal não encontrado");

  return ingestMessage(tx, scope, target, {
    type: "message",
    fromPhone: REALTIME_TEST_PHONE,
    fromExternalId: null,
    pushName: "Contato do Worker",
    providerMessageId: REALTIME_TEST_ID,
    fromMe: false,
    messageType: "text",
    text: REALTIME_TEST_TEXT ?? null,
    media: null,
    replyToProviderMessageId: null,
    occurredAt: new Date(),
  });
});

process.exit(applied ? 0 : 3);
