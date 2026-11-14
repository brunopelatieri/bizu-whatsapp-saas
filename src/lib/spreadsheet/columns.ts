import type { ColumnKey } from "@/lib/spreadsheet/types";

export type ColumnSpec = {
  key: ColumnKey;
  /** O cabeçalho que o modelo escreve. */
  header: string;
  required: boolean;
  /** Também aceitos, já normalizados (`normalizeHeader`). O canônico entra por `header`. */
  aliases: readonly string[];
  /** Texto da referência de colunas na tela. */
  description: string;
};

/**
 * Fonte única das colunas: o leitor, o modelo e a referência da tela leem daqui, então o modelo
 * nunca sugere um cabeçalho que o leitor não reconhece. Campos adicionais ficam fora da importação.
 */
export const IMPORT_COLUMNS: readonly ColumnSpec[] = [
  {
    key: "phone",
    header: "phone",
    required: true,
    aliases: ["telefone", "celular", "whatsapp", "numero"],
    description:
      "Telefone com DDD, como 11987654321. O DDI 55 é entendido sozinho; espaços, parênteses, traços e + são ignorados.",
  },
  {
    key: "name",
    header: "name",
    required: false,
    aliases: ["nome"],
    description: "Nome do cliente. Sem ele, o telefone formatado vira o nome.",
  },
  {
    key: "email",
    header: "email",
    required: false,
    aliases: ["e-mail"],
    description: "E-mail do cliente.",
  },
  {
    key: "document",
    header: "document",
    required: false,
    aliases: ["documento", "cpf", "cnpj"],
    description: "CPF, CNPJ ou outro documento.",
  },
  {
    key: "tags",
    header: "tags",
    required: false,
    aliases: ["etiquetas"],
    description:
      "Etiquetas do cliente. Uma por célula ou várias separadas por ponto e vírgula: vip;lead.",
  },
  {
    key: "notes",
    header: "notes",
    required: false,
    aliases: ["observacoes"],
    description: "Observações sobre o cliente.",
  },
];

/**
 * Cabeçalho comparável: sem BOM, sem acento, em minúsculas e sem espaço nas pontas. "Número" e
 * "numero" são a mesma coluna, e o Excel que salva em português não perde por causa do acento.
 */
export function normalizeHeader(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Índice da coluna de cada campo no cabeçalho, ou `-1`. Cabeçalho repetido: vale o primeiro. */
export type ColumnMap = Record<ColumnKey, number>;

export function mapColumns(headers: readonly string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader);
  const map = {} as ColumnMap;

  for (const column of IMPORT_COLUMNS) {
    const names = [column.header, ...column.aliases];
    // A ordem dos apelidos manda: "phone" vence "telefone" quando as duas colunas existem.
    let found = -1;
    for (const name of names) {
      found = normalized.indexOf(name);
      if (found !== -1) break;
    }
    map[column.key] = found;
  }

  return map;
}

export function hasPhoneColumn(headers: readonly string[]): boolean {
  return mapColumns(headers).phone !== -1;
}
