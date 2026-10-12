import {
  addLocalDays,
  localDateString,
  localDateTimeToUtc,
  localMinutesOfDay,
  minutesFromLocalTime,
  weekdayOfLocalDate,
  zonedParts,
} from '../time/timezone.js';

/**
 * Resolvedor de programacao.
 *
 * Dada uma loja, suas agendas, excecoes e horario de funcionamento, responde a
 * unica pergunta que o player faz: *o que toca agora, e ate quando?*
 *
 * Decisoes que o motor toma de forma deterministica, nunca "a primeira que
 * casar":
 *  1. excecao `blackout` da data local vence tudo -- silencio;
 *  2. excecao `override_playlist` substitui a playlist da janela;
 *  3. fora do horario de funcionamento, silencio (a nao ser que haja
 *     `special_hours` para a data);
 *  4. entre agendas sobrepostas vence a de maior `priority`; empatando, a
 *     janela que comeca mais tarde (mais especifica); empatando de novo, a
 *     criada por ultimo. A ordenacao e total: nao existe "arbitrario".
 *
 * `windowEndsAt` e sempre o proximo instante em que a decisao pode mudar --
 * fim da janela, inicio da proxima, virada do dia local ou fim do expediente.
 * O player re-sincroniza exatamente ali, sem polling cego.
 */

export interface ScheduleWindow {
  readonly id: string;
  readonly playlistId: string;
  readonly name: string;
  /** `null` = vale para todas as zonas da loja. */
  readonly zoneId: string | null;
  readonly weekdays: readonly number[];
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly priority: number;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface ScheduleExceptionRule {
  readonly id: string;
  readonly localDate: string;
  readonly kind: 'blackout' | 'override_playlist' | 'special_hours';
  readonly label: string;
  readonly overridePlaylistId: string | null;
  readonly startLocalTime: string | null;
  readonly endLocalTime: string | null;
}

export interface OpeningHoursRule {
  readonly weekday: number;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly closed: boolean;
}

export interface StoreScheduleContext {
  readonly storeId: string;
  readonly timezone: string;
  readonly openingHours: readonly OpeningHoursRule[];
  readonly schedules: readonly ScheduleWindow[];
  readonly exceptions: readonly ScheduleExceptionRule[];
}

export type IdleReason =
  | 'no_schedule'
  | 'outside_opening_hours'
  | 'blackout'
  | 'empty_playlist'
  | 'no_ready_media';

export interface ResolvedProgram {
  readonly playing: boolean;
  readonly playlistId: string | null;
  readonly scheduleId: string | null;
  readonly scheduleName: string | null;
  /** Instante em que esta decisao deixa de valer. Sempre no futuro. */
  readonly windowEndsAt: Date;
  readonly idleReason: IdleReason | null;
  /** Rotulo da excecao aplicada, para a UI explicar "por que esta em silencio". */
  readonly appliedException: string | null;
  readonly localDate: string;
  readonly localTime: string;
}

/** Janela local materializada em minutos, podendo atravessar a meia-noite. */
interface MaterializedWindow {
  readonly source: ScheduleWindow;
  readonly startMinutes: number;
  readonly endMinutes: number; // pode ser > 1440 quando cruza o dia
}

const MINUTES_IN_DAY = 1440;

function isWithinEffectiveRange(w: ScheduleWindow, localDate: string): boolean {
  if (w.effectiveFrom && localDate < w.effectiveFrom) return false;
  if (w.effectiveUntil && localDate > w.effectiveUntil) return false;
  return true;
}

/**
 * Janelas que *podem* cobrir um minuto do dia local, incluindo as que comecaram
 * no dia anterior e atravessaram a meia-noite (ex.: 22:00 -> 02:00).
 */
function materializeWindows(
  schedules: readonly ScheduleWindow[],
  localDate: string,
  zoneId: string | null,
): MaterializedWindow[] {
  const out: MaterializedWindow[] = [];
  const weekday = weekdayOfLocalDate(localDate);
  const previousDate = addLocalDays(localDate, -1);
  const previousWeekday = weekdayOfLocalDate(previousDate);

  for (const w of schedules) {
    if (!w.enabled) continue;
    if (w.zoneId !== null && zoneId !== null && w.zoneId !== zoneId) continue;

    const start = minutesFromLocalTime(w.startLocalTime);
    const end = minutesFromLocalTime(w.endLocalTime);
    const crossesMidnight = end <= start;

    if (w.weekdays.includes(weekday) && isWithinEffectiveRange(w, localDate)) {
      out.push({
        source: w,
        startMinutes: start,
        endMinutes: crossesMidnight ? end + MINUTES_IN_DAY : end,
      });
    }

    // Continuacao de uma janela iniciada ontem.
    if (crossesMidnight && w.weekdays.includes(previousWeekday) && isWithinEffectiveRange(w, previousDate)) {
      out.push({ source: w, startMinutes: start - MINUTES_IN_DAY, endMinutes: end });
    }
  }
  return out;
}

/**
 * Ordenacao total das janelas candidatas. Determinismo aqui e o que impede
 * duas lojas identicas de tocarem coisas diferentes.
 */
function pickWinner(candidates: readonly MaterializedWindow[]): MaterializedWindow | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    if (a.source.priority !== b.source.priority) return b.source.priority - a.source.priority;
    if (a.startMinutes !== b.startMinutes) return b.startMinutes - a.startMinutes;
    if (a.source.createdAt !== b.source.createdAt) return a.source.createdAt < b.source.createdAt ? 1 : -1;
    return a.source.id < b.source.id ? 1 : -1;
  })[0]!;
}

function openingWindowFor(
  openingHours: readonly OpeningHoursRule[],
  weekday: number,
): { opens: number; closes: number } | null {
  if (openingHours.length === 0) return { opens: 0, closes: MINUTES_IN_DAY }; // 24h quando nao informado
  const rule = openingHours.find((h) => h.weekday === weekday);
  if (!rule || rule.closed) return null;
  const opens = minutesFromLocalTime(rule.opensAt);
  const closes = minutesFromLocalTime(rule.closesAt);
  return { opens, closes: closes <= opens ? closes + MINUTES_IN_DAY : closes };
}

function utcAtLocalMinutes(localDate: string, minutes: number, timeZone: string): Date {
  const dayOffset = Math.floor(minutes / MINUTES_IN_DAY);
  const withinDay = ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const date = dayOffset === 0 ? localDate : addLocalDays(localDate, dayOffset);
  const hh = String(Math.floor(withinDay / 60)).padStart(2, '0');
  const mm = String(withinDay % 60).padStart(2, '0');
  return localDateTimeToUtc(date, `${hh}:${mm}`, timeZone);
}

export function resolveProgram(
  ctx: StoreScheduleContext,
  zoneId: string | null,
  at: Date,
): ResolvedProgram {
  const { timezone } = ctx;
  const parts = zonedParts(at, timezone);
  const localDate = localDateString(at, timezone);
  const localTime = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  const nowMinutes = localMinutesOfDay(at, timezone);
  const endOfLocalDay = utcAtLocalMinutes(localDate, MINUTES_IN_DAY, timezone);

  const base = { localDate, localTime } as const;

  // 1. Blackout da data local vence tudo.
  const blackout = ctx.exceptions.find((e) => e.localDate === localDate && e.kind === 'blackout');
  if (blackout) {
    return {
      ...base,
      playing: false,
      playlistId: null,
      scheduleId: null,
      scheduleName: null,
      windowEndsAt: endOfLocalDay,
      idleReason: 'blackout',
      appliedException: blackout.label,
    };
  }

  // 2. Horario de funcionamento -- `special_hours` substitui o do cadastro.
  const specialHours = ctx.exceptions.find(
    (e) => e.localDate === localDate && e.kind === 'special_hours' && e.startLocalTime && e.endLocalTime,
  );
  const opening = specialHours
    ? {
        opens: minutesFromLocalTime(specialHours.startLocalTime!),
        closes: (() => {
          const o = minutesFromLocalTime(specialHours.startLocalTime!);
          const c = minutesFromLocalTime(specialHours.endLocalTime!);
          return c <= o ? c + MINUTES_IN_DAY : c;
        })(),
      }
    : openingWindowFor(ctx.openingHours, parts.weekday);

  if (!opening || nowMinutes < opening.opens || nowMinutes >= opening.closes) {
    const nextBoundary =
      opening && nowMinutes < opening.opens
        ? utcAtLocalMinutes(localDate, opening.opens, timezone)
        : endOfLocalDay;
    return {
      ...base,
      playing: false,
      playlistId: null,
      scheduleId: null,
      scheduleName: null,
      windowEndsAt: nextBoundary,
      idleReason: 'outside_opening_hours',
      appliedException: specialHours?.label ?? null,
    };
  }

  // 3. Agenda vigente.
  const windows = materializeWindows(ctx.schedules, localDate, zoneId);
  const active = windows.filter((w) => nowMinutes >= w.startMinutes && nowMinutes < w.endMinutes);
  const winner = pickWinner(active);

  if (!winner) {
    // Silencio ate a proxima janela do dia (ou virada do dia).
    const upcoming = windows
      .filter((w) => w.startMinutes > nowMinutes)
      .sort((a, b) => a.startMinutes - b.startMinutes)[0];
    const until = upcoming
      ? utcAtLocalMinutes(localDate, Math.min(upcoming.startMinutes, opening.closes), timezone)
      : utcAtLocalMinutes(localDate, Math.min(opening.closes, MINUTES_IN_DAY), timezone);
    return {
      ...base,
      playing: false,
      playlistId: null,
      scheduleId: null,
      scheduleName: null,
      windowEndsAt: until,
      idleReason: 'no_schedule',
      appliedException: null,
    };
  }

  // 4. Override de playlist para a data.
  const override = ctx.exceptions.find(
    (e) => e.localDate === localDate && e.kind === 'override_playlist' && e.overridePlaylistId,
  );

  /*
   * A decisao muda no primeiro destes marcos: fim da janela vencedora, fim do
   * expediente, ou inicio de uma janela de prioridade maior ainda hoje.
   */
  const preempting = windows
    .filter((w) => w.startMinutes > nowMinutes && w.source.priority > winner.source.priority)
    .sort((a, b) => a.startMinutes - b.startMinutes)[0];

  const boundaryMinutes = Math.min(
    winner.endMinutes,
    opening.closes,
    preempting?.startMinutes ?? Number.POSITIVE_INFINITY,
  );

  return {
    ...base,
    playing: true,
    playlistId: override?.overridePlaylistId ?? winner.source.playlistId,
    scheduleId: winner.source.id,
    scheduleName: winner.source.name,
    windowEndsAt: utcAtLocalMinutes(localDate, boundaryMinutes, timezone),
    idleReason: null,
    appliedException: override?.label ?? null,
  };
}

// --------------------------------------------------------------------------
// Pre-visualizacao de calendario
// --------------------------------------------------------------------------

export interface CalendarBlock {
  readonly localDate: string;
  readonly startLocalTime: string;
  readonly endLocalTime: string;
  readonly playlistId: string | null;
  readonly scheduleId: string | null;
  readonly label: string;
  readonly kind: 'program' | 'blackout' | 'closed' | 'gap';
}

/**
 * Expande a grade de um dia local em blocos contiguos, varrendo a linha do
 * tempo pelos proprios `windowEndsAt` do resolvedor -- o calendario da UI e,
 * por construcao, o mesmo que o player vai obedecer. Sem segunda implementacao
 * para divergir.
 */
export function buildDayTimeline(ctx: StoreScheduleContext, zoneId: string | null, localDate: string): CalendarBlock[] {
  const blocks: CalendarBlock[] = [];
  let cursor = localDateTimeToUtc(localDate, '00:00', ctx.timezone);
  const dayEnd = localDateTimeToUtc(addLocalDays(localDate, 1), '00:00', ctx.timezone);
  let guard = 0;

  while (cursor < dayEnd && guard < 200) {
    guard += 1;
    const resolved = resolveProgram(ctx, zoneId, cursor);
    const blockEnd = resolved.windowEndsAt > dayEnd ? dayEnd : resolved.windowEndsAt;
    if (blockEnd <= cursor) break; // defesa contra janela degenerada

    const startLocalTime = minutesLabel(cursor, ctx.timezone);
    const endLocalTime = blockEnd >= dayEnd ? '24:00' : minutesLabel(blockEnd, ctx.timezone);

    blocks.push({
      localDate,
      startLocalTime,
      endLocalTime,
      playlistId: resolved.playlistId,
      scheduleId: resolved.scheduleId,
      label: resolved.playing
        ? (resolved.scheduleName ?? 'Programacao')
        : resolved.appliedException ?? idleLabel(resolved.idleReason),
      kind: resolved.playing
        ? 'program'
        : resolved.idleReason === 'blackout'
          ? 'blackout'
          : resolved.idleReason === 'outside_opening_hours'
            ? 'closed'
            : 'gap',
    });
    cursor = blockEnd;
  }
  return blocks;
}

function minutesLabel(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function idleLabel(reason: IdleReason | null): string {
  switch (reason) {
    case 'blackout':
      return 'Bloqueio';
    case 'outside_opening_hours':
      return 'Fora do horario';
    case 'empty_playlist':
      return 'Playlist vazia';
    case 'no_ready_media':
      return 'Sem audio pronto';
    default:
      return 'Sem programacao';
  }
}
