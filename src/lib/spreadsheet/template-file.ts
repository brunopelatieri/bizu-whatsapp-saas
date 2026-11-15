import { IMPORT_COLUMNS } from "@/lib/spreadsheet/columns";

export const TEMPLATE_FILENAME = "modelo-importacao-clientes.csv";

/**
 * Ponto e vírgula: é o que o Excel em português usa, então o arquivo abre em colunas com dois
 * cliques. O leitor detecta o delimitador e entende os dois. A célula de etiquetas leva aspas porque
 * tem o próprio `;`.
 */
const DELIMITER = ";";

/** Uma linha por exemplo, na ordem de `IMPORT_COLUMNS`. Números de aparência claramente fictícia. */
const EXAMPLES: readonly (readonly string[])[] = [
  ["11900000001", "Maria Souza", "maria@exemplo.com.br", "", "cliente;vip", "Prefere contato à tarde"],
  ["(21) 90000-0002", "João Lima", "joao@exemplo.com.br", "", "lead", ""],
];

function cell(value: string): string {
  return /["\r\n;,\t]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * O modelo, gerado de `IMPORT_COLUMNS` (um arquivo estático envelheceria no dia em que uma coluna
 * mudasse). Começa com BOM, para o Excel entender os acentos, e usa CRLF.
 */
export function buildTemplateCsv(): string {
  const header = IMPORT_COLUMNS.map(({ header: name }) => name);
  const lines = [header, ...EXAMPLES].map((row) => row.map(cell).join(DELIMITER));
  return `﻿${lines.join("\r\n")}\r\n`;
}
