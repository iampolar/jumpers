import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  diffLocalDays,
  eachLocalDate,
  isDaylightSaving,
  localDateString,
  localDateTimeToUtc,
  localMinutesOfDay,
  localTimeFromMinutes,
  offsetLabel,
  timezoneOffsetMs,
  weekdayOfLocalDate,
  zonedParts,
  zonedTimeToUtc,
} from './timezone';

const SP = 'America/Sao_Paulo';
const MANAUS = 'America/Manaus';
const RIO_BRANCO = 'America/Rio_Branco';
const NORONHA = 'America/Noronha';
const SANTIAGO = 'America/Santiago'; // ainda usa horario de verao
const NEW_YORK = 'America/New_York';

describe('zonedParts', () => {
  it('decompoe o mesmo instante em quatro horarios brasileiros diferentes', () => {
    // 2026-03-15T15:00:00Z
    const instant = new Date('2026-03-15T15:00:00.000Z');
    expect(zonedParts(instant, NORONHA).hour).toBe(13); // UTC-2
    expect(zonedParts(instant, SP).hour).toBe(12); // UTC-3
    expect(zonedParts(instant, MANAUS).hour).toBe(11); // UTC-4
    expect(zonedParts(instant, RIO_BRANCO).hour).toBe(10); // UTC-5
  });

  it('entrega o dia da semana no mesmo indice do Postgres (0 = domingo)', () => {
    expect(zonedParts(new Date('2026-03-15T15:00:00Z'), SP).weekday).toBe(0); // domingo
    expect(zonedParts(new Date('2026-03-16T15:00:00Z'), SP).weekday).toBe(1); // segunda
  });

  it('vira o dia local antes do dia UTC em fuso negativo', () => {
    // 02:00Z de dia 16 ainda e dia 15 em Sao Paulo.
    expect(localDateString(new Date('2026-03-16T02:00:00Z'), SP)).toBe('2026-03-15');
    expect(localDateString(new Date('2026-03-16T02:00:00Z'), 'UTC')).toBe('2026-03-16');
  });
});

describe('zonedTimeToUtc', () => {
  it('converte hora local de loja para instante UTC', () => {
    expect(zonedTimeToUtc(2026, 3, 16, 9, 0, SP).toISOString()).toBe('2026-03-16T12:00:00.000Z');
    expect(zonedTimeToUtc(2026, 3, 16, 9, 0, MANAUS).toISOString()).toBe('2026-03-16T13:00:00.000Z');
  });

  it('e inversa de zonedParts para qualquer hora comum', () => {
    for (const tz of [SP, MANAUS, NORONHA, NEW_YORK, 'Europe/Lisbon', 'Asia/Tokyo']) {
      for (const hour of [0, 6, 12, 18, 23]) {
        const utc = zonedTimeToUtc(2026, 6, 10, hour, 30, tz);
        const back = zonedParts(utc, tz);
        expect(`${tz} ${hour}`).toBe(`${tz} ${hour}`);
        expect(back.hour).toBe(hour);
        expect(back.minute).toBe(30);
        expect(back.day).toBe(10);
      }
    }
  });

  it('resolve o salto de primavera devolvendo o primeiro instante valido', () => {
    /*
     * Em 2026-09-06 Santiago adianta de 23:59 para 01:00: as 00:30 locais nao
     * existem. Devolvemos um instante real, nunca NaN nem uma hora fantasma.
     */
    const ghost = zonedTimeToUtc(2026, 9, 6, 0, 30, SANTIAGO);
    expect(Number.isNaN(ghost.getTime())).toBe(false);
    const back = zonedParts(ghost, SANTIAGO);
    expect(back.hour).toBeGreaterThanOrEqual(1); // empurrado para depois do salto
  });

  it('resolve a hora ambigua do recuo escolhendo a primeira ocorrencia', () => {
    // Em 2026-04-04 Santiago atrasa de 00:00 para 23:00: 23:30 acontece duas vezes.
    const first = zonedTimeToUtc(2026, 4, 4, 23, 30, SANTIAGO);
    const back = zonedParts(first, SANTIAGO);
    expect(back.hour).toBe(23);
    expect(back.minute).toBe(30);
  });

  it('mantem 09:00 local em Nova York nos dois lados do horario de verao', () => {
    const winter = zonedTimeToUtc(2026, 1, 15, 9, 0, NEW_YORK);
    const summer = zonedTimeToUtc(2026, 7, 15, 9, 0, NEW_YORK);
    expect(winter.toISOString()).toBe('2026-01-15T14:00:00.000Z'); // EST, UTC-5
    expect(summer.toISOString()).toBe('2026-07-15T13:00:00.000Z'); // EDT, UTC-4
    // Em UTC sao instantes diferentes; para a loja e a mesma abertura.
    expect(zonedParts(winter, NEW_YORK).hour).toBe(9);
    expect(zonedParts(summer, NEW_YORK).hour).toBe(9);
  });
});

describe('offset e horario de verao', () => {
  it('reporta o offset correto por fuso', () => {
    const instant = new Date('2026-06-15T12:00:00Z');
    expect(timezoneOffsetMs(instant, SP)).toBe(-3 * 3_600_000);
    expect(timezoneOffsetMs(instant, MANAUS)).toBe(-4 * 3_600_000);
    expect(offsetLabel(instant, SP)).toBe('UTC-03');
    expect(offsetLabel(instant, 'Asia/Kolkata')).toBe('UTC+05:30');
  });

  it('o Brasil nao tem mais horario de verao desde 2019', () => {
    expect(isDaylightSaving(new Date('2026-01-15T12:00:00Z'), SP)).toBe(false);
    expect(isDaylightSaving(new Date('2026-07-15T12:00:00Z'), SP)).toBe(false);
  });

  it('detecta horario de verao onde ele existe', () => {
    expect(isDaylightSaving(new Date('2026-07-15T12:00:00Z'), NEW_YORK)).toBe(true);
    expect(isDaylightSaving(new Date('2026-01-15T12:00:00Z'), NEW_YORK)).toBe(false);
  });
});

describe('aritmetica de data local', () => {
  it('soma dias em calendario, nao em multiplos de 24h', () => {
    expect(addLocalDays('2026-03-16', 1)).toBe('2026-03-17');
    expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 nao e bissexto
    expect(addLocalDays('2024-02-28', 1)).toBe('2024-02-29'); // 2024 e
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('atravessa o horario de verao sem perder um dia', () => {
    // 2026-11-01 e a virada de outono em Nova York (dia de 25h).
    const before = localDateTimeToUtc('2026-10-31', '12:00', NEW_YORK);
    const after = localDateTimeToUtc('2026-11-01', '12:00', NEW_YORK);
    const hours = (after.getTime() - before.getTime()) / 3_600_000;
    expect(hours).toBe(25);
    expect(addLocalDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('calcula dia da semana e diferenca de dias', () => {
    expect(weekdayOfLocalDate('2026-03-15')).toBe(0);
    expect(weekdayOfLocalDate('2026-03-20')).toBe(5);
    expect(diffLocalDays('2026-03-01', '2026-03-31')).toBe(30);
    expect(diffLocalDays('2026-03-31', '2026-03-01')).toBe(-30);
  });

  it('gera series densas de datas', () => {
    expect(eachLocalDate('2026-03-01', '2026-03-05')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
    expect(eachLocalDate('2026-03-01', '2026-03-01')).toEqual(['2026-03-01']);
  });
});

describe('minutos do dia', () => {
  it('converte ida e volta', () => {
    expect(localTimeFromMinutes(0)).toBe('00:00');
    expect(localTimeFromMinutes(9 * 60 + 30)).toBe('09:30');
    expect(localTimeFromMinutes(1439)).toBe('23:59');
    expect(localTimeFromMinutes(1440)).toBe('00:00'); // normaliza a virada
    expect(localTimeFromMinutes(-30)).toBe('23:30'); // normaliza negativo
  });

  it('le os minutos locais do instante', () => {
    expect(localMinutesOfDay(new Date('2026-03-16T12:30:00Z'), SP)).toBe(9 * 60 + 30);
    expect(localMinutesOfDay(new Date('2026-03-16T12:30:00Z'), MANAUS)).toBe(8 * 60 + 30);
  });
});
