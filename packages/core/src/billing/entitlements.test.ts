import { describe, expect, it } from 'vitest';
import { DomainError, type PlanQuotas } from '@castwave/contracts';
import { assertWithinQuota, buildMeters, formatBytes, type UsageSnapshot } from './entitlements.js';

const quotas: PlanQuotas = {
  maxStores: 3,
  maxDevices: 6,
  maxUsers: 5,
  maxStorageBytes: 1024 * 1024 * 1024,
  maxActiveCampaigns: 4,
  monthlyAiCopyGenerations: 100,
  monthlyAiTtsSeconds: 600,
};

const usage = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  storesActive: 2,
  devicesActive: 4,
  users: 3,
  storageBytes: 512 * 1024 * 1024,
  activeCampaigns: 1,
  aiCopyGenerationsThisPeriod: 0,
  aiTtsSecondsThisPeriod: 0,
  ...over,
});

describe('medidores de uso', () => {
  it('calcula proporcao e nao passa de 100%', () => {
    const meters = buildMeters(quotas, usage({ storesActive: 2 }));
    const stores = meters.find((m) => m.metric === 'stores_active')!;
    expect(stores.used).toBe(2);
    expect(stores.limit).toBe(3);
    expect(stores.ratio).toBeCloseTo(2 / 3);
    expect(stores.exceeded).toBe(false);

    const over = buildMeters(quotas, usage({ storesActive: 9 }));
    expect(over.find((m) => m.metric === 'stores_active')!.ratio).toBe(1);
    expect(over.find((m) => m.metric === 'stores_active')!.exceeded).toBe(true);
  });

  it('inclui medidores de IA mesmo sem provedor conectado', () => {
    const metrics = buildMeters(quotas, usage()).map((m) => m.metric);
    expect(metrics).toContain('ai_copy_generations');
    expect(metrics).toContain('ai_tts_seconds');
  });
});

describe('aplicacao de limite', () => {
  it('libera quando ha folga', () => {
    expect(() => assertWithinQuota('stores', quotas, usage({ storesActive: 2 }))).not.toThrow();
  });

  it('bloqueia exatamente no limite, nao depois', () => {
    expect(() => assertWithinQuota('stores', quotas, usage({ storesActive: 3 }))).toThrow(DomainError);
    expect(() => assertWithinQuota('devices', quotas, usage({ devicesActive: 6 }))).toThrow(DomainError);
  });

  it('considera o incremento pedido, nao so o uso atual', () => {
    // 4 players usados, limite 6: criar 2 cabe, criar 3 nao.
    expect(() => assertWithinQuota('devices', quotas, usage({ devicesActive: 4 }), 2)).not.toThrow();
    expect(() => assertWithinQuota('devices', quotas, usage({ devicesActive: 4 }), 3)).toThrow(DomainError);
  });

  it('o erro e 403 com acao acionavel, nao um 500 generico', () => {
    try {
      assertWithinQuota('storage', quotas, usage({ storageBytes: quotas.maxStorageBytes }), 1);
      expect.unreachable();
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe('plan_limit_reached');
      expect(err.status).toBe(403);
      expect(err.action).toBeTruthy();
      expect(err.toBody('req-1').error.action).toContain('plano');
    }
  });

  it('limites de IA valem antes mesmo de existir provedor', () => {
    expect(() =>
      assertWithinQuota('ai_copy', quotas, usage({ aiCopyGenerationsThisPeriod: 100 })),
    ).toThrow(DomainError);
  });
});

describe('formatBytes', () => {
  it('formata nas unidades certas', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 * 5.5)).toBe('5.5 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 42)).toBe('42 GB');
  });
});
