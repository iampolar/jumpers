/**
 * Conversao entre instante UTC e hora local de loja.
 *
 * Tudo e persistido em UTC (`timestamptz`); as regras de negocio -- "toca das
 * 09:00 as 22:00, de segunda a sabado" -- sao locais. Converter entre os dois
 * e a operacao mais sutil do produto: uma rede com loja em Sao Paulo (-03),
 * Manaus (-04), Rio Branco (-05) e Fernando de Noronha (-02) tem quatro
 * "manhas" diferentes acontecendo ao mesmo tempo, e lojas em Santiago ou
 * Assuncao ainda mudam de offset duas vezes por ano.
 *
 * Nao usamos biblioteca de fuso: `Intl` carrega a base IANA do ICU do runtime,
 * que e atualizada junto com o Node. Uma tabela empacotada no bundle envelhece.
 */

export interface ZonedParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number;
  readonly second: number;
  /** 0 = domingo, igual a `Date#getDay` e a `extract(dow)` do Postgres. */
  readonly weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Decompoe um instante nos componentes locais de um fuso IANA. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0';

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Offset do fuso naquele instante, em milissegundos (positivo a leste). */
export function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `Date.UTC` perde os milissegundos do instante; devolvemos para nao enviesar.
  return asIfUtc - (instant.getTime() - instant.getUTCMilliseconds());
}

/**
 * Hora local -> instante UTC.
 *
 * Duas passagens: a primeira estima o offset, a segunda corrige quando a
 * estimativa caiu do outro lado de uma troca de horario de verao.
 *
 * Casos de borda, documentados porque *vao* acontecer:
 *  - hora inexistente (salto de primavera, 00:00 -> 01:00 em Santiago): devolve
 *    o primeiro instante valido depois do salto;
 *  - hora ambigua (recuo de outono, 00:00 acontece duas vezes): devolve a
 *    primeira ocorrencia, isto e, ainda no horario de verao.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
  second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = timezoneOffsetMs(new Date(naive), timeZone);
  let instant = naive - firstOffset;
  const secondOffset = timezoneOffsetMs(new Date(instant), timeZone);
  if (secondOffset !== firstOffset) instant = naive - secondOffset;
  return new Date(instant);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function parseLocalDate(value: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(value);
  if (!m) throw new RangeError(`Data local invalida: ${value}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function parseLocalTime(value: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(value);
  if (!m) throw new RangeError(`Hora local invalida: ${value}`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** `YYYY-MM-DD` + `HH:MM` no fuso da loja -> instante UTC. */
export function localDateTimeToUtc(localDate: string, localTime: string, timeZone: string): Date {
  const d = parseLocalDate(localDate);
  const t = parseLocalTime(localTime);
  return zonedTimeToUtc(d.year, d.month, d.day, t.hour, t.minute, timeZone);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Data local da loja em `YYYY-MM-DD`. A chave de agregacao dos relatorios. */
export function localDateString(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function localTimeString(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Minutos desde a meia-noite local. Base das comparacoes de janela. */
export function localMinutesOfDay(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.hour * 60 + p.minute;
}

export function minutesFromLocalTime(localTime: string): number {
  const t = parseLocalTime(localTime);
  return t.hour * 60 + t.minute;
}

export function localTimeFromMinutes(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/**
 * Soma dias em calendario local, nao em multiplos de 24h.
 * Em dia de troca de horario de verao "amanha as 09:00" nao e "daqui a 24h".
 */
export function addLocalDays(localDate: string, days: number): string {
  const d = parseLocalDate(localDate);
  const shifted = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Dia da semana (0 = domingo) de uma data local, sem depender de fuso. */
export function weekdayOfLocalDate(localDate: string): number {
  const d = parseLocalDate(localDate);
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** Diferenca em dias de calendario entre duas datas locais (b - a). */
export function diffLocalDays(a: string, b: string): number {
  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  const ta = Date.UTC(pa.year, pa.month - 1, pa.day);
  const tb = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.round((tb - ta) / 86_400_000);
}

/** Datas locais de `from` ate `to`, inclusive. Usado para series densas. */
export function eachLocalDate(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i <= maxDays; i += 1) {
    out.push(cursor);
    if (cursor >= to) break;
    cursor = addLocalDays(cursor, 1);
  }
  return out;
}

/** Rotulo curto de offset para a UI: `UTC-03`, `UTC+05:30`. */
export function offsetLabel(instant: Date, timeZone: string): string {
  const totalMinutes = Math.round(timezoneOffsetMs(instant, timeZone) / 60_000);
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const hours = pad2(Math.floor(abs / 60));
  const minutes = abs % 60;
  return minutes === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${pad2(minutes)}`;
}

/** `true` quando o fuso esta em horario de verao naquele instante. */
export function isDaylightSaving(instant: Date, timeZone: string): boolean {
  const year = zonedParts(instant, timeZone).year;
  const jan = timezoneOffsetMs(new Date(Date.UTC(year, 0, 1, 12)), timeZone);
  const jul = timezoneOffsetMs(new Date(Date.UTC(year, 6, 1, 12)), timeZone);
  const standard = Math.min(jan, jul);
  return timezoneOffsetMs(instant, timeZone) > standard;
}
