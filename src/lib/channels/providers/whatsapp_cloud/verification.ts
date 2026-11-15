import { and, eq, sql } from "drizzle-orm";
import { type Scope, type Tx, withScope } from "@/db/rls";
import { channelWhatsappCloud, messageTemplate } from "@/db/schema";
import { type ChannelActor, requireChannelRow, runInScope } from "@/lib/channels/service";
import type { VerificationDelivery } from "@/lib/channels/types";
import { getEnv } from "@/lib/env";
import { notFound, TenantRuleError } from "@/lib/tenant/errors";

/**
 * Modelo de verificação de telefone do canal Cloud (SPEC `pre-producao`, T2b). A Meta só deixa
 * a empresa começar conversa por modelo aprovado; o link vai como sufixo de um botão de URL
 * dinâmica: `APP_URL/verificar-telefone?token={{1}}`.
 *
 * **A URL do botão é conferida contra `APP_URL`** ao escolher o modelo e de novo a cada envio:
 * um modelo que mandasse o token para outro endereço entregaria o link a quem controla esse
 * endereço. Corpo e cabeçalho sem variáveis: o núcleo só preenche o botão.
 */

/** O que o botão de URL do modelo precisa ser, exatamente. */
export const verificationButtonUrl = (appUrl = getEnv().APP_URL) =>
  `${new URL("/verificar-telefone", appUrl).toString()}?token={{1}}`;

type MetaButton = { type?: unknown; url?: unknown };
type MetaComponent = { type?: unknown; text?: unknown; format?: unknown; buttons?: unknown };

const hasVariable = (value: unknown) => typeof value === "string" && /\{\{[^}]*\}\}/.test(value);

/**
 * Motivo de o modelo não servir, ou `null`. Exige: aprovado, um único botão de URL e ele igual a
 * `verificationButtonUrl()`, nenhuma outra variável (corpo, cabeçalho, outros botões) e cabeçalho
 * só de texto (mídia pediria parâmetro).
 */
export function verificationTemplateProblem(
  template: { status: string; components: unknown[] },
  appUrl = getEnv().APP_URL,
): string | null {
  if (template.status !== "APPROVED") return "O modelo precisa estar aprovado pela Meta.";

  const expected = verificationButtonUrl(appUrl);
  const urlButtons: MetaButton[] = [];

  for (const raw of template.components) {
    const component = (raw ?? {}) as MetaComponent;
    const type = String(component.type ?? "").toUpperCase();

    if (type === "BUTTONS") {
      const buttons = Array.isArray(component.buttons) ? (component.buttons as MetaButton[]) : [];
      for (const button of buttons) {
        if (String(button.type ?? "").toUpperCase() === "URL") urlButtons.push(button);
        else if (hasVariable((button as { text?: unknown }).text)) {
          return "Só o botão de URL pode ter variável.";
        }
      }
      continue;
    }
    if (type === "HEADER" && component.format && String(component.format).toUpperCase() !== "TEXT") {
      return "O cabeçalho do modelo precisa ser de texto.";
    }
    if (hasVariable(component.text)) return "O texto do modelo não pode ter variáveis.";
  }

  if (urlButtons.length !== 1) return "O modelo precisa de exatamente um botão de URL.";
  if (urlButtons[0]?.url !== expected) {
    return `O botão de URL precisa apontar para ${expected}.`;
  }

  return null;
}

/** Posição do botão de URL entre os botões do modelo (a Meta pede o índice no envio). */
function urlButtonIndex(components: unknown[]) {
  for (const raw of components) {
    const component = (raw ?? {}) as MetaComponent;
    if (String(component.type ?? "").toUpperCase() !== "BUTTONS") continue;
    const buttons = Array.isArray(component.buttons) ? (component.buttons as MetaButton[]) : [];
    const index = buttons.findIndex((button) => String(button.type ?? "").toUpperCase() === "URL");
    if (index >= 0) return index;
  }
  return 0;
}

async function cloudRow(tx: Tx, scope: Scope, id: string) {
  await requireChannelRow(tx, scope, id);
  const [cloud] = await tx
    .select()
    .from(channelWhatsappCloud)
    .where(eq(channelWhatsappCloud.channelId, id));
  if (!cloud) throw notFound("Canal não encontrado.");

  return cloud;
}

async function findTemplate(
  tx: Tx,
  scope: Scope,
  wabaId: string,
  name: string,
  language: string,
) {
  const [template] = await tx
    .select({ status: messageTemplate.status, components: messageTemplate.components })
    .from(messageTemplate)
    .where(
      and(
        scope.kind === "tenant"
          ? eq(messageTemplate.tenantId, scope.tenantId)
          : sql`${messageTemplate.tenantId} is null`,
        eq(messageTemplate.wabaId, wabaId),
        eq(messageTemplate.name, name),
        eq(messageTemplate.language, language),
      ),
    );

  return template ?? null;
}

/**
 * Escolhe (ou tira, com `null`) o modelo de verificação do canal, entre os modelos aprovados já
 * sincronizados do WABA dele, no escopo de quem pede. 422 `INVALID_VERIFICATION_TEMPLATE` com o
 * motivo quando o modelo não serve.
 */
export async function setVerificationTemplate(
  scope: Scope,
  id: string,
  template: { name: string; language: string } | null,
  actor: ChannelActor,
) {
  await runInScope(scope, actor, async (tx, record) => {
    const target = await requireChannelRow(tx, scope, id, true);
    const cloud = await cloudRow(tx, scope, id);

    if (template) {
      const found = await findTemplate(tx, scope, cloud.wabaId, template.name, template.language);
      if (!found) throw notFound("Modelo não encontrado. Sincronize os modelos do número.");

      const problem = verificationTemplateProblem(found);
      if (problem) throw new TenantRuleError(422, "INVALID_VERIFICATION_TEMPLATE", problem);
    }

    await tx
      .update(channelWhatsappCloud)
      .set({
        verificationTemplateName: template?.name ?? null,
        verificationTemplateLanguage: template?.language ?? null,
      })
      .where(eq(channelWhatsappCloud.channelId, id));
    await record("channel.updated", { id: target.id, type: target.type });
  });

  return { template };
}

/**
 * `ChannelModule.verificationDelivery`: o modelo escolhido, se ainda aprovado e com a URL certa;
 * sem ele, o canal não está apto e o núcleo passa ao próximo (D-3).
 */
export async function cloudVerificationDelivery(
  scope: Scope,
  id: string,
): Promise<VerificationDelivery> {
  return withScope(scope, async (tx) => {
    const cloud = await cloudRow(tx, scope, id);
    const name = cloud.verificationTemplateName;
    const language = cloud.verificationTemplateLanguage;
    if (!name || !language) return { kind: "unavailable", reason: "sem modelo de verificação" };

    const found = await findTemplate(tx, scope, cloud.wabaId, name, language);
    if (!found || verificationTemplateProblem(found)) {
      return { kind: "unavailable", reason: "modelo de verificação inválido" };
    }

    const index = String(urlButtonIndex(found.components));
    return {
      kind: "template",
      name,
      language,
      components: (token: string) => [
        {
          type: "button",
          sub_type: "url",
          index,
          parameters: [{ type: "text", text: token }],
        },
      ],
    };
  });
}
