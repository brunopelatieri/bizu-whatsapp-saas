import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth } from "@/api/auth";
import {
  authRateLimit,
  jsonBodyLimitOf,
  MINUTE,
  sameOrigin,
  validationError,
} from "@/api/guards";
import { requirePermission, requireTenant, type TenantEnv, teamActor } from "@/api/permissions";
import { rateLimit } from "@/api/rate-limit";
import { handleTenantError } from "@/api/tenant-errors";
import {
  IMPORT_BODY_MAX_BYTES,
  IMPORT_RATE_LIMIT,
  importBatchSchema,
} from "@/lib/schemas/customer-import";
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
