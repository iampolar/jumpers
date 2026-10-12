import { z } from 'zod';

/** Identificador de recurso. UUID v4 gerado pelo servidor. */
export const zId = z.uuid();

export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'E-mail invalido.' }))
  .describe('E-mail normalizado (trim + lowercase) antes da unicidade.');

export const zIsoDateTime = z.iso.datetime({ offset: true, message: 'Data/hora ISO-8601 invalida.' });
export const zIsoDate = z.iso.date();

/** `HH:MM` local da loja. Guardado como `time` no Postgres, resolvido no fuso da loja. */
export const zLocalTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM, 24 horas.');

const TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * Fuso IANA validado contra a base do ICU do runtime -- nao uma lista
 * hardcoded que envelhece. Brasil tem 4 offsets; "America/Sao_Paulo" nao serve
 * para Manaus nem para Rio Branco.
 */
export const zTimezone = z
  .string()
  .refine((v) => TIMEZONES.has(v), { message: 'Fuso horario IANA desconhecido.' })
  .describe('Identificador IANA, ex.: America/Sao_Paulo');

/** Dia da semana no padrao JS/Postgres `extract(dow)`: 0 = domingo. */
export const zWeekday = z.number().int().min(0).max(6);

export const zSlug = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use apenas letras minusculas, numeros e hifens.');

/** Texto visivel ao usuario. Trim + limite + rejeita caracteres de controle. */
export const zSafeText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    // Recusar caractere de controle e exatamente o proposito desta validacao.
    // eslint-disable-next-line no-control-regex
    .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), {
      message: 'Texto contem caracteres de controle nao permitidos.',
    });

export const zPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type Pagination = z.infer<typeof zPagination>;

export const zSortDirection = z.enum(['asc', 'desc']).default('desc');

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export const emptyPage = <T>(p: Pagination): Page<T> => ({
  items: [],
  page: p.page,
  pageSize: p.pageSize,
  total: 0,
  totalPages: 0,
});

/**
 * Chave de idempotencia para POSTs que criam recursos ou movem dinheiro/estado.
 * Enviada no header `Idempotency-Key`.
 */
export const zIdempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/** Intervalo fechado. Usado em relatorios e vigencias. */
export const zDateRange = z
  .object({ from: zIsoDate, to: zIsoDate })
  .refine((v) => v.from <= v.to, { message: 'A data final deve ser igual ou posterior a inicial.' });

export const zMoneyCents = z.number().int().min(0).max(100_000_000);
export const zCurrency = z.enum(['BRL', 'USD', 'EUR']);
