import type { RotationRules } from '@castwave/contracts';
import { localMinutesOfDay, minutesFromLocalTime } from '../time/timezone.js';

/**
 * Motor de rotacao.
 *
 * Transforma uma playlist (musicas + spots) numa sequencia linear de itens com
 * posicao no tempo -- o que o player de fato executa.
 *
 * Garantias verificadas por teste unitario, nao por inspecao:
 *  - termina sempre (limite por duracao-alvo E por numero de itens);
 *  - nunca repete o mesmo spot em sequencia quando ha alternativa;
 *  - respeita teto de execucoes por hora, por spot;
 *  - respeita vigencia do item, da campanha e janela de silencio;
 *  - spots nao se sobrepoem: a sequencia e serial por construcao;
 *  - shuffle e deterministico sob uma semente -- o mesmo manifesto pode ser
 *    reproduzido numa auditoria.
 */

export interface RotationCandidate {
  readonly id: string;
  readonly itemType: 'music' | 'promo_spot' | 'operational_notice' | 'jingle';
  readonly mediaAssetId: string;
  readonly announcementId: string | null;
  readonly announcementVersionId: string | null;
  readonly campaignId: string | null;
  readonly title: string;
  readonly durationMs: number;
  readonly priority: number;
  readonly weight: number;
  readonly sortOrder: number;
  readonly activeFrom: Date | null;
  readonly activeUntil: Date | null;
  readonly maxPlaysPerDay: number | null;
  /** Execucoes ja contabilizadas hoje nesta zona. Alimenta `maxPlaysPerDay`. */
  readonly playsToday: number;
  readonly enabled: boolean;
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
  readonly gain: number;
}

export interface RotationInput {
  readonly rules: RotationRules;
  readonly candidates: readonly RotationCandidate[];
  readonly timezone: string;
  readonly startAt: Date;
  /** Quanto de programacao gerar. O manifesto cobre a janela + folga. */
  readonly horizonMs: number;
  readonly maxItems: number;
}

export interface RotationSlot {
  readonly slotId: string;
  readonly candidate: RotationCandidate;
  readonly startsAfterMs: number;
  readonly startsAt: Date;
}

export interface RotationResult {
  readonly slots: readonly RotationSlot[];
  readonly totalDurationMs: number;
  /** Diagnostico honesto: por que algo nao entrou. Vai para a UI de preview. */
  readonly excluded: readonly { id: string; title: string; reason: ExclusionReason }[];
}

export type ExclusionReason =
  | 'disabled'
  | 'not_yet_valid'
  | 'expired'
  | 'daily_cap_reached'
  | 'zero_duration'
  | 'no_music_available';

/**
 * PRNG xorshift32. Deterministico sob semente, barato e sem dependencia.
 * Nao criptografico -- e embaralhamento de playlist, nao geracao de token.
 */
function createRandom(seed: number): () => number {
  let state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

function isEligible(
  c: RotationCandidate,
  at: Date,
): { ok: true } | { ok: false; reason: ExclusionReason } {
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  if (c.durationMs <= 0) return { ok: false, reason: 'zero_duration' };
  if (c.activeFrom && at < c.activeFrom) return { ok: false, reason: 'not_yet_valid' };
  if (c.activeUntil && at >= c.activeUntil) return { ok: false, reason: 'expired' };
  if (c.maxPlaysPerDay !== null && c.playsToday >= c.maxPlaysPerDay) {
    return { ok: false, reason: 'daily_cap_reached' };
  }
  return { ok: true };
}

function inQuietWindow(rules: RotationRules, at: Date, timezone: string): boolean {
  if (rules.quietWindows.length === 0) return false;
  const nowMinutes = localMinutesOfDay(at, timezone);
  return rules.quietWindows.some((w) => {
    const from = minutesFromLocalTime(w.from);
    const to = minutesFromLocalTime(w.to);
    // Janela que cruza a meia-noite (ex.: 23:00 -> 06:00).
    return from <= to ? nowMinutes >= from && nowMinutes < to : nowMinutes >= from || nowMinutes < to;
  });
}

const isSpot = (c: RotationCandidate): boolean => c.itemType !== 'music';

export function buildRotation(input: RotationInput): RotationResult {
  const { rules, timezone, startAt, horizonMs, maxItems } = input;
  const excluded: { id: string; title: string; reason: ExclusionReason }[] = [];

  const eligible: RotationCandidate[] = [];
  for (const c of input.candidates) {
    const verdict = isEligible(c, startAt);
    if (verdict.ok) eligible.push(c);
    else excluded.push({ id: c.id, title: c.title, reason: verdict.reason });
  }

  const music = eligible.filter((c) => !isSpot(c)).sort((a, b) => a.sortOrder - b.sortOrder);
  const spots = eligible.filter(isSpot);

  if (music.length === 0 && spots.length === 0) {
    return { slots: [], totalDurationMs: 0, excluded };
  }

  const random = createRandom(rules.shuffleSeed ?? deriveSeed(startAt, timezone));
  const musicOrder = rules.musicOrder === 'shuffle' ? shuffleInPlace([...music], random) : music;

  /*
   * Fila de spots por prioridade decrescente. Dentro da mesma prioridade o
   * `weight` controla quantas vezes o item aparece no ciclo -- um peso 3 entra
   * tres vezes, o que da frequencia relativa sem sortear a cada volta.
   */
  const spotCycle: RotationCandidate[] = [];
  for (const s of [...spots].sort((a, b) => b.priority - a.priority || a.sortOrder - b.sortOrder)) {
    for (let i = 0; i < Math.min(s.weight, 20); i += 1) spotCycle.push(s);
  }

  const slots: RotationSlot[] = [];
  const playsThisRun = new Map<string, number[]>(); // candidateId -> offsets (ms)
  let cursorMs = 0;
  let musicIndex = 0;
  let spotIndex = 0;
  let tracksSinceBreak = 0;
  let msSinceBreak = 0;

  const canPlaySpot = (c: RotationCandidate, offsetMs: number): boolean => {
    const history = playsThisRun.get(c.id) ?? [];
    const withinHour = history.filter((t) => offsetMs - t < 3_600_000).length;
    if (withinHour >= rules.maxSpotPlaysPerHour) return false;
    const dayTotal = c.playsToday + history.length;
    if (c.maxPlaysPerDay !== null && dayTotal >= c.maxPlaysPerDay) return false;
    /*
     * "Back to back" e adjacencia literal na sequencia emitida -- dois spots
     * iguais colados. Com musica entre eles nao ha repeticao percebida, e
     * bloquear nesse caso faria uma playlist de spot unico simplesmente parar
     * de tocar o spot apos a primeira insercao.
     */
    if (rules.avoidBackToBackSameSpot && slots.at(-1)?.candidate.id === c.id) return false;
    const at = new Date(startAt.getTime() + offsetMs);
    if (c.activeUntil && at >= c.activeUntil) return false;
    if (c.activeFrom && at < c.activeFrom) return false;
    return true;
  };

  const pushSlot = (candidate: RotationCandidate): void => {
    slots.push({
      slotId: `${candidate.id}:${cursorMs}`,
      candidate,
      startsAfterMs: cursorMs,
      startsAt: new Date(startAt.getTime() + cursorMs),
    });
    if (isSpot(candidate)) {
      const history = playsThisRun.get(candidate.id) ?? [];
      history.push(cursorMs);
      playsThisRun.set(candidate.id, history);
    }
    cursorMs += candidate.durationMs;
  };

  const emitBreak = (): void => {
    if (spotCycle.length === 0) return;
    if (inQuietWindow(rules, new Date(startAt.getTime() + cursorMs), timezone)) return;

    let emitted = 0;
    let attempts = 0;
    while (emitted < rules.spotsPerBreak && attempts < spotCycle.length * 2) {
      const candidate = spotCycle[spotIndex % spotCycle.length]!;
      spotIndex += 1;
      attempts += 1;
      if (cursorMs + candidate.durationMs > horizonMs) break;
      if (!canPlaySpot(candidate, cursorMs)) continue;
      pushSlot(candidate);
      emitted += 1;
    }
  };

  // Playlist so de spots (ex.: grade de avisos operacionais): emite em serie.
  if (musicOrder.length === 0) {
    let attempts = 0;
    while (cursorMs < horizonMs && slots.length < maxItems && attempts < maxItems * 4) {
      attempts += 1;
      const before = slots.length;
      emitBreak();
      if (slots.length === before) break; // nada mais elegivel: evita loop infinito
    }
    return { slots, totalDurationMs: cursorMs, excluded };
  }

  while (cursorMs < horizonMs && slots.length < maxItems) {
    const track = musicOrder[musicIndex % musicOrder.length]!;
    musicIndex += 1;

    // Reembaralha a cada volta completa para nao repetir a mesma ordem.
    if (rules.musicOrder === 'shuffle' && musicIndex % musicOrder.length === 0) {
      shuffleInPlace(musicOrder, random);
    }

    if (cursorMs + track.durationMs > horizonMs) break;
    pushSlot(track);
    tracksSinceBreak += 1;
    msSinceBreak += track.durationMs;

    const breakDue =
      rules.insertionMode === 'every_n_tracks'
        ? tracksSinceBreak >= rules.everyNTracks
        : msSinceBreak >= rules.everyNMinutes * 60_000;

    if (breakDue) {
      emitBreak();
      tracksSinceBreak = 0;
      msSinceBreak = 0;
    }
  }

  if (slots.every((s) => !isSpot(s.candidate)) && spots.length > 0 && spotCycle.length > 0) {
    // Horizonte curto demais para alcancar o primeiro intervalo: avisa em vez
    // de deixar o lojista achando que o spot vai tocar.
    for (const s of spots) excluded.push({ id: s.id, title: s.title, reason: 'no_music_available' });
  }

  return { slots, totalDurationMs: cursorMs, excluded };
}

/** Semente derivada do dia local: estavel dentro do dia, varia entre dias. */
function deriveSeed(at: Date, timezone: string): number {
  const key = `${at.toISOString().slice(0, 10)}:${timezone}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
