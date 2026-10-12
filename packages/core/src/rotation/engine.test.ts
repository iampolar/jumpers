import { describe, expect, it } from 'vitest';
import { zRotationRules, type RotationRules } from '@castwave/contracts';
import { buildRotation, type RotationCandidate } from './engine.js';

const SP = 'America/Sao_Paulo';
const START = new Date('2026-03-16T13:00:00Z'); // 10:00 em Sao Paulo
const MIN = 60_000;

const rules = (over: Partial<RotationRules> = {}): RotationRules =>
  zRotationRules.parse({ shuffleSeed: 42, ...over });

const track = (id: string, durationMs = 3 * MIN): RotationCandidate => ({
  id,
  itemType: 'music',
  mediaAssetId: `media-${id}`,
  announcementId: null,
  announcementVersionId: null,
  campaignId: null,
  title: `Faixa ${id}`,
  durationMs,
  priority: 0,
  weight: 1,
  sortOrder: Number(id.replace(/\D/g, '')) || 0,
  activeFrom: null,
  activeUntil: null,
  maxPlaysPerDay: null,
  playsToday: 0,
  enabled: true,
  sizeBytes: 3_000_000,
  checksumSha256: null,
  gain: 100,
});

const spot = (id: string, over: Partial<RotationCandidate> = {}): RotationCandidate => ({
  ...track(id, 20_000),
  itemType: 'promo_spot',
  announcementId: `ann-${id}`,
  announcementVersionId: `ver-${id}`,
  title: `Spot ${id}`,
  priority: 10,
  ...over,
});

const build = (candidates: RotationCandidate[], over: Partial<RotationRules> = {}, horizonMs = 60 * MIN) =>
  buildRotation({
    rules: rules(over),
    candidates,
    timezone: SP,
    startAt: START,
    horizonMs,
    maxItems: 200,
  });

describe('insercao de spots', () => {
  it('insere um spot a cada N faixas', () => {
    const r = build([track('m1'), track('m2'), track('m3'), track('m4'), spot('s1')], {
      insertionMode: 'every_n_tracks',
      everyNTracks: 2,
      musicOrder: 'sequential',
    });
    const types = r.slots.map((s) => s.candidate.itemType);
    expect(types.slice(0, 6)).toEqual(['music', 'music', 'promo_spot', 'music', 'music', 'promo_spot']);
  });

  it('insere um spot a cada N minutos', () => {
    const r = build([track('m1', 5 * MIN), track('m2', 5 * MIN), spot('s1')], {
      insertionMode: 'every_n_minutes',
      everyNMinutes: 10,
      musicOrder: 'sequential',
    });
    const firstSpotIndex = r.slots.findIndex((s) => s.candidate.itemType === 'promo_spot');
    expect(firstSpotIndex).toBe(2); // so apos 10 minutos de musica
    expect(r.slots[firstSpotIndex]!.startsAfterMs).toBe(10 * MIN);
  });

  it('emite um bloco comercial com varios spots', () => {
    const r = build([track('m1'), track('m2'), spot('s1'), spot('s2'), spot('s3')], {
      everyNTracks: 1,
      spotsPerBreak: 3,
      musicOrder: 'sequential',
    });
    const firstBreak = r.slots.slice(1, 4).map((s) => s.candidate.itemType);
    expect(firstBreak).toEqual(['promo_spot', 'promo_spot', 'promo_spot']);
  });

  it('sem spot nenhum, toca so musica', () => {
    const r = build([track('m1'), track('m2')], { musicOrder: 'sequential' });
    expect(r.slots.every((s) => s.candidate.itemType === 'music')).toBe(true);
  });
});

describe('posicionamento no tempo', () => {
  it('itens sao seriais: nenhum comeca antes do anterior terminar', () => {
    const r = build([track('m1', 2 * MIN), track('m2', 4 * MIN), spot('s1', { durationMs: 30_000 })], {
      everyNTracks: 1,
      musicOrder: 'sequential',
    });
    for (let i = 1; i < r.slots.length; i += 1) {
      const prev = r.slots[i - 1]!;
      expect(r.slots[i]!.startsAfterMs).toBe(prev.startsAfterMs + prev.candidate.durationMs);
    }
  });

  it('nunca ultrapassa o horizonte solicitado', () => {
    const r = build([track('m1', 7 * MIN)], { musicOrder: 'sequential' }, 20 * MIN);
    const last = r.slots.at(-1)!;
    expect(last.startsAfterMs + last.candidate.durationMs).toBeLessThanOrEqual(20 * MIN);
    expect(r.totalDurationMs).toBeLessThanOrEqual(20 * MIN);
  });
});

describe('limites de repeticao', () => {
  it('nao repete o mesmo spot em sequencia quando ha alternativa', () => {
    const r = build([track('m1'), track('m2'), spot('s1'), spot('s2')], {
      everyNTracks: 1,
      spotsPerBreak: 2,
      musicOrder: 'sequential',
      avoidBackToBackSameSpot: true,
    });
    const spots = r.slots.filter((s) => s.candidate.itemType === 'promo_spot');
    for (let i = 1; i < spots.length; i += 1) {
      expect(spots[i]!.candidate.id).not.toBe(spots[i - 1]!.candidate.id);
    }
  });

  it('respeita o teto de execucoes por hora de um spot', () => {
    const r = build(
      [track('m1', MIN), spot('s1')],
      { everyNTracks: 1, musicOrder: 'sequential', maxSpotPlaysPerHour: 3, avoidBackToBackSameSpot: false },
      60 * MIN,
    );
    const plays = r.slots.filter((s) => s.candidate.id === 's1');
    expect(plays.length).toBe(3);
  });

  it('respeita maxPlaysPerDay somando o que ja tocou hoje', () => {
    const r = build(
      [track('m1', MIN), spot('s1', { maxPlaysPerDay: 5, playsToday: 4 })],
      { everyNTracks: 1, musicOrder: 'sequential', maxSpotPlaysPerHour: 60, avoidBackToBackSameSpot: false },
      60 * MIN,
    );
    expect(r.slots.filter((s) => s.candidate.id === 's1')).toHaveLength(1);
  });

  it('exclui com motivo o spot que ja bateu o limite diario', () => {
    const r = build([track('m1'), spot('s1', { maxPlaysPerDay: 2, playsToday: 2 })], {
      everyNTracks: 1,
      musicOrder: 'sequential',
    });
    expect(r.excluded).toContainEqual({ id: 's1', title: 'Spot s1', reason: 'daily_cap_reached' });
    expect(r.slots.some((s) => s.candidate.id === 's1')).toBe(false);
  });
});

describe('vigencia', () => {
  it('spot que ainda nao comecou nao entra, e o motivo aparece', () => {
    const r = build([track('m1'), spot('s1', { activeFrom: new Date('2026-04-01T00:00:00Z') })], {
      everyNTracks: 1,
      musicOrder: 'sequential',
    });
    expect(r.excluded).toContainEqual({ id: 's1', title: 'Spot s1', reason: 'not_yet_valid' });
  });

  it('spot vencido deixa de ser elegivel automaticamente', () => {
    const r = build([track('m1'), spot('s1', { activeUntil: new Date('2026-03-01T00:00:00Z') })], {
      everyNTracks: 1,
      musicOrder: 'sequential',
    });
    expect(r.excluded).toContainEqual({ id: 's1', title: 'Spot s1', reason: 'expired' });
    expect(r.slots.some((s) => s.candidate.id === 's1')).toBe(false);
  });

  it('para de inserir o spot no instante em que a campanha vence, no meio da rotacao', () => {
    // Campanha expira 10 min depois do inicio; horizonte de 60 min.
    const expiry = new Date(START.getTime() + 10 * MIN);
    const r = build(
      [track('m1', MIN), spot('s1', { activeUntil: expiry })],
      { everyNTracks: 1, musicOrder: 'sequential', maxSpotPlaysPerHour: 60, avoidBackToBackSameSpot: false },
      60 * MIN,
    );
    const plays = r.slots.filter((s) => s.candidate.id === 's1');
    expect(plays.length).toBeGreaterThan(0);
    for (const p of plays) expect(p.startsAt.getTime()).toBeLessThan(expiry.getTime());
  });

  it('item desabilitado e excluido com motivo', () => {
    const r = build([track('m1'), spot('s1', { enabled: false })], { everyNTracks: 1 });
    expect(r.excluded).toContainEqual({ id: 's1', title: 'Spot s1', reason: 'disabled' });
  });

  it('audio com duracao zero nunca entra', () => {
    const r = build([track('m1'), track('quebrado', 0)], { musicOrder: 'sequential' });
    expect(r.excluded).toContainEqual({ id: 'quebrado', title: 'Faixa quebrado', reason: 'zero_duration' });
  });
});

describe('janelas de silencio', () => {
  it('nao insere spot dentro da janela de silencio', () => {
    // START = 10:00 local. Silencio das 09:00 as 11:00.
    const r = build([track('m1'), track('m2'), spot('s1')], {
      everyNTracks: 1,
      musicOrder: 'sequential',
      quietWindows: [{ from: '09:00', to: '11:00', label: 'Abertura' }],
    });
    expect(r.slots.some((s) => s.candidate.itemType === 'promo_spot')).toBe(false);
    expect(r.slots.every((s) => s.candidate.itemType === 'music')).toBe(true);
  });

  it('volta a inserir quando a rotacao sai da janela de silencio', () => {
    // Silencio ate 10:30; horizonte de 2h a partir das 10:00.
    const r = build(
      [track('m1', 10 * MIN), spot('s1')],
      {
        everyNTracks: 1,
        musicOrder: 'sequential',
        maxSpotPlaysPerHour: 60,
        avoidBackToBackSameSpot: false,
        quietWindows: [{ from: '09:00', to: '10:30' }],
      },
      120 * MIN,
    );
    const spots = r.slots.filter((s) => s.candidate.itemType === 'promo_spot');
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) expect(s.startsAfterMs).toBeGreaterThanOrEqual(30 * MIN);
  });

  it('entende janela de silencio que cruza a meia-noite', () => {
    const lateStart = new Date('2026-03-17T04:00:00Z'); // 01:00 local
    const r = buildRotation({
      rules: rules({
        everyNTracks: 1,
        musicOrder: 'sequential',
        quietWindows: [{ from: '23:00', to: '06:00' }],
      }),
      candidates: [track('m1'), spot('s1')],
      timezone: SP,
      startAt: lateStart,
      horizonMs: 30 * MIN,
      maxItems: 50,
    });
    expect(r.slots.some((s) => s.candidate.itemType === 'promo_spot')).toBe(false);
  });
});

describe('prioridade e peso', () => {
  it('spot de maior prioridade entra primeiro', () => {
    const r = build(
      [track('m1'), spot('baixa', { priority: 1, sortOrder: 1 }), spot('alta', { priority: 90, sortOrder: 2 })],
      { everyNTracks: 1, musicOrder: 'sequential' },
    );
    const firstSpot = r.slots.find((s) => s.candidate.itemType === 'promo_spot');
    expect(firstSpot!.candidate.id).toBe('alta');
  });

  it('peso maior rende mais execucoes na mesma janela', () => {
    const r = build(
      [
        track('m1', MIN),
        spot('leve', { weight: 1, priority: 5, sortOrder: 1 }),
        spot('pesado', { weight: 3, priority: 5, sortOrder: 2 }),
      ],
      { everyNTracks: 1, musicOrder: 'sequential', maxSpotPlaysPerHour: 60 },
      60 * MIN,
    );
    const leve = r.slots.filter((s) => s.candidate.id === 'leve').length;
    const pesado = r.slots.filter((s) => s.candidate.id === 'pesado').length;
    expect(pesado).toBeGreaterThan(leve);
  });
});

describe('determinismo e terminacao', () => {
  it('a mesma semente produz exatamente a mesma sequencia', () => {
    const library = [track('m1'), track('m2'), track('m3'), track('m4'), track('m5'), spot('s1')];
    const a = build(library, { musicOrder: 'shuffle', shuffleSeed: 7, everyNTracks: 2 });
    const b = build(library, { musicOrder: 'shuffle', shuffleSeed: 7, everyNTracks: 2 });
    expect(a.slots.map((s) => s.slotId)).toEqual(b.slots.map((s) => s.slotId));
  });

  it('sementes diferentes produzem ordens diferentes', () => {
    const library = [track('m1'), track('m2'), track('m3'), track('m4'), track('m5')];
    const a = build(library, { musicOrder: 'shuffle', shuffleSeed: 7 });
    const b = build(library, { musicOrder: 'shuffle', shuffleSeed: 999 });
    expect(a.slots.map((s) => s.candidate.id)).not.toEqual(b.slots.map((s) => s.candidate.id));
  });

  it('playlist vazia devolve nada, sem travar', () => {
    const r = build([]);
    expect(r.slots).toHaveLength(0);
    expect(r.totalDurationMs).toBe(0);
  });

  it('playlist so de avisos opera em serie e termina', () => {
    const r = build(
      [spot('a1', { itemType: 'operational_notice', priority: 1 }), spot('a2', { itemType: 'operational_notice', priority: 1 })],
      { maxSpotPlaysPerHour: 4, avoidBackToBackSameSpot: true },
      60 * MIN,
    );
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.slots.length).toBeLessThanOrEqual(8);
  });

  it('nao entra em loop infinito quando nenhum spot e elegivel', () => {
    const r = build([spot('s1', { maxPlaysPerDay: 1, playsToday: 1 })], {}, 600 * MIN);
    expect(r.slots).toHaveLength(0);
  });

  it('respeita o teto de itens do manifesto', () => {
    const r = buildRotation({
      rules: rules({ musicOrder: 'sequential' }),
      candidates: [track('m1', 1000)],
      timezone: SP,
      startAt: START,
      horizonMs: 24 * 60 * MIN,
      maxItems: 25,
    });
    expect(r.slots).toHaveLength(25);
  });
});
