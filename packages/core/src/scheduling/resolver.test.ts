import { describe, expect, it } from 'vitest';
import {
  buildDayTimeline,
  resolveProgram,
  type OpeningHoursRule,
  type ScheduleExceptionRule,
  type ScheduleWindow,
  type StoreScheduleContext,
} from './resolver';
import { localDateTimeToUtc } from '../time/timezone';

const SP = 'America/Sao_Paulo';
const MANAUS = 'America/Manaus';

const window = (over: Partial<ScheduleWindow> & Pick<ScheduleWindow, 'id' | 'playlistId'>): ScheduleWindow => ({
  name: `Agenda ${over.id}`,
  zoneId: null,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  startLocalTime: '09:00',
  endLocalTime: '22:00',
  effectiveFrom: null,
  effectiveUntil: null,
  priority: 0,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const allDayOpen: OpeningHoursRule[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  opensAt: '08:00',
  closesAt: '23:00',
  closed: false,
}));

const ctx = (over: Partial<StoreScheduleContext> = {}): StoreScheduleContext => ({
  storeId: 'store-1',
  timezone: SP,
  openingHours: allDayOpen,
  schedules: [],
  exceptions: [],
  ...over,
});

const at = (localDate: string, localTime: string, tz = SP): Date =>
  localDateTimeToUtc(localDate, localTime, tz);

describe('resolveProgram — janela basica', () => {
  it('toca dentro da janela e silencia fora', () => {
    const c = ctx({ schedules: [window({ id: 's1', playlistId: 'p1' })] });

    const inside = resolveProgram(c, null, at('2026-03-16', '10:00'));
    expect(inside.playing).toBe(true);
    expect(inside.playlistId).toBe('p1');

    const before = resolveProgram(c, null, at('2026-03-16', '08:30'));
    expect(before.playing).toBe(false);
    expect(before.idleReason).toBe('no_schedule');

    const afterClose = resolveProgram(c, null, at('2026-03-16', '23:30'));
    expect(afterClose.playing).toBe(false);
    expect(afterClose.idleReason).toBe('outside_opening_hours');
  });

  it('respeita o dia da semana', () => {
    const c = ctx({ schedules: [window({ id: 's1', playlistId: 'p1', weekdays: [1, 2, 3, 4, 5] })] });
    expect(resolveProgram(c, null, at('2026-03-16', '10:00')).playing).toBe(true); // segunda
    expect(resolveProgram(c, null, at('2026-03-15', '10:00')).playing).toBe(false); // domingo
  });

  it('respeita a vigencia da agenda', () => {
    const c = ctx({
      schedules: [
        window({ id: 's1', playlistId: 'p1', effectiveFrom: '2026-03-10', effectiveUntil: '2026-03-20' }),
      ],
    });
    expect(resolveProgram(c, null, at('2026-03-09', '10:00')).playing).toBe(false);
    expect(resolveProgram(c, null, at('2026-03-10', '10:00')).playing).toBe(true);
    expect(resolveProgram(c, null, at('2026-03-20', '10:00')).playing).toBe(true);
    expect(resolveProgram(c, null, at('2026-03-21', '10:00')).playing).toBe(false);
  });

  it('ignora agenda desabilitada', () => {
    const c = ctx({ schedules: [window({ id: 's1', playlistId: 'p1', enabled: false })] });
    expect(resolveProgram(c, null, at('2026-03-16', '10:00')).playing).toBe(false);
  });
});

describe('resolveProgram — a mesma regra em fusos diferentes', () => {
  it('abre as 09:00 locais em Sao Paulo e em Manaus, em instantes UTC distintos', () => {
    const schedules = [window({ id: 's1', playlistId: 'p1', startLocalTime: '09:00', endLocalTime: '18:00' })];
    const sp = ctx({ timezone: SP, schedules });
    const mao = ctx({ timezone: MANAUS, schedules, storeId: 'store-2' });

    const noonUtc = new Date('2026-03-16T12:00:00Z'); // 09:00 em SP, 08:00 em Manaus
    expect(resolveProgram(sp, null, noonUtc).playing).toBe(true);
    expect(resolveProgram(mao, null, noonUtc).playing).toBe(false);

    const onePmUtc = new Date('2026-03-16T13:00:00Z'); // 09:00 em Manaus
    expect(resolveProgram(mao, null, onePmUtc).playing).toBe(true);
  });
});

describe('resolveProgram — prioridade e sobreposicao', () => {
  const base = window({ id: 'base', playlistId: 'ambiente', priority: 0 });
  const promo = window({
    id: 'promo',
    playlistId: 'promocional',
    priority: 10,
    startLocalTime: '12:00',
    endLocalTime: '14:00',
  });

  it('a maior prioridade vence a sobreposicao', () => {
    const c = ctx({ schedules: [base, promo] });
    expect(resolveProgram(c, null, at('2026-03-16', '11:00')).playlistId).toBe('ambiente');
    expect(resolveProgram(c, null, at('2026-03-16', '13:00')).playlistId).toBe('promocional');
    expect(resolveProgram(c, null, at('2026-03-16', '15:00')).playlistId).toBe('ambiente');
  });

  it('desempata prioridades iguais pela janela mais especifica, deterministicamente', () => {
    const a = window({ id: 'a', playlistId: 'pa', startLocalTime: '09:00', endLocalTime: '22:00' });
    const b = window({ id: 'b', playlistId: 'pb', startLocalTime: '12:00', endLocalTime: '14:00' });
    const c1 = ctx({ schedules: [a, b] });
    const c2 = ctx({ schedules: [b, a] }); // ordem de entrada invertida
    expect(resolveProgram(c1, null, at('2026-03-16', '13:00')).playlistId).toBe('pb');
    expect(resolveProgram(c2, null, at('2026-03-16', '13:00')).playlistId).toBe('pb');
  });

  it('antecipa o fim da janela quando uma agenda de maior prioridade entra depois', () => {
    const c = ctx({ schedules: [base, promo] });
    const r = resolveProgram(c, null, at('2026-03-16', '11:00'));
    expect(r.windowEndsAt.toISOString()).toBe(at('2026-03-16', '12:00').toISOString());
  });
});

describe('resolveProgram — escopo de zona', () => {
  it('agenda de zona especifica nao vale para outra zona', () => {
    const c = ctx({
      schedules: [
        window({ id: 'geral', playlistId: 'ambiente' }),
        window({ id: 'caixa', playlistId: 'avisos', zoneId: 'zone-caixa', priority: 5 }),
      ],
    });
    expect(resolveProgram(c, 'zone-caixa', at('2026-03-16', '10:00')).playlistId).toBe('avisos');
    expect(resolveProgram(c, 'zone-salao', at('2026-03-16', '10:00')).playlistId).toBe('ambiente');
  });
});

describe('resolveProgram — janela que cruza a meia-noite', () => {
  it('continua tocando de madrugada o que comecou ontem a noite', () => {
    const c = ctx({
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        opensAt: '00:00',
        closesAt: '23:59',
        closed: false,
      })),
      schedules: [
        window({ id: 'noturna', playlistId: 'madrugada', startLocalTime: '22:00', endLocalTime: '02:00' }),
      ],
    });
    expect(resolveProgram(c, null, at('2026-03-16', '23:00')).playlistId).toBe('madrugada');
    expect(resolveProgram(c, null, at('2026-03-17', '01:00')).playlistId).toBe('madrugada');
    expect(resolveProgram(c, null, at('2026-03-17', '03:00')).playing).toBe(false);
  });

  it('nao vaza para a madrugada quando o dia anterior nao estava na agenda', () => {
    const c = ctx({
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        opensAt: '00:00',
        closesAt: '23:59',
        closed: false,
      })),
      schedules: [
        window({
          id: 'sabado-noite',
          playlistId: 'balada',
          weekdays: [6], // apenas sabado
          startLocalTime: '22:00',
          endLocalTime: '02:00',
        }),
      ],
    });
    // Domingo 01:00 e continuacao do sabado: toca.
    expect(resolveProgram(c, null, at('2026-03-22', '01:00')).playlistId).toBe('balada');
    // Segunda 01:00 e continuacao do domingo, que nao esta na agenda.
    expect(resolveProgram(c, null, at('2026-03-23', '01:00')).playing).toBe(false);
  });
});

describe('resolveProgram — excecoes', () => {
  const exception = (over: Partial<ScheduleExceptionRule> & Pick<ScheduleExceptionRule, 'kind' | 'localDate'>): ScheduleExceptionRule => ({
    id: `exc-${over.localDate}-${over.kind}`,
    label: 'Excecao',
    overridePlaylistId: null,
    startLocalTime: null,
    endLocalTime: null,
    ...over,
  });

  it('blackout de feriado silencia o dia inteiro', () => {
    const c = ctx({
      schedules: [window({ id: 's1', playlistId: 'p1' })],
      exceptions: [exception({ kind: 'blackout', localDate: '2026-04-21', label: 'Tiradentes' })],
    });
    const r = resolveProgram(c, null, at('2026-04-21', '10:00'));
    expect(r.playing).toBe(false);
    expect(r.idleReason).toBe('blackout');
    expect(r.appliedException).toBe('Tiradentes');
    // O dia seguinte volta ao normal.
    expect(resolveProgram(c, null, at('2026-04-22', '10:00')).playing).toBe(true);
  });

  it('override troca a playlist mantendo a janela', () => {
    const c = ctx({
      schedules: [window({ id: 's1', playlistId: 'ambiente' })],
      exceptions: [
        exception({
          kind: 'override_playlist',
          localDate: '2026-12-24',
          label: 'Vespera de Natal',
          overridePlaylistId: 'natal',
        }),
      ],
    });
    const r = resolveProgram(c, null, at('2026-12-24', '10:00'));
    expect(r.playing).toBe(true);
    expect(r.playlistId).toBe('natal');
    expect(r.appliedException).toBe('Vespera de Natal');
  });

  it('horario especial substitui o expediente do cadastro', () => {
    const c = ctx({
      schedules: [window({ id: 's1', playlistId: 'p1', startLocalTime: '00:00', endLocalTime: '23:59' })],
      exceptions: [
        exception({
          kind: 'special_hours',
          localDate: '2026-12-31',
          label: 'Reveillon',
          startLocalTime: '08:00',
          endLocalTime: '14:00',
        }),
      ],
    });
    expect(resolveProgram(c, null, at('2026-12-31', '10:00')).playing).toBe(true);
    const late = resolveProgram(c, null, at('2026-12-31', '16:00'));
    expect(late.playing).toBe(false);
    expect(late.idleReason).toBe('outside_opening_hours');
  });
});

describe('resolveProgram — horario de funcionamento', () => {
  it('dia marcado como fechado nao toca', () => {
    const c = ctx({
      openingHours: [
        { weekday: 0, opensAt: '00:00', closesAt: '00:00', closed: true },
        ...[1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt: '08:00', closesAt: '22:00', closed: false })),
      ],
      schedules: [window({ id: 's1', playlistId: 'p1' })],
    });
    expect(resolveProgram(c, null, at('2026-03-15', '10:00')).idleReason).toBe('outside_opening_hours'); // domingo
    expect(resolveProgram(c, null, at('2026-03-16', '10:00')).playing).toBe(true);
  });

  it('sem horario cadastrado assume 24 horas', () => {
    const c = ctx({
      openingHours: [],
      schedules: [window({ id: 's1', playlistId: 'p1', startLocalTime: '00:00', endLocalTime: '23:59' })],
    });
    expect(resolveProgram(c, null, at('2026-03-16', '03:00')).playing).toBe(true);
  });
});

describe('windowEndsAt', () => {
  it('aponta sempre para o futuro e para o proximo marco de decisao', () => {
    const c = ctx({ schedules: [window({ id: 's1', playlistId: 'p1', startLocalTime: '09:00', endLocalTime: '18:00' })] });
    const now = at('2026-03-16', '10:00');
    const r = resolveProgram(c, null, now);
    expect(r.windowEndsAt.getTime()).toBeGreaterThan(now.getTime());
    expect(r.windowEndsAt.toISOString()).toBe(at('2026-03-16', '18:00').toISOString());
  });
});

describe('buildDayTimeline', () => {
  it('cobre o dia inteiro sem buracos nem sobreposicao', () => {
    const c = ctx({
      schedules: [
        window({ id: 'manha', playlistId: 'suave', startLocalTime: '08:00', endLocalTime: '12:00' }),
        window({ id: 'tarde', playlistId: 'ativa', startLocalTime: '12:00', endLocalTime: '20:00' }),
      ],
    });
    const blocks = buildDayTimeline(c, null, '2026-03-16');

    expect(blocks[0]!.startLocalTime).toBe('00:00');
    expect(blocks.at(-1)!.endLocalTime).toBe('24:00');
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i]!.startLocalTime).toBe(blocks[i - 1]!.endLocalTime);
    }
    const program = blocks.filter((b) => b.kind === 'program');
    expect(program.map((b) => b.playlistId)).toEqual(['suave', 'ativa']);
  });

  it('marca o feriado como bloqueio em um unico bloco', () => {
    const c = ctx({
      schedules: [window({ id: 's1', playlistId: 'p1' })],
      exceptions: [
        {
          id: 'e1',
          localDate: '2026-04-21',
          kind: 'blackout',
          label: 'Tiradentes',
          overridePlaylistId: null,
          startLocalTime: null,
          endLocalTime: null,
        },
      ],
    });
    const blocks = buildDayTimeline(c, null, '2026-04-21');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('blackout');
    expect(blocks[0]!.label).toBe('Tiradentes');
  });

  it('termina mesmo com agendas patologicas (sem loop infinito)', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      window({
        id: `s${i}`,
        playlistId: `p${i}`,
        priority: i % 7,
        startLocalTime: `${String(i % 23).padStart(2, '0')}:00`,
        endLocalTime: `${String((i % 23) + 1).padStart(2, '0')}:00`,
      }),
    );
    const blocks = buildDayTimeline(ctx({ schedules: many, openingHours: [] }), null, '2026-03-16');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.length).toBeLessThan(200);
  });
});
