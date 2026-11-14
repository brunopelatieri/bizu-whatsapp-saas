import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimit,
  jsonBodyLimitOf,
  MINUTE,
  sameOrigin,
  validationError,
} from "@/api/guards";
import { requirePermission, requireTenant, type TenantEnv, teamActor } from "@/api/permissions";
import { rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import {
  GOOGLE_SHEET_RATE_LIMIT,
  googleSheetImportSchema,
  IMPORT_BODY_MAX_BYTES,
  IMPORT_RATE_LIMIT,
  importBatchSchema,
} from "@/lib/schemas/customer-import";
import {
  fetchGoogleSheetCsv,
  SheetFetchError,
} from "@/lib/spreadsheet/google-sheets-fetch.server";
import { GoogleSheetLinkError, parseGoogleSheetLink } from "@/lib/spreadsheet/google-sheets-link";
import { customerImportQuota, importCustomers } from "@/lib/tenant/customer-import";

/**
 * Importação de clientes (bloco I, I2). Arquivo à parte de `customers.ts` porque o corpo daqui
 * (até 500 linhas) passa muito do limite de 16 KB das outras rotas de cliente: `app.ts` registra
 * este grupo **antes** de `customerRoutes`, que nunca chega a ver estes caminhos (cada rota termina
 * a resposta sem chamar o próximo), e cada rota abaixo repete o resto da cadeia de lá.
 */
export const customerImportRoutes = new Hono<TenantEnv>();

customerImportRoutes.onError(handleTenantError);
customerImportRoutes.use(
  "/api/customers/import/*",
  sameOrigin,
  jsonBodyLimitOf(IMPORT_BODY_MAX_BYTES, "Lote grande demais."),
  authRateLimit,
  requireAuth,
  requireTenant,
);

/**
 * Cada pedido grava até 500 fichas: o limite segura quem usaria isso para encher a organização. É
 * por pessoa e organização (depois de `requireTenant`), e não pelo IP, que muda atrás de proxy.
 */
const importRateLimit = rateLimit({
  name: "customer-import",
  limit: IMPORT_RATE_LIMIT,
  windowMs: 10 * MINUTE,
  key: (c) => `${c.get("tenant").id}:${c.get("user").id}`,
});

/** As vagas do plano, só para a tela avisar antes. Quem para no limite é o `POST`. */
customerImportRoutes.get(
  "/api/customers/import/quota",
  requirePermission("customer", "create"),
  async (c) => c.json(await customerImportQuota(c.get("tenant").id)),
);

/**
 * Cria as fichas das linhas (regras do cadastro, sem atualizar nenhuma existente) e devolve um
 * resultado por linha. Valem a permissão e o modo da organização de `POST /api/customers`:
 * `customer:create`, e `read_only` recusa em `requireTenant`. Etiqueta nova exige também `tag:manage`.
 */
customerImportRoutes.post(
  "/api/customers/import",
  requirePermission("customer", "create"),
  importRateLimit,
  zValidator("json", importBatchSchema, validationError),
  async (c) =>
    c.json(
      await importCustomers(c.get("tenant").id, c.req.valid("json").rows, {
        userId: teamActor(c).userId,
        ip: teamActor(c).ip,
        canManageTags: c.get("permissions").includes("tag:manage"),
      }),
    ),
);

/**
 * Buscar uma planilha faz o servidor baixar até 10 MB de fora: limite próprio, bem abaixo do da
 * importação, e por pessoa e organização como ele.
 */
const googleSheetRateLimit = rateLimit({
  name: "customer-import-google",
  limit: GOOGLE_SHEET_RATE_LIMIT,
  windowMs: 10 * MINUTE,
  key: (c) => `${c.get("tenant").id}:${c.get("user").id}`,
});

/**
 * Baixa o CSV de uma planilha pública do Google Planilhas (I3) e o devolve **como texto**, para o
 * navegador ler com o mesmo leitor do arquivo enviado e seguir pelos mesmos lotes de
 * `POST /api/customers/import`. Não grava nada: quem cria as fichas continua sendo aquela rota.
 *
 * O link colado nunca é buscado: `parseGoogleSheetLink` tira dele só os identificadores e
 * `fetchGoogleSheetCsv` monta o endereço e guarda cada salto (`google-sheets-fetch.server.ts`).
 * Toda falha da busca é 422 com mensagem do que fazer: 5xx devolveria a tentativa ao rate limit, e
 * uma busca que falha também custou uma ida ao Google. Nada da planilha (link, identificador,
 * conteúdo) vai a log ou auditoria; a auditoria fica com `customer.imported`, quando algo entra.
 */
customerImportRoutes.post(
  "/api/customers/import/google-sheets",
  requirePermission("customer", "create"),
  googleSheetRateLimit,
  // O corpo é só o link: o teto de 16 KB das outras rotas, não os 5 MB do grupo.
  jsonBodyLimit,
  zValidator("json", googleSheetImportSchema, validationError),
  async (c) => {
    let csv: Uint8Array;
    try {
      csv = await fetchGoogleSheetCsv(parseGoogleSheetLink(c.req.valid("json").url));
    } catch (error) {
      if (error instanceof GoogleSheetLinkError) {
        return c.json({ error: error.message, code: "INVALID_SHEET_LINK" }, 400);
      }
      if (error instanceof SheetFetchError) {
        return c.json({ error: error.message, code: `SHEET_${error.code.toUpperCase()}` }, 422);
      }
      throw error;
    }

    // Texto para baixar, nunca página: `nosniff`, anexo e sem cache (o CSV tem dado de clientes).
    return c.body(csv as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="planilha.csv"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
  },
);
