import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { type Scope, type Tx, withScope } from "@/db/rls";
import { channel, channelWhatsappCloud, messageTemplate } from "@/db/schema";
import { can } from "@/lib/channels/capabilities";
import { permissionDenied, requireVisibleConversation } from "@/lib/inbox/conversations";
import { dispatch, queueMessage, type SendOutcome } from "@/lib/inbox/send";
import {
  analyzeTemplate,
  buildSendComponents,
  isApprovedTemplate,
  renderTemplate,
  type TemplateSlot,
  variableProblem,
} from "@/lib/inbox/templates";
import type { InboxActor } from "@/lib/inbox/visibility";
import type { SendTemplateInput } from "@/lib/schemas/inbox";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Modelo de mensagem aprovado (SPEC, "Envio"): só de `message_template` com status aprovado, do WABA do
 * canal da conversa, com as variáveis conferidas contra `components`. É a única forma de falar com a
 * janela de 24 h fechada (`requiresWindow: false`). A criação e a submissão de modelos não existem aqui:
 * a tabela é só lida (`tech/29-canais-whatsapp.md`).
 */

const scopeFilter = (scope: Scope): SQL =>
  scope.kind === "tenant"
    ? eq(messageTemplate.tenantId, scope.tenantId)
    : (isNull(messageTemplate.tenantId) as SQL);

/** Condição que prende o modelo ao WABA do número (`JOIN` com a configuração Cloud) e ao escopo. */
const ofChannel = (scope: Scope, channelId: string) =>
  and(eq(channelWhatsappCloud.channelId, channelId), scopeFilter(scope));

/** `SELECT` dos modelos; quem chama junta `ofChannel` e o que mais precisar num `.where` só. */
function selectTemplates(tx: Tx) {
  return tx
    .select({
      id: messageTemplate.id,
      name: messageTemplate.name,
      language: messageTemplate.language,
      category: messageTemplate.category,
      status: messageTemplate.status,
      components: messageTemplate.components,
    })
    .from(messageTemplate)
    .innerJoin(channelWhatsappCloud, eq(channelWhatsappCloud.wabaId, messageTemplate.wabaId));
}

const notSupported = () =>
  new TenantRuleError(400, "TEMPLATES_NOT_SUPPORTED", "Este número não envia modelos de mensagem.");

export type ConversationTemplate = {
  id: string;
  name: string;
  language: string;
  category: string | null;
  /** `false`: listado, mas a tela o desabilita (`reason` explica). */
  supported: boolean;
  reason: string | null;
  slots: TemplateSlot[];
  positional: boolean;
  header: string | null;
  body: string | null;
  footer: string | null;
};

/** Os modelos **aprovados** do WABA do canal da conversa, já analisados, para o `template-dialog`. */
export async function listConversationTemplates(actor: InboxActor, conversationId: string) {
  if (!actor.can.reply) throw permissionDenied();

  return withScope(actor.scope, async (tx) => {
    const current = await requireVisibleConversation(tx, actor, conversationId);
    const [target] = await tx.select().from(channel).where(eq(channel.id, current.channelId));
    if (!target || !can(target.type, "templates")) return { templates: [] as ConversationTemplate[] };

    const rows = await selectTemplates(tx)
      .where(and(ofChannel(actor.scope, target.id), sql`upper(${messageTemplate.status}) = 'APPROVED'`))
      .orderBy(asc(messageTemplate.name), asc(messageTemplate.language));

    const templates = rows.map((row): ConversationTemplate => {
      const analysis = analyzeTemplate(row.components);
      const base = { id: row.id, name: row.name, language: row.language, category: row.category };

      return analysis.supported
        ? {
            ...base,
            supported: true,
            reason: null,
            slots: analysis.slots,
            positional: analysis.positional,
            header: analysis.header,
            body: analysis.body,
            footer: analysis.footer,
          }
        : {
            ...base,
            supported: false,
            reason: analysis.reason,
            slots: [],
            positional: true,
            header: null,
            body: null,
            footer: null,
          };
    });

    return { templates };
  });
}

/** `POST /conversations/:id/messages` com `type: "template"`. Vale com a janela de 24 h fechada. */
export async function sendTemplate(
  actor: InboxActor,
  conversationId: string,
  input: SendTemplateInput,
): Promise<SendOutcome> {
  if (!actor.can.reply) throw permissionDenied();

  const prepared = await withScope(actor.scope, (tx) =>
    queueMessage(tx, actor, conversationId, {
      clientId: input.clientId,
      requiresWindow: false,
      build: async (inner, target) => {
        if (!can(target.type, "templates")) throw notSupported();

        // Fora do WABA do canal (ou de outro escopo) é igual a não existir.
        const [template] = await selectTemplates(inner).where(
          and(ofChannel(actor.scope, target.id), eq(messageTemplate.id, input.templateId)),
        );
        if (!template) throw notFound("Modelo não encontrado.");

        if (!isApprovedTemplate(template.status)) {
          throw new TenantRuleError(409, "TEMPLATE_NOT_APPROVED", "Este modelo não está aprovado.");
        }

        const analysis = analyzeTemplate(template.components);
        if (!analysis.supported) {
          throw new TenantRuleError(400, "TEMPLATE_NOT_SUPPORTED", analysis.reason);
        }

        if (input.variables.length !== analysis.slots.length) {
          throw new TenantRuleError(
            400,
            "INVALID_TEMPLATE_VARIABLES",
            `Este modelo pede ${analysis.slots.length} variável(is).`,
          );
        }
        for (const value of input.variables) {
          const problem = variableProblem(value);
          if (problem) throw new TenantRuleError(400, "INVALID_TEMPLATE_VARIABLES", problem);
        }

        const variables = input.variables.map((value) => value.trim());
        const components = buildSendComponents(analysis, variables);

        return {
          type: "template",
          // O texto já preenchido: é o que o contato lê e o que a bolha mostra (nunca o corpo do provedor).
          text: renderTemplate(analysis, variables),
          templateName: template.name,
          payload: {
            template: {
              id: template.id,
              name: template.name,
              language: template.language,
              variables,
              components,
            },
          },
          delivery: () => ({
            kind: "template",
            name: template.name,
            language: template.language,
            components,
          }),
        };
      },
    }),
  );

  return dispatch(actor, prepared);
}
