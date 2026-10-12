/**
 * Exportacao CSV segura.
 *
 * Uma celula que comeca com `=`, `+`, `-`, `@`, TAB ou CR e tratada como
 * formula pelo Excel e pelo Google Sheets. Um nome de playlist como
 * `=HYPERLINK("http://...")` vira execucao de codigo na maquina de quem abre o
 * relatorio -- CSV injection, a vulnerabilidade mais ignorada de todo painel
 * B2B. Prefixamos com apostrofo, o que neutraliza a formula e preserva o texto.
 */

const DANGEROUS_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  // Uma celula nunca pode virar "[object Object]" num relatorio entregue ao
  // cliente: datas saem em ISO e o resto em JSON, de forma legivel e estavel.
  let s: string;
  if (typeof value === 'string') s = value;
  else if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') s = String(value);
  else s = JSON.stringify(value) ?? '';
  if (DANGEROUS_PREFIX.test(s)) s = `'${s}`;
  if (/[",\n\r;]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface CsvColumn<T> {
  readonly header: string;
  readonly value: (row: T) => unknown;
}

export interface CsvOptions {
  /** `;` e o padrao do Excel em pt-BR; `,` em locale en. */
  readonly delimiter?: ',' | ';';
  /** BOM UTF-8: sem ele o Excel no Windows quebra acentos. */
  readonly bom?: boolean;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[], options: CsvOptions = {}): string {
  const delimiter = options.delimiter ?? ';';
  const lines: string[] = [columns.map((c) => escapeCsvCell(c.header)).join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvCell(c.value(row))).join(delimiter));
  }
  const body = lines.join('\r\n');
  return options.bom === false ? body : `\uFEFF${body}`;
}

/** Nome de arquivo saneado: sem path traversal, sem caractere reservado. */
export function safeDownloadFilename(base: string, extension: string): string {
  const clean = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${clean || 'export'}.${extension}`;
}
