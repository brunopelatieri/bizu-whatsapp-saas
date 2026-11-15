import { z } from "zod";
import { MAX_GOOGLE_SHEET_LINK_CHARS } from "@/lib/spreadsheet/google-sheets-link";
import { MAX_CELL_CHARS } from "@/lib/spreadsheet/types";

/**
 * Contrato de `POST /api/customers/import` e `GET /api/customers/import/quota` (bloco I, I2).
 *
 * O envelope só **limita o tamanho** do que chega (memória e corpo da requisição). O que é conteúdo
 * (telefone inválido, nome curto, e-mail malformado) nunca derruba o pedido: vira o resultado
 * `invalid` da linha, com o motivo, pelo mesmo `customerSchema` do cadastro.
 */

/** Linhas por pedido. A tela fatia o arquivo (até 10.000 linhas) em pedidos deste tamanho. */
export const IMPORT_BATCH_MAX = 500;

/** Pedidos por 10 minutos, por pessoa e organização (`customer-import`): cabem 20.000 linhas. */
export const IMPORT_RATE_LIMIT = 40;

/**
 * Corpo máximo da rota: 500 linhas no pior caso dos tetos abaixo (cerca de 8,3 KB cada). Uma
 * importação normal tem uns 150 KB por pedido; o teto só existe para não aceitar mais que isso.
 */
export const IMPORT_BODY_MAX_BYTES = 5 * 1024 * 1024;

export const importRowSchema = z
  .object({
    /** Linha da planilha (1 = cabeçalho). O servidor só a devolve, para a tela localizar a linha. */
    sourceRow: z.number().int().min(1).max(10_000_000),
    phone: z.string().max(100),
    name: z.string().max(500).optional(),
    email: z.string().max(500).optional(),
    document: z.string().max(200).optional(),
    tags: z.array(z.string().max(100)).max(100),
    notes: z.string().max(MAX_CELL_CHARS).optional(),
  })
  .strict();
export type ImportRowInput = z.infer<typeof importRowSchema>;

export const importBatchSchema = z
  .object({ rows: z.array(importRowSchema).min(1).max(IMPORT_BATCH_MAX) })
  .strict();
export type ImportBatchInput = z.infer<typeof importBatchSchema>;

/**
 * - `created`: a ficha foi criada.
 * - `duplicate`: o telefone já é de outra ficha da organização ou se repete no arquivo. Nada é
 *   atualizado, ligado nem enviado.
 * - `invalid`: não passou pelo cadastro (`reason` diz por quê).
 * - `limit`: o plano não tem mais vaga; **não** é linha ignorada: com mais vagas, entra.
 */
export type ImportRowStatus = "created" | "duplicate" | "invalid" | "limit";

export type ImportRowResult = {
  sourceRow: number;
  status: ImportRowStatus;
  /** Texto fixo do sistema (nunca eco do conteúdo da linha). Só em `duplicate` e `invalid`. */
  reason?: string;
  /** A ficha nasceu ligada à pessoa da equipe dona do telefone confirmado (D-9). */
  teamLinked?: true;
};

export type ImportBatchResponse = {
  /** Uma por linha enviada, na mesma ordem. */
  results: ImportRowResult[];
  counts: Record<ImportRowStatus, number>;
  teamLinked: number;
  tags: {
    /** Etiquetas novas criadas por este pedido. */
    created: number;
    /** Nomes de etiqueta que não foram ligados (etiqueta nova sem permissão, ou teto de 100). */
    ignored: number;
    ignoredReason: "no_permission" | "tag_limit" | null;
  };
};

export type ImportQuota = {
  /** `null`: o plano não limita clientes. */
  limit: number | null;
  used: number;
  /** Vagas restantes; `null` sem limite. */
  available: number | null;
};

/**
 * `POST /api/customers/import/google-sheets` (I3): o link colado. O formato fica com
 * `parseGoogleSheetLink`, que dá a mensagem certa para cada erro; aqui só o tamanho.
 */
export const googleSheetImportSchema = z
  .object({ url: z.string().max(MAX_GOOGLE_SHEET_LINK_CHARS, "Link longo demais.") })
  .strict();
export type GoogleSheetImportInput = z.infer<typeof googleSheetImportSchema>;

/**
 * Buscas ao Google por 10 minutos, por pessoa e organização (`customer-import-google`). Bem abaixo
 * dos 40 pedidos da importação: cada busca faz o servidor baixar até 10 MB de fora.
 */
export const GOOGLE_SHEET_RATE_LIMIT = 10;
