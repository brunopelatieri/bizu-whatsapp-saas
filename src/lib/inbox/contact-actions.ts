import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { scopeTenantId, type Tx, withScope } from "@/db/rls";
import { chatContact, conversation, customer, user } from "@/db/schema";
import { requireChannelRow } from "@/lib/channels/service";
import { activeMemberRole, alreadyAssigned, auditInbox } from "@/lib/inbox/assignment";
import {
  autoLinkContact,
  findContactByPhoneKey,
  linkCandidates,
  upsertContact,
} from "@/lib/inbox/contacts";
import {
  contactView,
  conversationItem,
  linkOf,
  permissionDenied,
} from "@/lib/inbox/conversations";
import { notifyInbox } from "@/lib/inbox/notify";
import { type InboxActor, readsCustomers, visibleConversation } from "@/lib/inbox/visibility";
import { canWhatsApp, normalizePhone, phoneErrorMessage } from "@/lib/phone/br";
import type {
  LinkContactInput,
  SaveContactAsCustomerInput,
  StartConversationInput,
} from "@/lib/schemas/inbox";
import { createCustomer } from "@/lib/tenant/customers";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * O contato no painel (SPEC, passo 5): nome, candidatos, vínculo, "salvar como cliente" e iniciar
 * conversa. Contato não tem visibilidade própria: o ator alcança o contato de uma conversa que ele
 * vê. Fora disso, 404.
 */

const CONTACT_NOT_FOUND = "Contato não encontrado.";

type ContactRow = typeof chatContact.$inferSelect;

/** Conversas do contato que o ator vê (subconsulta sem correlação: só ids). */
const visibleConversationsOf = (tx: Tx, actor: InboxActor, contactId: string) =>
  tx
    .select({ id: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.contactId, contactId), visibleConversation(actor)));

async function requireVisibleContact(tx: Tx, actor: InboxActor, contactId: string) {
  const [row] = await tx
    .select()
    .from(chatContact)
    .where(
      and(
        eq(chatContact.id, contactId),
        inArray(chatContact.id, visibleConversationsOf(tx, actor, contactId)),
      ),
    );
  if (!row) throw notFound(CONTACT_NOT_FOUND);
  return row;
}

/** Nome a mostrar: cliente (para quem lê clientes), membro, o dado pela equipe, o do WhatsApp. */
async function displayNameFor(tx: Tx, actor: InboxActor, contact: ContactRow) {
  if (contact.customerId && readsCustomers(actor)) {
    const [row] = await tx
      .select({ name: customer.name })
      .from(customer)
      .where(eq(customer.id, contact.customerId));
    if (row) return row.name;
  }
  if (contact.userId) {
    const [row] = await tx.select({ name: user.name }).from(user).where(eq(user.id, contact.userId));
    if (row) return row.name;
  }
  return contact.name ?? contact.waName ?? null;
}

/** Avisa as conversas do contato (o painel e a lista relêem o vínculo). */
async function notifyContactConversations(tx: Tx, actor: InboxActor, contactId: string) {
  const rows = await tx
    .select({ id: conversation.id, assignedUserId: conversation.assignedUserId })
    .from(conversation)
    .where(eq(conversation.contactId, contactId));

  for (const row of rows) {
    await notifyInbox(tx, {
      s: scopeTenantId(actor.scope),
      c: row.id,
      k: "conversation",
      a: row.assignedUserId,
      p: row.assignedUserId,
    });
  }
}

async function contactResponse(tx: Tx, actor: InboxActor, contactId: string) {
  const [row] = await tx.select().from(chatContact).where(eq(chatContact.id, contactId));
  if (!row) throw notFound(CONTACT_NOT_FOUND);

  return {
    contact: contactView(row, await displayNameFor(tx, actor, row)),
    link: await linkOf(tx, actor, row),
  };
}

export async function updateContact(actor: InboxActor, contactId: string, name: string | null) {
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    await requireVisibleContact(tx, actor, contactId);
    await tx
      .update(chatContact)
      .set({ name, updatedAt: sql`now()` })
      .where(eq(chatContact.id, contactId));
    await notifyContactConversations(tx, actor, contactId);

    return contactResponse(tx, actor, contactId);
  });
}

/** Quem tem a mesma `phone_key`: membros e, para quem lê clientes, clientes. */
export async function contactCandidates(actor: InboxActor, contactId: string) {
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    const contact = await requireVisibleContact(tx, actor, contactId);
    const { users, customers } = await linkCandidates(tx, actor.scope, contact.phoneKey);

    return { users, customers: readsCustomers(actor) ? customers : [] };
  });
}

/** Membro ativo do tenant (não banido). */
const isActiveMember = async (tx: Tx, tenantId: string, userId: string) =>
  (await activeMemberRole(tx, tenantId, userId)) !== null;

/**
 * Vincular a um cliente (`customer:update`), a um membro ativo, ou desfazer. Um vínculo só: o
 * outro lado é zerado (`CHECK` do banco).
 */
export async function linkContact(actor: InboxActor, contactId: string, input: LinkContactInput) {
  if (!actor.can.reply) throw permissionDenied();
  if (actor.scope.kind !== "tenant") throw permissionDenied();
  const tenantId = actor.scope.tenantId;
  if (input.customerId && !actor.permissions.includes("customer:update")) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    await requireVisibleContact(tx, actor, contactId);

    let link: { customerId: string | null; userId: string | null };
    if (input.customerId) {
      const [row] = await tx
        .select({ id: customer.id })
        .from(customer)
        .where(and(eq(customer.id, input.customerId), eq(customer.tenantId, tenantId)));
      if (!row) throw notFound("Cliente não encontrado.");
      link = { customerId: row.id, userId: null };
    } else if (input.userId) {
      if (!(await isActiveMember(tx, tenantId, input.userId))) {
        throw new TenantRuleError(400, "INVALID_LINK", "Escolha alguém da equipe.");
      }
      link = { customerId: null, userId: input.userId };
    } else {
      link = { customerId: null, userId: null };
    }

    await tx
      .update(chatContact)
      .set({ ...link, updatedAt: sql`now()` })
      .where(eq(chatContact.id, contactId));

    await auditInbox(tx, actor, "inbox.contact_linked", { type: "chat_contact", id: contactId }, {
      customerId: link.customerId,
      userId: link.userId,
    });
    await notifyContactConversations(tx, actor, contactId);

    return contactResponse(tx, actor, contactId);
  });
}

const alreadyLinked = () =>
  new TenantRuleError(
    409,
    "CONTACT_ALREADY_LINKED",
    "Este contato já está vinculado. Desvincule antes de salvar como cliente.",
  );

/**
 * "Salvar como cliente": cria o `customer` com o telefone do contato **como o WhatsApp entregou**
 * (sem inserir o 9º dígito) e vincula, na mesma transação. Passa pelo limite do plano e pelas
 * regras do cadastro (`PLAN_LIMIT_REACHED`, `INVALID_PHONE`, `PHONE_IN_USE` com o cliente dono do
 * número, `CUSTOMER_EMAIL_TAKEN`).
 */
export async function saveContactAsCustomer(
  actor: InboxActor,
  contactId: string,
  input: SaveContactAsCustomerInput,
) {
  if (!actor.can.reply || !actor.permissions.includes("customer:create")) throw permissionDenied();
  if (actor.scope.kind !== "tenant") throw permissionDenied();
  const tenantId = actor.scope.tenantId;

  const contact = await withScope(actor.scope, (tx) => requireVisibleContact(tx, actor, contactId));
  if (contact.customerId || contact.userId) throw alreadyLinked();

  const created = await createCustomer(
    tenantId,
    {
      name: input.name,
      email: input.email ?? null,
      // O número do WhatsApp, a menos que o atendente o tenha corrigido (a regra do cadastro o valida).
      phone: input.phone ?? `+${contact.phone}`,
      document: null,
      notes: null,
      tagIds: input.tagIds,
      customFields: input.customFields,
    },
    { userId: actor.userId, ip: actor.ip, canRead: readsCustomers(actor) },
    {
      // Na transação do cadastro: perdeu a corrida (outro vínculo, ou a conversa saiu do
      // alcance do ator), o cliente também não é criado.
      afterCreate: async (tx, customerId) => {
        const linked = await tx
          .update(chatContact)
          .set({ customerId, updatedAt: sql`now()` })
          .where(
            and(
              eq(chatContact.id, contactId),
              isNull(chatContact.customerId),
              isNull(chatContact.userId),
              inArray(chatContact.id, visibleConversationsOf(tx, actor, contactId)),
            ),
          )
          .returning({ id: chatContact.id });
        if (linked.length === 0) throw alreadyLinked();

        await auditInbox(
          tx,
          actor,
          "inbox.contact_saved_as_customer",
          { type: "chat_contact", id: contactId },
          { customerId },
        );
        await notifyContactConversations(tx, actor, contactId);
      },
    },
  );

  return created;
}

// ---------------------------------------------------------------------------
// Iniciar conversa
// ---------------------------------------------------------------------------

const phoneRequired = () =>
  new TenantRuleError(400, "PHONE_REQUIRED", "Cadastre um telefone para conversar pelo WhatsApp.");

/** O telefone do destino: do cliente, do membro ou o digitado. */
async function destinationPhone(tx: Tx, tenantId: string, input: StartConversationInput) {
  let raw: string;
  let link: { customerId?: string; userId?: string } = {};

  if (input.customerId) {
    const [row] = await tx
      .select({ phone: customer.phoneNormalized })
      .from(customer)
      .where(and(eq(customer.id, input.customerId), eq(customer.tenantId, tenantId)));
    if (!row) throw notFound("Cliente não encontrado.");
    if (!row.phone) throw phoneRequired();
    raw = `+${row.phone}`;
    link = { customerId: input.customerId };
  } else if (input.userId) {
    if (!(await isActiveMember(tx, tenantId, input.userId))) throw notFound("Membro não encontrado.");
    const [row] = await tx
      .select({ phone: user.phoneNormalized })
      .from(user)
      .where(eq(user.id, input.userId));
    if (!row?.phone) throw phoneRequired();
    raw = `+${row.phone}`;
    link = { userId: input.userId };
  } else {
    raw = input.phone ?? "";
  }

  const result = normalizePhone(raw);
  if (!result.ok) {
    throw new TenantRuleError(400, "INVALID_PHONE", phoneErrorMessage(result.reason), {
      reason: result.reason,
    });
  }
  return { phone: result.phone, key: result.key, kind: result.kind, link };
}

/**
 * Acha ou cria a conversa com um cliente, um membro ou um telefone, pelo número de saída escolhido.
 * Não envia nada. O número precisa poder ter WhatsApp (`canWhatsApp`) **ou já ter escrito**: com
 * `chat_contact` da mesma `phone_key`, a conversa usa esse contato e o número dele, mesmo que o
 * cadastro seja fixo ou celular antigo. A conversa nova nasce com quem a iniciou como dono; a que já
 * existe e é de outro atendente responde 409 `ALREADY_ASSIGNED` a quem não supervisiona.
 */
export async function startConversation(actor: InboxActor, input: StartConversationInput) {
  if (!actor.can.reply) throw permissionDenied();
  if (actor.scope.kind !== "tenant") throw permissionDenied();
  // A conversa mostra o telefone do contato: pelo cliente, só quem já lê clientes.
  if (input.customerId && !readsCustomers(actor)) throw permissionDenied();
  const tenantId = actor.scope.tenantId;

  return withScope(actor.scope, async (tx) => {
    const target = await requireChannelRow(tx, actor.scope, input.channelId);
    if (target.status === "disabled") {
      throw new TenantRuleError(409, "CHANNEL_DISABLED", "Este número foi desativado.");
    }

    const destination = await destinationPhone(tx, tenantId, input);
    // Ligar o contato ao cliente é editar o cadastro (como em `linkContact`): só com `customer:update`.
    if (destination.link.customerId && !actor.permissions.includes("customer:update")) {
      destination.link = {};
    }
    const known = await findContactByPhoneKey(tx, actor.scope, destination.key);
    if (!known && !canWhatsApp(destination.kind)) {
      throw new TenantRuleError(
        400,
        "PHONE_NOT_WHATSAPP",
        "Este número não pode receber WhatsApp (fixo ou celular sem o 9º dígito).",
      );
    }

    let contactId: string;
    if (known) {
      contactId = known.id;
      // Contato sem vínculo que acabou de ser identificado pela tela: liga.
      const { customerId, userId } = destination.link;
      if (!known.customerId && !known.userId && (customerId || userId)) {
        await tx
          .update(chatContact)
          .set({ customerId: customerId ?? null, userId: userId ?? null })
          .where(eq(chatContact.id, known.id));
      }
    } else {
      const contact = await upsertContact(tx, actor.scope, {
        phone: destination.phone,
        phoneKey: destination.key,
        waName: null,
        createdVia: "outbound",
      });
      contactId = contact.id;
      if (contact.inserted) {
        const { customerId, userId } = destination.link;
        if (customerId || userId) {
          await tx
            .update(chatContact)
            .set({ customerId: customerId ?? null, userId: userId ?? null })
            .where(eq(chatContact.id, contact.id));
        } else {
          await autoLinkContact(tx, actor.scope, contact.id, destination.key);
        }
      }
    }

    const [inserted] = await tx
      .insert(conversation)
      .values({
        tenantId,
        channelId: target.id,
        contactId,
        status: "open",
        assignedUserId: actor.userId,
        assignedAt: sql`now()`,
        lastMessageAt: sql`now()`,
        unreadCount: 0,
      })
      .onConflictDoNothing({
        target: [conversation.tenantId, conversation.contactId, conversation.channelId],
      })
      .returning({ id: conversation.id });

    if (inserted) {
      await auditInbox(tx, actor, "inbox.conversation_claimed", { type: "conversation", id: inserted.id }, {
        via: "start",
      });
      await notifyInbox(tx, {
        s: tenantId,
        c: inserted.id,
        k: "conversation",
        a: actor.userId,
        p: null,
        u: actor.userId,
      });
      return { conversation: await conversationItem(tx, actor, inserted.id), created: true };
    }

    const [existing] = await tx
      .select({
        id: conversation.id,
        assignedUserId: conversation.assignedUserId,
        visible: sql<boolean>`${visibleConversation(actor)}`,
        ownerName: user.name,
      })
      .from(conversation)
      .leftJoin(user, eq(user.id, conversation.assignedUserId))
      .where(
        and(
          eq(conversation.tenantId, tenantId),
          eq(conversation.contactId, contactId),
          eq(conversation.channelId, target.id),
        ),
      );
    if (!existing) throw new Error("Conversa não encontrada depois do conflito.");
    if (!existing.visible && existing.assignedUserId) {
      throw alreadyAssigned({ id: existing.assignedUserId, name: existing.ownerName });
    }
    return { conversation: await conversationItem(tx, actor, existing.id), created: false };
  });
}
