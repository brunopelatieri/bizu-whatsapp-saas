import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { scopeTenantId } from "@/db/rls";
import type { InboxNotice } from "@/lib/inbox/notify";
import { realtimeAvailable, subscribeInbox, waitForRealtime } from "@/lib/inbox/realtime";
import { type InboxActor, noticeVisibleTo } from "@/lib/inbox/visibility";

/**
 * SSE da caixa de entrada (SPEC, "Tempo real"). A rota de tenant é `GET /api/inbox/events`, em
 * `src/api/inbox.ts`, atrás de `requireAuth` + `requireTenant` + `inbox:read`; a da plataforma
 * (C6) chama `streamInboxEvents` com o ator da plataforma, sem mudar nada aqui.
 *
 * - **Filtro no servidor:** só avisos do escopo do ator e, por pessoa, o mesmo predicado das
 *   consultas (`noticeVisibleTo`, irmão de `visibleConversation`). A carga só tem ids; a tela relê
 *   pela API, que aplica a visibilidade de novo.
 * - **Batimento** a cada 25 s (comentário SSE), para proxy e navegador não fecharem por ociosidade.
 * - **Vida máxima** de 15 min: o servidor encerra e a reconexão passa por `requireAuth` de novo
 *   (sessão revogada, papel trocado ou membro removido param de receber em até 15 min).
 * - **Até 3 fluxos por pessoa** neste processo; o quarto recebe 429 e a tela usa polling.
 * - **Sem escuta** (`LISTEN` fora do ar): 503, e a tela usa polling. A queda no meio do fluxo o
 *   encerra, para a tela reler o que pode ter perdido.
 */

export const SSE_HEARTBEAT_MS = 25_000;
export const SSE_LIFETIME_MS = 15 * 60_000;
export const SSE_MAX_STREAMS_PER_USER = 3;
/** Na primeira assinatura do processo a conexão `LISTEN` ainda está abrindo. */
const FIRST_LISTEN_WAIT_MS = 3_000;
/** Cliente que não lê: passou disso, o fluxo é encerrado (ele reconecta e relê). */
const MAX_PENDING_WRITES = 100;
/** Pausa que o navegador espera antes de reconectar sozinho. */
const RETRY_MS = 5_000;

const timing = { heartbeatMs: SSE_HEARTBEAT_MS, lifetimeMs: SSE_LIFETIME_MS };

/** Só para testes: encurta o batimento e a vida do fluxo. `undefined` volta ao padrão. */
export function setInboxEventTimingForTests(next?: { heartbeatMs?: number; lifetimeMs?: number }) {
  timing.heartbeatMs = next?.heartbeatMs ?? SSE_HEARTBEAT_MS;
  timing.lifetimeMs = next?.lifetimeMs ?? SSE_LIFETIME_MS;
}

/** Fluxos abertos por pessoa neste processo. */
const openStreams = new Map<string, number>();

export const openInboxStreams = (userId: string) => openStreams.get(userId) ?? 0;

function release(userId: string) {
  const count = (openStreams.get(userId) ?? 1) - 1;
  if (count > 0) openStreams.set(userId, count);
  else openStreams.delete(userId);
}

/** O que a tela recebe: os ids da conversa, sem o escopo (ela já sabe qual é). */
export type InboxEventData = Omit<InboxNotice, "s">;

function eventData(notice: InboxNotice): InboxEventData {
  const { s: _scope, ...rest } = notice;
  return rest;
}

export async function streamInboxEvents(c: Context, actor: InboxActor) {
  if (openInboxStreams(actor.userId) >= SSE_MAX_STREAMS_PER_USER) {
    return c.json(
      {
        error: "Muitas abas com o atendimento aberto. Esta usa a atualização periódica.",
        code: "TOO_MANY_STREAMS",
      },
      429,
    );
  }

  if (!(await waitForRealtime(FIRST_LISTEN_WAIT_MS))) {
    return c.json(
      { error: "Atualização em tempo real indisponível.", code: "REALTIME_UNAVAILABLE" },
      503,
    );
  }

  // Confere de novo depois da espera: outra aba pode ter entrado no meio.
  if (openInboxStreams(actor.userId) >= SSE_MAX_STREAMS_PER_USER) {
    return c.json(
      {
        error: "Muitas abas com o atendimento aberto. Esta usa a atualização periódica.",
        code: "TOO_MANY_STREAMS",
      },
      429,
    );
  }
  openStreams.set(actor.userId, openInboxStreams(actor.userId) + 1);

  // Sem buffer em proxy (Nginx lê `X-Accel-Buffering`; o Caddy já descarrega `text/event-stream`)
  // e sem transformação (compressão) no caminho.
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    try {
      await new Promise<void>((resolve) => {
        let done = false;
        let pending = 0;

        const finish = () => {
          if (done) return;
          done = true;
          clearInterval(heartbeat);
          clearTimeout(lifetime);
          unsubscribe();
          resolve();
        };

        const send = (chunk: string) => {
          if (done || stream.closed || stream.aborted) return;
          if (pending >= MAX_PENDING_WRITES) {
            finish();
            return;
          }
          pending += 1;
          void stream.write(chunk).finally(() => {
            pending -= 1;
          });
        };

        const unsubscribe = subscribeInbox(scopeTenantId(actor.scope), {
          notice(notice) {
            if (!noticeVisibleTo(actor, notice)) return;
            send(`event: inbox\ndata: ${JSON.stringify(eventData(notice))}\n\n`);
          },
          lost: finish,
        });

        const heartbeat = setInterval(() => send(": ping\n\n"), timing.heartbeatMs);
        const lifetime = setTimeout(finish, timing.lifetimeMs);
        stream.onAbort(finish);
        // Quem fechou antes de o fluxo começar não dispara `onAbort` de novo.
        if (stream.aborted) finish();

        send(`retry: ${RETRY_MS}\nevent: ready\ndata: {}\n\n`);
        // A escuta caiu entre a espera e a assinatura: o aviso de queda já passou.
        if (!realtimeAvailable()) finish();
      });
    } finally {
      release(actor.userId);
    }
  });
}
