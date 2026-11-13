import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { organization, user } from "@/db/schema";
import { appLink } from "@/lib/auth/links";
import { listTenantOwners } from "@/lib/billing/notify";
import { sendEmail } from "@/lib/email/send";
import { phoneNumberClaimedTemplate } from "@/lib/email/templates/phone-number-claimed";
import { phoneVerificationManualTemplate } from "@/lib/email/templates/phone-verification-manual";
import type { PhoneVerificationSubject } from "@/lib/phone/verification";

/**
 * E-mails do bloco T (SPEC `pre-producao`). Nenhum leva o número inteiro: só os 4 últimos
 * dígitos. Rodam depois do commit de quem chama; falha aqui não desfaz nada.
 */

/** As contas que perderam a confirmação para quem provou a posse do número (`demote`). */
export async function notifyPhoneClaimed(userIds: string[], phoneHint: string) {
  if (userIds.length === 0) return;

  const people = await getDb()
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(and(inArray(user.id, userIds), eq(user.banned, false)));

  for (const person of people) {
    await sendEmail({
      to: person.email,
      ...phoneNumberClaimedTemplate({ name: person.name, phoneHint, url: appLink("/app") }),
      tags: { template: "phone-number-claimed" },
    });
  }
}

export type ManualNotice = {
  tenantId: string | null;
  subjectType: PhoneVerificationSubject;
  personName: string;
  phoneHint: string;
};

async function platformOwners() {
  return getDb()
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(and(eq(user.role, "platform_owner"), eq(user.banned, false)));
}

/**
 * O pedido caiu na liberação à mão: avisa quem libera. Na plataforma, os proprietários; na
 * organização, os owners dela. Quem chama decide se o pedido é da fila desse responsável.
 */
export async function notifyManualRelease(notice: ManualNotice) {
  if (!notice.tenantId) {
    for (const person of await platformOwners()) {
      await sendEmail({
        to: person.email,
        ...phoneVerificationManualTemplate({
          name: person.name,
          personName: notice.personName,
          phoneHint: notice.phoneHint,
          where: "na plataforma",
          url: appLink("/admin/usuarios"),
        }),
        tags: { template: "phone-verification-manual" },
      });
    }
    return;
  }

  const [tenant] = await getDb()
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, notice.tenantId));
  if (!tenant) return;

  const isCustomer = notice.subjectType === "customer";
  for (const person of await listTenantOwners(notice.tenantId)) {
    await sendEmail({
      to: person.email,
      ...phoneVerificationManualTemplate({
        name: person.name,
        personName: notice.personName,
        phoneHint: notice.phoneHint,
        where: `${isCustomer ? "nos clientes" : "na equipe"} de ${tenant.name}`,
        url: appLink(isCustomer ? "/app/clientes" : "/app/equipe"),
      }),
      tags: { template: "phone-verification-manual" },
    });
  }
}
