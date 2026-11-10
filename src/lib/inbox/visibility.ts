import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Scope } from "@/db/rls";
import { conversation } from "@/db/schema";
import type { RoleCatalog } from "@/lib/auth/permissions";

/**
 * Quem vê qual conversa (SPEC da caixa de entrada, "Fila e visibilidade"; plano T13). O RLS isola
 * o tenant, não a pessoa: este predicado entra em **toda** leitura e escrita de conversa e de
 * mensagem, e conversa fora dele responde 404, igual a id inexistente.
 *
 * | Quem | Vê |
 * |---|---|
 * | tenant com `inbox:supervise` | todas as do tenant |
 * | tenant com `inbox:read` | sem dono (a fila inteira) ou com ele mesmo como dono |
 * | plataforma | todas as da plataforma (`tenant_id` nulo) |
 */

export type InboxCapabilities = {
  read: boolean;
  reply: boolean;
  assign: boolean;
  supervise: boolean;
};

/** Quem age na caixa de entrada. Montado pela rota; nada aqui lê a requisição. */
export type InboxActor = {
  scope: Scope;
  userId: string;
  can: InboxCapabilities;
  /** Permissões do tenant (`customer:read`...): o painel do contato mostra o cadastro só a quem lê clientes. */
  permissions: readonly string[];
  /** Papéis do tenant: transferir confere se o destino tem `inbox:reply`. */
  catalog?: RoleCatalog;
  ip?: string;
};

/** O ator lê clientes (`customer:read`): só então o painel e a lista mostram o cadastro. */
export const readsCustomers = (actor: InboxActor) =>
  actor.scope.kind === "tenant" && actor.permissions.includes("customer:read");

/** As capacidades da caixa a partir da lista plana de permissões do tenant. */
export function inboxCapabilities(permissions: readonly string[]): InboxCapabilities {
  const read = permissions.includes("inbox:read");

  return {
    read,
    reply: read && permissions.includes("inbox:reply"),
    assign: permissions.includes("inbox:assign"),
    // `supervise` sem `read` não tem efeito (SPEC, "Permissões").
    supervise: read && permissions.includes("inbox:supervise"),
  };
}

/** Escopo da conversa: o RLS já isola, e o filtro explícito é a segunda trava. */
export function conversationScope(scope: Scope): SQL {
  return scope.kind === "tenant"
    ? eq(conversation.tenantId, scope.tenantId)
    : isNull(conversation.tenantId);
}

/**
 * Como o ator enxerga as conversas: `none` (sem `inbox:read`), `all` (todas do escopo) ou `own`
 * (sem dono ou com ele como dono). Fonte única das duas formas do predicado abaixo: a de SQL
 * (`visibleConversation`, nas consultas) e a de memória (`noticeVisibleTo`, no SSE).
 */
type Reach = "none" | "all" | "own";

function reachOf(actor: InboxActor): Reach {
  // Quem não lê não vê nada, mesmo que a rota esqueça a permissão.
  if (!actor.can.read) return "none";
  if (actor.scope.kind === "platform" || actor.can.supervise) return "all";
  return "own";
}

/** O predicado de visibilidade. Sem `inbox:read`, nada. */
export function visibleConversation(actor: InboxActor): SQL {
  const scoped = conversationScope(actor.scope);
  const reach = reachOf(actor);

  if (reach === "none") return sql`false`;
  if (reach === "all") return scoped;

  return and(
    scoped,
    or(isNull(conversation.assignedUserId), eq(conversation.assignedUserId, actor.userId)),
  ) as SQL;
}

/**
 * O mesmo predicado sobre um dono já conhecido (o `a` ou o `p` de um aviso), sem ir ao banco.
 * Dono desconhecido (`undefined`) só passa para quem vê tudo: falha fechada.
 */
export function ownerVisible(actor: InboxActor, owner: string | null | undefined): boolean {
  const reach = reachOf(actor);

  if (reach === "none") return false;
  if (reach === "all") return true;
  if (owner === undefined) return false;
  return owner === null || owner === actor.userId;
}

/** O que o SSE precisa de um aviso para decidir a entrega (`InboxNotice`, sem depender dele). */
export type NoticeOwners = { s: string | null; a?: string | null; p?: string | null };

/**
 * O aviso chega ao assinante? Só do próprio escopo (tenant da sessão, ou plataforma) e, de
 * conversa que ele via **antes** (`p`) ou vê **depois** (`a`) da mudança: entrar e sair da fila
 * também interessam. Sem `p`, o dono não mudou e vale o `a`.
 */
export function noticeVisibleTo(actor: InboxActor, notice: NoticeOwners): boolean {
  const scopeId = actor.scope.kind === "tenant" ? actor.scope.tenantId : null;
  if (notice.s !== scopeId) return false;

  const before = notice.p === undefined ? notice.a : notice.p;
  return ownerVisible(actor, notice.a) || ownerVisible(actor, before);
}
