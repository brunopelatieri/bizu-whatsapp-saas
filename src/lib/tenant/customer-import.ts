import { and, eq, inArray, or } from "drizzle-orm";
import { withTenant } from "@/db/rls";
import { customer, customerTag, tag } from "@/db/schema";
import { auditInTransaction } from "@/lib/audit";
import { checkLimit, withinLimitRoom } from "@/lib/billing/limits";
import { TAG_LIMIT } from "@/lib/crm/constants";
import { createTag } from "@/lib/crm/tags";
import { verifiedPhone } from "@/lib/phone/verification";
import type {
  ImportBatchResponse,
  ImportQuota,
  ImportRowInput,
  ImportRowResult,
  ImportRowStatus,
} from "@/lib/schemas/customer-import";
import { type PreparedRow, prepareRow } from "@/lib/spreadsheet/prepare-row";
import { TenantRuleError } from "@/lib/tenant/errors";
import { matchingTeamMembers } from "@/lib/tenant/team-customer";

/**
 * Importação de clientes (bloco I, I2): `POST /api/customers/import`, um lote de até 500 linhas.
 *
 * **Regras das linhas** (as do cadastro, `createCustomer`): `customerSchema`, telefone por `phoneValues`,
 * unicidade por organização pela `phone_key` (e e-mail único). O telefone nasce `team` (a equipe
 * importa o que já sabe). Linha cujo número já é de outra ficha, ou se repete no arquivo, é
 * `duplicate`: **nunca atualiza** a ficha existente, nunca abre `claim` e nunca dispara mensagem.
 * A ficha nasce ligada à pessoa da equipe só quando o número é o telefone **confirmado** dela
 * (`matchingTeamMembers`); o e-mail nunca liga (D-9).
 *
 * **Como o lote usa a transação.** Uma transação por lote, e **só instruções em conjunto dentro dela**:
 * uma leitura dos telefones e e-mails já cadastrados, uma da equipe, **um `INSERT` de todas as
 * fichas**, um das etiquetas e as auditorias. Nada por linha. O custo, com a trava de `customers`
 * tomada, é de uns 8 comandos, não de 500 vezes alguma coisa: a trava da organização cai em dezenas
 * de milissegundos, e um cadastro manual ou outro lote da mesma organização só espera isso. Uma
 * transação por linha pagaria a trava, a contagem e o `COMMIT` 500 vezes; fatiar em sublotes só
 * encurtaria a espera às custas de mais ida e volta, sem ganho depois que o lote virou um `INSERT`.
 *
 * **O pool.** Tudo o que roda dentro da transação usa a `tx` recebida e nunca chama `getDb()`,
 * `withTenant` nem `createTag` (que abre a própria transação): quem segura a trava termina sem
 * pedir outra conexão (RISK-015, `src/db/nested-section.ts`). O que precisa de outra conexão
 * (ler o plano, resolver e criar etiquetas) corre **antes**, em sequência e sem segurar nada.
 *
 * **O limite.** `withinLimitRoom` toma a trava e conta sob ela; as vagas valem para as primeiras
 * linhas que seriam criadas, na ordem do arquivo, e as demais saem `limit`. Linha inválida ou
 * duplicada é classificada como tal mesmo sem vaga (não adianta mudar de plano para elas).
 */

export type ImportActor = {
  userId: string;
  ip?: string;
  /** Quem tem `tag:manage` cria etiquetas novas; os demais só ligam as que existem. */
  canManageTags: boolean;
};

const DUPLICATE_BASE = "Este telefone já está cadastrado.";
const DUPLICATE_FILE = "Telefone repetido no arquivo.";
const EMAIL_TAKEN = "Já existe um cliente com este e-mail.";
const RACE = "Outro cadastro foi criado ao mesmo tempo. Importe o arquivo de novo.";

/** Ligações de etiqueta por `INSERT` (3 parâmetros cada), bem abaixo do teto de parâmetros do Postgres. */
const TAG_LINK_CHUNK = 5_000;

export async function customerImportQuota(tenantId: string): Promise<ImportQuota> {
  const check = await checkLimit(tenantId, "customers");
  if (check.limit === null) return { limit: null, used: 0, available: null };

  return {
    limit: check.limit,
    used: check.used,
    available: Math.max(0, check.limit - check.used),
  };
}

/** A linha validada (`prepareRow`, a mesma da tela) e a posição dela no pedido. */
type Prepared = PreparedRow & { index: number };

type TagResolution = {
  /** Nome em minúsculas → id da etiqueta. */
  ids: Map<string, string>;
  created: number;
  ignored: number;
  ignoredReason: "no_permission" | "tag_limit" | null;
};

/** Nome em minúsculas → id, de todas as etiquetas da organização (no máximo 100). */
async function tagIdsOf(tenantId: string) {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: tag.id, name: tag.name }).from(tag).where(eq(tag.tenantId, tenantId)),
  );
  return new Map(rows.map((row) => [row.name.toLowerCase(), row.id]));
}

/**
 * As etiquetas do lote: as existentes são ligadas; as novas só são criadas por quem gere etiquetas,
 * até o teto da organização. Corre **antes** da transação das fichas (cada `createTag` abre a
 * própria transação, com a trava das etiquetas, e termina antes de qualquer outra trava).
 * Uma etiqueta que sobra sem ligar nunca recusa a linha: a ficha entra sem ela, e a resposta avisa.
 */
async function resolveTags(
  tenantId: string,
  names: string[],
  actor: ImportActor,
): Promise<TagResolution> {
  const result: TagResolution = { ids: new Map(), created: 0, ignored: 0, ignoredReason: null };
  if (names.length === 0) return result;

  result.ids = await tagIdsOf(tenantId);
  const missing = names.filter((name) => !result.ids.has(name.toLowerCase()));
  if (missing.length === 0) return result;

  if (!actor.canManageTags) {
    result.ignored = missing.length;
    result.ignoredReason = "no_permission";
    return result;
  }

  const room = Math.max(0, TAG_LIMIT - result.ids.size);
  const toCreate = missing.slice(0, room);
  if (missing.length > toCreate.length) {
    result.ignored += missing.length - toCreate.length;
    result.ignoredReason = "tag_limit";
  }

  for (const [position, name] of toCreate.entries()) {
    try {
      await createTag(
        { kind: "tenant", tenantId },
        { name },
        { userId: actor.userId, ip: actor.ip },
      );
      result.created += 1;
    } catch (error) {
      if (!(error instanceof TenantRuleError)) throw error;
      // O teto foi atingido por outro cadastro no meio do caminho: o resto fica sem ligar.
      if (error.code === "TAG_LIMIT") {
        result.ignored += toCreate.length - position;
        result.ignoredReason = "tag_limit";
        break;
      }
      // Outro pedido criou a mesma etiqueta agora: ligamos a dele.
      if (error.code !== "TAG_NAME_TAKEN") throw error;
    }
  }

  // Relê todas: as criadas agora (e as que outro pedido criou), sem comparar a caixa no banco.
  result.ids = await tagIdsOf(tenantId);

  return result;
}

const emptyCounts = (): Record<ImportRowStatus, number> => ({
  created: 0,
  duplicate: 0,
  invalid: 0,
  limit: 0,
});

export async function importCustomers(
  tenantId: string,
  rows: ImportRowInput[],
  actor: ImportActor,
): Promise<ImportBatchResponse> {
  const results: ImportRowResult[] = new Array(rows.length);
  const prepared: Prepared[] = [];

  rows.forEach((row, index) => {
    const result = prepareRow(row);
    if (result.ok) prepared.push({ ...result.row, index });
    else results[index] = { sourceRow: row.sourceRow, status: "invalid", reason: result.reason };
  });

  const response = (tags: TagResolution): ImportBatchResponse => {
    const counts = emptyCounts();
    let teamLinked = 0;
    for (const result of results) {
      counts[result.status] += 1;
      if (result.teamLinked) teamLinked += 1;
    }
    return {
      results,
      counts,
      teamLinked,
      tags: { created: tags.created, ignored: tags.ignored, ignoredReason: tags.ignoredReason },
    };
  };

  const noTags: TagResolution = { ids: new Map(), created: 0, ignored: 0, ignoredReason: null };
  if (prepared.length === 0) return response(noTags);

  // Etiquetas só para quem tem chance de entrar: sem vaga nenhuma (leitura sem trava, só para
  // não criar etiqueta à toa) e sem a segunda ocorrência de um telefone no mesmo lote.
  const quota = await customerImportQuota(tenantId);
  let tags = noTags;
  if (quota.available !== 0) {
    const firstOfPhone = new Set<string>();
    const wanted = new Map<string, string>();
    for (const row of prepared) {
      if (firstOfPhone.has(row.phone.phoneKey)) continue;
      firstOfPhone.add(row.phone.phoneKey);
      for (const name of row.tagNames) {
        if (!wanted.has(name.toLowerCase())) wanted.set(name.toLowerCase(), name);
      }
    }
    tags = await resolveTags(tenantId, [...wanted.values()], actor);
  }

  await withinLimitRoom(tenantId, "customers", {}, async (tx, room) => {
    const keys = prepared.map((row) => row.phone.phoneKey);
    const emails = prepared.flatMap((row) => (row.input.email ? [row.input.email] : []));

    const taken = await tx
      .select({ phoneKey: customer.phoneKey, email: customer.email })
      .from(customer)
      .where(
        and(
          eq(customer.tenantId, tenantId),
          or(
            inArray(customer.phoneKey, keys),
            emails.length > 0 ? inArray(customer.email, emails) : undefined,
          ),
        ),
      );
    const takenPhones = new Set(taken.flatMap(({ phoneKey }) => (phoneKey ? [phoneKey] : [])));
    const takenEmails = new Set(taken.flatMap(({ email }) => (email ? [email] : [])));

    const seenPhones = new Set<string>();
    const seenEmails = new Set<string>();
    const eligible: Prepared[] = [];
    let left = room;

    for (const row of prepared) {
      const { index, sourceRow } = row;
      const { phoneKey } = row.phone;
      const email = row.input.email;

      if (takenPhones.has(phoneKey)) {
        results[index] = { sourceRow, status: "duplicate", reason: DUPLICATE_BASE };
      } else if (seenPhones.has(phoneKey)) {
        results[index] = { sourceRow, status: "duplicate", reason: DUPLICATE_FILE };
      } else if (email && (takenEmails.has(email) || seenEmails.has(email))) {
        results[index] = { sourceRow, status: "invalid", reason: EMAIL_TAKEN };
      } else if (left !== null && left <= 0) {
        results[index] = { sourceRow, status: "limit" };
      } else {
        eligible.push(row);
        seenPhones.add(phoneKey);
        if (email) seenEmails.add(email);
        if (left !== null) left -= 1;
      }
    }

    const team = await matchingTeamMembers(
      tx,
      tenantId,
      eligible.map((row) => row.phone.phoneKey),
    );

    // O `INSERT` em conjunto. Conflito (só por corrida, quando o plano não tem limite e nada trava
    // o cadastro manual) pula a linha em vez de abortar a transação; ela é classificada abaixo.
    const inserted =
      eligible.length === 0
        ? []
        : await tx
            .insert(customer)
            .values(
              eligible.map((row) => ({
                tenantId,
                name: row.input.name,
                email: row.input.email ?? null,
                ...row.phone,
                ...verifiedPhone("team"),
                userId: team.get(row.phone.phoneKey) ?? null,
                document: row.input.document ?? null,
                notes: row.input.notes ?? null,
                customFields: {},
              })),
            )
            .onConflictDoNothing()
            .returning({ id: customer.id, phoneKey: customer.phoneKey, userId: customer.userId });
    const insertedByKey = new Map(inserted.map((row) => [row.phoneKey, row]));

    const lost = eligible.filter((row) => !insertedByKey.has(row.phone.phoneKey));
    const lostPhones =
      lost.length === 0
        ? new Set<string>()
        : new Set(
            (
              await tx
                .select({ phoneKey: customer.phoneKey })
                .from(customer)
                .where(
                  and(
                    eq(customer.tenantId, tenantId),
                    inArray(
                      customer.phoneKey,
                      lost.map((row) => row.phone.phoneKey),
                    ),
                  ),
                )
            ).flatMap(({ phoneKey }) => (phoneKey ? [phoneKey] : [])),
          );
    for (const row of lost) {
      results[row.index] = lostPhones.has(row.phone.phoneKey)
        ? { sourceRow: row.sourceRow, status: "duplicate", reason: DUPLICATE_BASE }
        : { sourceRow: row.sourceRow, status: "invalid", reason: RACE };
    }

    const links: { customerId: string; tagId: string }[] = [];
    const linkedToTeam: { customerId: string; userId: string }[] = [];
    for (const row of eligible) {
      const made = insertedByKey.get(row.phone.phoneKey);
      if (!made) continue;

      results[row.index] = {
        sourceRow: row.sourceRow,
        status: "created",
        ...(made.userId ? { teamLinked: true as const } : {}),
      };
      if (made.userId) linkedToTeam.push({ customerId: made.id, userId: made.userId });
      for (const name of row.tagNames) {
        const tagId = tags.ids.get(name.toLowerCase());
        if (tagId) links.push({ customerId: made.id, tagId });
      }
    }

    for (let start = 0; start < links.length; start += TAG_LINK_CHUNK) {
      await tx
        .insert(customerTag)
        .values(links.slice(start, start + TAG_LINK_CHUNK).map((link) => ({ tenantId, ...link })));
    }

    // Só contagens e ids: nenhum nome, telefone ou e-mail vai para a auditoria.
    for (const link of linkedToTeam) {
      await auditInTransaction(tx, "customer.team_linked", {
        actor: { id: actor.userId },
        tenantId,
        target: { type: "customer", id: link.customerId },
        metadata: { userId: link.userId, via: "imported" },
        ip: actor.ip,
      });
    }
    if (inserted.length > 0) {
      const counts = emptyCounts();
      for (const result of results) counts[result.status] += 1;
      await auditInTransaction(tx, "customer.imported", {
        actor: { id: actor.userId },
        tenantId,
        metadata: {
          rows: rows.length,
          created: counts.created,
          duplicate: counts.duplicate,
          invalid: counts.invalid,
          limit: counts.limit,
          teamLinked: linkedToTeam.length,
          tagsCreated: tags.created,
          tagsIgnored: tags.ignored,
        },
        ip: actor.ip,
      });
    }
  });

  return response(tags);
}
